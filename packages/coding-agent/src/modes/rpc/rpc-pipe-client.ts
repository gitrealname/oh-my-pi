/**
 * RpcPipeClient — extends RpcClient with named-pipe / TCP side-channel transport.
 *
 * The child process is spawned with --rpc-pipe <port/path> and communicates via
 * a TCP socket (Windows) or Unix domain socket (Unix) instead of stdin/stdout.
 * All RPC protocol logic (commands, events, tools) stays in the base RpcClient.
 *
 * Usage:
 *   const client = new RpcPipeClient({ cliPath: "cmd.exe", args: ["/c", "ow", "--new"] });
 *   const inject = new RpcInjectClient(client);
 *   await client.start();
 *   client.onExit(() => { ... });
 */
import type { RpcCommand, RpcHostToolResult, RpcHostToolUpdate } from "./rpc-types";
import { RpcClient, type RpcClientOptions } from "./rpc-client";
import { PipeConnection, buildSpawnCmd } from "./pipe-transport";

export class RpcPipeClient extends RpcClient {
	#conn: PipeConnection | null = null;

	/**
	 * Start: spawn child with --rpc-pipe, wait for connection, run ready handshake.
	 * Overrides start() — does not call super.start() since spawn path is different.
	 */
	override async start(): Promise<void> {
		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const isBunModule = /\.[jt]s$/.test(cliPath);

		const args: string[] = [];
		if (isBunModule) args.push("--mode", "rpc");
		if (this.options.provider) args.push("--provider", this.options.provider);
		if (this.options.model) args.push("--model", this.options.model);
		if (this.options.sessionDir) args.push("--session-dir", this.options.sessionDir);
		if (this.options.args) args.push(...this.options.args);

		const cmd = buildSpawnCmd(cliPath, args, { isBunModule, headedMode: false });
		this.#conn = await PipeConnection.create(cmd, {
			isBunModule,
			headedMode: false,
			cwd: this.options.cwd,
			env: this.options.env,
		});

		this.process = this.#conn.process;
		await this._startHandshake(this.#conn.getLines(), true);
	}

	/** Capture child pid from ready frame. */
	protected override _onReadyFrame(data: Record<string, unknown>): void {
		this.#conn?.onReadyFrame(data);
	}

	/** Route all writes through the pipe socket. */
	protected override writeFrame(
		frame: RpcCommand | RpcHostToolResult | RpcHostToolUpdate,
		_onError?: (error: Error) => void,
	): void {
		this.#conn?.writeFrame(frame);
	}

	override stop(): void {
		this.#conn?.destroy();
		this.#conn = null;
		super.stop();
	}

	/** PID of the actual child process (from the pipe ready frame). */
	get childPid(): number | null { return this.#conn?.childPid ?? null; }

	/**
	 * Register a callback fired when the child process exits or the pipe closes.
	 * Also fires on explicit stop().
	 */
	onExit(handler: (code: number | null) => void): void {
		this.#conn?.onExit(handler);
	}
}
