import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "../src/session/session-manager"
import { findAgedImages, hasImageBlock, makePlaceholder } from "../src/session/compaction/mprune-images"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUserTextEntry(text: string): SessionEntry {
	return {
		type: "message",
		id: `u-${Math.random()}`,
		parentId: null,
		message: { role: "user", content: text, timestamp: Date.now() },
	} as unknown as SessionEntry;
}

function makeUserImageEntry(mimeType = "image/png"): SessionEntry {
	return {
		type: "message",
		id: `i-${Math.random()}`,
		parentId: null,
		message: {
			role: "user",
			content: [
				{ type: "text", text: "see this image" },
				{ type: "image", data: "base64", mimeType },
			],
			timestamp: Date.now(),
		},
	} as unknown as SessionEntry;
}

function makeAssistantEntry(text: string): SessionEntry {
	return {
		type: "message",
		id: `a-${Math.random()}`,
		parentId: null,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
			api: "anthropic-messages" as const,
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		},
	} as unknown as SessionEntry;
}

// ─── hasImageBlock ─────────────────────────────────────────────────────────────

describe("hasImageBlock", () => {
	it("returns false for string content", () => {
		expect(hasImageBlock("plain text")).toBe(false);
	});

	it("returns false for null/undefined", () => {
		expect(hasImageBlock(null)).toBe(false);
		expect(hasImageBlock(undefined)).toBe(false);
	});

	it("returns false for text-only array", () => {
		expect(hasImageBlock([{ type: "text", text: "hello" }])).toBe(false);
	});

	it("returns true for array with image block", () => {
		expect(hasImageBlock([{ type: "image", data: "b64", mimeType: "image/png" }])).toBe(true);
	});

	it("returns true for mixed text+image array", () => {
		expect(hasImageBlock([
			{ type: "text", text: "caption" },
			{ type: "image", data: "b64", mimeType: "image/jpeg" },
		])).toBe(true);
	});

	it("returns false for empty array", () => {
		expect(hasImageBlock([])).toBe(false);
	});
});

// ─── findAgedImages ────────────────────────────────────────────────────────────

describe("findAgedImages", () => {
	it("returns empty when keepTurns=0 (disabled)", () => {
		const entries = [makeUserImageEntry()];
		expect(findAgedImages(entries, 10, 0)).toHaveLength(0);
	});

	it("returns empty when no entries", () => {
		expect(findAgedImages([], 10, 5)).toHaveLength(0);
	});

	it("returns empty when image is within keepTurns", () => {
		// Image at turn 0, current turn = 4, keepTurns = 5 → 4-0=4 <= 5 → not aged
		const entries = [
			makeUserImageEntry(),   // turn 0
			makeAssistantEntry("ok"),
			makeUserTextEntry("follow up"),  // turn 1
			makeAssistantEntry("ok"),
		];
		expect(findAgedImages(entries, 4, 5)).toHaveLength(0);
	});

	it("returns image when aged beyond keepTurns", () => {
		// Image at turn 0, current turn = 6, keepTurns = 5 → 6-0=6 > 5 → aged
		const entries = [
			makeUserImageEntry(),   // turn 0, entryIndex 0
			makeAssistantEntry("ok"),
		];
		const result = findAgedImages(entries, 6, 5);
		expect(result).toHaveLength(1);
		expect(result[0].entryIndex).toBe(0);
		expect(result[0].imageTurnIndex).toBe(0);
	});

	it("handles multiple images at different turn indices", () => {
		const entries = [
			makeUserImageEntry(),   // turn 0
			makeAssistantEntry("ok"),
			makeUserTextEntry("t1"),  // turn 1 — no image
			makeAssistantEntry("ok"),
			makeUserImageEntry(),   // turn 2
			makeAssistantEntry("ok"),
			makeUserTextEntry("t3"),  // turn 3
			makeAssistantEntry("ok"),
		];
		// currentTurnIndex=8, keepTurns=5
		// turn 0: 8-0=8 > 5 → aged
		// turn 2: 8-2=6 > 5 → aged
		const result = findAgedImages(entries, 8, 5);
		expect(result).toHaveLength(2);
	});

	it("returns entryIndex pointing to the correct entry", () => {
		const t = makeUserTextEntry("first turn"); // turn 0, index 0 — no image
		const img = makeUserImageEntry();            // turn 1, index 1 — has image
		const entries = [t, img];
		// currentTurnIndex=10, keepTurns=5: 10-1=9 > 5 → aged
		const result = findAgedImages(entries, 10, 5);
		expect(result).toHaveLength(1); // only img is aged (t has no image)
		expect(result[0].entryIndex).toBe(1);
		expect(result[0].imageTurnIndex).toBe(1);
	});

	it("ignores non-message entries (compaction etc.)", () => {
		const compactionEntry = {
			type: "compaction",
			id: "c1",
			parentId: null,
			summary: "summary",
			firstKeptEntryId: "x",
			timestamp: Date.now(),
			fromExtension: false,
		} as unknown as SessionEntry;
		const entries = [compactionEntry, makeUserImageEntry()];
		const result = findAgedImages(entries, 10, 5);
		expect(result).toHaveLength(1);
		expect(result[0].entryIndex).toBe(1);
	});

	it("ignores assistant and toolResult entries for turn counting", () => {
		const entries = [
			makeUserImageEntry(),  // turn 0
			makeAssistantEntry("a"), // NOT a turn boundary
			// toolResult entries would also not count — only user messages
		];
		const result = findAgedImages(entries, 6, 5);
		expect(result).toHaveLength(1);
		expect(result[0].imageTurnIndex).toBe(0);
	});
});

// ─── makePlaceholder ──────────────────────────────────────────────────────────

describe("makePlaceholder", () => {
	it("includes mimeType in placeholder", () => {
		expect(makePlaceholder("image/png")).toContain("image/png");
	});

	it("includes turn index when provided", () => {
		expect(makePlaceholder("image/jpeg", 7)).toContain("turn 7");
	});

	it("omits turn info when not provided", () => {
		const result = makePlaceholder("image/png");
		expect(result).not.toContain("turn");
	});

	it("includes re-paste hint", () => {
		expect(makePlaceholder("image/png")).toContain("Re-paste");
	});
});
