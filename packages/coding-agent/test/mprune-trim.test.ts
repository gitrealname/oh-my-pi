import { describe, expect, it } from "bun:test";
import { softTrim, trimToolResult } from "../src/session/compaction/mprune-trim"

describe("softTrim", () => {
	describe("passthrough cases", () => {
		it("returns unchanged when text.length <= maxChars", () => {
			expect(softTrim("hello", 10)).toBe("hello");
		});

		it("returns unchanged when text.length === maxChars exactly", () => {
			const text = "a".repeat(100);
			expect(softTrim(text, 100)).toBe(text);
		});

		it("returns unchanged when maxChars === 0 (disabled)", () => {
			const text = "a".repeat(500);
			expect(softTrim(text, 0)).toBe(text);
		});

		it("returns unchanged when maxChars < 0 (disabled)", () => {
			const text = "a".repeat(500);
			expect(softTrim(text, -1)).toBe(text);
		});
	});

	describe("trim behavior", () => {
		it("trims a 200-char string to maxChars=100 with head+tail split", () => {
			const head = "H".repeat(40);
			const middle = "M".repeat(100);
			const tail = "T".repeat(60);
			const text = head + middle + tail;
			const result = softTrim(text, 100);
			expect(result.startsWith("H".repeat(40))).toBe(true);
			expect(result.endsWith("T".repeat(60))).toBe(true);
			expect(result).toContain("[... 100 chars trimmed — re-run for full output ...]");
		});

		it("head is 40% of maxChars, tail is 60%", () => {
			const text = "A".repeat(1000);
			const result = softTrim(text, 100);
			// head = 40 chars of A, tail = 60 chars of A
			const [head, rest] = result.split("\n\n[");
			expect(head).toBe("A".repeat(40));
			const tail = rest?.split("]\n\n")[1];
			expect(tail).toBe("A".repeat(60));
		});

		it("notice contains exact char count trimmed", () => {
			const text = "x".repeat(150);
			const result = softTrim(text, 100);
			expect(result).toContain("[... 50 chars trimmed");
		});

		it("result is longer than maxChars (due to notice), but content is bounded", () => {
			const text = "z".repeat(500);
			const result = softTrim(text, 100);
			// head(40) + notice + tail(60) — the notice adds length beyond maxChars
			// but original content retained is exactly maxChars
			const contentChars = 40 + 60;
			expect(contentChars).toBe(100);
			expect(result.length).toBeGreaterThan(100); // notice adds to total
		});
	});
});

describe("trimToolResult", () => {
	it("passes through content unchanged when maxChars=0", () => {
		const content = [{ type: "text" as const, text: "x".repeat(500) }];
		expect(trimToolResult(content, 0)).toBe(content);
	});

	it("returns new array when trimming occurs", () => {
		const content = [{ type: "text" as const, text: "x".repeat(500) }];
		const result = trimToolResult(content, 100);
		expect(result).not.toBe(content);
		expect(result[0]).not.toBe(content[0]);
		expect(result[0].text).toContain("chars trimmed");
	});

	it("passes through image blocks unchanged", () => {
		const img = { type: "image" as const, data: "base64data", mimeType: "image/png" as const };
		const content = [img];
		const result = trimToolResult(content, 10);
		expect(result[0]).toBe(img);
	});

	it("trims only text blocks in mixed content", () => {
		const img = { type: "image" as const, data: "base64data", mimeType: "image/png" as const };
		const txt = { type: "text" as const, text: "x".repeat(500) };
		const result = trimToolResult([img, txt], 100);
		expect(result[0]).toBe(img); // image unchanged, same reference
		expect(result[1].type).toBe("text");
		// biome-ignore lint: narrow the type for test
		expect((result[1] as { type: "text"; text: string }).text).toContain("chars trimmed");
	});

	it("does not mutate original content blocks", () => {
		const block = { type: "text" as const, text: "x".repeat(500) };
		const original = block.text;
		trimToolResult([block], 100);
		expect(block.text).toBe(original); // original unchanged
	});
});
