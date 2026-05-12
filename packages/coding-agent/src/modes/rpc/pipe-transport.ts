/**
 * Cross-platform named-pipe / Unix-socket transport for the RPC side-channel.
 *
 * Platform behaviour:
 *   Unix  — Unix domain socket at /tmp/<name>.sock
 *   Win32 — TCP loopback on a random ephemeral port.
 *           Bun's Windows named-pipe server is broken (Bun issues #11820,
 *           #13042, #14329 — both backslash and forward-slash forms fail on
 *           the server side). The port number IS the "name" passed via
 *           --rpc-pipe, so only a single CLI arg is needed on all platforms.
 *
 * Master is always the SERVER (listens before spawning child).
 * Child is always the CLIENT (connects after its own startup).
 *
 * Single CLI arg contract:
 *   Unix:    --rpc-pipe /tmp/omp-rpc-<id>.sock   (socket file path)
 *   Windows: --rpc-pipe 54321                     (TCP port number)
 */

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";

// ── Name/path generation ─────────────────────────────────────────────────────

export function genPipeName(): string {
	if (process.platform === "win32") {
		// Will be replaced by the actual port once the server is created
		return `omp-rpc-${Snowflake.generate()}`;
	}
	return path.join(os.tmpdir(), `omp-rpc-${Snowflake.generate()}.sock`);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipeServer {
	/** Single CLI arg value to pass to child: socket path (Unix) or port number as string (Windows). */
	childArg: string;
	/** Resolves when the first client connects. */
	waitForClient(): Promise<PipeSocket>;
	/** Shut down the server. */
	close(): void;
}

export interface PipeSocket {
	readLines(): AsyncGenerator<unknown>;
	writeFrame(obj: object): void;
	destroy(): void;
}

// ── Server (master side) ──────────────────────────────────────────────────────

export function createPipeServer(): Promise<PipeServer> {
	if (process.platform === "win32") {
		return createTcpServer();
	}
	return createUnixServer();
}

function createUnixServer(): Promise<PipeServer> {
	const sockPath = path.join(os.tmpdir(), `omp-rpc-${Snowflake.generate()}.sock`);
	try { fs.unlinkSync(sockPath); } catch { /* stale socket ok */ }

	return new Promise((resolve, reject) => {
		const server = net.createServer();
		const { promise: clientPromise, resolve: clientResolve, reject: clientReject } =
			Promise.withResolvers<PipeSocket>();

		server.once("connection", (socket) => clientResolve(wrapSocket(socket)));
		server.once("error", (err) => { clientReject(err); reject(err); });

		server.listen(sockPath, () => {
			resolve({
				childArg: sockPath,
				waitForClient: () => clientPromise,
				close() { server.close(); try { fs.unlinkSync(sockPath); } catch { /* ok */ } },
			});
		});
	});
}

function createTcpServer(): Promise<PipeServer> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		const { promise: clientPromise, resolve: clientResolve, reject: clientReject } =
			Promise.withResolvers<PipeSocket>();

		server.once("connection", (socket) => {
			logger.debug("[pipe-transport] TCP client connected");
			clientResolve(wrapSocket(socket));
		});
		server.once("error", (err) => { clientReject(err); reject(err); });

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as net.AddressInfo;
			logger.debug("[pipe-transport] TCP server listening", { port: addr.port });
			// The port IS the pipe name on Windows — no separate --rpc-port arg needed
			resolve({
				childArg: String(addr.port),
				waitForClient: () => clientPromise,
				close() { server.close(); },
			});
		});
	});
}

// ── Client (child side) ───────────────────────────────────────────────────────

/**
 * Connect using the single --rpc-pipe arg value.
 *   Numeric string → TCP loopback port (Windows fallback)
 *   Path string    → Unix domain socket
 */
export function connectToPipe(arg: string): Promise<PipeSocket> {
	return new Promise((resolve, reject) => {
		const port = parseInt(arg, 10);
		logger.debug("[pipe-transport] child connecting", { arg, usingTcp: !isNaN(port) });
		const socket = !isNaN(port)
			? net.connect({ host: "127.0.0.1", port })
			: net.connect(arg);

		socket.once("connect", () => {
			logger.debug("[pipe-transport] child connected to pipe");
			resolve(wrapSocket(socket));
		});
		socket.once("error", (err) => {
			logger.error("[pipe-transport] child connection error", { err: String(err) });
			reject(err);
		});
	});
}

// ── Socket wrapper ────────────────────────────────────────────────────────────

function wrapSocket(socket: net.Socket): PipeSocket {
	return {
		async *readLines(): AsyncGenerator<unknown> {
			let buf = "";
			for await (const chunk of socket) {
				buf += (chunk as Buffer).toString("utf8");
				for (;;) {
					const nl = buf.indexOf("\n");
					if (nl === -1) break;
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					try { yield JSON.parse(line); } catch { /* ignore malformed frames */ }
				}
			}
		},
		writeFrame(obj: object) { socket.write(`${JSON.stringify(obj)}\n`); },
		destroy() { socket.destroy(); },
	};
}

// ── Spawn command builder (used by RpcClient) ────────────────────────────────

/**
 * Build the process command array for spawning a child agent.
 *
 * - JS/TS modules (`cliPath` ends in .js/.ts): prefix with "bun"; mode args injected.
 * - Shell executables (batch files, .exe, scripts): run directly; no mode args.
 * - On Windows: normalises backslashes to forward slashes.
 * - On Windows: if command is `cmd.exe /c <something>` (not already `start`),
 *   injects `start ""` so the child opens in a visible console window.
 */
export function buildSpawnCmd(
	cliPath: string,
	args: string[],
	options: { isBunModule: boolean; headedMode: boolean },
): string[] {
	const { isBunModule, headedMode } = options;
	const raw = isBunModule ? ["bun", cliPath, ...args] : [cliPath, ...args];
	// Normalize path separators — Bun.spawn on Windows handles forward slashes fine
	const cmd = raw.map(s => s.replace(/\\/g, "/"));
	// On Windows, inject `start ""` after `cmd.exe /c` (if not already present) so the
	// child process opens in a new visible console window instead of running hidden.
	if (
		!isBunModule &&
		process.platform === "win32" &&
		cmd[0]?.toLowerCase().endsWith("cmd.exe") &&
		cmd[1] === "/c" &&
		cmd[2] !== "start"
	) {
		cmd.splice(2, 0, "start", "");
	}
	void headedMode; // reserved for future use (currently affects stdin/stdout in caller)
	return cmd;
}

// ── RpcTransport — pluggable I/O channel for RpcClient ───────────────────────

/**
 * Abstraction over the I/O channel RpcClient uses to communicate with the child.
 * Implement this to replace stdin/stdout with any other transport (e.g. pipe socket).
 * Pass an instance as the second argument to `new RpcClient(options, transport)`.
 */
export interface RpcTransport {
	/** Async iterable of parsed JSONL frames from the child. */
	getLines(): AsyncGenerator<unknown>;
	/** Write a JSONL frame to the child. */
	writeFrame(obj: object): void;
	/** Tear down the transport and fire exit handlers. */
	destroy(): void;
	/** PID of the child process (if known). */
	readonly childPid: number | null;
	/** Register a callback fired on disconnect or explicit destroy(). */

	onExit(handler: (code: number | null) => void): void;
	/** Called by RpcClient when the ready frame arrives (allows transport to capture pid). */
	onReadyFrame(data: Record<string, unknown>): void;
	/** Fire all registered exit handlers (called by RpcClient on stream end/error). */
	fireExitHandlers(code: number | null): void;
}

// ── PipeConnection — RpcTransport over a named pipe / TCP socket ─────────────

/**
 * Encapsulates the pipe side-channel: socket I/O, child PID, and exit callbacks.
 * Implements `RpcTransport` so it can be injected directly into RpcClient.
 */
export class PipeConnection implements RpcTransport {
	readonly socket: PipeSocket;
	readonly process: import("@oh-my-pi/pi-utils").ptree.ChildProcess;
	#childPid: number | null = null;
	#exitHandlers: Array<(code: number | null) => void> = [];

	private constructor(
		proc: import("@oh-my-pi/pi-utils").ptree.ChildProcess,
		socket: PipeSocket,
	) {
		this.process = proc;
		this.socket = socket;
	}

	/** Spawn a child process and establish the pipe side-channel. */
	static async create(
		cmd: string[],
		options: { cwd?: string; env?: Record<string, string>; isBunModule: boolean; headedMode: boolean },
	): Promise<PipeConnection> {
		const { ptree } = await import("@oh-my-pi/pi-utils");
		const server = await createPipeServer();
		cmd.push("--rpc-pipe", server.childArg);
		const proc = ptree.spawn(cmd, {
			cwd: options.cwd,
			env: { ...Bun.env, ...options.env },
			stdin: options.isBunModule ? (options.headedMode ? "inherit" : "pipe") : "ignore",
			stdout: options.isBunModule ? (options.headedMode ? "inherit" : "pipe") : "ignore",
		});
		const socket = await server.waitForClient();
		logger.debug("[pipe-transport] pipe client connected");
		server.close();
		return new PipeConnection(proc, socket);
	}

	get childPid(): number | null { return this.#childPid; }
	/** Called by RpcClient on the ready frame — captures the child's pid. */
	onReadyFrame(data: Record<string, unknown>): void {
		if (typeof data.pid === "number") this.#childPid = data.pid;
	}

	onExit(handler: (code: number | null) => void): void { this.#exitHandlers.push(handler); }

	fireExitHandlers(code: number | null): void {
		for (const h of this.#exitHandlers) h(code);
		this.#exitHandlers = [];
	}

	getLines(): AsyncGenerator<unknown> { return this.socket.readLines(); }

	writeFrame(obj: object): void { this.socket.writeFrame(obj); }

	destroy(): void {
		if (this.#childPid) {
			try { process.kill(this.#childPid); } catch { /* already dead */ }
			this.#childPid = null;
		}
		this.socket.destroy();
		this.fireExitHandlers(null);
	}
}