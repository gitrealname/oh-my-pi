/**
 * MmemoryServerClient — TCP client for the mmemory Python server.
 *
 * Lazy-start: server is NOT spawned at construction time. It starts on the
 * first query() call and restarts transparently after an idle-timeout shutdown.
 *
 * Protocol: newline-delimited JSON over TCP (localhost only).
 *
 * Design notes:
 *   - Fixed port from config (mmemory.serverPort, default 49200). No dynamic
 *     port discovery, no stdout pipe, no READY handshake.
 *   - One server process handles ALL projects. Project identity is sent as
 *     `project_dir` in every request payload — the server dispatches on it.
 *   - stderr is redirected to a dedicated log file (never read by this process).
 *     Third-party tooling can tail that file independently.
 *   - Startup: pre-spawn ping first (reuse if another OMP instance already
 *     started the server), then PID-file stale-kill, then spawn.
 *   - PID file is written by the server itself (passed via --pid-file).
 *     The client reads it only for stop() and stale-process detection.
 *     The server uses a double-read pattern to elect a single winner when
 *     two processes are spawned concurrently.
 *   - stop() never kills the server process. The server has its own idle
 *     timeout and may be shared by other OMP instances or third-party
 *     consumers. stop() only drops the local reference; the server dies
 *     on its own schedule.
 */
import * as net from "net";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { resolvePython } from "../../stt/transcriber";

const PING_INTERVAL_MS   = 50;
const STARTUP_TIMEOUT_MS = 30_000;

export class MmemoryServerClient {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private proc: any = null;
	private startPromise: Promise<void> | null = null;
	private broken = false;
	constructor(
		private readonly serverScriptPath: string,
		private readonly port: number,
		private readonly logFile: string,
		private readonly idleTimeoutMinutes = 10,
		private readonly pythonCmd = resolvePython() ?? "python",
	) {}

	// ── public ──────────────────────────────────────────────────────────────

	async query(action: string, args: Record<string, unknown> = {}): Promise<unknown | null> {
		if (this.broken) return null;
		await this.#ensureRunning();
		return this.#rawQuery({ action, ...args });
	}

	async stop(): Promise<void> {
		// Drop local reference only. The server has its own idle timeout and may
		// be shared by other OMP instances or third-party consumers — never kill it.
		// The PID file stays on disk; next startup's stale check will clear it if
		// the server has since died.
		this.proc = null;
		this.startPromise = null;
	}

	// ── private ─────────────────────────────────────────────────────────────

	async #ensureRunning(): Promise<void> {
		if (this.startPromise) return this.startPromise;
		if (this.proc) {
			try {
				await this.#rawQuery({ action: "ping" });
				return;
			} catch {
				// Server died via idle timeout — drop reference and let #start() respawn.
				// Do NOT remove the PID file here: the stale check in #start() handles it
				// correctly whether the process is gone or another instance picked it up.
				logger.debug("[mmemory] server ping failed, will respawn on next query", { source: "mmemory-server" });
				this.proc = null;
			}
		}
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.#start()
			.catch((err: unknown) => {
				this.broken = true;
				console.warn("[mmemory] server failed to start — recall disabled for this session");
				throw err;
			})
			.finally(() => {
				this.startPromise = null;
			});
		return this.startPromise;
	}

	async #start(): Promise<void> {
		// ── 1. Pre-spawn ping: reuse server started by another OMP instance ──────
		try {
			const pong = await this.#rawQuery({ action: "ping" }) as { pending_queue_projects?: string[] };
			logger.debug(`[mmemory] reusing existing server on port ${this.port}`, { source: "mmemory-server" });
			// proc stays null — we didn't spawn it, so stop() will not kill it
			void this.#drainPendingQueues(pong.pending_queue_projects);
			return;
		} catch {
			// Not yet responding — continue to spawn
		}

		// ── 2. Stale PID check ───────────────────────────────────────────────────
		const pidPath = this.#pidFilePath();
		const stalePid = this.#readPidFile(pidPath);
		if (stalePid !== null) {
			if (this.#isProcessAlive(stalePid)) {
				// Process alive but port not responding — crashed after spawn, before bind.
				// Kill it so the port is free for our new spawn.
				logger.debug(`[mmemory] killing stale server pid=${stalePid} (alive but port not responding)`, { source: "mmemory-server" });
				try { process.kill(stalePid, 9); } catch { /* already dead */ }
				await new Promise(r => setTimeout(r, 200)); // brief pause for OS port release
			}
			fs.rmSync(pidPath, { force: true });
		}

		// ── 3. Spawn ─────────────────────────────────────────────────────────────
		logger.debug(`[mmemory] starting Python server on port ${this.port}...`, { source: "mmemory-server" });
		fs.mkdirSync(path.dirname(this.logFile), { recursive: true });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const spawn = (globalThis as any).Bun?.spawn;
		if (!spawn) throw new Error("mmemory server requires Bun runtime");
		this.proc = spawn(
			[
				this.pythonCmd,
				this.serverScriptPath,
				"--port",     String(this.port),
				"--timeout",  String(this.idleTimeoutMinutes),
				"--log-file", this.logFile,
				"--pid-file", this.#pidFilePath(),
			],
			{
				stdout:      "ignore",
				stderr:      "ignore",  // Python writes to --log-file directly
				windowsHide: true,
			},
		);

		// ── 4. Wait for ready ────────────────────────────────────────────────────
		const pong = await this.#waitUntilReady();
		logger.debug(`[mmemory] server ready on port ${this.port}`, { source: "mmemory-server" });
		// ── 5. Drain orphaned queue files from previous run ──────────────────────
		// PID file is now written by the server itself; no client-side write needed.
		void this.#drainPendingQueues(pong.pending_queue_projects);
	}

	/** Poll ping until the server responds or timeout expires.
	 *  Returns the final pong payload (contains pending_queue_projects). */
	async #waitUntilReady(): Promise<{ pending_queue_projects?: string[] }> {
		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		let lastErr: unknown;
		while (Date.now() < deadline) {
			try {
				return await this.#rawQuery({ action: "ping" }) as { pending_queue_projects?: string[] };
			} catch (e) {
				lastErr = e;
				await new Promise(r => setTimeout(r, PING_INTERVAL_MS));
			}
		}
		throw new Error(`mmemory server failed to start within ${STARTUP_TIMEOUT_MS / 1000}s: ${lastErr}`);
	}

	/** Fire-and-forget build for each project dir that has pending queue files.
	 *  Must NOT be awaited from #start() — callers must not block on background work. */
	#drainPendingQueues(projects: string[] | undefined): void {
		if (!projects?.length) return;
		for (const project_dir of projects) {
			this.#rawQuery({ action: "build", project_dir })
				.then(() => logger.debug(`[mmemory] triggered build for orphaned queue: ${project_dir}`, { source: "mmemory-server" }))
				.catch((e: unknown) => logger.debug(`[mmemory] failed to trigger orphan build for ${project_dir}: ${e}`, { source: "mmemory-server" }));
		}
	}

	// ── PID file helpers ─────────────────────────────────────────────────────

	#pidFilePath(): string {
		return path.join(path.dirname(this.logFile), `mmemory-server-${this.port}.pid`);
	}

	#readPidFile(pidPath: string): number | null {
		try {
			const content = fs.readFileSync(pidPath, "utf-8").trim();
			const pid = parseInt(content, 10);
			return Number.isNaN(pid) ? null : pid;
		} catch {
			return null;
		}
	}

	/** Check if a PID is alive without sending a real signal.
	 *  process.kill(pid, 0) throws ESRCH if the process doesn't exist. */
	#isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	#rawQuery(req: Record<string, unknown>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(this.port, "127.0.0.1", () => {
				socket.write(JSON.stringify(req) + "\n");
			});
			socket.setTimeout(15_000, () => {
				socket.destroy();
				reject(new Error("mmemory server query timed out after 15s"));
			});
			let buf = "";
			socket.on("data", (d: Buffer) => {
				buf += d.toString();
				// Protocol: newline-delimited JSON. Resolve on first complete line
				// without waiting for the server to close the connection.
				const nl = buf.indexOf("\n");
				if (nl !== -1) {
					const line = buf.slice(0, nl);
					socket.destroy();
					try {
						resolve(JSON.parse(line));
					} catch {
						reject(new Error(`mmemory server returned invalid JSON: ${line.slice(0, 200)}`));
					}
				}
			});
			socket.on("error", (err) => {
				// ECONNRESET after we called destroy() is expected — suppress it
				if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return;
				reject(err);
			});
		});
	}
}
