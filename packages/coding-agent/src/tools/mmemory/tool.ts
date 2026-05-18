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
import { z } from "zod/v4";
import type { ToolSession } from "..";
import { SCHEDULE_SLASH_CHANNEL } from "../../utils/event-bus";
import { toolResult } from "../tool-result";

import embeddedDesc from "../../sidecars/mme-gateway.tool-desc.md" with { type: "text" };
import { createSidecar, sidecarPath } from "../../utils/m-utils";
const resolveDesc = createSidecar(sidecarPath("mme-gateway.tool-desc.md"), embeddedDesc);

const schema = z.object({
	query: z.string().describe(
		"Natural language memory query, or content to store if operation is retain. " +
		"Be specific: include entity names, file paths, or decision context. " +
		"Prefix with '/ ' for a one-time global recall (e.g. '/ auth flow').",
	),
	operation: z.enum(["recall", "retain", "reflect"]).describe(
		"Operation type. Default: recall",
	).optional(),
	scope: z.string().describe(
		"Scope override: per-project (default) | global | / (one-time global for this query only)",
	).optional(),
});

export class MMemoryTool implements AgentTool<typeof schema> {
	readonly name = "mmemory";
	readonly label = "Memory";
	readonly parameters = schema;
	readonly description = resolveDesc();
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
