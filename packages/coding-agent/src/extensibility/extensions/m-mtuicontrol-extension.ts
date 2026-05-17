/**
 * mtuicontrol — programmatic TUI/RPC session control.
 *
 * spawn     --cmd <full command>              user owns full command; --rpc-pipe <port> appended
 * prompt    [id] [--timeout N] <message...>  send prompt, wait for full response, return it
 * keypress  [id] <ESC><CTRL-C>...            inject keyboard sequences (headed: real keypress path)
 * command   [id] <slash command>             inject slash command into child session
 * exec      [id] <step>[|<step>...]          enqueue steps on slave; result via asyncSubmit/asyncDisplay
 * interrupt [id]                             abort current step, clear queue
 * stop      [id | --all]                     clean shutdown; closes child window(s)
 * list                                       list active session ids
 *
 * [id] defaults to last spawned/used session.
 * wait/wait-idle removed from public API — prompt is now synchronous.
 */
import type { ExtensionFactory } from "./types";
import { RpcPipeClient } from "../../modes/rpc/rpc-pipe-client";
import { RpcInjectClient } from "../../modes/rpc/rpc-inject-client";
import type { RpcExecStep } from "../../modes/rpc/rpc-inject";
import { logger } from "@oh-my-pi/pi-utils";

// ── Slave exec state ─────────────────────────────────────────────────────────

/** Per-slave state for exec queue tracking. Callbacks come from asyncSubmit/asyncDisplay. */
interface SlaveExecState {
	counter: number;
	/** Called per exec_step_result → "!" panel for user visibility while slave is working. */
	display: ((text: string) => void) | null;
	/** Called at counter===0 → scheduleInput → wakes LLM to process "!" panel content. */
	submit: ((text: string) => Promise<void>) | null;
}

const slaveExecStates = new Map<string, SlaveExecState>();

// ── Session pool ──────────────────────────────────────────────────────────────
const sessionPool = new Map<string, RpcInjectClient>();
/** Last assistant text received from each child session — for error surfacing. */
const sessionLastText = new Map<string, string>();
let lastSessionId: string | undefined;

function genId(): string {
	return `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Resolve optional id — defaults to last spawned/used session. */
function resolveSession(id?: string): { client: RpcInjectClient; id: string } | string {
	const target = id ?? lastSessionId;
	if (target) {
		const s = sessionPool.get(target);
		if (s) { lastSessionId = target; return { client: s, id: target }; }
		return `Session "${target}" not found. Active: ${[...sessionPool.keys()].join(", ") || "none"}`;
	}
	if (sessionPool.size === 0) return "No active sessions. Use /mtuicontrol spawn first.";
	// Fall back to the most recently added session
	const fallbackId = [...sessionPool.keys()].at(-1)!;
	lastSessionId = fallbackId;
	return { client: sessionPool.get(fallbackId)!, id: fallbackId };
}

// ── Keyboard sequence parser ──────────────────────────────────────────────────

/**
 * Resolve a key token like "ESC", "CTRL-C", "CTRL-ALT-D", "SHIFT-ENTER" to a terminal escape.
 * - Named keys: ESC, ENTER, TAB, BACKSPACE, F1-F12
 * - CTRL-[A-Z]: computes control code \x01-\x1a dynamically
 * - CTRL-ALT-[A-Z]: sends ESC prefix + CTRL code (common terminal convention)
 * - SHIFT-ENTER, ALT-[char]: documented but terminal-dependent; sent as escape sequences
 */
function resolveKey(name: string): string {
	const n = name.toUpperCase();
	// Named
	const NAMED: Record<string, string> = {
		ESC: "\x1b", ESCAPE: "\x1b",
		ENTER: "\r", RETURN: "\r",
		TAB: "\t",
		BACKSPACE: "\x7f", BS: "\x7f",
		DELETE: "\x1b[3~", DEL: "\x1b[3~",
		UP: "\x1b[A", DOWN: "\x1b[B", RIGHT: "\x1b[C", LEFT: "\x1b[D",
		HOME: "\x1b[H", END: "\x1b[F",
		PGUP: "\x1b[5~", PGDN: "\x1b[6~",
		// Ctrl+Arrow keys (CSI 1;5X format — standard for most terminals incl. Windows Terminal)
		"CTRL-UP": "\x1b[1;5A", "CTRL-DOWN": "\x1b[1;5B",
		"CTRL-RIGHT": "\x1b[1;5C", "CTRL-LEFT": "\x1b[1;5D",
		// Alt+Arrow
		"ALT-UP": "\x1b[1;3A", "ALT-DOWN": "\x1b[1;3B",
		"ALT-RIGHT": "\x1b[1;3C", "ALT-LEFT": "\x1b[1;3D",
		// Shift+Arrow
		"SHIFT-UP": "\x1b[1;2A", "SHIFT-DOWN": "\x1b[1;2B",
		"SHIFT-RIGHT": "\x1b[1;2C", "SHIFT-LEFT": "\x1b[1;2D",
		// F-keys
		F1: "\x1bOP", F2: "\x1bOQ", F3: "\x1bOR", F4: "\x1bOS",
		F5: "\x1b[15~", F6: "\x1b[17~", F7: "\x1b[18~", F8: "\x1b[19~",
		F9: "\x1b[20~", F10: "\x1b[21~", F11: "\x1b[23~", F12: "\x1b[24~",
		// Space and common specials
		SPACE: " ",
	};
	if (NAMED[n]) return NAMED[n];
	// CTRL-[A-Z] → \x01-\x1a
	const ctrlMatch = n.match(/^CTRL-([A-Z])$/);
	if (ctrlMatch) return String.fromCharCode(ctrlMatch[1].charCodeAt(0) - 64);
	// CTRL-ALT-[A-Z] → ESC + CTRL code (most terminals)
	const ctrlAltMatch = n.match(/^CTRL-ALT-([A-Z])$/);
	if (ctrlAltMatch) return "\x1b" + String.fromCharCode(ctrlAltMatch[1].charCodeAt(0) - 64);
	// ALT-[char] → ESC + char
	const altMatch = n.match(/^ALT-([A-Z0-9])$/);
	if (altMatch) return "\x1b" + altMatch[1].toLowerCase();
	// SHIFT-ENTER → \x1b[13;2u (Kitty protocol) or \r — terminal-dependent
	if (n === "SHIFT-ENTER") return "\x1b[13;2u";
	// Unknown — return as-is so caller can see it
	return name;
}

/** Parse "<ESC><CTRL-C><CTRL-ALT-D>" into resolved key strings. */
function parseKeySequence(raw: string): string[] {
	const matches = raw.match(/<[A-Z][A-Z0-9-]*>/gi) ?? [];
	return matches.map(m => resolveKey(m.slice(1, -1)));
}

// ── Command handler ───────────────────────────────────────────────────────────

export async function handleMtuicontrol(args: string, asyncSubmit?: (text: string) => Promise<void>, asyncDisplay?: (text: string) => void): Promise<string> {
	const parts = args.trim().split(/\s+/);
	const action = parts[0]?.toLowerCase();
	logger.debug("[mtuicontrol] handle", { action, args: args.slice(0, 100) });

	/** Show msg in "!" (user sees it + LLM sees it via appendCustomResult); wake LLM via setImmediate. */
	const reply = (msg: string, { wake = true } = {}): string => {
		logger.debug("[mtuicontrol] reply", { msg: msg.slice(0, 120), wake });
		asyncDisplay?.(msg);
		// setImmediate: defer so session loop re-registers onInputCallback before wake fires.
		if (wake) setImmediate(() => { void asyncSubmit?.(msg); });
		return "";
	};

	switch (action) {
		case "spawn": {
			// Find --cmd in the raw args string to preserve quoted command lines
			const cmdFlagMatch = args.match(/--cmd\s+(.*)/s);
			if (!cmdFlagMatch) {
				return reply([
					"Usage: /mtuicontrol spawn --cmd <full command line>",
					"  --cmd value is the exact command to run; --rpc-pipe <port> is appended.",
					'Example: /mtuicontrol spawn --cmd "cmd.exe /c start ow --new --no-memory"',
					'Example: /mtuicontrol spawn --cmd "cmd.exe /c ow --new --no-memory"',
				].join("\n"));
			}
			// Strip surrounding quotes if the whole value is quoted
			let cmdLine = cmdFlagMatch[1].trim();
			if ((cmdLine.startsWith('"') && cmdLine.endsWith('"')) ||
				(cmdLine.startsWith("'") && cmdLine.endsWith("'"))) {
				cmdLine = cmdLine.slice(1, -1);
			}
			// Split into argv respecting quoted tokens
			const cmdParts = cmdLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
			if (cmdParts.length === 0) {
				return reply("spawn --cmd requires a command");
			}
			const cliPath = cmdParts[0]!.replace(/^["']|["']$/g, "");
			const cmdArgs = cmdParts.slice(1).map(p => p.replace(/^["']|["']$/g, ""));
			const base = new RpcPipeClient({ cliPath, args: cmdArgs });
			const client = new RpcInjectClient(base);
			try {
				await base.start();
			} catch (e: unknown) {
				return reply(`Failed to spawn: ${e instanceof Error ? e.message : String(e)}`);
			}
			const id = genId();
			sessionPool.set(id, client);
			lastSessionId = id;
			// Initialize exec state — counter=1: startup exec_step_result drives it to 0.
			slaveExecStates.set(id, {
				counter: 1,
				display: asyncDisplay ?? null,
				submit: asyncSubmit ?? null,
			});
			// Register exec_step_result handler: drives counter; fires LLM turn at remaining=0.
			client.onExecStepResult(result => {
				const state = slaveExecStates.get(id);
				if (!state) return;
				const lines: string[] = [`# [${id}] exec ${result.stepType}`];
				for (const [label, val] of Object.entries(result.sections)) {
					if (val) lines.push(`## ${label} ##\n${val}`);
				}
				const formatted = lines.join("\n");
				if (lines.length > 1) state.display?.(formatted);
				state.counter = result.remaining;
				logger.debug("[mtuicontrol] exec_step_result", { id, stepType: result.stepType, remaining: result.remaining });
				if (state.counter === 0) {
					logger.debug("[mtuicontrol] all steps done → LLM turn", { id });
					void state.submit?.("slave(s) responded");
				}
			});
			// Auto-cleanup when child exits unexpectedly (closed window, crash, etc.)
			client.onExit(() => {
				const exitState = slaveExecStates.get(id);
				if (sessionPool.has(id)) {
					sessionPool.delete(id);
					sessionLastText.delete(id);
					if (lastSessionId === id) lastSessionId = [...sessionPool.keys()].at(-1);
					logger.debug("[mtuicontrol] session exited, removed from pool", { id });
				}
				// Pipe/communication error: display to "!", reset counter=0, wake LLM with error message.
				if (exitState) {
					const errMsg = exitState.counter > 0
						? `communication error [${id}] — session exited with ${exitState.counter} step(s) pending`
						: `session [${id}] exited`;
					exitState.display?.(errMsg);
					exitState.counter = 0;
					void exitState.submit?.(errMsg);
				}
				slaveExecStates.delete(id);
			});
			// Capture child turn completions — store last assistant text for surfacing in wait results
			client.onEvent((event) => {
				if (event.type === "turn_end") {
					const msg = (event.message as unknown) as { content?: unknown } | undefined;
					const text = Array.isArray(msg?.content)
						? (msg!.content as Array<{ type: string; text?: string }>).filter(b => b.type === "text").map(b => b.text ?? "").join("")
						: typeof msg?.content === "string" ? msg.content : "";
					if (text) {
						sessionLastText.set(id, text);
						logger.debug("[mtuicontrol] child turn_end", { id, preview: text.slice(0, 120) });
					}
				}
			});
			const childPid = base.childPid;
			logger.debug("[mtuicontrol] spawned", { id, cmd: cmdLine, childPid });
			asyncDisplay?.(`Session ${id} ready.${childPid ? ` (child pid=${childPid})` : ""}`);
			return "";
		}

		case "prompt": {
			const maybeId = parts[1]?.startsWith("rpc-") ? parts[1] : undefined;
			const timeoutIdx = parts.indexOf("--timeout");
			const timeout =
				timeoutIdx !== -1 ? (parseInt(parts[timeoutIdx + 1] ?? "60000", 10) || 60_000) : 60_000;
			const skipCount = (maybeId ? 1 : 0) + (timeoutIdx !== -1 ? 2 : 0);
			const message = parts.slice(1 + skipCount).join(" ");

			if (!message) return reply("Usage: /mtuicontrol prompt [id] [--timeout N] <message...>");
			const r = resolveSession(maybeId);
			if (typeof r === "string") return reply(r);

			// Use promptAndWait — registers agent_end listener BEFORE sending (no race),
			// then collects all events. Extract text from message_update text_delta events.
			let assistantText = "";
			try {
				const events = await r.client.promptAndWait(message, [], timeout);
				for (const event of events) {
					if (event.type === "message_update" &&
						(event as { assistantMessageEvent?: { type: string; delta?: string } })
							.assistantMessageEvent?.type === "text_delta") {
						const delta = (event as { assistantMessageEvent: { delta: string } })
							.assistantMessageEvent.delta;
						if (delta) assistantText += delta;
					}
				}
			const response = assistantText || sessionLastText.get(r.id) || "(no text response)";
			sessionLastText.set(r.id, response);
			logger.debug("[mtuicontrol] prompt ok", { id: r.id, len: response.length });
			return reply(`Child:\n${response}`);
			} catch {
				logger.warn("[mtuicontrol] prompt timed out, injecting ESC", { id: r.id });
				try { await r.client.enqueueExec([{ type: "keypress", keys: ["\x1b"] }]); } catch { /* ignore */ }
				try {
					await r.client.waitForIdle(3_000);
					const response = assistantText || sessionLastText.get(r.id) || "(timed out, no response)";
					sessionLastText.set(r.id, response);
					return reply(`Child (aborted by ESC):\n${response}`);
				} catch {
					r.client.stop();
					sessionPool.delete(r.id);
					sessionLastText.delete(r.id);
					if (lastSessionId === r.id) lastSessionId = [...sessionPool.keys()].at(-1);
					return reply(`Session ${r.id} terminated (unresponsive after ESC).`);
				}
			}
		}

		case "keypress": {
			const maybeId = parts[1];
			const isId = maybeId && sessionPool.has(maybeId);
			const id = isId ? maybeId : undefined;
			const seqStart = isId ? 2 : 1;
			const raw = parts.slice(seqStart).join(" ");

			if (!raw) return reply("Usage: /mtuicontrol keypress [id] <ESC><ENTER><CTRL-C>...");
			const r = resolveSession(id);
			if (typeof r === "string") return reply(r);
			try {
				const keys = parseKeySequence(raw);
				if (keys.length === 0) return reply(`No valid key tokens in: ${raw}`);
				const state = slaveExecStates.get(r.id);
				if (state) state.counter = 1;
				await r.client.enqueueExec([{ type: "keypress", keys }]);
				asyncDisplay?.(`Injected ${keys.length} key(s).`);
				return "";
			} catch (e: unknown) {
				return reply(`keypress failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		case "command": {
			// Inject a slash command into the child session (mirrors mcommand)
			const maybeId = parts[1];
			const isId = maybeId && sessionPool.has(maybeId);
			const id = isId ? maybeId : undefined;
			const cmdStart = isId ? 2 : 1;
			const cmd = parts.slice(cmdStart).join(" ");

			if (!cmd) return reply("Usage: /mtuicontrol command [id] <slash command>");
			const r = resolveSession(id);
			if (typeof r === "string") return reply(r);
			const slashCmd = cmd.startsWith("/") ? cmd : `/${cmd}`;
			try {
				const state = slaveExecStates.get(r.id);
				if (state) state.counter = 1;
				await r.client.enqueueExec([{ type: "slash", command: slashCmd, timeoutMs: 60_000 }]);
				asyncDisplay?.(`Command "${slashCmd}" scheduled.`);
				return "";
			} catch (e: unknown) {
				return reply(`command failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		case "exec": {
			// Parse: [id] <step>[|<step>...]
			// step format: type:body[:timeoutMs]   escape \| for literal pipe, \: for literal colon
			const maybeId = parts[1];
			const isId = maybeId?.startsWith("rpc-") && sessionPool.has(maybeId);
			const stepsRaw = parts.slice(isId ? 2 : 1).join(" ");

			if (!stepsRaw) return reply("Usage: /mtuicontrol exec [id] <step>[|<step>...]");
			const r = resolveSession(isId ? maybeId : undefined);
			if (typeof r === "string") return reply(r);

			// Split on unescaped |, then un-escape
			const stepTokens = stepsRaw.split(/(?<!\\)\|/).map(s => s.replace(/\\\|/g, "|"));
			const steps: RpcExecStep[] = [];
			for (const token of stepTokens) {
				// Split on unescaped : — last all-digits segment is optional timeoutMs
				const colonParts = token.split(/(?<!\\):/);
				const type = colonParts[0]?.trim().toLowerCase();
				if (!type) return reply(`Invalid step token: ${token}`);
				let timeoutMs = 60_000;
				let bodyParts = colonParts.slice(1);
				if (bodyParts.length >= 2) {
					const last = bodyParts.at(-1)!.trim();
					if (/^\d+$/.test(last)) { timeoutMs = parseInt(last, 10); bodyParts = bodyParts.slice(0, -1); }
				}
				const body = bodyParts.join(":").replace(/\\:/g, ":").trim();
				switch (type) {
					case "prompt":   steps.push({ type: "prompt",   text: body,    timeoutMs }); break;
					case "slash":    steps.push({ type: "slash",    command: body, timeoutMs }); break;
					case "bash":     steps.push({ type: "bash",     command: body, timeoutMs }); break;
					case "bash_x":   steps.push({ type: "bash_x",   command: body, timeoutMs }); break;
					case "python":   steps.push({ type: "python",   code: body,    timeoutMs }); break;
					case "python_x": steps.push({ type: "python_x", code: body,    timeoutMs }); break;
					case "keypress": steps.push({ type: "keypress", keys: parseKeySequence(body) }); break;
					case "sleep": {
						const ms = parseInt(body, 10);
						if (isNaN(ms)) return reply(`sleep step requires numeric ms: ${body}`);
						steps.push({ type: "sleep", ms });
						break;
					}
					default: return reply(`Unknown step type: ${type}`);
				}
			}
			if (steps.length === 0) return reply("exec: no steps parsed");
			try {
				await r.client.enqueueExec(steps);
				const state = slaveExecStates.get(r.id);
				if (state) state.counter = 1;
				const msg = `Enqueued ${steps.length} step(s) on ${r.id}.`;
				asyncDisplay?.(msg);
				logger.debug("[mtuicontrol] exec enqueued", { id: r.id, steps: steps.length });
				return "";
			} catch (e: unknown) {
				return reply(`exec failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		case "interrupt": {
			const maybeId = parts[1];
			const isId = maybeId?.startsWith("rpc-") && sessionPool.has(maybeId);
			const r = resolveSession(isId ? maybeId : undefined);
			if (typeof r === "string") return reply(r);
			try {
				const state = slaveExecStates.get(r.id);
				if (state) state.counter = 1;
				await r.client.enqueueExec([{ type: "interrupt" }]);
				asyncDisplay?.(`Interrupt sent to ${r.id}.`);
				return "";
			} catch (e: unknown) {
				return reply(`interrupt failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		case "stop": {
			// stop --all: stop every session
			if (parts.includes("--all")) {
				if (sessionPool.size === 0) {
					const msg = "No active sessions.";
					asyncDisplay?.(msg);
					void asyncSubmit?.(msg);
					return "";
				}
				const ids = [...sessionPool.keys()];
				for (const sid of ids) {
					const c = sessionPool.get(sid)!;
					c.stop();
					sessionPool.delete(sid);
					slaveExecStates.delete(sid);
					if (lastSessionId === sid) lastSessionId = [...sessionPool.keys()].at(-1);
					logger.debug("[mtuicontrol] stopped", { id: sid });
				}
				const msg = `Stopped ${ids.length} session(s).`;
				asyncDisplay?.(msg);
				void asyncSubmit?.(msg);
				return "";
			}
			// stop [id]: stop one session
			const maybeId = parts[1];
			const isId = maybeId && !maybeId.startsWith("-") && sessionPool.has(maybeId);
			const id = isId ? maybeId : undefined;
			const r = resolveSession(id);
			if (typeof r === "string") return reply(r);
			r.client.stop();
			sessionPool.delete(r.id);
			slaveExecStates.delete(r.id);
			if (lastSessionId === r.id) lastSessionId = [...sessionPool.keys()].at(-1);
			logger.debug("[mtuicontrol] stopped", { id: r.id });
			const msg = `Session ${r.id} stopped.`;
			asyncDisplay?.(msg);
			void asyncSubmit?.(msg);
			return "";
		}

		case "list": {
			const msg = sessionPool.size === 0
				? "No active sessions."
				: `Active sessions:\n${[...sessionPool.keys()].join("\n")}`;
			asyncDisplay?.(msg);
			void asyncSubmit?.(msg);
			return "";
		}

		default:
			return reply([
				"Usage: /mtuicontrol <action>",
				"  spawn     --cmd <command>                   Spawn child; --rpc-pipe appended",
				"  prompt    [id] [--timeout N] <msg>         Send prompt, wait for full response",
				"  keypress  [id] <ESC><CTRL-C>...             Inject keyboard sequences",
				"  command   [id] <slash command>              Schedule slash command in child",
				"  exec      [id] <step>[|<step>...]           Enqueue steps; result via follow-up",
				"  interrupt [id]                              Abort current step, clear queue",
				"  stop      [id | --all]                      Stop session(s)",
				"  list                                        List active session ids",
			].join("\n"));
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNamedInt(parts: string[], flag: string, defaultValue: number): number {
	const idx = parts.indexOf(flag);
	if (idx === -1 || !parts[idx + 1]) return defaultValue;
	const n = parseInt(parts[idx + 1], 10);
	return isNaN(n) ? defaultValue : n;
}

