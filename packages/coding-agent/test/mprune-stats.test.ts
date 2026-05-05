import { describe, expect, it } from "bun:test";
import {
	accumulateStats,
	buildStatsLines,
	charsToTokens,
	createPersistentStats,
	createSessionStats,
	estimateBatchSavings,
	estimateTrimSavings,
	formatTokens,
	IMAGE_TOKEN_ESTIMATE,
	persistentTotal,
	sessionTotal,
} from "../src/session/compaction/mprune-stats-pure";

// ── formatTokens ──────────────────────────────────────────────────────────────

describe("formatTokens", () => {
	it("returns plain number below 1000", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(1)).toBe("1");
		expect(formatTokens(999)).toBe("999");
	});

	it("uses K at 1000", () => {
		expect(formatTokens(1000)).toBe("1K");
	});

	it("uses decimal K for 1001-9999", () => {
		expect(formatTokens(1500)).toBe("1.5K");
		expect(formatTokens(1100)).toBe("1.1K");
		expect(formatTokens(9999)).toBe("10K"); // rounds to 10K
	});

	it("uses rounded K for 10000-999999", () => {
		expect(formatTokens(10_000)).toBe("10K");
		expect(formatTokens(25_000)).toBe("25K");
		expect(formatTokens(999_999)).toBe("1000K"); // rounds up
	});

	it("uses M at 1_000_000", () => {
		expect(formatTokens(1_000_000)).toBe("1M");
	});

	it("uses decimal M for 1M-9.9M", () => {
		expect(formatTokens(1_500_000)).toBe("1.5M");
		expect(formatTokens(2_300_000)).toBe("2.3M");
	});

	it("uses rounded M above 10M", () => {
		expect(formatTokens(25_000_000)).toBe("25M");
	});

	it("drops trailing .0 in decimal form", () => {
		expect(formatTokens(2_000)).toBe("2K");   // not "2.0K"
		expect(formatTokens(3_000_000)).toBe("3M"); // not "3.0M"
	});
});

// ── charsToTokens ─────────────────────────────────────────────────────────────

describe("charsToTokens", () => {
	it("returns 0 for 0 chars", () => {
		expect(charsToTokens(0)).toBe(0);
	});

	it("rounds up (never understates savings)", () => {
		expect(charsToTokens(1)).toBe(1);  // ceil(1/4) = 1
		expect(charsToTokens(4)).toBe(1);  // ceil(4/4) = 1
		expect(charsToTokens(5)).toBe(2);  // ceil(5/4) = 2
		expect(charsToTokens(8)).toBe(2);  // ceil(8/4) = 2
		expect(charsToTokens(9)).toBe(3);  // ceil(9/4) = 3
	});

	it("scales linearly", () => {
		expect(charsToTokens(4000)).toBe(1000);
		expect(charsToTokens(12000)).toBe(3000);
	});
});

// ── estimateTrimSavings ───────────────────────────────────────────────────────

describe("estimateTrimSavings", () => {
	it("returns 0 when no trimming occurred", () => {
		expect(estimateTrimSavings(100, 100)).toBe(0);
	});

	it("returns 0 when afterChars > beforeChars (no savings)", () => {
		expect(estimateTrimSavings(100, 200)).toBe(0);
	});

	it("estimates tokens saved from char difference", () => {
		// 12000 chars before, 4000 chars after → 8000 chars saved → 2000 tokens
		expect(estimateTrimSavings(12000, 4000)).toBe(2000);
	});

	it("rounds up on fractional tokens", () => {
		// 5 chars saved → ceil(5/4) = 2
		expect(estimateTrimSavings(105, 100)).toBe(2);
	});
});

// ── estimateBatchSavings ──────────────────────────────────────────────────────

describe("estimateBatchSavings", () => {
	it("returns 0 when summary is longer than raw content", () => {
		expect(estimateBatchSavings(100, 200)).toBe(0);
	});

	it("returns 0 when equal", () => {
		expect(estimateBatchSavings(100, 100)).toBe(0);
	});

	it("estimates tokens saved from raw vs summary chars", () => {
		// 8000 raw chars, 400 summary chars → 7600 saved → 1900 tokens
		expect(estimateBatchSavings(8000, 400)).toBe(1900);
	});
});

// ── IMAGE_TOKEN_ESTIMATE ──────────────────────────────────────────────────────

describe("IMAGE_TOKEN_ESTIMATE", () => {
	it("matches compaction.ts value of 1200", () => {
		expect(IMAGE_TOKEN_ESTIMATE).toBe(1200);
	});
});

// ── sessionTotal / persistentTotal ───────────────────────────────────────────

describe("sessionTotal", () => {
	it("sums all three saving categories", () => {
		const s = createSessionStats();
		s.tokensSavedTrim = 100;
		s.tokensSavedBatch = 200;
		s.tokensSavedImages = 1200;
		expect(sessionTotal(s)).toBe(1500);
	});

	it("returns 0 for empty stats", () => {
		expect(sessionTotal(createSessionStats())).toBe(0);
	});
});

describe("persistentTotal", () => {
	it("sums all three saving categories", () => {
		const p = createPersistentStats();
		p.tokensSavedTrim = 500;
		p.tokensSavedBatch = 1000;
		p.tokensSavedImages = 2400;
		expect(persistentTotal(p)).toBe(3900);
	});
});

// ── accumulateStats ───────────────────────────────────────────────────────────

describe("accumulateStats", () => {
	it("adds session stats onto persistent stats", () => {
		const p = createPersistentStats();
		p.tokensSavedTrim = 100;
		p.batchFlushes = 2;

		const s = createSessionStats();
		s.tokensSavedTrim = 50;
		s.tokensSavedBatch = 300;
		s.batchFlushes = 1;

		const result = accumulateStats(p, s);
		expect(result.tokensSavedTrim).toBe(150);
		expect(result.tokensSavedBatch).toBe(300);
		expect(result.batchFlushes).toBe(3);
	});

	it("does not mutate input objects", () => {
		const p = createPersistentStats();
		p.tokensSavedTrim = 100;
		const s = createSessionStats();
		s.tokensSavedTrim = 50;

		accumulateStats(p, s);
		expect(p.tokensSavedTrim).toBe(100); // unchanged
	});

	it("updates lastUpdated timestamp", () => {
		const before = new Date().toISOString();
		const p = createPersistentStats();
		const s = createSessionStats();
		const result = accumulateStats(p, s);
		expect(result.lastUpdated >= before).toBe(true);
	});
});

// ── buildStatsLines ───────────────────────────────────────────────────────────

describe("buildStatsLines", () => {
	it("returns an array of strings", () => {
		const s = createSessionStats();
		const p = createPersistentStats();
		expect(Array.isArray(buildStatsLines(s, p))).toBe(true);
	});

	it("includes session total line", () => {
		const s = createSessionStats();
		s.tokensSavedBatch = 2500;
		const p = createPersistentStats();
		const lines = buildStatsLines(s, p);
		const sessionLine = lines.find(l => l.includes("This session"));
		expect(sessionLine).toBeDefined();
		expect(sessionLine).toContain("2.5K");
	});

	it("includes lifetime total line", () => {
		const s = createSessionStats();
		const p = createPersistentStats();
		p.tokensSavedBatch = 50_000;
		const lines = buildStatsLines(s, p);
		const lifetimeLine = lines.find(l => l.includes("All time"));
		expect(lifetimeLine).toBeDefined();
		expect(lifetimeLine).toContain("50K");
	});

	it("shows session breakdown only when session total > 0", () => {
		const s = createSessionStats(); // all zeros
		const p = createPersistentStats();
		const lines = buildStatsLines(s, p);
		expect(lines.some(l => l.includes("trim:"))).toBe(false);
	});

	it("shows trim breakdown when trim savings present", () => {
		const s = createSessionStats();
		s.tokensSavedTrim = 1000;
		s.trimEvents = 3;
		const p = createPersistentStats();
		const lines = buildStatsLines(s, p);
		const trimLine = lines.find(l => l.includes("trim:"));
		expect(trimLine).toBeDefined();
		expect(trimLine).toContain("1K");
		expect(trimLine).toContain("3 events");
	});

	it("shows image breakdown when images pruned", () => {
		const s = createSessionStats();
		s.tokensSavedImages = IMAGE_TOKEN_ESTIMATE * 2;
		s.imagesPruned = 2;
		const p = createPersistentStats();
		const lines = buildStatsLines(s, p);
		const imgLine = lines.find(l => l.includes("images:"));
		expect(imgLine).toBeDefined();
		expect(imgLine).toContain("2 pruned");
	});

	it("shows lastUpdated date for lifetime when total > 0", () => {
		const s = createSessionStats();
		const p = createPersistentStats();
		p.tokensSavedBatch = 1000;
		p.lastUpdated = "2026-05-05T12:00:00.000Z";
		const lines = buildStatsLines(s, p);
		expect(lines.some(l => l.includes("2026-05-05"))).toBe(true);
	});
});
