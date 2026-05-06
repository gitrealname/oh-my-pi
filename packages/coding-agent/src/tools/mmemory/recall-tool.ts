import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { SCHEDULE_SLASH_CHANNEL } from "../../utils/event-bus";
import { Type } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { toolResult } from "../tool-result";
import { executeMemoryRecall, loadMmemoryConfig } from ".";
import embeddedRecallDesc from "../../sidecars/mme-recall.tool-desc.md" with { type: "text" };
import { createSidecar, sidecarPath } from "../../utils/m-utils";
const resolveDesc = createSidecar(sidecarPath("mme-recall.tool-desc.md"), embeddedRecallDesc);

const schema = Type.Object({
	query: Type.String({
		description:
			"Natural language search query. Be specific about what you need to know. " +
			"Include entity names, file paths, or decision context for best results.",
	}),
	scope: Type.Optional(
		Type.String({
			description: "Scope override: per-project | global | / (one-time global for this query only)",
		}),
	),
});

export class MmemoryRecallTool implements AgentTool<typeof schema> {
	readonly name = "mmemory_recall";
	readonly label = "Memory: Recall";
	readonly parameters = schema;
	readonly description = resolveDesc();

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MmemoryRecallTool | null {
		if (!session.settings.get("mmemory.enabled")) return null;
		return new MmemoryRecallTool(session);
	}

	async execute(
		_toolCallId: string,
		{ query, scope }: { query: string; scope?: string },
	): Promise<AgentToolResult> {
		const slashCmd = `/mmemory recall ${query}${scope ? ` --scope ${scope}` : ""}`.trim();
		this.session.eventBus?.emit(SCHEDULE_SLASH_CHANNEL, slashCmd);
		return toolResult().text("↩").done();
	}
}
