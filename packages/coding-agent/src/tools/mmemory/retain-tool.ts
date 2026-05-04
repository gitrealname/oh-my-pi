import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { toolResult } from "../tool-result";
import { executeMemoryRetain, loadMmemoryConfig } from ".";

const schema = Type.Object({
	content: Type.String({
		description:
			"Information to store in project memory. Include relevant context: " +
			"what was decided, why, and under what constraints.",
	}),
});

export class MmemoryRetainTool implements AgentTool<typeof schema> {
	readonly name = "mmemory_retain";
	readonly label = "Memory: Retain";
	readonly parameters = schema;
	readonly description =
		"Store important information in project memory for future sessions. " +
		"Use for technical decisions, API contracts, constraints, error patterns, and conventions.";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MmemoryRetainTool | null {
		if (!session.settings.get("mmemory.enabled" as any)) return null;
		return new MmemoryRetainTool(session);
	}

	async execute(_toolCallId: string, { content }: { content: string }): Promise<AgentToolResult> {
		const config = loadMmemoryConfig(this.session.settings, this.session.cwd);
		if (!config) {
			return toolResult().text("Memory system is not enabled.").done();
		}
		const sessionId = this.session.getSessionId?.() ?? "default";
		const msg = await executeMemoryRetain(sessionId, content, config);
		return toolResult().text(msg).done();
	}
}
