import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
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
			const result = await executeMemoryRecall(query, scope, config);
			return toolResult().text(result.text).done();
		});
	}
}
