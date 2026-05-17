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
 *   4. formatBlock    — XML block renderer for system prompt injection
 *   5. showMPanel     — render a panel into chat, excluded from LLM context
 *   6. appendCustomResult / flushCustomResults — inject tool output into LLM
 *      context with the same streaming guard as recordBashResult. Use this
 *      when the LLM must see the output (unlike showMPanel / showStatus).
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
import { completeSimple, type CompleteSimpleOptions } from "@oh-my-pi/pi-ai";
import { Markdown, Spacer, Text } from "@oh-my-pi/pi-tui";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { DynamicBorder } from "../modes/components/dynamic-border";
import { getMarkdownTheme, theme } from "../modes/theme/theme";
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
		// Attempt to load from the user-editable sidecar file.
		let fromFile: string | undefined;
		try {
			const { mtimeMs } = statSync(sidecarPath);
			if (mtimeMs >= BUILD_TIME.getTime()) {
				fromFile = readFileSync(sidecarPath, "utf-8");
			}
		} catch {
			// Missing or unreadable — fall through to embedded
		}
		if (fromFile !== undefined) {
			if (!fromFile) throw new Error(`[createSidecar] sidecar file is empty: ${sidecarPath}`);
			cached = fromFile;
			return cached;
		}
		// Embedded is newer (or file missing): write so user can edit from latest
		try {
			mkdirSync(dirname(sidecarPath), { recursive: true });
			writeFileSync(sidecarPath, embedded, "utf-8");
		} catch {
			// Write failed (read-only install) — serve from memory silently
		}
		if (!embedded) throw new Error(`[createSidecar] embedded fallback is empty: ${sidecarPath}`);
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
			.map(k => settings.get(`modelRoles.${k}` as "modelRoles.smol"))
			.find(v => v != null) ??
		settings.get("modelRoles.smol") ??
		settings.get("modelRoles.default" as "modelRoles.smol");

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
			systemPrompt: opts.systemPrompt,
			messages: [
				{ role: "user", content: [{ type: "text", text: opts.userMessage }], timestamp: Date.now() },
			],
		} as CompleteSimpleOptions, {
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
// 4. formatBlock
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Render a tagged XML block for system prompt injection.
 *
 * Returns an empty string when `lines` is empty — never emits an empty tag pair.
 * Callers compose sibling blocks by concatenating non-empty results.
 *
 * @param tag   XML tag name (no angle brackets), e.g. "memories"
 * @param lines Content lines; each is written verbatim, one per line.
 *
 * @example
 *   formatBlock("memories", ["• fact one", "• fact two"])
 *   // → "<memories>\n• fact one\n• fact two\n</memories>"
 */
export function formatBlock(tag: string, lines: string[]): string {
	if (lines.length === 0) return "";
	return `<${tag}>\n${lines.join("\n")}\n</${tag}>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. showMPanel
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Render a titled markdown panel into the chat container, excluded from LLM context.
 * Equivalent to the `!!` command pattern — visible to the user, never sent to the model.
 *
 * Keeps core UI imports (Markdown, DynamicBorder, theme) inside "m" space so that
 * slash command handlers don't need to import core UI machinery directly.
 *
 * @param ctx    InteractiveModeContext from the slash command runtime
 * @param title  Accent-coloured header line (e.g. "Memory Recall Snapshot")
 * @param markdown  Markdown body to render
 */
export function showMPanel(
	ctx: { chatContainer: { addChild: (c: unknown) => void }; ui: { requestRender: () => void } },
	title: string,
	markdown: string,
): void {
	ctx.chatContainer.addChild(new Spacer(1));
	ctx.chatContainer.addChild(new DynamicBorder());
	ctx.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
	ctx.chatContainer.addChild(new Spacer(1));
	ctx.chatContainer.addChild(new Markdown(markdown.trim(), 1, 1, getMarkdownTheme()));
	ctx.chatContainer.addChild(new DynamicBorder());
	ctx.ui.requestRender();
}


// ═══════════════════════════════════════════════════════════════════════════
// 5. resolveTemplateModelSpec (m-prompt-template support)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve a template model: / role: field to a concrete model string.
 * Used by m-prompt-template/activate.ts role resolver.
 */
export function resolveTemplateModelSpec(spec: string, settings: import("../config/settings").Settings): string {
	const roles = settings.get("modelRoles") as Record<string, string | undefined>;
	return roles[spec] ?? spec;
}
// ══════════════════════════════════════════════════════════════════════════════
// 6. appendCustomResult
// ══════════════════════════════════════════════════════════════════════════════
// Injects tool output into LLM context WITHOUT triggering a new LLM turn and
// WITHOUT rendering to the session view.
//
// Mechanism: agent.appendMessage with display:false — synchronous array push to
// agent.#state.messages. No events emitted. No render triggered. convertToLlm
// does not check the display flag, so LLM sees content verbatim on next turn.
// scheduleInput fires via setImmediate (next tick), by which point the message
// is already in agent.#state.messages.
//
// Use alongside showStatus in asyncDisplay:
//   showStatus(text)                  → "!" panel for user (real-time visibility)
//   appendCustomResult(session, ...) → LLM context only (seen when woken)
//
// The combination does NOT wake the LLM — waking is done exclusively by asyncSubmit.
// ══════════════════════════════════════════════════════════════════════════════

/** Minimal session shape — avoids circular import with agent-session.ts. */
interface CustomResultSession {
	readonly agent: {
		appendMessage(msg: { role: "custom"; customType: string; content: string; display: boolean; timestamp: number }): void;
	};
}

/**
 * Inject content into LLM context for the next turn — no rendering, no LLM wake.
 * Caller must also call showStatus(text) for user visibility via "!" panel.
 *
 * @param session    AgentSession (runtime.ctx.session)
 * @param customType Label stored on the message, e.g. "mtuicontrol"
 * @param content    Text the LLM will see verbatim when woken by asyncSubmit
 */
export function appendCustomResult(session: CustomResultSession, customType: string, content: string): void {
	session.agent.appendMessage({ role: "custom", customType, content, display: false, timestamp: Date.now() });
}