/**
 * Client-side inject extensions for RpcClient.
 *
 * Wraps an existing RpcClient instance and adds injectKey / injectText /
 * injectSlash methods using the minimal _sendCommand escape hatch.
 * Zero structural changes to rpc-client.ts beyond that one method.
 *
 * Usage:
 *   const base = new RpcClient(options);
 *   const client = new RpcInjectClient(base);
 *   await client.start();
 *   await client.prompt("...");
 *   await client.injectKey("Escape");
 */
import type { RpcClient } from "./rpc-client";

/**
 * Wraps an RpcClient and adds input-injection methods.
 * Delegates all standard operations to the wrapped client.
 */
export class RpcInjectClient {
	readonly #client: RpcClient;

	constructor(client: RpcClient) {
		this.#client = client;
	}

	/** Underlying RpcClient for all standard operations. */
	get client(): RpcClient {
		return this.#client;
	}

	// ── Standard RpcClient delegation ───────────────────────────────────────

	get start() { return this.#client.start.bind(this.#client); }
	get stop() { return this.#client.stop.bind(this.#client); }
	get prompt() { return this.#client.prompt.bind(this.#client); }
	get steer() { return this.#client.steer.bind(this.#client); }
	get abort() { return this.#client.abort.bind(this.#client); }
	get waitForIdle() { return this.#client.waitForIdle.bind(this.#client); }
	get getState() { return this.#client.getState.bind(this.#client); }
	get onEvent() { return this.#client.onEvent.bind(this.#client); }
	get promptAndWait() { return this.#client.promptAndWait.bind(this.#client); }
	get bash() { return this.#client.bash.bind(this.#client); }
	get abortBash() { return this.#client.abortBash.bind(this.#client); }
	get setCustomTools() { return this.#client.setCustomTools.bind(this.#client); }
	// onExit/childPid live on RpcPipeClient (subclass); delegate when present
	get onExit() {
		const fn = (this.#client as unknown as { onExit?: (h: (c: number | null) => void) => void }).onExit;
		return fn ? fn.bind(this.#client) : (_h: (c: number | null) => void) => {};
	}

	// ── Inject methods ──────────────────────────────────────────────────────

	/**
	 * Inject a keypress into the child session.
	 * Headed mode: triggers the real InputController path (onEscape → abortTask etc.).
	 * Headless mode: "Escape"/"\x1b" maps to session.abort(); others are no-ops.
	 */
	async injectKey(key: string): Promise<void> {
		await this.#client._sendCommand({ type: "inject_key", key });
	}

	/**
	 * Inject text into the child session.
	 * Headed mode: types into the editor component.
	 * Headless mode: delivers as a follow-up prompt.
	 */
	async injectText(text: string): Promise<void> {
		await this.#client._sendCommand({ type: "inject_text", text });
	}

	/**
	 * Schedule a slash command in the child session (e.g. "/mreview /path").
	 * Routed via the session event bus in both headed and headless mode.
	 */
	async injectSlash(command: string): Promise<void> {
		await this.#client._sendCommand({ type: "inject_slash", command });
	}
}
