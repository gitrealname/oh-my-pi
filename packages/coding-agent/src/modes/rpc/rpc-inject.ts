/**
 * Generic RPC input-injection command/response types.
 *
 * Extend the base RPC protocol with inject_key / inject_text / inject_slash
 * commands that let any RPC client drive input into a running agent session.
 *
 * In headless mode (--mode rpc): inject_key Escape maps to session.abort();
 * inject_text delivers text as a follow-up prompt; inject_slash schedules a
 * slash command via the event bus.
 *
 * In headed mode (--new --rpc-pipe): handlers call InputController directly so
 * the real keypress path is exercised end-to-end.
 */

export type RpcInjectCommand =
	| { id?: string; type: "inject_key"; key: string }
	| { id?: string; type: "inject_text"; text: string }
	| { id?: string; type: "inject_slash"; command: string };

export type RpcInjectResponse =
	| { id?: string; type: "response"; command: "inject_key"; success: true }
	| { id?: string; type: "response"; command: "inject_text"; success: true }
	| { id?: string; type: "response"; command: "inject_slash"; success: true };

export function isRpcInjectCommand(obj: unknown): obj is RpcInjectCommand {
	if (!obj || typeof obj !== "object") return false;
	const t = (obj as { type?: unknown }).type;
	return t === "inject_key" || t === "inject_text" || t === "inject_slash";
}
