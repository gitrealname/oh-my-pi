/**
 * mprune — Dynamic context pruning extension for aws-corp branch.
 *
 * Inspired by pi-context-prune (https://github.com/getpi/context-prune) by the Pi team — MIT.
 *
 * Registered as an inline ExtensionFactory in sdk.ts alongside createMmemoryExtension.
 * No sidecar file needed — compiled into the binary.
 *
 * Responsibilities:
 *   - Insertion-time trim: large tool results trimmed at write time (tool_result event)
 *   - Batch summarization: summarize completed tool-call batches on agent-message turns
 *   - Image aging: replace aged image bytes with a text placeholder
 *   - Stats: per-session in-memory + lifetime persistent to getAgentDir()/mprune-stats.json
 *
 * Pure logic lives in src/session/compaction/mprune-*.ts (tested independently).
 *
 * Design notes:
 *   - agent-message trigger = turn_end where toolResults.length === 0
 *   - Batches are accumulated in-memory per session across tool-calling turns,
 *     then flushed when the text-only turn fires.
 *   - rewriteEntries() is not on ReadonlySessionManager — cast is intentional
 *     and contained to this file. See design doc gap 1b for flushSessionEntries() PR.
 */
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { resolveRoleModel } from "../../utils/m-utils";
import { settings } from "../../config/settings";
import { captureBatch, serializeBatchForSummarizer, type PruneBatch } from "../../session/compaction/mprune-batch";
import { findAgedImages, makePlaceholder } from "../../session/compaction/mprune-images";
import { buildSummarizerPrompt } from "../../session/compaction/mprune-prompt";
import {
	accumulateStats,
	charsToTokens,
	createSessionStats,
	estimateBatchSavings,
	estimateTrimSavings,
	IMAGE_TOKEN_ESTIMATE,
	loadPersistentStats,
	savePersistentStats,
	type MpruneSessionStats,
} from "../../session/compaction/mprune-stats";
import { trimToolResult } from "../../session/compaction/mprune-trim";
import type { ExtensionAPI, ExtensionContext } from "./types";
import type { ReadonlySessionManager, SessionManager } from "../../session/session-manager";

// ── Per-session state ─────────────────────────────────────────────────────────

interface MpruneSessionState {
	/** Accumulated tool-call batches since last flush, in turn order. */
	pendingBatches: PruneBatch[];
	/** Per-session token-savings accounting. */
	stats: MpruneSessionStats;
	/** Pending session stats not yet flushed to disk (accumulated across flushes). */
	unpersisted: MpruneSessionStats;
}

const sessionMap = new WeakMap<ReadonlySessionManager, MpruneSessionState>();

function getOrCreateState(ctx: ExtensionContext): MpruneSessionState | null {
	if (!settings.get("mprune.enabled")) return null;
	if (ctx.taskDepth > 0) return null; // subagent guard
	let state = sessionMap.get(ctx.sessionManager);
	if (!state) {
		state = {
			pendingBatches: [],
			stats: createSessionStats(),
			unpersisted: createSessionStats(),
		};
		sessionMap.set(ctx.sessionManager, state);
	}
	return state;
}

// ── Stats persistence ─────────────────────────────────────────────────────────

function flushStatsToDisk(state: MpruneSessionState): void {
	const u = state.unpersisted;
	const hasWork =
		u.tokensSavedTrim > 0 || u.tokensSavedBatch > 0 || u.tokensSavedImages > 0;
	if (!hasWork) return;
	try {
		const agentDir = getAgentDir();
		const persistent = loadPersistentStats(agentDir);
		const updated = accumulateStats(persistent, u);
		savePersistentStats(agentDir, updated);
		// Reset unpersisted counter — session stats remain for /mprune stats display.
		state.unpersisted = createSessionStats();
		logger.debug("[mprune] stats persisted", {
			trim: u.tokensSavedTrim,
			batch: u.tokensSavedBatch,
			images: u.tokensSavedImages,
		});
	} catch (err) {
		logger.warn("[mprune] stats flush failed", { error: String(err) });
	}
}

// ── Summarizer call ───────────────────────────────────────────────────────────

async function summarizeBatches(
	batches: PruneBatch[],
	ctx: ExtensionContext,
): Promise<string | null> {
	const registry = ctx.modelRegistry;
	const model = resolveRoleModel(undefined, registry, settings, ["prune"]);
	logger.debug("[mprune] resolving prune model", { model: model?.id });
	if (!model) {
		logger.warn("[mprune] no model resolved (prune/smol/default all unset or unresolvable)");
		return null;
	}

	const serialized = batches.map(b => serializeBatchForSummarizer(b)).join("\n\n");
	const response = await completeSimple(
		model,
		{
			systemPrompt: buildSummarizerPrompt(),
			messages: [{ role: "user", content: [{ type: "text", text: serialized }], timestamp: Date.now() }],
		},
	);

	if (response.stopReason === "error" || !response.content) return null;
	return response.content
		.filter((c: { type: string }) => c.type === "text")
		.map((c: { type: string; text?: string }) => c.text ?? "")
		.join("");
}

// ── Extension factory ─────────────────────────────────────────────────────────

export function createMpruneExtension(api: ExtensionAPI): void {
	api.setLabel("mprune");

	// ── session_start: log active configuration ───────────────────────────────
	api.on("session_start", (_event, ctx) => {
		if (!settings.get("mprune.enabled")) {
			logger.debug("[mprune] disabled — all handlers are no-ops");
			return;
		}
		if (ctx.taskDepth > 0) return; // subagent — silent
		logger.info("[mprune] active", {
			imagesKeepTurns: settings.get("mprune.images.keepTurns"),
			softTrimChars:   settings.get("mprune.trim.softTrimChars"),
			pruneModel:      settings.get("modelRoles.prune" as "modelRoles.smol") ?? "(fallback to default)",
		});
	});

	// ── tool_result: insertion-time trim ──────────────────────────────────────
	api.on("tool_result", (event, ctx) => {
		if (!settings.get("mprune.enabled")) return;
		const maxChars = settings.get("mprune.trim.softTrimChars");
		if (!maxChars) return;

		// Calculate savings before trimming so we have the original length.
		const beforeChars = event.content
			.filter((b: { type: string }) => b.type === "text")
			.reduce((n: number, b: { type: string; text?: string }) => n + (b.text?.length ?? 0), 0);

		const trimmed = trimToolResult(event.content, maxChars);
		if (trimmed === event.content) return; // nothing trimmed

		const afterChars = trimmed
			.filter((b: { type: string }) => b.type === "text")
			.reduce((n: number, b: { type: string; text?: string }) => n + (b.text?.length ?? 0), 0);

		const state = getOrCreateState(ctx);
		if (state) {
			const saved = estimateTrimSavings(beforeChars, afterChars);
			state.stats.tokensSavedTrim += saved;
			state.stats.trimEvents++;
			state.unpersisted.tokensSavedTrim += saved;
			state.unpersisted.trimEvents++;
		}

		logger.debug("[mprune] trimmed tool result", {
			toolName: event.toolName,
			beforeChars,
			afterChars,
			tokensSaved: state ? estimateTrimSavings(beforeChars, afterChars) : 0,
		});
		return { content: trimmed };
	});

	// ── turn_end: accumulate batch from tool-calling turns ────────────────────
	api.on("turn_end", (event, ctx) => {
		if (event.toolResults.length === 0) return;
		const state = getOrCreateState(ctx);
		if (!state) return;
		const batch = captureBatch(event);
		if (batch.toolResults.length === 0) return;
		state.pendingBatches.push(batch);
		logger.debug("[mprune] captured batch", { turnIndex: event.turnIndex, toolCount: batch.toolResults.length });
	});

	// ── turn_end: flush on agent-message (text-only) turn ─────────────────────
	api.on("turn_end", async (event, ctx) => {
		if (event.toolResults.length > 0) return;
		const state = getOrCreateState(ctx);
		if (!state || state.pendingBatches.length === 0) return;

		const batchesToFlush = state.pendingBatches.splice(0);
		const rawChars = batchesToFlush
			.flatMap(b => b.toolResults)
			.reduce((n, r) => n + r.charCount, 0);

		logger.debug("[mprune] flushing batches", {
			batches: batchesToFlush.length,
			rawChars,
		});

		let summary: string | null = null;
		try {
			summary = await summarizeBatches(batchesToFlush, ctx);
		} catch (err) {
			logger.warn("[mprune] summarizer error", { error: String(err) });
			return;
		}
		if (!summary) {
			logger.debug("[mprune] summarizer returned no content — skipping flush", {
				batches: batchesToFlush.length,
				rawChars,
			});
			return;
		}

		api.sendMessage(
			{ customType: "mprune_summary", content: summary, display: false as unknown as string },
			{ deliverAs: "steer" },
		);

		// Replace content of summarized tool results with a placeholder and mark prunedAt.
		// Without this, the original verbose content remains in the session and still costs
		// tokens on every subsequent API call — defeating the purpose of summarization.
		// This mirrors what OMP's pruneToolOutputs() does (pruning.ts:85) but for mprune-handled entries.
		const entries = ctx.sessionManager.getBranch();
		const prunedAt = Date.now();
		const prunedIds = new Set(
			batchesToFlush.flatMap(b => b.toolResults.map(r => r.toolCallId)),
		);
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const msg = entry.message as { role: string; toolCallId?: string; prunedAt?: number; content?: unknown };
			if (msg.role !== "toolResult") continue;
			if (!prunedIds.has(msg.toolCallId ?? "")) continue;
			msg.content = [{ type: "text", text: "[summarized by mprune — see context above]" }];
			msg.prunedAt = prunedAt;
		}

		// as any: rewriteEntries() not on ReadonlySessionManager by design. See file header.
		await (ctx.sessionManager as any as SessionManager).rewriteEntries();

		// Record savings.
		const saved = estimateBatchSavings(rawChars, summary.length);
		state.stats.tokensSavedBatch += saved;
		state.stats.batchFlushes++;
		state.unpersisted.tokensSavedBatch += saved;
		state.unpersisted.batchFlushes++;

		flushStatsToDisk(state);
		logger.debug("[mprune] flush complete", { tokensSaved: saved });
	});

	// ── turn_end: image aging ──────────────────────────────────────────────────
	api.on("turn_end", async (event, ctx) => {
		if (!settings.get("mprune.enabled")) return;
		const keepTurns = settings.get("mprune.images.keepTurns");
		if (!keepTurns) return;
		if (ctx.taskDepth > 0) return;

		const entries = ctx.sessionManager.getBranch();
		const aged = findAgedImages(entries, event.turnIndex, keepTurns);
		if (aged.length === 0) return;

		for (const { entryIndex, imageTurnIndex } of aged) {
			const entry = entries[entryIndex];
			if (entry.type !== "message") continue;
			const msg = entry.message as { content: unknown };
			if (!Array.isArray(msg.content)) continue;
			const mimeTypes = (msg.content as Array<{ type: string; mimeType?: string }>)
				.filter((b: { type: string }) => b.type === "image")
				.map((b: { type: string; mimeType?: string }) => b.mimeType ?? "image/*");
			msg.content = (msg.content as Array<{ type: string; mimeType?: string }>).map(block => {
				if (block.type !== "image") return block;
				return { type: "text", text: makePlaceholder(block.mimeType ?? "image/*", imageTurnIndex) };
			});
			logger.debug("[mprune] replaced aged image", { entryIndex, imageTurnIndex, mimeTypes });
		}

		await (ctx.sessionManager as any as SessionManager).rewriteEntries();

		// Record savings: each pruned image = IMAGE_TOKEN_ESTIMATE tokens.
		const state = getOrCreateState(ctx);
		if (state) {
			const saved = aged.length * IMAGE_TOKEN_ESTIMATE;
			state.stats.tokensSavedImages += saved;
			state.stats.imagesPruned += aged.length;
			state.unpersisted.tokensSavedImages += saved;
			state.unpersisted.imagesPruned += aged.length;
			flushStatsToDisk(state);
		}

		logger.debug("[mprune] pruned aged images", { count: aged.length, turnIndex: event.turnIndex });
	});

	// ── session_shutdown: flush any remaining unpersisted stats ───────────────
	api.on("session_shutdown", (_event, ctx) => {
		if (ctx.taskDepth > 0) return;
		const state = sessionMap.get(ctx.sessionManager);
		if (!state) return;
		flushStatsToDisk(state);
	});
}

/**
 * Retrieve session stats for the current session manager.
 * Returns null if mprune is disabled or no session state exists yet.
 * Used by the /mprune stats command in builtin-registry.ts.
 */
export function getMpruneSessionStats(sessionManager: ReadonlySessionManager): MpruneSessionStats | null {
	return sessionMap.get(sessionManager)?.stats ?? null;
}
