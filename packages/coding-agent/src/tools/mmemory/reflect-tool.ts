import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { SCHEDULE_SLASH_CHANNEL } from "../../utils/event-bus";
import { z } from "zod/v4";
import type { ToolSession } from "..";
import { toolResult } from "../tool-result";
import { executeMemoryReflect, loadMmemoryConfig } from ".";
import embeddedReflectDesc from "../../sidecars/mme-reflect.tool-desc.md" with { type: "text" };
import { createSidecar, sidecarPath } from "../../utils/m-utils";
const resolveDesc = createSidecar(sidecarPath("mme-reflect.tool-desc.md"), embeddedReflectDesc);

const schema = z.object({
	query: z.string().describe(
		"Topic or question to synthesize memories about. " +
		"Reflection retrieves a broader set of memories and frames them as a synthesis.",
	),
	scope: z.string().describe(
		"Scope override: per-project | global | / (one-time global for this query only)",
	).optional(),
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
		const activeRole = this.session.activeSkillRoles?.get(this.name);
		const roleFlag = activeRole ? ` --role ${activeRole}` : "";
		const slashCmd = `/mmemory reflect ${query}${scope ? ` --scope ${scope}` : ""}${roleFlag}`.trim();
		this.session.eventBus?.emit(SCHEDULE_SLASH_CHANNEL, slashCmd);
		return toolResult().text("↩").done();
	}
}
