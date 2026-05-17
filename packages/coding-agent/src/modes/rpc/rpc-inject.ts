/**
 * RPC input-injection command/response types.
 *
 * In headed mode (--new --rpc-pipe): InputController is called directly so
 * the real keypress path is exercised end-to-end.
 */

// ── Slave-side execution queue protocol ──────────────────────────────────────

/**
 * A single step in a slave-side execution queue.
 * All text-based steps are submitted via editor.onSubmit — the TUI routes
 * based on the prefix exactly as user input would be.
 *
 * - prompt:    plain text → LLM turn (awaits turn_end or timeout)
 * - slash:     /cmd → slash command handler (awaits tui_output or timeout)
 * - bash:      !cmd → bash, included in context (awaits tool_execution_end or timeout)
 * - bash_x:    !!cmd → bash, excluded from context (awaits tool_execution_end or timeout)
 * - python:    $code → Python in shared kernel, included in context
 * - python_x:  $$code → Python, excluded from context
 * - keypress:  pre-resolved raw key bytes, injected immediately (no wait)
 * - sleep:     pause N ms before next step
 * - interrupt: abort current step, clear queue, enqueue any steps that follow it
 */
export type RpcExecStep =
	| { type: "prompt";    text: string;    timeoutMs: number }
	| { type: "slash";     command: string; timeoutMs: number }
	| { type: "bash";      command: string; timeoutMs: number }
	| { type: "bash_x";    command: string; timeoutMs: number }
	| { type: "python";    code: string;    timeoutMs: number }
	| { type: "python_x";  code: string;    timeoutMs: number }
	| { type: "keypress";  keys: string[] }
	| { type: "sleep";     ms: number }
	| { type: "interrupt" };

/**
 * One response frame per executed step — slave → master.
 * sections is a dynamic label→text map. Slave adds whatever labels have content.
 * Master iterates whatever it receives — no coordination needed on label names.
 * Common labels: error, llm_input, llm_output, tool_output, bash_visible,
 * bash_invisible, eval_visible, eval_invisible, task_progress, task_lifecycle
 */
export type ExecStepResult = {
	type: "exec_step_result";
	stepIndex: number;
	stepType: RpcExecStep["type"] | "startup";
	/** Steps still pending after this one. Master sets counter = remaining. 0 = done. */
	remaining: number;
	/** Dynamic label→text. Slave emits any labels; master renders whatever it gets. */
	sections: Record<string, string>;
};

export function isExecStepResult(obj: unknown): obj is ExecStepResult {
	if (!obj || typeof obj !== "object") return false;
	return (obj as { type?: unknown }).type === "exec_step_result";
}

/**
 * Enqueue one or more steps on the slave's execution queue.
 * Steps run sequentially. If the queue is empty and the slave is idle the
 * first step starts immediately; otherwise it is appended.
 *
 * When an `interrupt` step is present in the batch, the slave processes it
 * inline during enqueue: aborts the current step, clears the existing queue,
 * and enqueues only the steps that follow the interrupt in this batch.
 */
export type RpcExecEnqueueCommand = {
	id?: string;
	type: "exec_enqueue";
	steps: RpcExecStep[];
};

export type RpcExecResponse =
	| { id?: string; type: "response"; command: "exec_enqueue"; success: true; queued: number };

export function isRpcExecCommand(obj: unknown): obj is RpcExecEnqueueCommand {
	if (!obj || typeof obj !== "object") return false;
	return (obj as { type?: unknown }).type === "exec_enqueue";
}
