/**
 * LLM-based temporal query pre-processor for mmemory recall.
 *
 * When a recall query contains a time reference ("yesterday", "last week",
 * "3 days ago", etc.), this module calls a cheap LLM to extract temporal
 * bounds and returns a cleaned query with the time expression stripped.
 *
 * Skip condition: if no recognisable time keyword → no LLM call, original
 * query returned unchanged.
 *
 * System prompt override (local-wins, same pattern as mreview sidecar):
 *   Compiled : <binary-dir>/mme-time-filter.prompt.md
 *   Dev      : ~/.omp/mme-time-filter.prompt.md
 *
 *   - No local file             → flush embedded to disk, use embedded
 *   - local.mtime >= build time → use local (user is customising it)
 *   - local.mtime <  build time → flush embedded, use embedded (build is newer)
 *
 * Edit the local copy to adapt the prompt for different languages or time
 * conventions without rebuilding the binary.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { MmemoryConfig } from "./index";
import { createSidecar, callWithRole, sidecarPath } from "../../utils/m-utils";
import embeddedPrompt from "../../sidecars/mme-time-filter.prompt.md" with { type: "text" };

// ── Sidecar / override ───────────────────────────────────────────────────────
const PROMPT_SIDECAR = sidecarPath("mme-time-filter.prompt.md");

const resolvePrompt = createSidecar(PROMPT_SIDECAR, embeddedPrompt);

export interface TimeFilter {
	/** Cleaned query with time expressions removed. */
	query: string;
	/** Start of time window — Unix seconds, inclusive. Undefined = no lower bound. */
	ts_after?: number;
	/** End of time window — Unix seconds, inclusive. Undefined = no upper bound. */
	ts_before?: number;
	/** Source type filter — "session" | "file" | "observation" | undefined (all sources). */
	source?: "session" | "file" | "observation";
}

/**
 * Resolve a recall query via LLM temporal parser.
 *
 * The LLM handles detection: if no time reference is present it returns
 * the original query unchanged with null timestamps — no client-side
 * regex gate needed. Falls back to the original query on any error.
 */
export async function resolveTimeFilter(
	query: string,
	config: MmemoryConfig,
	registry: ModelRegistry,
	settings?: import("../../config/settings").Settings,
): Promise<TimeFilter> {
	logger.debug(`[mmemory] time-filter: query="${query}"`, { source: "mmemory" });
	const available = registry.getAvailable();
	if (!available.length) {
		return { query };
	}

	// Use callWithRole — handles model resolution, fallback chain, and completeSimple
	const nowMs   = Date.now();
	const nowUnix = Math.floor(nowMs / 1000);
	const nowIso  = new Date(nowMs).toISOString();
	const systemPrompt = resolvePrompt().replace("{{NOW}}", String(nowUnix));
	const text = await callWithRole({
		systemPrompt,
		userMessage: `[now: ${nowIso}  unix: ${nowUnix}] ${query}`,
		maxTokens: 256,
		roleValue: config.timeFilterModelRole ?? config.modelRole,
		extraRoles: ["memory"],
		logPrefix: "[mmemory] time-filter",
	}, registry, settings!);
	if (!text) return { query };

	try {
		// Strip optional markdown code fence
		const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
		const parsed = JSON.parse(json) as {
			query?: string;
			ts_after?: number | null;
			ts_before?: number | null;
			source?: string | null;
		};
		const validSources = ["session", "file", "observation"] as const;
		const result: TimeFilter = {
			query:     typeof parsed.query === "string" && parsed.query.trim() ? parsed.query.trim() : query,
			ts_after:  typeof parsed.ts_after  === "number" ? parsed.ts_after  : undefined,
			ts_before: typeof parsed.ts_before === "number" ? parsed.ts_before : undefined,
			source:    validSources.includes(parsed.source as any) ? parsed.source as TimeFilter["source"] : undefined,
		};
		logger.debug(
			`[mmemory] time-filter: "${query}" -> query="${result.query}" ts_after=${result.ts_after ?? "none"} ts_before=${result.ts_before ?? "none"} source=${result.source ?? "all"}`,
			{ source: "mmemory" },
		);
		return result;
	} catch (err) {
		logger.debug(`[mmemory] time-filter LLM failed (continuing without): ${err}`, { source: "mmemory" });
		return { query };
	}
}
