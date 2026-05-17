/**
 * Insertion-time soft trimming for large tool results.
 *
 * Applied when a tool result enters the session — never modifies existing entries.
 * Cache-safe: we only trim new content before it is written.
 *
 * Pure functions — no I/O, no settings reads, easily unit-tested.
 */
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

/**
 * Soft-trim text to maxChars using a head+tail split.
 *
 * - head: 40% of maxChars (captures setup/context)
 * - tail: 60% of maxChars (captures exit codes and final output)
 * - middle: replaced with a notice line
 *
 * Returns the original string unchanged if text.length <= maxChars.
 * Returns unchanged if maxChars <= 0 (disabled).
 */
export function softTrim(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;

	const headChars = Math.floor(maxChars * 0.4);
	const tailChars = maxChars - headChars;
	const trimmedChars = text.length - maxChars;
	const notice = `\n\n[... ${trimmedChars} chars trimmed — re-run for full output ...]\n\n`;

	return text.slice(0, headChars) + notice + text.slice(text.length - tailChars);
}

/**
 * Apply soft trimming to all text blocks in a tool result content array.
 * Image blocks are passed through unchanged.
 * Returns a new array (does not mutate input).
 */
export function trimToolResult(
	content: (TextContent | ImageContent)[],
	maxChars: number,
): (TextContent | ImageContent)[] {
	if (maxChars <= 0) return content;
	return content.map(block => {
		if (block.type !== "text") return block;
		const trimmed = softTrim(block.text, maxChars);
		if (trimmed === block.text) return block;
		return { ...block, text: trimmed };
	});
}
