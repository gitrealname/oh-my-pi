import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { SCHEDULE_SLASH_CHANNEL } from "../../utils/event-bus";
import { Type } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { toolResult } from "../tool-result";
import { executeMemoryReflect, loadMmemoryConfig } from ".";
import embeddedReflectDesc from "../../sidecars/mme-reflect.tool-desc.md" with { type: "text" };
import { createSidecar, sidecarPath } from "../../utils/m-utils";
const resolveDesc = createSidecar(sidecarPath("mme-reflect.tool-desc.md"), embeddedReflectDesc);

const schema = Type.Object({
	query: Type.String({
		description:
			"Topic or question to synthesize memories about. " +
			"Reflection retrieves a broader set of memories and frames them as a synthesis.",
	}),
	scope: Type.Optional(
		Type.String({
			description: "Scope override: per-project | global | / (one-time global for this query only)",
		}),
	),
});

export class MmemoryReflectTool implements AgentTool<typeof schema> {
	readonly name = "mmemory_reflect";
	readonly label = "Memory: Reflect";
	readonly parameters = schema;
	readonly description = resolveDesc();

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MmemoryReflectTool | null {
		if (!session.settings.get("mmemory.enabled")) return null;
		return new MmemoryReflectTool(session);
	}

	async execute(
		_toolCallId: string,
		{ query, scope }: { query: string; scope?: string },
	): Promise<AgentToolResult> {
		const slashCmd = `/mmemory reflect ${query}${scope ? ` --scope ${scope}` : ""}`.trim();
		this.session.eventBus?.emit(SCHEDULE_SLASH_CHANNEL, slashCmd);
		return toolResult().text("↩").done();
	}
}
