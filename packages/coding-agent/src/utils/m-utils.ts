/**
 * m-utils — Shared utilities for the "m" family of OMP extensions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 * The "m" family (mmemory, mprune, mreview, mtree, ...) shares a set of
 * recurring concerns. This file is the single home for those concerns so that
 * each tool does not re-implement them and so that bugs are fixed once.
 *
 * When you build a new "m" tool, LOOK HERE FIRST before writing boilerplate.
 *
 * Current concerns handled:
 *   1. createSidecar  — embedded-file / local-override pattern
 *   2. resolveRoleModel — role → model resolution with standard fallback chain
 *   3. callWithRole   — LLM call with role resolution in one step
 *
 * Candidates for future extraction (not yet here):
 *   - mreview-style "open in browser" event-bus pattern
 *   - extension config skeleton (enabled flag + model role field)
 *   - ensureScript (Python subprocess extraction) — currently in mmemory/index.ts
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PATTERN 1 — SIDECAR / EMBEDDED-FILE OVERRIDE  (createSidecar)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Problem: we want to ship a file (HTML, prompt, config) baked into the binary
 * but also allow users to customise it without rebuilding.
 *
 * Solution: on first use, compare the local file's mtime against BUILD_TIME.
 *   - No local file → flush embedded to disk so the user can edit it
 *   - local.mtime >= BUILD_TIME → use local (user has customised it)
 *   - local.mtime <  BUILD_TIME → embedded is newer (rebuild happened) → flush and use embedded
 *
 * BUILD_TIME is baked in at compile time via `--define process.env.BUILD_TIME=...`
 * in build-binary.ts. It equals `new Date().toISOString()` at the start of the
 * build script — slightly before the binary file is written, which is intentional:
 * it means a file written by the user AFTER a build is always treated as newer.
 *
 * The resolver is cached in memory — disk IO fires exactly once per process.
 *
 * Usage:
 *   import rawHtml from "../../assets/my-tool.html" with { type: "text" };
 *   import * as os from "node:os";
 *   import { resolve as resolvePath } from "node:path";
 *
 *   const SIDECAR =
 *     process.env.PI_COMPILED === "true"
 *       ? resolvePath(process.execPath, "..", "my-tool.html")       // next to omp.exe
 *       : resolvePath(os.homedir(), ".omp", "my-tool.html");         // dev: ~/.omp/
 *
 *   const resolveHtml = createSidecar(SIDECAR, rawHtml);
 *   // ... later ...
 *   const html = resolveHtml();   // fast after first call
 *
 * Naming convention for sidecar files:
 *   - HTML/UI:      <tool-name>-ui.html    (e.g. mreview-ui.html)
 *   - Prompts/text: m<tool>-<purpose>.prompt.md  (e.g. mme-time-filter.prompt.md)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PATTERN 2 — ROLE → MODEL RESOLUTION  (resolveRoleModel)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Problem: every m-extension that calls an LLM needs to find the right model.
 * The model is specified in config as a role name (e.g. "memory", "prune")
 * but `completeSimple` needs the actual model object. The resolution chain
 * has bitten us multiple times (getAll() vs getAvailable(), apiKey crashes).
 *
 * Solution: one function with the correct pattern, documented once.
 *
 * Registry rules (see also .role2model-mapping.md in repo root):
 *   ctx.modelRegistry        — use in extension handlers (api.on / ctx.*)
 *   runtime.ctx.session.modelRegistry  — use in slash command handlers
 *   NEVER call .getAll() on ctx.modelRegistry — it is undefined at runtime
 *   NEVER call .getApiKey() — completeSimple resolves the key internally
 *
 * Usage:
 *   const model = resolveRoleModel(config.modelRole, registry, settings, ["memory"]);
 *   if (!model) { logger.warn("no model"); return; }
 *   // pass model to completeSimple or callWithRole
 *
 * @param roleValue  Primary role from config (e.g. config.modelRole).
 *                   Pass undefined or "default" to skip to fallbacks.
 * @param registry   ctx.modelRegistry (extension) OR runtime.ctx.session.modelRegistry (slash cmd)
 * @param settings   Settings singleton
 * @param extras     Extra modelRoles.* keys to try before "smol", in order.
 *                   e.g. ["memory"] tries modelRoles.memory before modelRoles.smol
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PATTERN 3 — LLM CALL WITH ROLE RESOLUTION  (callWithRole)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Problem: each m-extension that calls an LLM duplicates: resolve model →
 * guard against null → call completeSimple → extract text → catch errors.
 *
 * Solution: callWithRole combines all three steps. Returns the text content
 * of the first response message, or null on any failure (model not found,
 * network error, empty response). Never throws.
 *
 * Usage:
 *   const text = await callWithRole({
 *     systemPrompt: resolvePrompt(),
 *     userMessage: `[now: ${nowIso}] ${query}`,
 *     maxTokens: 256,
 *     roleValue: config.modelRole,
 *     extraRoles: ["memory"],
 *     logPrefix: "[mmemory] time-filter",
 *   }, registry, settings);
 *   if (!text) return fallback;
 *   const parsed = JSON.parse(text);
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { completeSimple } from "@oh-my-pi/pi-ai";
type CompleteSimpleOptions = Parameters<typeof completeSimple>[0];
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";

// ── BUILD_TIME ────────────────────────────────────────────────────────────────
// Baked in at compile time via --define process.env.BUILD_TIME in build-binary.ts.
// Falls back to Unix epoch in dev / test (treats every local file as "newer").
const BUILD_TIME = new Date(process.env.BUILD_TIME ?? 0);


// ══════════════════════════════════════════════════════════════════════════════
// 0. sidecarPath
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Return the full filesystem path for a named sidecar file.
 *
 * Resolution order (highest → lowest priority):
 *   1. <agentDir>/sidecars/<filename>  — per-agent override  (PI_CODING_AGENT_DIR)
 *   2. <binaryDir>/sidecars/<filename> — machine-wide default (layer="binary")
 *   3. embedded in binary              — createSidecar fallback
 *
 * Different agents (Russian, English, specialist) get their own layer by pointing
 * PI_CODING_AGENT_DIR at a different directory containing a sidecars/ subdirectory.
 *
 * @param filename  Bare filename — no path separators. e.g. "mme-time-filter.prompt.md"
 * @param layer     "agent" (default) | "binary"
 */
export function sidecarPath(filename: string, layer: "agent" | "binary" = "agent"): string {
	if (layer === "binary") return join(dirname(process.execPath), "sidecars", filename);
	return join(getAgentDir(), "sidecars", filename);
}
// ══════════════════════════════════════════════════════════════════════════════
// 1. createSidecar
// ══════════════════════════════════════════════════════════════════════════════

export function createSidecar(sidecarPath: string, embedded: string): () => string {
	let cached: string | undefined;
	return function resolve(): string {
		if (cached !== undefined) return cached;
		try {
			const { mtimeMs } = statSync(sidecarPath);
			if (mtimeMs >= BUILD_TIME.getTime()) {
				cached = readFileSync(sidecarPath, "utf-8");
				return cached;
			}
		} catch {
			// Missing or unreadable — fall through to flush
		}
		// Embedded is newer (or file missing): write so user can edit from latest
		try {
			mkdirSync(dirname(sidecarPath), { recursive: true });
			writeFileSync(sidecarPath, embedded, "utf-8");
		} catch {
			// Write failed (read-only install) — serve from memory silently
		}
		cached = embedded;
		return cached;
	};
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. resolveRoleModel
// ══════════════════════════════════════════════════════════════════════════════

export function resolveRoleModel(
	roleValue: string | undefined,
	registry: Pick<ModelRegistry, "getAvailable">,
	settings: Settings,
	extras: string[] = [],
): ReturnType<typeof resolveModelRoleValue>["model"] {
	const effectiveRole =
		(roleValue && roleValue !== "default" ? roleValue : undefined) ??
		extras
			.map(k => (settings.get("modelRoles") as Record<string, string | undefined>)[k])
			.find(v => v != null) ??
		(settings.get("modelRoles") as Record<string, string | undefined>)["smol"] ??
		(settings.get("modelRoles") as Record<string, string | undefined>)["default"];

	const resolved = resolveModelRoleValue(effectiveRole, registry.getAvailable(), {
		modelRegistry: registry as ModelRegistry,
	});
	return resolved.model;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. callWithRole
// ══════════════════════════════════════════════════════════════════════════════

export interface CallWithRoleOptions {
	/** System prompt (from createSidecar or inline string). */
	systemPrompt: string;
	/** User message to send. */
	userMessage: string;
	/** Max tokens for the response. Default: 1024. */
	maxTokens?: number;
	/** Primary role value from config (e.g. config.modelRole). */
	roleValue?: string;
	/** Extra modelRoles.* keys to try before smol (e.g. ["memory", "prune"]). */
	extraRoles?: string[];
	/** Log prefix for debug/warn messages (e.g. "[mmemory] time-filter"). */
	logPrefix?: string;
}

export async function callWithRole(
	opts: CallWithRoleOptions,
	registry: Pick<ModelRegistry, "getAvailable">,
	settings: Settings,
): Promise<string | null> {
	const model = resolveRoleModel(opts.roleValue, registry, settings, opts.extraRoles ?? []);
	if (!model) {
		if (opts.logPrefix) {
			logger.debug(`${opts.logPrefix} no model resolved — skipping`, { source: "m-utils" });
		}
		return null;
	}
	try {
		const response = await completeSimple(model, {
			systemPrompt: opts.systemPrompt ? [opts.systemPrompt] : undefined,
			messages: [
				{ role: "user", content: [{ type: "text", text: opts.userMessage }], timestamp: Date.now() },
			],
		}, {
			maxTokens: opts.maxTokens ?? 1024,
		});
		return (response.content ?? [])
			.filter((c: { type: string }) => c.type === "text")
			.map((c: { type: string; text?: string }) => c.text ?? "")
			.join("")
			.trim() || null;
	} catch (err) {
		if (opts.logPrefix) {
			logger.debug(`${opts.logPrefix} LLM call failed: ${err}`, { source: "m-utils" });
		}
		return null;
	}
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. resolveTemplateModelSpec
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve a template model: field value to a concrete model string.
 *
 * Handles:
 *   "slow"                       → settings.modelRoles["slow"] → concrete model string
 *   "smol"                       → settings.modelRoles["smol"] → concrete model string
 *   "vision"                     → settings.modelRoles["vision"] → concrete model string
 *   "openrouter/xiaomi/mimo-v2-flash" → returned as-is (already a concrete provider/model)
 *   "claude-sonnet-4"            → returned as-is (no modelRoles key found)
 *
 * Used by m-prompt-template/model-selection.ts to translate role names from template
 * frontmatter before doing the model registry lookup.
 *
 * @param spec      Value from template model: frontmatter field
 * @param settings  OMP settings (for modelRoles resolution)
 * @returns Concrete model string, or the original spec if no resolution found
 */
export function resolveTemplateModelSpec(spec: string, settings: Settings): string {
	const roles = settings.get("modelRoles") as Record<string, string | undefined>;
	return roles[spec] ?? spec;
}
