/**
 * MmemoryServerClient — TCP client for the mmemory Python server.
 *
 * Lazy-start: server is NOT spawned at construction time. It starts on the first
 * query() call and restarts transparently after an idle-timeout shutdown.
 *
 * Protocol: newline-delimited JSON over TCP (localhost only).
 * Server prints "READY:<port>" to stdout before accepting connections.
 *
 * Spawn options:
 *   windowsHide: true  — no visible console window on Windows
 *   priority 10        — below-normal priority; server is background infrastructure
 *   stderr → logger    — Python server logs routed through omp's logger facility
 */
import * as net from "net";
import { logger } from "@oh-my-pi/pi-utils";
import { resolvePython } from "../../stt/transcriber";

export class MmemoryServerClient {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private proc: any = null;
	private port = 0;
	private startPromise: Promise<void> | null = null;

	constructor(
		private readonly serverScriptPath: string,
		private readonly idleTimeoutMinutes = 10,
		private readonly pythonCmd = resolvePython() ?? "python",
	) {}

	// ── public ──────────────────────────────────────────────────────────────

	async query(action: string, args: Record<string, unknown> = {}): Promise<unknown> {
		await this.#ensureRunning();
		return this.#rawQuery({ action, ...args });
	}

	async stop(): Promise<void> {
		if (this.port > 0) {
			await this.#rawQuery({ action: "shutdown" }).catch(() => {});
		}
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		this.proc?.kill();
		this.port = 0;
		this.proc = null;
		this.startPromise = null;
	}

	// ── private ─────────────────────────────────────────────────────────────

	/** Ensure server is alive. Transparent restart after idle-timeout. */
	async #ensureRunning(): Promise<void> {
		if (this.startPromise) return this.startPromise;
		if (this.port > 0) {
			try {
				await this.#rawQuery({ action: "ping" });
				return;
			} catch {
				// Server self-terminated after idle timeout — restart
				this.port = 0;
				this.proc = null;
			}
		}
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.#start().finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	async #start(): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const spawn = (globalThis as any).Bun?.spawn;
		if (!spawn) throw new Error("mmemory server requires Bun runtime");

		this.proc = spawn(
			[this.pythonCmd, this.serverScriptPath, "--port", "0", "--timeout", String(this.idleTimeoutMinutes)],
			{
				stdout: "pipe",
				stderr: "pipe",
				// No visible console window on Windows — consistent with all other
				// background subprocess spawns in omp (LSP servers, plugins, eval gateway).
				windowsHide: true,
			},
		);

		// Below-normal process priority — the mmemory server is background infrastructure.
		// Recall performance comes from the warm model, not from CPU scheduling.
		// Priority 10 = BELOW_NORMAL_PRIORITY_CLASS on Windows; nice ~10 on Unix.
		try {
			process.setPriority?.(this.proc.pid as number, 10);
		} catch {
			// Non-fatal — elevated permissions may be required on some systems.
		}

		// Route Python server stderr → omp logger. Server logs [mmemory] prefixed messages.
		// Without this, all Python-side diagnostics (model load times, build stats, errors)
		// are silently dropped.
		this.#consumeStderr();

		this.port = await this.#readReadyPort();
	}

	/** Drain stderr from the Python process and route through omp's logger. */
	#consumeStderr(): void {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
		const stderr: NodeJS.ReadableStream | undefined = this.proc?.stderr;
		if (!stderr) return;

		let buf = "";
		stderr.on("data", (chunk: Buffer | string) => {
			buf += typeof chunk === "string" ? chunk : chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed) {
					// ERROR lines surface as warn; everything else as debug (hidden in normal use)
					if (trimmed.includes("ERROR")) {
						logger.warn(trimmed, { source: "mmemory-server" });
					} else {
						logger.debug(trimmed, { source: "mmemory-server" });
					}
				}
			}
		});
		stderr.on("end", () => {
			if (buf.trim()) logger.debug(buf.trim(), { source: "mmemory-server" });
		});
	}

	/** Read "READY:<port>" line from stdout. Times out after 30s. */
	#readReadyPort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const proc = this.proc;
			const timer = setTimeout(() => {
				reject(new Error("mmemory server failed to start within 30s"));
			}, 30_000);

			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
			const stdout: NodeJS.ReadableStream = proc.stdout;
			let buf = "";
			stdout.on("data", (chunk: Buffer | string) => {
				buf += typeof chunk === "string" ? chunk : chunk.toString();
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					const m = line.trim().match(/^READY:(\d+)/);
					if (m) {
						clearTimeout(timer);
						resolve(parseInt(m[1], 10));
						return;
					}
				}
			});
			stdout.on("error", (err: Error) => {
				clearTimeout(timer);
				reject(err);
			});
			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
			proc.exited?.then(() => {
				clearTimeout(timer);
				reject(new Error("mmemory server process exited before READY"));
			});
		});
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
			socket.on("data", (d: Buffer) => { buf += d.toString(); });
			socket.on("end", () => {
				try {
					resolve(JSON.parse(buf));
				} catch {
					reject(new Error(`mmemory server returned invalid JSON: ${buf.slice(0, 200)}`));
				}
			});
			socket.on("error", reject);
		});
	}
}
