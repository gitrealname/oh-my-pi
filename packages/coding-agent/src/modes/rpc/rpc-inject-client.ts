import type { ExecStepResult, RpcExecStep } from "./rpc-inject";

/**
 * Client-side extensions for RpcClient — exec queue and event subscriptions.
 *
 * Usage:
 *   const base = new RpcClient(options);
 *   const client = new RpcInjectClient(base);
 *   await client.start();
 *   await client.enqueueExec([{ type: "prompt", text: "...", timeoutMs: 60_000 }]);
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
	/**
	 * Subscribe to tui_output events emitted by a headed+pipe slave TUI
	 * (showStatus / showError / showWarning forwarded through the RPC pipe).
	 * Filters the generic onEvent stream — zero changes needed in upstream RpcClient
	 * beyond adding "tui_output" to agentEventTypes.
	 */
	onTuiOutput(listener: (event: { level: "status" | "error" | "warning"; text: string }) => void): () => void {
		return this.#client.onEvent((event) => {
			const e = event as unknown as { type: string; level?: string; text?: string };
			if (e.type === "tui_output" && e.level && e.text) {
				listener({ level: e.level as "status" | "error" | "warning", text: e.text });
			}
		});
	}

	/**
	 * Subscribe to exec_step_result frames from the slave.
	 * The slave sends exactly ONE frame per enqueued step (including interrupt steps).
	 * Returns an unsubscribe function.
	 */
	onExecStepResult(listener: (result: ExecStepResult) => void): () => void {
		return this.#client.onEvent((event) => {
			const e = event as unknown as { type: string };
			if (e.type === "exec_step_result") {
				listener(e as unknown as ExecStepResult);
			}
		});
	}
	// onExit/childPid live on RpcPipeClient (subclass); delegate when present
	get onExit() {
		const fn = (this.#client as unknown as { onExit?: (h: (c: number | null) => void) => void }).onExit;
		return fn ? fn.bind(this.#client) : (_h: (c: number | null) => void) => {};
	}


	/**
	 * Enqueue steps on the slave's execution queue.
	 * Steps run sequentially; new steps are appended if the queue is busy.
	 * When an `interrupt` step is included, the slave handles it inline:
	 * aborts current, clears queue, enqueues only the steps after the interrupt.
	 */
	async enqueueExec(steps: RpcExecStep[]): Promise<{ queued: number }> {
		const resp = await this.#client._sendCommand({ type: "exec_enqueue", steps }) as { data?: { queued: number } };
		return (resp as unknown as { data: { queued: number } }).data ?? { queued: steps.length };
	}
}
