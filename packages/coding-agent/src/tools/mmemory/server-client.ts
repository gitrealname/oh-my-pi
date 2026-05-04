/**
 * MmemoryServerClient — TCP client for the mmemory Python server.
 *
 * Lazy-start: server is NOT spawned at construction time. It starts on the first
 * query() call and restarts transparently after an idle-timeout shutdown.
 *
 * Protocol: newline-delimited JSON over TCP (localhost only).
 * Server prints "READY:<port>" to stdout before accepting connections.
 */
import * as net from "net";
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
		// If a start is already in flight, wait for it
		if (this.startPromise) {
			return this.startPromise;
		}
		if (this.port > 0) {
			// Ping to check if still alive
			try {
				await this.#rawQuery({ action: "ping" });
				return;
			} catch {
				// Server self-terminated after idle timeout — restart
				this.port = 0;
				this.proc = null;
			}
		}
		// Re-check after any await — another caller may have started while we were pinging
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.#start().finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	async #start(): Promise<void> {
		// Bun.spawn is available in the Bun runtime
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const spawn = (globalThis as any).Bun?.spawn;
		if (!spawn) throw new Error("mmemory server requires Bun runtime");

		this.proc = spawn(
			[this.pythonCmd, this.serverScriptPath, "--port", "0", "--timeout", String(this.idleTimeoutMinutes)],
			{ stdout: "pipe", stderr: "pipe" },
		);
		// Slightly elevated priority for recall responsiveness
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(process as any).setPriority?.(this.proc.pid as number, -5);
		} catch {
			// Non-fatal: priority setting may require elevated permissions on some systems
		}
		this.port = await this.#readReadyPort();
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
			socket.on("data", (d: Buffer) => {
				buf += d.toString();
			});
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
