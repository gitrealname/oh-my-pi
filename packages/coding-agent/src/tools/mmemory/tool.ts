/**
 * MMemoryTool — semantic gateway for agent memory.
 *
 * Follows the MReviewTool pattern: emits a slash command via the event bus
 * rather than executing inline, so the agent has completed its turn before
 * memory I/O begins.
 *
 * Debounce guard prevents re-entry loops from the synthetic slash injection.
 */
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { SCHEDULE_SLASH_CHANNEL } from "../../utils/event-bus";
import { toolResult } from "../tool-result";


const schema = Type.Object({
	query: Type.String({
		description:
			"Natural language memory query, or content to store if operation is retain. " +
			"Be specific: include entity names, file paths, or decision context.",
	}),
	operation: Type.Optional(
		Type.Union(
			[Type.Literal("recall"), Type.Literal("retain"), Type.Literal("reflect")],
			{ description: "Operation type. Default: recall" },
		),
	),
	scope: Type.Optional(
		Type.String({
			description: "Scope override: per-project | per-project-tagged | global",
		}),
	),
});

export class MMemoryTool implements AgentTool<typeof schema> {
	readonly name = "mmemory";
	readonly label = "Memory";
	readonly parameters = schema;
	readonly description =
		"Dispatch a memory operation via the session event bus. " +
		"Called automatically when the user prefixes a message with `.memory`. " +
		"Do NOT call this tool directly — use mmemory_recall, mmemory_retain, or mmemory_reflect instead.";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MMemoryTool | null {
		if (!session.settings.get("mmemory.enabled")) return null;
		return new MMemoryTool(session);
	}

	async execute(
		toolCallId: string,
		{ query, operation = "recall", scope }: { query: string; operation?: string; scope?: string },
	): Promise<AgentToolResult> {


		const scopeFlag = scope ? ` --scope ${scope}` : "";
		const slashCmd = `/mmemory ${operation} ${query}${scopeFlag}`.trim();

		this.session.eventBus?.emit(SCHEDULE_SLASH_CHANNEL, slashCmd);
		return toolResult().text(`Processing memory ${operation}: ${query}`).done();
	}
}
