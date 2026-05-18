/**
 * mprune persistent stats — token savings accounting.
 *
 * Pure functions live in mprune-stats-pure.ts (no native deps, bun:test safe).
 * This file adds file I/O and re-exports everything so callers use one import.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

export type { MprunePersistentStats, MpruneSessionStats } from "./mprune-stats-pure";
export {
	IMAGE_TOKEN_ESTIMATE,
	accumulateStats,
	buildStatsLines,
	charsToTokens,
	createPersistentStats,
	createSessionStats,
	estimateBatchSavings,
	estimateTrimSavings,
	formatTokens,
	persistentTotal,
	sessionTotal,
} from "./mprune-stats-pure";

import type { MprunePersistentStats } from "./mprune-stats-pure";
import { createPersistentStats } from "./mprune-stats-pure";

// ── File I/O ─────────────────────────────────────────────────────────────────

const STATS_FILENAME = "mprune-stats.json";

export function statsFilePath(agentDir: string): string {
	return path.join(agentDir, STATS_FILENAME);
}

export function loadPersistentStats(agentDir: string): MprunePersistentStats {
	const filePath = statsFilePath(agentDir);
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<MprunePersistentStats>;
		return { ...createPersistentStats(), ...parsed };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.warn("[mprune] failed to load stats file", { path: filePath, error: String(err) });
		}
		return createPersistentStats();
	}
}

export function savePersistentStats(agentDir: string, stats: MprunePersistentStats): void {
	const filePath = statsFilePath(agentDir);
	try {
		const updated: MprunePersistentStats = { ...stats, lastUpdated: new Date().toISOString() };
		const tmp = filePath + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), "utf-8");
		fs.renameSync(tmp, filePath); // atomic on same filesystem
	} catch (err) {
		logger.warn("[mprune] failed to save stats file", { path: filePath, error: String(err) });
	}
}
