/**
 * Batch capture and serialization for mprune.
 *
 * A "batch" is the set of tool results from one completed agent turn.
 * Pure functions — no I/O, no settings reads, easily unit-tested.
 */
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { TurnEndEvent } from "../../extensibility/extensions/types";

export interface ToolResultEntry {
	toolCallId: string;
	toolName: string;
	/** Concatenated text content (images skipped for summarization). */
	content: string;
	/** Rough char count of content — caller can convert to tokens estimate. */
	charCount: number;
	/** Already pruned by OMP's own pass — summarizer should still include in output. */
	prunedAt?: number;
}

export interface PruneBatch {
	turnIndex: number;
	toolResults: ToolResultEntry[];
}

/**
 * Convert a TurnEndEvent into a PruneBatch for summarization.
 * Only captures the text content of tool results (images are not summarized).
 */
export function captureBatch(event: TurnEndEvent): PruneBatch {
	const toolResults: ToolResultEntry[] = event.toolResults.map((msg: ToolResultMessage) => {
		const textParts: string[] = [];
		if (typeof msg.content === "string") {
			textParts.push(msg.content);
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "text" && "text" in block) {
					textParts.push((block as { type: "text"; text: string }).text);
				}
				// image blocks are not included in summarization text
			}
		}
		const content = textParts.join("\n");
		return {
			toolCallId: msg.toolCallId,
			toolName: msg.toolName,
			content,
			charCount: content.length,
			prunedAt: msg.prunedAt,
		};
	});
	return { turnIndex: event.turnIndex, toolResults };
}

/** Tools that mutate state — need verbose summaries (no re-run possible). */
const MUTATION_TOOLS = new Set(["write", "edit", "bash", "notebook"]);

/**
 * Serialize a batch into a human-readable block for the LLM summarizer.
 * Terse for read-only tools (re-run hint); verbose for mutation tools.
 */
export function serializeBatchForSummarizer(batch: PruneBatch): string {
	if (batch.toolResults.length === 0) return "";

	const lines: string[] = [`## Turn ${batch.turnIndex} — ${batch.toolResults.length} tool call(s)`];

	for (const entry of batch.toolResults) {
		const isMutation = MUTATION_TOOLS.has(entry.toolName);
		const already = entry.prunedAt !== undefined ? " [already truncated]" : "";
		const preview = entry.content.length > 0
			? entry.content.slice(0, isMutation ? 500 : 200)
			: "(empty)";
		const ellipsis = entry.content.length > (isMutation ? 500 : 200) ? "..." : "";
		const hint = isMutation
			? ""
			: " [re-run for full output]";
		lines.push(`- ${entry.toolName}(${entry.toolCallId})${already}: ${preview}${ellipsis}${hint}`);
	}

	lines.push("[Pruned. Re-run the relevant tool with the same arguments if full output is needed.]");
	return lines.join("\n");
}
