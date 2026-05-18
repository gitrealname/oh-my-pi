/**
 * Image age detection for mprune.
 *
 * Images in user messages are pruned after `keepTurns` agent turns.
 * Counts "turns" as user messages (each user message = one turn boundary).
 *
 * Pure functions — no I/O, no settings reads, easily unit-tested.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "../../session/session-manager";

export interface ImageEntry {
	/** Index into the entries array. */
	entryIndex: number;
	/** Which user-turn this image was attached in (0-indexed). */
	imageTurnIndex: number;
}

/**
 * Returns true if a user message content array contains at least one image block.
 */
export function hasImageBlock(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((b: unknown) => typeof b === "object" && b !== null && (b as { type?: string }).type === "image");
}

/**
 * Find session entries containing aged images.
 *
 * @param entries        Full session entry list (from getBranch())
 * @param currentTurnIndex  Current agent turn index (from TurnEndEvent.turnIndex)
 * @param keepTurns      How many turns to keep images (config: mprune.images.keepTurns)
 * @returns              ImageEntry list for entries eligible for image pruning
 */
export function findAgedImages(
	entries: SessionEntry[],
	currentTurnIndex: number,
	keepTurns: number,
): ImageEntry[] {
	if (keepTurns <= 0) return []; // disabled

	const result: ImageEntry[] = [];
	let userTurnIndex = 0;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as AgentMessage;
		if (message.role !== "user") continue;

		const content = (message as { content: unknown }).content;
		if (hasImageBlock(content)) {
			if (currentTurnIndex - userTurnIndex > keepTurns) {
				result.push({ entryIndex: i, imageTurnIndex: userTurnIndex });
			}
		}
		userTurnIndex++;
	}

	return result;
}

/**
 * Build a text placeholder to replace a pruned image block.
 */
export function makePlaceholder(mimeType: string, turnIndex?: number): string {
	const turn = turnIndex !== undefined ? `, attached turn ${turnIndex}` : "";
	return `[Image pruned: ${mimeType}${turn}. Re-paste if needed.]`;
}
