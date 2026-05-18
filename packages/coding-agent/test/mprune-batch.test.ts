import { describe, expect, it } from "bun:test";
import type { TurnEndEvent } from "../src/extensibility/extensions/types"
import { captureBatch, serializeBatchForSummarizer } from "../src/session/compaction/mprune-batch"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTurnEnd(toolResults: Array<{
	toolCallId: string;
	toolName: string;
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	prunedAt?: number;
}>): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 5,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
			api: "anthropic-messages" as const,
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		} as any,
		toolResults: toolResults.map(r => ({
			role: "toolResult" as const,
			toolCallId: r.toolCallId,
			toolName: r.toolName,
			content: r.content as any,
			isError: false,
			prunedAt: r.prunedAt,
			timestamp: Date.now(),
		})),
	};
}

// ─── captureBatch ──────────────────────────────────────────────────────────────

describe("captureBatch", () => {
	it("captures turnIndex from event", () => {
		const event = makeTurnEnd([]);
		const batch = captureBatch(event);
		expect(batch.turnIndex).toBe(5);
	});

	it("returns empty toolResults for event with no tool calls", () => {
		const batch = captureBatch(makeTurnEnd([]));
		expect(batch.toolResults).toHaveLength(0);
	});

	it("extracts toolName and toolCallId", () => {
		const event = makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "file content" }],
		}]);
		const batch = captureBatch(event);
		expect(batch.toolResults[0].toolCallId).toBe("tc-1");
		expect(batch.toolResults[0].toolName).toBe("read");
	});

	it("concatenates text blocks into content string", () => {
		const event = makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "read",
			content: [
				{ type: "text", text: "part 1" },
				{ type: "text", text: "part 2" },
			],
		}]);
		const batch = captureBatch(event);
		expect(batch.toolResults[0].content).toBe("part 1\npart 2");
	});

	it("skips image blocks (not included in summarization text)", () => {
		const event = makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "read",
			content: [
				{ type: "image", data: "base64", mimeType: "image/png" },
				{ type: "text", text: "caption" },
			],
		}]);
		const batch = captureBatch(event);
		expect(batch.toolResults[0].content).toBe("caption");
		expect(batch.toolResults[0].content).not.toContain("base64");
	});

	it("sets charCount to content length", () => {
		const event = makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "abc" }],
		}]);
		const batch = captureBatch(event);
		expect(batch.toolResults[0].charCount).toBe(3);
	});

	it("preserves prunedAt when set", () => {
		const ts = Date.now();
		const event = makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "x" }],
			prunedAt: ts,
		}]);
		const batch = captureBatch(event);
		expect(batch.toolResults[0].prunedAt).toBe(ts);
	});

	it("handles string content (not array)", () => {
		const event = makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "bash",
			content: "exit 0" as any,
		}]);
		const batch = captureBatch(event);
		expect(batch.toolResults[0].content).toBe("exit 0");
	});
});

// ─── serializeBatchForSummarizer ───────────────────────────────────────────────

describe("serializeBatchForSummarizer", () => {
	it("returns empty string for batch with no tool results", () => {
		const batch = captureBatch(makeTurnEnd([]));
		expect(serializeBatchForSummarizer(batch)).toBe("");
	});

	it("includes turn index in header", () => {
		const batch = captureBatch(makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "content" }],
		}]));
		expect(serializeBatchForSummarizer(batch)).toContain("Turn 5");
	});

	it("adds [re-run for full output] hint for read-only tool", () => {
		const batch = captureBatch(makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "content" }],
		}]));
		const out = serializeBatchForSummarizer(batch);
		expect(out).toContain("[re-run for full output]");
	});

	it("does NOT add re-run hint for mutation tool (bash)", () => {
		const batch = captureBatch(makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "bash",
			content: [{ type: "text", text: "exit 0" }],
		}]));
		const out = serializeBatchForSummarizer(batch);
		expect(out).not.toContain("[re-run for full output]");
	});

	it("does NOT add re-run hint for mutation tool (write)", () => {
		const batch = captureBatch(makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "write",
			content: [{ type: "text", text: "file written" }],
		}]));
		expect(serializeBatchForSummarizer(batch)).not.toContain("[re-run for full output]");
	});

	it("includes [already truncated] for entries with prunedAt", () => {
		const event = makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "content" }],
			prunedAt: Date.now(),
		}]);
		const batch = captureBatch(event);
		const out = serializeBatchForSummarizer(batch);
		expect(out).toContain("already truncated");
	});

	it("ends with the re-run reminder line", () => {
		const batch = captureBatch(makeTurnEnd([{
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "x" }],
		}]));
		const out = serializeBatchForSummarizer(batch);
		expect(out).toContain("[Pruned. Re-run the relevant tool");
	});

	it("handles multiple tool results", () => {
		const batch = captureBatch(makeTurnEnd([
			{ toolCallId: "tc-1", toolName: "read", content: [{ type: "text", text: "r1" }] },
			{ toolCallId: "tc-2", toolName: "bash", content: [{ type: "text", text: "r2" }] },
		]));
		const out = serializeBatchForSummarizer(batch);
		expect(out).toContain("2 tool call(s)");
	});
});
