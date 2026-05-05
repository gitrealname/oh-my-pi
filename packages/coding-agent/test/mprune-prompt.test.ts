import { describe, expect, it } from "bun:test";
import { buildSummarizerPrompt } from "../src/session/compaction/mprune-prompt"

describe("buildSummarizerPrompt", () => {
	it("returns a non-empty string", () => {
		expect(buildSummarizerPrompt().length).toBeGreaterThan(0);
	});

	it("contains instruction for read-only tools", () => {
		expect(buildSummarizerPrompt()).toContain("Read-only tools");
	});

	it("contains instruction for mutation tools", () => {
		expect(buildSummarizerPrompt()).toContain("Mutation tools");
	});

	it("instructs to add re-run hint for read-only tools", () => {
		expect(buildSummarizerPrompt()).toContain("re-run for full output");
	});

	it("instructs to preserve original language", () => {
		expect(buildSummarizerPrompt()).toContain("Preserve the original language");
	});

	it("returns same string on repeated calls (pure function)", () => {
		expect(buildSummarizerPrompt()).toBe(buildSummarizerPrompt());
	});

	it("includes format example with Turn N header", () => {
		expect(buildSummarizerPrompt()).toContain("Turn N");
	});
});
