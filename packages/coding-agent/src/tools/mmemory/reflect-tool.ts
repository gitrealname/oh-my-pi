import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { toolResult } from "../tool-result";
import { executeMemoryReflect, loadMmemoryConfig } from ".";

const schema = Type.Object({
	query: Type.String({
		description:
			"Topic or question to synthesize memories about. " +
			"Reflection retrieves a broader set of memories and frames them as a synthesis.",
	}),
	scope: Type.Optional(
		Type.String({
			description: "Scope override: per-project | per-project-tagged | global",
		}),
	),
});

export class MmemoryReflectTool implements AgentTool<typeof schema> {
	readonly name = "mmemory_reflect";
	readonly label = "Memory: Reflect";
	readonly parameters = schema;
	readonly description =
		"Synthesize project memories on a topic. Returns a broader set of relevant memories " +
		"than recall, useful for understanding accumulated context on a subject.";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MmemoryReflectTool | null {
		if (!session.settings.get("mmemory.enabled")) return null;
		return new MmemoryReflectTool(session);
	}

	async execute(
		_toolCallId: string,
		{ query, scope }: { query: string; scope?: string },
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			// TODO(wiring): use getMmemorySessionConfig(this.session.ctx) here once ToolSession
			// exposes a `ctx: ExtensionContext` field — avoids re-reading settings on every call.
			// See mmemory-extension.ts getMmemorySessionConfig for the ready-made accessor.
			const config = loadMmemoryConfig(this.session.settings, this.session.cwd);
			if (!config) {
				return toolResult().text("Memory system is not enabled.").done();
			}
			const result = await executeMemoryReflect(query, scope, config);
			return toolResult().text(result.text).done();
		});
	}
}
