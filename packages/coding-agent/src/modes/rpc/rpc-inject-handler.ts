/**
 * Server-side handler for RPC exec-queue commands.
 *
 * Plugged into rpc-mode.ts via handleRpcExecCommand in the switch default case.
 *
 * Headed mode: when an InputController reference is registered via
 * registerInputController(), keypress steps call it directly so the real
 * onEscape() / onEnter() path is exercised.
 * Headless mode: falls back to session primitives.
 */
import { PIPE_TUI_OUTPUT_CHANNEL } from "../../utils/event-bus";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../task/types";
import type { ExecStepResult, RpcExecEnqueueCommand, RpcExecStep } from "./rpc-inject";
import { isRpcExecCommand } from "./rpc-inject";
import { logger } from "@oh-my-pi/pi-utils";

/** Minimal interface the handler needs from the running agent session. */
export interface InjectHandlerSession {
	abort(): Promise<void> | void;
	sendUserMessage(
		content: Array<{ type: "text"; text: string }>,
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void>;
	eventBus?: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };
	/** No-timeout wait — race against setTimeout externally if needed. */
	waitForIdle?(): Promise<void>;
	/** Subscribe to session events (AgentEvent + compaction events). */
	subscribe?(listener: (event: { type: string }) => void): () => void;
}

/** Optional InputController reference (only set in headed mode). */
let activeInputController: { injectKey(key: string): void; injectText(text: string): void; injectCommand(text: string): void } | null =
	null;

/**
 * Register the live InputController from InteractiveMode (Phase 2 — headed mode).
 * Call this once after InputController is initialised.
 */
export function registerInputController(
	controller: { injectKey(key: string): void; injectText(text: string): void; injectCommand(text: string): void } | null,
): void {
	activeInputController = controller;
}



// ── Slave-side execution queue ────────────────────────────────────────────────


/** Write a frame back through the pipe to the master. Set by rpc-mode.ts. */
let execOutputFn: ((frame: object) => void) | null = null;
export function registerExecOutputFn(fn: ((frame: object) => void) | null): void {
	execOutputFn = fn;
}

/** Dynamic accumulator — slave adds any label it wants. */
type StepSections = Record<string, string[]>;

function emptySections(): StepSections { return {}; }

function append(sec: StepSections, label: string, text: string): void {
	if (!text) return;
	(sec[label] ??= []).push(text);
}

function sectionsToResult(s: StepSections): ExecStepResult["sections"] {
	const r: Record<string, string> = {};
	for (const [k, v] of Object.entries(s)) {
		const joined = v.join("\n");
		if (joined) r[k] = joined;
	}
	return r;
}

function emitStepResult(stepIndex: number, stepType: ExecStepResult["stepType"], sections: StepSections): void {
	if (!execOutputFn) return;
	const remaining = execQueue.steps.length; // steps still pending AFTER this one
	const result: ExecStepResult = {
		type: "exec_step_result",
		stepIndex,
		stepType,
		remaining,
		sections: sectionsToResult(sections),
	};
	logger.debug("[rpc-inject] exec_step_result", { stepIndex, stepType, remaining, sections: Object.keys(result.sections) });
	execOutputFn(result);
}

interface SlaveExecQueue {
	steps: RpcExecStep[];
	stepIndex: number;
	running: boolean;
	abort: AbortController | null;
}

const execQueue: SlaveExecQueue = { steps: [], stepIndex: 0, running: false, abort: null };

/** Convert an RpcExecStep to the raw text submitted via editor.onSubmit. */
function stepToEditorText(step: RpcExecStep): string | null {
	switch (step.type) {
		case "prompt":   return step.text;
		case "slash":    return step.command.startsWith("/") ? step.command : `/${step.command}`;
		case "bash":     return `!${step.command}`;
		case "bash_x":   return `!!${step.command}`;
		case "python":   return `$${step.code}`;
		case "python_x": return `$$${step.code}`;
		default:         return null;
	}
}

/** Run one step, accumulate sections, emit one exec_step_result frame. */
async function runStep(
	step: RpcExecStep,
	stepIndex: number,
	session: InjectHandlerSession,
	abort: AbortController,
): Promise<void> {
	if (abort.signal.aborted) return;
	const sec = emptySections();
	// Quiet-period callback — set in the await block, called by event handlers.
	let onEvent: (() => void) | undefined;

	// Register tui_output listener before executing (captures showError/showWarning/showStatus).
	// Routed through PIPE_TUI_OUTPUT_CHANNEL → rpc-mode → tui_output frame → back to master,
	// but we also need slave-local capture. We use the session.subscribe path for session events.

	if (step.type === "sleep") {
		await new Promise<void>(resolve => {
			const t = setTimeout(resolve, step.ms);
			abort.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
		});
		emitStepResult(stepIndex, "sleep", sec);
		return;
	}

	if (step.type === "keypress") {
		for (const key of step.keys) {
			if (abort.signal.aborted) break;
			if (activeInputController) activeInputController.injectKey(key);
			else if (key === "\x1b") void session.abort();
		}
		emitStepResult(stepIndex, "keypress", sec);
		return;
	}

	const text = stepToEditorText(step);
	if (!text || !activeInputController) {
		append(sec, 'error', "No input controller available"); onEvent?.();
		emitStepResult(stepIndex, step.type, sec);
		return;
	}

	const timeoutMs = (step as { timeoutMs?: number }).timeoutMs ?? 60_000;

	// Capture llm_input for prompt steps
	if (step.type === "prompt") append(sec, 'llm_input', step.text); onEvent?.();
	if (step.type === "slash")  append(sec, 'llm_input', step.command); onEvent?.();
	if (step.type === "bash")   append(sec, 'bash_visible', `$ ${step.command}`); onEvent?.();
	if (step.type === "bash_x") append(sec, 'bash_invisible', `$ ${step.command}`); onEvent?.();
	if (step.type === "python")   append(sec, 'eval_visible', step.code); onEvent?.();
	if (step.type === "python_x") append(sec, 'eval_invisible', step.code); onEvent?.();

	// Subscribe to session events to collect all output channels
	const unsub = session.subscribe?.((event) => {
		const e = event as Record<string, unknown>;
		if (e.type === "turn_end") {
			// LLM output text
			const msg = e.message as { content?: unknown } | undefined;
			const llmText = Array.isArray(msg?.content)
				? (msg!.content as Array<{ type: string; text?: string }>)
					.filter(b => b.type === "text").map(b => b.text ?? "").join("")
				: typeof msg?.content === "string" ? msg.content : "";
			if (llmText) append(sec, 'llm_output', llmText); onEvent?.();
		}
		if (e.type === "message_update") {
			// Capture streaming LLM text delta — includes subagent output as it streams.
			const assistantEvent = (e as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
			if (assistantEvent?.type === "text_delta" && assistantEvent.delta) {
				append(sec, 'llm_output', assistantEvent.delta); onEvent?.();
			}
		}
		if (e.type === "tool_execution_end") {
			const toolEvent = e as { toolName?: string; result?: { content?: Array<{ type: string; text?: string }> }; isError?: boolean };
			const toolText = toolEvent.result?.content
				?.filter(b => b.type === "text").map(b => b.text ?? "").join("") ?? "";
			if (toolText) {
				const prefix = toolEvent.isError ? `[${toolEvent.toolName}:error]` : `[${toolEvent.toolName}]`;
				append(sec, 'tool_output', `${prefix} ${toolText}`); onEvent?.();
			}
		}
		if (e.type === "tool_execution_start") {
			const t = e as { toolName?: string };
			if (t.toolName) append(sec, 'tool_output', `[${t.toolName}:start]`); onEvent?.();
		}
		if (e.type === "tool_execution_update") {
			const t = e as { toolName?: string; content?: Array<{ type: string; text?: string }> };
			const txt = t.content?.filter(b => b.type === "text").map(b => b.text ?? "").join("") ?? "";
			if (txt) append(sec, 'tool_output', `[${t.toolName}:update] ${txt}`); onEvent?.();
		}
		// tui_output (showError/showWarning/showStatus) is emitted to PIPE_TUI_OUTPUT_CHANNEL on slave
		// and forwarded to master via pipe — NOT a session event. Remove dead check here.
	});
	// Subscribe to PIPE_TUI_OUTPUT_CHANNEL DIRECTLY on slave's eventBus for warning/error capture.
	const unsubTui = session.eventBus?.on(PIPE_TUI_OUTPUT_CHANNEL, (data) => {
		const d = data as { level?: string; text?: string };
		if (d.text) append(sec, 'error', `[${d.level ?? "status"}] ${d.text}`); onEvent?.();
	});
	// Subagent progress (task tool running bash, etc.) — shows ⏳ Task progress in slave TUI.
	const unsubProgress = session.eventBus?.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (data) => {
		const d = data as { agent?: string; progress?: { state?: string; outputLines?: number } };
		const state = d.progress?.state ?? "";
		if (d.agent && state) append(sec, 'tool_output', `[task:${d.agent}] ${state}`); onEvent?.();
	});
	const unsubLifecycle = session.eventBus?.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (data) => {
		const d = data as { agent?: string; status?: string };
		if (d.agent && d.status) append(sec, 'tool_output', `[task:${d.agent}:${d.status}]`); onEvent?.();
	});

	await new Promise<void>(resolve => {
		let done = false;
		const finish = () => { if (!done) { done = true; clearTimeout(timer); unsub?.(); unsubTui?.(); unsubProgress?.(); unsubLifecycle?.(); resolve(); } };
		const timer = setTimeout(() => {
			// Timeout: inject ESC to abort any running task.
			// Delay finish by 2s so tool_execution_end (error response) can be captured.
			logger.debug("[rpc-inject] exec step timeout, injecting ESC", { stepType: step.type });
			if (activeInputController) activeInputController.injectKey("\x1b");
			else void session.abort();
			setTimeout(finish, 2000); // 2s drain window after ESC
		}, timeoutMs);
		abort.signal.addEventListener("abort", finish, { once: true });
		// Quiet-period completion: finish() fires 1s after the last event from any channel.
		// This handles both:
		//  - UI-only slash commands (showStatus → tui_output event → quiet 1s → done)
		//  - LLM steps (streaming events → agent_end → quiet 1s → done)
		// Start with 3s initial quiet to let async execution begin; events reset to 1s.
		let quietTimerId: NodeJS.Timeout | undefined;
		const resetQuiet = (shortDelay = false) => {
			if (quietTimerId) clearTimeout(quietTimerId);
			quietTimerId = setTimeout(finish, shortDelay ? 1000 : 3000);
		};
		// Wire resetQuiet into all event captures (need to call it from within handlers)
		// We do this by wrapping: after injectCommand, start quiet monitoring.
		onEvent = () => resetQuiet(true);
		setTimeout(resetQuiet, 0); // initial 3s quiet — extended by any event
		// ── Look-ahead: scan remaining queue before submitting ──────────────────
		// If sleep→keypress found: schedule them to fire concurrently while this step awaits.
		const lookAhead = execQueue.steps.slice(); // snapshot — don't mutate yet
		// Schedule concurrent sleep→keypress sequences from the front of the lookahead
		let lookaheadMs = 0;
		let i = 0;
		while (i < lookAhead.length) {
			const s = lookAhead[i];
			if (s.type === "sleep") {
				lookaheadMs += s.ms;
				i++;
		} else if (s.type === "keypress") {
				// Consume this sleep+keypress chain concurrently.
				// Capture indices BEFORE the setTimeout closure for correct step numbering.
				const sleepSteps = lookAhead.slice(0, i).filter(ls => ls.type === "sleep");
				const sleepBaseIdx = execQueue.stepIndex + i - sleepSteps.length;
				const keypressIdx = execQueue.stepIndex + i;
				const keys = (s as { keys: string[] }).keys;
				const delayMs = lookaheadMs;
				setTimeout(() => {
					if (abort.signal.aborted || done) return;
					logger.debug("[rpc-inject] lookahead keypress", { delay: delayMs, count: keys.length });
					// Emit exec_step_result for each consumed sleep step
					sleepSteps.forEach((_, si) => {
						const sec = emptySections();
						emitStepResult(sleepBaseIdx + si, "sleep", sec);
					});
					// Inject the keypresses
					for (const key of keys) {
						if (activeInputController) activeInputController.injectKey(key);
						else if (key === "\x1b") void session.abort();
					}
					// Emit exec_step_result for the keypress step
					const kSec = emptySections();
					emitStepResult(keypressIdx, "keypress", kSec);
					// Remove the consumed sleep+keypress steps from the live queue
					const consumed = new Set([s, ...lookAhead.slice(0, i)]);
					execQueue.steps = execQueue.steps.filter(qs => !consumed.has(qs));
				}, delayMs);
				lookaheadMs = 0;
				i++;
			} else {
				break; // non-sleep/keypress step: stop lookahead
			}
		}
		// Submit the step text after lookahead is set up
		activeInputController!.injectCommand(text);
	});

	emitStepResult(stepIndex, step.type, sec);
}

async function runQueue(session: InjectHandlerSession): Promise<void> {
	if (execQueue.running) return;
	execQueue.running = true;
	try {
		while (execQueue.steps.length > 0) {
			const step = execQueue.steps.shift()!;
			const index = execQueue.stepIndex++;
			const abort = new AbortController();
			execQueue.abort = abort;
			logger.debug("[rpc-inject] exec step", { type: step.type, index });
			await runStep(step, index, session, abort);
			execQueue.abort = null;
			if (abort.signal.aborted) break;
		}
	} finally {
		execQueue.running = false;
		execQueue.abort = null;
		// Restart if an interrupt enqueued new steps while we were aborting.
		if (execQueue.steps.length > 0) void runQueue(session);
	}
}

/**
 * Handle exec_enqueue commands from the master.
 *
 * Interrupt step semantics: when an `interrupt` step is found in the batch,
 * it is NOT pushed into the queue. Instead, inline:
 *   1. All steps before it in this batch are discarded.
 *   2. The currently running step is aborted and existing queue is cleared.
 *   3. Steps after the interrupt in this batch are enqueued normally.
 *   4. One exec_step_result (stepType="interrupt") is emitted immediately
 *      with remaining = count of post-interrupt steps.
 *
 * Counter examples:
 *   int               → remaining=0 (nothing queued after)
 *   int|prompt|sleep  → remaining=2 (prompt+sleep queued after)
 *   prompt|int        → prompt dropped, remaining=0
 */
export async function handleRpcExecCommand(
	raw: unknown,
	session: InjectHandlerSession,
	success: (id: string | undefined, command: string, data?: object | null) => unknown,
	error: (id: string | undefined, command: string, message: string) => unknown,
): Promise<unknown> {
	if (!isRpcExecCommand(raw)) return null;
	const cmd = raw as RpcExecEnqueueCommand;
	const id = cmd.id;

	const steps = cmd.steps;
	const interruptIdx = steps.findIndex(s => s.type === "interrupt");

	if (interruptIdx !== -1) {
		const droppedFromBatch = interruptIdx;
		const previouslyQueued = execQueue.steps.length;
		const totalCleared = previouslyQueued + droppedFromBatch;
		const stepsAfter = steps.slice(interruptIdx + 1);

		// Clear existing queue and abort any running step.
		execQueue.steps = [];
		execQueue.abort?.abort();

		// Enqueue post-interrupt steps so emitStepResult reads correct remaining.
		execQueue.steps.push(...stepsAfter);

		logger.debug("[rpc-inject] interrupt step", { totalCleared, stepsAfter: stepsAfter.length });
		const sec = emptySections();
		append(sec, 'error', `Interrupted: ${totalCleared} pending step(s) cleared.`);
		emitStepResult(execQueue.stepIndex++, "interrupt", sec);

		// runQueue is guarded by running flag; if currently running it will
		// restart from its finally block when the aborted step resolves.
		if (!execQueue.running) void runQueue(session);
		return success(id, "exec_enqueue", { queued: stepsAfter.length });
	}

	execQueue.steps.push(...steps);
	logger.debug("[rpc-inject] exec_enqueue", { count: steps.length, total: execQueue.steps.length });
	void runQueue(session);
	return success(id, "exec_enqueue", { queued: steps.length });
}
