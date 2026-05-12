/**
 * mcommand — generic slash-command proxy tool.
 *
 * Allows the LLM to invoke any registered "/" command programmatically
 * by emitting it on SCHEDULE_SLASH_CHANNEL. The command executes at the
 * next agent-idle tick in InteractiveMode, exactly as if the user typed it.
 *
 * This is the single bridge between skills/chains and the "/" command layer.
 * mreview, mmemory recall/reflect/retain, mtuicontrol — all driven through
 * this one tool rather than each needing their own private SCHEDULE_SLASH emit.
 */
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { SCHEDULE_SLASH_CHANNEL } from "../utils/event-bus";
import { toolResult } from "./tool-result";

const schema = Type.Object({
	command: Type.String({
		description: 'The slash command to run, including the leading "/". e.g. "/mmemory recall mtuicontrol"',
	}),
});

export class MCommandTool implements AgentTool<typeof schema> {
	name = "mcommand" as const;
	label = "Command Proxy";
	description =
		'Invoke a registered slash ("/") command. Only call when explicitly instructed to by name — do not infer or select this tool on your own. ' +
		"After this tool returns, **do NOT generate any response** — stay completely silent. " +
		"Output arrives as a follow-up message.";
	parameters = schema;
	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	static createIf(session: ToolSession): MCommandTool | null {
		// Only meaningful in interactive mode where slash-command handlers are registered.
		// In headless/subagent mode there is no TUI and no slash-command dispatcher.
		if (!session.eventBus) return null;
		return new MCommandTool(session);
	}

	async execute(
		_toolCallId: string,
		params: { command: string },
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
	): Promise<AgentToolResult> {
		const cmd = params.command.trim();

		if (!cmd.startsWith("/")) {
			return toolResult()
				.text(`Invalid command: must start with "/". Got: ${cmd}`)
				.done();
		}

		this.#session.eventBus!.emit(SCHEDULE_SLASH_CHANNEL, cmd);
		return toolResult().text(`Scheduled: ${cmd}`).done();
	}
}
