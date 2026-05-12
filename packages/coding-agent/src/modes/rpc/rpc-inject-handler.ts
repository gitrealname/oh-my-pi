/**
 * Server-side handler for RPC input-injection commands.
 *
 * Plugged into rpc-mode.ts via a single call in the switch default case —
 * zero other changes to core RPC files.
 *
 * Headed mode: when an InputController reference is registered via
 * registerInputController(), inject_key calls it directly so the real
 * onEscape() / onEnter() path is exercised.
 * Headless mode: falls back to session primitives.
 */
import { SCHEDULE_SLASH_CHANNEL } from "../../utils/event-bus";
import type { RpcInjectCommand, RpcInjectResponse } from "./rpc-inject";
import { isRpcInjectCommand } from "./rpc-inject";
import { logger } from "@oh-my-pi/pi-utils";

/** Minimal interface the handler needs from the running agent session. */
export interface InjectHandlerSession {
	abort(): Promise<void> | void;
	sendUserMessage(
		content: Array<{ type: "text"; text: string }>,
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void>;
	eventBus?: { emit(channel: string, data: unknown): void };
}

/** Optional InputController reference (only set in headed mode). */
let activeInputController: { injectKey(key: string): void; injectText(text: string): void; injectCommand(text: string): void } | null =
	null;

/**
 * Register the live InputController from InteractiveMode (Phase 2 — headed mode).
 * Call this once after InputController is initialised.
 */
export function registerInputController(
	controller: { injectKey(key: string): void; injectText(text: string): void } | null,
): void {
	activeInputController = controller;
}

type SuccessFn = (id: string | undefined, command: string, data?: object | null) => RpcInjectResponse;
type ErrorFn = (id: string | undefined, command: string, message: string) => RpcInjectResponse;

/**
 * Handle an RPC inject command. Returns the response if the command was
 * recognised, or null if it was not (so the caller can fall through to its
 * own unknown-command error).
 */
export async function handleRpcInjectCommand(
	raw: unknown,
	session: InjectHandlerSession,
	success: SuccessFn,
	error: ErrorFn,
	eventBus?: { emit(channel: string, data: unknown): void },
): Promise<RpcInjectResponse | null> {
	if (!isRpcInjectCommand(raw)) return null;
	const command = raw as RpcInjectCommand;
	const id = command.id;
	logger.debug("[rpc-inject] received", { type: command.type });

	try {
		switch (command.type) {
			case "inject_key": {
				const key = command.key;
				if (activeInputController) {
					logger.debug("[rpc-inject] inject_key → inputController", { key: JSON.stringify(key) });
					activeInputController.injectKey(key);
				} else if (key === "\x1b" || key.toLowerCase() === "escape") {
					logger.debug("[rpc-inject] inject_key → session.abort() (headless fallback)");
					void session.abort();
				} else {
					logger.debug("[rpc-inject] inject_key → no-op (headless, non-ESC key)", { key: JSON.stringify(key) });
				}
				return success(id, "inject_key");
			}

			case "inject_text": {
				if (activeInputController) {
					logger.debug("[rpc-inject] inject_text → inputController");
					activeInputController.injectText(command.text);
				} else {
					logger.debug("[rpc-inject] inject_text → sendUserMessage (headless fallback)");
					await session.sendUserMessage([{ type: "text", text: command.text }], {
						deliverAs: "followUp",
					});
				}
				return success(id, "inject_text");
			}

		case "inject_slash": {
			if (activeInputController) {
				// Headed mode: submit via editor.onSubmit — TUI handles /commands natively
				logger.debug("[rpc-inject] inject_slash → injectCommand", { command: command.command });
				activeInputController.injectCommand(command.command);
			} else {
				// Headless fallback: schedule via event bus
				const bus = eventBus ?? session.eventBus;
				logger.debug("[rpc-inject] inject_slash → eventBus", { command: command.command, hasEventBus: !!bus });
				if (bus) bus.emit(SCHEDULE_SLASH_CHANNEL, command.command);
			}
			return success(id, "inject_slash");
		}
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.error("[rpc-inject] error handling command", { type: command.type, err: msg });
		return error(id, command.type, msg) as RpcInjectResponse;
	}
}
