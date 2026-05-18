/**
 * mprune stats — pure functions, no native dependencies.
 * Extracted from mprune-stats.ts for testability (bun test cannot load native addons).
 *
 * All imports safe in bun:test context.
 */

// ── Token estimation constants ────────────────────────────────────────────────

/** Characters-per-token approximation (cl100k_base, ~4 chars/token for English/code). */
const CHARS_PER_TOKEN = 4;

/** Fixed token cost for an inline image (matches IMAGE_TOKEN_ESTIMATE in compaction.ts). */
export const IMAGE_TOKEN_ESTIMATE = 1200;

/**
 * Estimate tokens from a character count.
 * Rounds up so savings are never overstated.
 */
export function charsToTokens(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens saved by a soft-trim operation.
 */
export function estimateTrimSavings(beforeChars: number, afterChars: number): number {
	const saved = beforeChars - afterChars;
	return saved > 0 ? charsToTokens(saved) : 0;
}

/**
 * Estimate tokens saved by replacing tool-result content with a summary.
 */
export function estimateBatchSavings(rawChars: number, summaryChars: number): number {
	const saved = rawChars - summaryChars;
	return saved > 0 ? charsToTokens(saved) : 0;
}

// ── Stats shapes ─────────────────────────────────────────────────────────────

export interface MpruneSessionStats {
	tokensSavedTrim: number;
	tokensSavedBatch: number;
	tokensSavedImages: number;
	trimEvents: number;
	batchFlushes: number;
	imagesPruned: number;
}

export function createSessionStats(): MpruneSessionStats {
	return {
		tokensSavedTrim: 0,
		tokensSavedBatch: 0,
		tokensSavedImages: 0,
		trimEvents: 0,
		batchFlushes: 0,
		imagesPruned: 0,
	};
}

export interface MprunePersistentStats {
	tokensSavedTrim: number;
	tokensSavedBatch: number;
	tokensSavedImages: number;
	trimEvents: number;
	batchFlushes: number;
	imagesPruned: number;
	lastUpdated: string; // ISO 8601
}

export function createPersistentStats(): MprunePersistentStats {
	return {
		tokensSavedTrim: 0,
		tokensSavedBatch: 0,
		tokensSavedImages: 0,
		trimEvents: 0,
		batchFlushes: 0,
		imagesPruned: 0,
		lastUpdated: new Date().toISOString(),
	};
}

// ── Derived totals ────────────────────────────────────────────────────────────

export function sessionTotal(s: MpruneSessionStats): number {
	return s.tokensSavedTrim + s.tokensSavedBatch + s.tokensSavedImages;
}

export function persistentTotal(s: MprunePersistentStats): number {
	return s.tokensSavedTrim + s.tokensSavedBatch + s.tokensSavedImages;
}

// ── Accumulation ─────────────────────────────────────────────────────────────

export function accumulateStats(
	persistent: MprunePersistentStats,
	session: MpruneSessionStats,
): MprunePersistentStats {
	return {
		tokensSavedTrim:   persistent.tokensSavedTrim   + session.tokensSavedTrim,
		tokensSavedBatch:  persistent.tokensSavedBatch  + session.tokensSavedBatch,
		tokensSavedImages: persistent.tokensSavedImages + session.tokensSavedImages,
		trimEvents:        persistent.trimEvents        + session.trimEvents,
		batchFlushes:      persistent.batchFlushes      + session.batchFlushes,
		imagesPruned:      persistent.imagesPruned      + session.imagesPruned,
		lastUpdated:       new Date().toISOString(),
	};
}

// ── Display formatting ────────────────────────────────────────────────────────

/**
 * Format a token count for display.
 * Convention: 1K = 1000 (consistent with formatNumber in @oh-my-pi/pi-utils / /context output).
 */
export function formatTokens(n: number): string {
	if (n < 1_000) return `${n}`;
	if (n < 10_000) return `${trimOne(n / 1_000)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
	if (n < 10_000_000) return `${trimOne(n / 1_000_000)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function trimOne(n: number): string {
	const s = n.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function buildStatsLines(
	session: MpruneSessionStats,
	lifetime: MprunePersistentStats,
): string[] {
	const st = sessionTotal(session);
	const lt = persistentTotal(lifetime);
	const lines: string[] = [];

	lines.push("mprune token savings");
	lines.push("");

	lines.push(`This session:   ${formatTokens(st)} tokens saved`);
	if (st > 0) {
		if (session.tokensSavedTrim > 0)
			lines.push(`  trim:         ${formatTokens(session.tokensSavedTrim)} (${session.trimEvents} events)`);
		if (session.tokensSavedBatch > 0)
			lines.push(`  summarized:   ${formatTokens(session.tokensSavedBatch)} (${session.batchFlushes} flushes)`);
		if (session.tokensSavedImages > 0)
			lines.push(`  images:       ${formatTokens(session.tokensSavedImages)} (${session.imagesPruned} pruned)`);
	}

	lines.push("");

	lines.push(`All time:       ${formatTokens(lt)} tokens saved`);
	if (lt > 0) {
		if (lifetime.tokensSavedTrim > 0)
			lines.push(`  trim:         ${formatTokens(lifetime.tokensSavedTrim)} (${lifetime.trimEvents} events)`);
		if (lifetime.tokensSavedBatch > 0)
			lines.push(`  summarized:   ${formatTokens(lifetime.tokensSavedBatch)} (${lifetime.batchFlushes} flushes)`);
		if (lifetime.tokensSavedImages > 0)
			lines.push(`  images:       ${formatTokens(lifetime.tokensSavedImages)} (${lifetime.imagesPruned} pruned)`);
		lines.push(`  last updated: ${lifetime.lastUpdated.slice(0, 10)}`);
	}

	return lines;
}
