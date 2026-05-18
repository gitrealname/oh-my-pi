import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { z } from "zod/v4";
import type { ToolSession } from "..";
import { toolResult } from "../tool-result";
import { executeMemoryRetain, loadMmemoryConfig } from ".";
import embeddedRetainDesc from "../../sidecars/mme-retain.tool-desc.md" with { type: "text" };
import { createSidecar, sidecarPath } from "../../utils/m-utils";
const resolveDesc = createSidecar(sidecarPath("mme-retain.tool-desc.md"), embeddedRetainDesc);

const schema = z.object({
	content: z.string().describe(
		"Information to store in project memory. Include relevant context: " +
		"what was decided, why, and under what constraints.",
	),
});

export class MmemoryRetainTool implements AgentTool<typeof schema> {
	readonly name = "mmemory_retain";
	readonly label = "Memory: Retain";
	readonly parameters = schema;
	readonly description = resolveDesc();

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MmemoryRetainTool | null {
		if (!session.settings.get("mmemory.enabled")) return null;
		return new MmemoryRetainTool(session);
	}

	async execute(_toolCallId: string, { content }: { content: string }): Promise<AgentToolResult> {
		// TODO(wiring): use getMmemorySessionConfig(this.session.ctx) here once ToolSession
		// exposes a `ctx: ExtensionContext` field — avoids re-reading settings on every call.
		// See mmemory-extension.ts getMmemorySessionConfig for the ready-made accessor.
		const config = loadMmemoryConfig(this.session.settings, this.session.cwd);
		if (!config) {
			return toolResult().text("Memory system is not enabled.").done();
		}
		const msg = await executeMemoryRetain(content, config);
		return toolResult().text(msg).done();
	}
}
