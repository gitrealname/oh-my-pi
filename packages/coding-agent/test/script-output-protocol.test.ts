import { describe, expect, it } from "bun:test";
import { INLINE_LIMIT, parseOutput } from "../src/modes/controllers/input-controller-m-scripts-protocol";

describe("parseOutput — @omp: output protocol", () => {
	describe("bare text (stdout)", () => {
		it("returns single stdout directive for bare text", () => {
			const result = parseOutput("hello world");
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ kind: "stdout", content: "hello world" });
		});

		it("trims trailing whitespace from joined stdout", () => {
			const result = parseOutput("line1\nline2\n");
			expect(result[0]).toEqual({ kind: "stdout", content: "line1\nline2" });
		});

		it("returns empty array for empty string", () => {
			expect(parseOutput("")).toHaveLength(0);
		});

		it("returns empty array for whitespace-only string", () => {
			expect(parseOutput("   \n  \n  ")).toHaveLength(0);
		});
	});

	describe("@omp:image:", () => {
		it("parses image directive", () => {
			const result = parseOutput("@omp:image:/tmp/foo.png");
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ kind: "image", path: "/tmp/foo.png" });
		});

		it("trims whitespace from image path", () => {
			const result = parseOutput("@omp:image:  /tmp/foo.png  ");
			expect(result[0]).toEqual({ kind: "image", path: "/tmp/foo.png" });
		});

		it("handles Windows-style path", () => {
			const result = parseOutput("@omp:image:C:/Users/common/AppData/Local/Temp/img.png");
			expect(result[0]).toEqual({ kind: "image", path: "C:/Users/common/AppData/Local/Temp/img.png" });
		});
	});

	describe("@omp:text:", () => {
		it("parses plain text directive", () => {
			const result = parseOutput("@omp:text:hello");
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ kind: "text", content: "hello" });
		});

		it("unescapes \\n to newline", () => {
			const result = parseOutput("@omp:text:line1\\nline2");
			expect(result[0]).toEqual({ kind: "text", content: "line1\nline2" });
		});

		it("unescapes \\\\ to backslash", () => {
			const result = parseOutput("@omp:text:a\\\\b");
			expect(result[0]).toEqual({ kind: "text", content: "a\\b" });
		});

		it("single-pass: \\\\n stays as backslash+n, not newline", () => {
			// \\n in raw output means literal backslash followed by n
			// single-pass replace: \\\\ → \\ first occurrence, then n is not preceded by \\ so stays as n
			// The regex /\\(n|\\)/g handles this correctly:
			// \\\\n → first match \\\\→\\, then n is not preceded by \\ so stays as n
			// result: \\n (backslash + n), NOT a newline
			const result = parseOutput("@omp:text:a\\\\nb");
			expect(result[0]).toEqual({ kind: "text", content: "a\\nb" });
		});

		it("unescapes multiple \\n sequences", () => {
			const result = parseOutput("@omp:text:a\\nb\\nc");
			expect(result[0]).toEqual({ kind: "text", content: "a\nb\nc" });
		});

		it("empty text directive yields empty content string", () => {
			const result = parseOutput("@omp:text:");
			expect(result[0]).toEqual({ kind: "text", content: "" });
		});
	});

	describe("@omp:!!:", () => {
		it("parses excluded-output directive", () => {
			const result = parseOutput("@omp:!!:some status message");
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ kind: "excluded", content: "some status message" });
		});

		it("preserves content verbatim including colons", () => {
			const result = parseOutput("@omp:!!:status: done: 42 items");
			expect(result[0]).toEqual({ kind: "excluded", content: "status: done: 42 items" });
		});
	});

	describe("unknown @omp: tag", () => {
		it("treats unknown tag as stdout (visible/debuggable)", () => {
			const result = parseOutput("@omp:unknown:data");
			expect(result[0]).toEqual({ kind: "stdout", content: "@omp:unknown:data" });
		});
	});

	describe("mixed output", () => {
		it("handles image + text + excluded + stdout in one output", () => {
			const raw = [
				"@omp:image:/tmp/img.png",
				"@omp:text:hello\\nworld",
				"@omp:!!:debug info",
				"bare line 1",
				"bare line 2",
			].join("\n");
			const result = parseOutput(raw);
			expect(result).toHaveLength(4); // image, text, excluded, stdout (bare lines merged)
			expect(result[0]).toEqual({ kind: "image", path: "/tmp/img.png" });
			expect(result[1]).toEqual({ kind: "text", content: "hello\nworld" });
			expect(result[2]).toEqual({ kind: "excluded", content: "debug info" });
			expect(result[3].kind).toBe("stdout");
			expect((result[3] as { kind: string; content: string }).content).toContain("bare line 1");
			expect((result[3] as { kind: string; content: string }).content).toContain("bare line 2");
		});

		it("multiple @omp: directives with no bare text produces no stdout directive", () => {
			const raw = "@omp:text:a\n@omp:text:b";
			const result = parseOutput(raw);
			expect(result.every(d => d.kind !== "stdout")).toBe(true);
			expect(result).toHaveLength(2);
		});
	});

	describe("INLINE_LIMIT", () => {
		it("INLINE_LIMIT is 1000", () => {
			expect(INLINE_LIMIT).toBe(1000);
		});
	});
});
