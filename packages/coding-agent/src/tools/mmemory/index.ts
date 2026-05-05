/**
 * mmemory core execution functions.
 *
 * These are called by:
 *   - The /mmemory slash command handler (builtin-registry.ts)
 *   - MmemoryRetainTool, MmemoryRecallTool, MmemoryReflectTool
 *
 * Storage layout (`<storageRoot>/`):
 *   queue/                      transient .md files; deleted after build processes them
 *     YYYYMMDD-HHMMSS-<sessionId>.md   auto-retain (overwritten each cycle)
 *     YYYYMMDD-HHMMSS-note-<id>.md     tool-initiated retains
 *   chunks.json               DURABLE STORE — full chunk texts, append-only
 *   vectors.safetensors       rebuildable from chunks.json
 *   vectors.meta.json         chunk hashes for incremental embedding
 *   facts.json                Phase 3: extracted facts
 *   mental_models/            Phase 3: seeded summaries
 *   kb_config.yaml            auto-generated registry entry
 *
 * storageRoot defaults to $PI_CODING_AGENT_DIR/mmemory/ (launched via o/ow),
 * <exe-dir>/extensions/mmemory/ (compiled), or ~/.omp/mmemory/ (dev).
 */
import * as fs from "node:fs/promises";
import * as os from "os";
import * as path from "path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import { MmemoryServerClient } from "./server-client";
import mmemoryServerPy from "./mmemory_server.py" with { type: "text" };
import { resolveTimeFilter } from "./time-filter";

// ── Config ────────────────────────────────────────────────────────────────────

export interface MmemoryConfig {
	storageRoot: string;
	projectLabel: string;
	agentTag: string;
	modelRole: string;
	consolidateModelRole: string;
	timeFilterModelRole: string;
	retainMission: string;
	extractionMode: "structured" | "verbatim";
	scoping: "per-project" | "global";
	retainEveryNTurns: number;
	retainContextTurns: number;
	recallMaxQueryChars: number;
	recallLimit: number;
	recallDeadlineMs: number;
	recencyWeight: number;
	deduplicationThreshold: number;
	serverIdleTimeoutMinutes: number;
	serverPort: number;
	serverLogFile: string | undefined;
	autoRetain: boolean;
	maxTranscriptChars: number;
	maxRawFacts: number;
}

/** Normalize a filesystem path to a stable project label.
 *  Replaces backslashes with forward slashes; strips drive colon.
 *  `D:\.ai` → `D/.ai`, `C:\repos\carity2` → `C/repos/carity2` */
function normalizeCwd(p: string): string {
	return p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1");
}

export function loadMmemoryConfig(settings: Settings, cwd?: string): MmemoryConfig | null {
	if (!settings.get("mmemory.enabled")) return null;

	const rawStorageRoot = settings.get("mmemory.storageRoot");
	const storageRoot = rawStorageRoot
		? rawStorageRoot.replace(/^~/, os.homedir())
		: process.env.PI_CODING_AGENT_DIR
			? path.join(process.env.PI_CODING_AGENT_DIR, "mmemory")
			: process.env.PI_COMPILED === "true"
				? path.join(path.dirname(process.execPath), "extensions", "mmemory")
				: path.join(os.homedir(), ".omp", "mmemory");

	return {
		storageRoot,
		modelRole:               settings.get("mmemory.modelRole")               ?? "smol",
		consolidateModelRole:    settings.get("mmemory.consolidateModelRole")     ?? settings.get("mmemory.modelRole") ?? "smol",
		timeFilterModelRole:     settings.get("mmemory.timeFilterModelRole")      ?? settings.get("mmemory.modelRole") ?? "smol",
		agentTag:                settings.get("mmemory.agentTag")               ?? "default",
		projectLabel:            normalizeCwd(cwd ?? process.cwd()),
		retainMission:           settings.get("mmemory.retainMission")            ?? "Focus on technical decisions, API contracts, constraints, error patterns, and project conventions",
		extractionMode:          settings.get("mmemory.extractionMode"),
		scoping:                 settings.get("mmemory.scoping"),
		retainEveryNTurns:       settings.get("mmemory.retainEveryNTurns"),
		retainContextTurns:      settings.get("mmemory.retainContextTurns"),
		recallMaxQueryChars:     settings.get("mmemory.recallMaxQueryChars"),
		recallLimit:             settings.get("mmemory.recallLimit"),
		recallDeadlineMs:        settings.get("mmemory.recallDeadlineMs"),
		recencyWeight:           settings.get("mmemory.recencyWeight"),
		deduplicationThreshold:  settings.get("mmemory.deduplicationThreshold"),
		serverIdleTimeoutMinutes: settings.get("mmemory.serverIdleTimeoutMinutes"),
		serverPort:              settings.get("mmemory.serverPort"),
		serverLogFile:           settings.get("mmemory.serverLogFile")?.replace(/^~/, os.homedir()),
		autoRetain:              settings.get("mmemory.autoRetain"),
		maxTranscriptChars:      settings.get("mmemory.maxTranscriptChars"),
		maxRawFacts:             settings.get("mmemory.maxRawFacts"),
	};
}

/** Resolved storage paths for a project. */
export interface MmemoryPaths {
	projectDir: string;       // storageRoot
	queueDir: string;         // storageRoot/queue  (transient .md files, deleted after build)
	chunksPath: string;       // storageRoot/chunks.json  (durable store)
	vectorsPath: string;      // storageRoot/vectors.safetensors
	vectorsMetaPath: string;  // storageRoot/vectors.meta.json
	factsPath: string;        // projectDir/facts.json  (Phase 3)
	observationsPath: string; // projectDir/observations.json  (Phase 3)
	mentalModelsDir: string;  // projectDir/mental_models  (Phase 3)
}

export function resolvePaths(config: MmemoryConfig): MmemoryPaths {
	const projectDir = config.storageRoot;
	return {
		projectDir,
		queueDir: path.join(projectDir, "queue"),
		chunksPath: path.join(projectDir, "chunks.json"),
		vectorsPath: path.join(projectDir, "vectors.safetensors"),
		vectorsMetaPath: path.join(projectDir, "vectors.meta.json"),
		factsPath: path.join(projectDir, "facts.json"),
		observationsPath: path.join(projectDir, "observations.json"),
		mentalModelsDir: path.join(projectDir, "mental_models"),
	};
}




// ── Recall query composition ──────────────────────────────────────────────────

export const STRIP_TAGS_REGEX = /<memories>[\s\S]*?<\/memories>|<mental_models>[\s\S]*?<\/mental_models>/g;

function stripMemoryTagsLocal(text: string): string {
	return text.replace(STRIP_TAGS_REGEX, "").trim();
}

/**
 * Slice messages to the last N turns, where a turn boundary is a user message.
 * Returns the trailing tail starting at the (N-th from the end) user message.
 */
export function sliceLastTurnsByUserBoundary(
	messages: { role: string; content: unknown }[],
	turns: number,
): { role: string; content: unknown }[] {
	if (messages.length === 0 || turns <= 0) return [];

	let userTurnsSeen = 0;
	let startIndex = -1;

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			userTurnsSeen += 1;
			if (userTurnsSeen >= turns) {
				startIndex = i;
				break;
			}
		}
	}

	return startIndex === -1 ? [...messages] : messages.slice(startIndex);
}

function extractMessageText(content: unknown): string {
	if (Array.isArray(content)) {
		return (content as { type: string; text?: string }[])
			.filter(c => c.type === "text")
			.map(c => c.text ?? "")
			.join(" ");
	}
	return String(content ?? "");
}

/**
 * Compose a recall query from the latest user prompt plus optional prior context.
 *
 * When `recallContextTurns <= 1` the query is just the trimmed latest prompt.
 * Otherwise we prepend a `Prior context:` block built from the trailing
 * `recallContextTurns` user-bounded turns (memory tags stripped, latest prompt
 * suppressed to avoid duplicating it inside the context block).
 */
export function composeRecallQuery(
	latestQuery: string,
	messages: { role: string; content: unknown }[],
	recallContextTurns: number,
): string {
	const latest = latestQuery.trim();
	if (recallContextTurns <= 1 || messages.length === 0) return latest;

	const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
	const contextLines: string[] = [];

	for (const msg of contextual) {
		const content = stripMemoryTagsLocal(extractMessageText(msg.content)).trim();
		if (!content) continue;
		if (msg.role === "user" && content === latest) continue;
		contextLines.push(`${msg.role}: ${content}`);
	}

	if (contextLines.length === 0) return latest;
	return ["Prior context:", contextLines.join("\n"), latest].join("\n\n");
}

/**
 * Truncate a composed recall query to `maxChars`.
 *
 * Always preserves the latest user message. Drops oldest context lines first
 * and degrades gracefully when even the latest message exceeds the budget.
 */
export function truncateRecallQuery(query: string, latestQuery: string, maxChars: number): string {
	if (maxChars <= 0 || query.length <= maxChars) return query;

	const latest = latestQuery.trim();
	const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;

	if (!query.includes("Prior context:")) return latestOnly;

	const contextMarker = "Prior context:\n\n";
	const markerIndex = query.indexOf(contextMarker);
	if (markerIndex === -1) return latestOnly;

	const suffix = `\n\n${latest}`;
	const suffixIndex = query.lastIndexOf(suffix);
	if (suffixIndex === -1) return latestOnly;
	if (suffix.length >= maxChars) return latestOnly;

	const contextBody = query.slice(markerIndex + contextMarker.length, suffixIndex);
	const contextLines = contextBody.split("\n").filter(Boolean);

	const kept: string[] = [];
	for (let i = contextLines.length - 1; i >= 0; i--) {
		kept.unshift(contextLines[i]);
		const candidate = `${contextMarker}${kept.join("\n")}${suffix}`;
		if (candidate.length > maxChars) {
			kept.shift();
			break;
		}
	}

	if (kept.length > 0) return `${contextMarker}${kept.join("\n")}${suffix}`;
	return latestOnly;
}

// ── Server singleton per port ─────────────────────────────────────────────────
//
// One server process handles all projects. The port is fixed and configurable
// (mmemory.serverPort, default 49200). Project identity travels in each request
// as `project_dir`. The singleton is keyed by port so multiple configs that
// share the same port (the common case) reuse the same client.

const serverMap = new Map<number, MmemoryServerClient>();
const serverCreating = new Map<number, Promise<MmemoryServerClient>>();

const MMEMORY_EXT_DIR = process.env.PI_COMPILED === "true"
	? path.join(path.dirname(process.execPath), "extensions")
	: path.join(os.homedir(), ".omp", "extensions");

const BUILD_TIME = new Date(process.env.BUILD_TIME ?? 0);

async function ensureScript(filename: string, content: string): Promise<string> {
	const dest = path.join(MMEMORY_EXT_DIR, filename);
	try {
		const { mtimeMs } = await fs.stat(dest);
		if (mtimeMs >= BUILD_TIME.getTime()) return dest;
		await fs.writeFile(dest, content, "utf-8");
	} catch {
		await fs.mkdir(MMEMORY_EXT_DIR, { recursive: true });
		await fs.writeFile(dest, content, "utf-8");
	}
	return dest;
}

export async function ensureServerScript(): Promise<string> {
	return ensureScript("mmemory_server.py", mmemoryServerPy);
}

export async function getOrCreateServerClient(config: MmemoryConfig): Promise<MmemoryServerClient> {
	const key = config.serverPort;
	const existing = serverMap.get(key);
	if (existing) return existing;
	let creating = serverCreating.get(key);
	if (!creating) {
		creating = (async () => {
			const serverScript = await ensureServerScript();
			const logFile = config.serverLogFile ?? path.join(config.storageRoot, "mmemory-server.log");
			const client = new MmemoryServerClient(
				serverScript,
				config.serverPort,
				logFile,
				config.serverIdleTimeoutMinutes,
			);
			serverMap.set(key, client);
			serverCreating.delete(key);
			return client;
		})();
		serverCreating.set(key, creating);
	}
	return creating;
}

export function disposeServerClient(config: MmemoryConfig): void {
	const key = config.serverPort;
	const client = serverMap.get(key);
	if (client) {
		void client.stop();
		serverMap.delete(key);
	}
	serverCreating.delete(key);
}

// ── Filename helpers ──────────────────────────────────────────────────────────

/**
 * YYYYMMDD-HHMMSS prefix — digits only, no colons (invalid on Windows).
 * Lexicographic sort = chronological sort.
 */
function timestampPrefix(d: Date = new Date()): string {
	const pad = (n: number, digits = 2) => String(n).padStart(digits, "0");
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	);
}

/**
 * Session file uses a FIXED timestamp (session start time) so repeated auto-retain
 * cycles overwrite the same file rather than accumulating copies.
 */
export function sessionFilename(sessionId: string, sessionStartTime: Date): string {
	return `${timestampPrefix(sessionStartTime)}-${sessionId}.md`;
}

/** Each tool-initiated retain is a unique note file. */
export function noteFilename(): string {
	return `${timestampPrefix()}-note-${Date.now().toString(36).slice(-6)}.md`;
}

// ── Core operations ───────────────────────────────────────────────────────────

// ── Private helpers ───────────────────────────────────────────────────────────

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const tmp = filePath + ".tmp";
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
	await fs.rename(tmp, filePath);
}

function parseJsonArrayOrWrapped(raw: string, wrapKey: string): unknown[] {
	// LLMs sometimes prefix JSON with prose (e.g. "Here are the facts:\n[...]").
	// Strip everything before the first '[' or '{' so JSON.parse doesn't choke.
	const trimmed = raw.trim();
	const arrayStart = trimmed.indexOf("[");
	const objectStart = trimmed.indexOf("{");
	const start =
		arrayStart === -1 ? objectStart
		: objectStart === -1 ? arrayStart
		: Math.min(arrayStart, objectStart);
	const jsonStr = start > 0 ? trimmed.slice(start) : trimmed;
	const parsed = JSON.parse(jsonStr);
	if (Array.isArray(parsed)) return parsed;
	const wrapped = (parsed as any)?.[wrapKey];
	return Array.isArray(wrapped) ? wrapped : [];
}

function keywordMatchAndMerge(
	items: unknown[],
	query: string,
	textFn: (item: unknown) => string,
	dateFn: (item: unknown) => string | undefined,
	boostFactor: number,
	quota: number,
	existing: { text: string; score?: number; when?: string }[],
	recallLimit: number,
): { text: string; score?: number; when?: string }[] {
	if (items.length === 0) return existing;
	const qwords = query.toLowerCase().match(/\b\w{3,}\b/g) ?? [];
	if (qwords.length === 0) return existing;
	const hits = items
		.map(item => {
			const txt = textFn(item).toLowerCase();
			const matching = qwords.filter(w => new RegExp(`\\b${w}\\b`).test(txt)).length;
			return { text: textFn(item), score: (matching / qwords.length) * boostFactor, when: dateFn(item) };
		})
		.filter(h => h.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, quota);
	if (hits.length === 0) return existing;
	const combined = [...hits, ...existing];
	const seen = new Set<string>();
	return combined
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
		.filter(r => {
			const key = r.text.slice(0, 80);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, recallLimit);
}

// ── Facts extraction & recall ─────────────────────────────────────────────────

export interface FactEntry {
	fact: string;
	entities?: string[];
	date?: string;
	extracted_at?: string;
}

/** Read and parse facts.json; returns [] on missing or corrupt file. */
export async function loadFacts(config: MmemoryConfig): Promise<FactEntry[]> {
	const { factsPath } = resolvePaths(config);
	try {
		const raw = await fs.readFile(factsPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((f): f is FactEntry => typeof f?.fact === "string");
	} catch {
		return [];
	}
}

/**
 * Orchestrator: parse LLM output, merge with existing facts.json, write atomically.
 * `extractFn` is provided by the caller (extension) and keeps this file free of
 * ExtensionContext.
 */
export async function executeMemoryExtract(
	config: MmemoryConfig,
	extractFn: () => Promise<string>,
): Promise<void> {
	const { factsPath } = resolvePaths(config);
	let rawOutput: string;
	try {
		rawOutput = await extractFn();
		logger.debug(`[mmemory] extract: LLM returned ${rawOutput.length} chars`, { source: "mmemory" });
	} catch (err) {
		logger.warn(`[mmemory] extractFn failed: ${err}`, { source: "mmemory" });
		return;
	}

	let newFacts: FactEntry[];
	try {
		const arr = parseJsonArrayOrWrapped(rawOutput, "facts");
		const today = new Date().toISOString().slice(0, 10);
		newFacts = arr
			.filter((f): f is FactEntry => typeof (f as any)?.fact === "string")
			.map(f => ({
				...(f as FactEntry),
				extracted_at: (f as FactEntry).extracted_at ?? today,
			}));
		logger.debug(`[mmemory] extract: parsed ${newFacts.length} facts from LLM output`, { source: "mmemory" });
	} catch (err) {
		logger.warn(`[mmemory] failed to parse LLM fact output: ${err} — raw: ${rawOutput.slice(0, 200)}`, { source: "mmemory" });
		return;
	}

	if (newFacts.length === 0) {
		logger.debug("[mmemory] extract: no new facts after filtering", { source: "mmemory" });
		return;
	}

	// Load existing, merge, dedup by fact string (case-insensitive)
	const existing = await loadFacts(config);
	const seen = new Set(existing.map(f => f.fact.toLowerCase()));
	const toAdd = newFacts.filter(f => !seen.has(f.fact.toLowerCase()));
	if (toAdd.length === 0) {
		logger.debug("[mmemory] extract: all facts already known, nothing to add", { source: "mmemory" });
		return;
	}

	const merged = [...existing, ...toAdd];
	try {
		await atomicWriteJson(factsPath, merged);
		logger.debug(`[mmemory] extract: wrote ${toAdd.length} new facts (total: ${merged.length})`, { source: "mmemory" });
	} catch (err) {
		logger.warn(`[mmemory] failed to write facts.json: ${err}`, { source: "mmemory" });
	}
}
export interface RecallResult {
	text: string;
	resultCount: number;
}

/**
 * Query memory for relevant chunks.
 * When scoping === "per-project-tagged", merges results from project + global dirs.
 */
export async function executeMemoryRecall(
	query: string,
	scope: string | undefined | null,
	config: MmemoryConfig,
	registry?: import("../config/model-registry").ModelRegistry,
	settings?: import("../config/settings").Settings,
): Promise<RecallResult> {
	const paths = resolvePaths(config);
	const client = await getOrCreateServerClient(config);

	// LLM time-filter: detect "yesterday", "last week", etc. and convert to timestamps
	const timeFilter = registry
		? await resolveTimeFilter(query, config, registry, settings)
		: { query };
	const resolvedQuery = timeFilter.query;

	// Resolve effective scope → project filter
	const effectiveScope = scope ?? config.scoping;
	const projectLabel = config.projectLabel;
	const scopeFilter: Record<string, unknown> =
		effectiveScope === null || effectiveScope === "global"
			? {}
			: effectiveScope === "per-project"
				? { project: projectLabel }
				: { project: effectiveScope };  // named project

	const filter: Record<string, unknown> = {
		...scopeFilter,
		// agent_tag filter — omitted on global scope so cross-agent recall works
		...(effectiveScope !== null && effectiveScope !== "global" && config.agentTag !== "default"
			? { agent_tag: config.agentTag }
			: {}),
		...(timeFilter.ts_after  !== undefined ? { ts_after:  timeFilter.ts_after  } : {}),
		...(timeFilter.ts_before !== undefined ? { ts_before: timeFilter.ts_before } : {}),
	};

	const recallArgs = {
		query: resolvedQuery,
		project_dir: paths.projectDir,
		filter,
		limit: config.recallLimit * 3,
		recency_weight: config.recencyWeight,
	};

	let results: any[];
	try {
		const response = await Promise.race([
			client.query("recall", recallArgs),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("recall timeout")), config.recallDeadlineMs),
			),
		]);
		results = ((response as any)?.results ?? []).slice(0, config.recallLimit);
	} catch (err) {
		return {
			text: `Memory recall unavailable: ${err instanceof Error ? err.message : String(err)}`,
			resultCount: 0,
		};
	}

	// ── Facts recall (additive — no-op when facts.json is empty) ──────────────
	const allFacts = await loadFacts(config);
	results = keywordMatchAndMerge(
		allFacts, query,
		f => (f as FactEntry).fact,
		f => (f as FactEntry).date ?? (f as FactEntry).extracted_at,
		1.2, Math.ceil(config.recallLimit / 3), results, config.recallLimit,
	);

	// ── Observations recall (additive — no-op when observations.json is empty) ──
	const allObservations = await loadObservations(config);
	results = keywordMatchAndMerge(
		allObservations, query,
		o => (o as ObservationEntry).observation,
		o => (o as ObservationEntry).date ?? (o as ObservationEntry).consolidated_at,
		1.5, Math.ceil(config.recallLimit / 4), results, config.recallLimit,
	);
	if (results.length === 0) return { text: "No relevant memories found.", resultCount: 0 };

	const lines: string[] = [];
	for (const r of results) {
		const when = r.when ? ` [${r.when}]` : "";
		lines.push(`• ${r.text}${when}`);
	}
	return { text: lines.join("\n"), resultCount: results.length };
}

// ── Observations (consolidated facts) ────────────────────────────────────────

export interface ObservationEntry {
	observation: string;
	entities?: string[];
	date?: string;
	consolidated_at?: string;
}

export interface ConsolidationResult {
	observationCount: number;
	factsConsumed: number;
	skipped: boolean;
	message: string;
}

/** Read and parse observations.json; returns [] on missing or corrupt file. */
export async function loadObservations(config: MmemoryConfig): Promise<ObservationEntry[]> {
	const { observationsPath } = resolvePaths(config);
	const obsPath = observationsPath;
	try {
		const raw = await fs.readFile(obsPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((o): o is ObservationEntry => typeof o?.observation === "string");
	} catch {
		return [];
	}
}

/**
 * Consolidate raw facts into higher-level observations.
 * `consolidateFn` is supplied by the caller (keeps this file free of ExtensionContext).
 */
export async function executeMemoryConsolidate(
	config: MmemoryConfig,
	consolidateFn: (factsJson: string) => Promise<string>,
): Promise<ConsolidationResult> {
	const maxRawFacts = config.maxRawFacts;
	try {
		const facts = await loadFacts(config);
		if (facts.length < maxRawFacts) {
			return {
				skipped: true,
				factsConsumed: facts.length,
				observationCount: 0,
				message: `Only ${facts.length} facts (threshold: ${maxRawFacts}). Run more sessions first.`,
			};
		}

		const factsJson = JSON.stringify(facts, null, 2);
		const truncated = factsJson.length > 20000 ? factsJson.slice(0, 20000) : factsJson;

		let rawOutput: string;
		try {
			rawOutput = await consolidateFn(truncated);
		} catch (err) {
			return {
				skipped: false,
				factsConsumed: facts.length,
				observationCount: 0,
				message: `consolidateFn failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		let observations: ObservationEntry[];
		try {
			const arr = parseJsonArrayOrWrapped(rawOutput, "observations");
			observations = arr
				.filter((o): o is ObservationEntry => typeof (o as any)?.observation === "string")
			.map(o => ({
				...(o as ObservationEntry),
				consolidated_at: (o as ObservationEntry).consolidated_at ?? new Date().toISOString(),
			}));
		} catch (err) {
			return {
				skipped: false,
				factsConsumed: facts.length,
				observationCount: 0,
				message: `Failed to parse consolidation output: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		if (observations.length === 0) {
			return {
				skipped: false,
				factsConsumed: facts.length,
				observationCount: 0,
				message: "Consolidation produced no observations after filtering.",
			};
		}

		// Intentional full replacement: observations.json is always the complete synthesis
		// of the current facts corpus. Merging would accumulate stale observations from
		// prior passes. If only a truncated slice of facts was processed (20000-char cap),
		// previous observations covering the unprocessed tail are lost — acceptable
		// because the next consolidation pass will cover the full corpus again.
		const { observationsPath: obsPathW } = resolvePaths(config);
		await atomicWriteJson(obsPathW, observations);

		return {
			skipped: false,
			factsConsumed: facts.length,
			observationCount: observations.length,
			message: `Consolidated ${facts.length} facts into ${observations.length} observations.`,
		};
	} catch (err) {
		return {
			skipped: false,
			factsConsumed: 0,
			observationCount: 0,
			message: `Consolidation failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Trigger the server's background build for a project dir.
 * The server reads queue/*.md, processes into chunks, deletes .md files.
 */
export async function executeMemoryBuild(config: MmemoryConfig): Promise<void> {
	const paths = resolvePaths(config);
	logger.debug(`[mmemory] build: project=${paths.projectDir}`, { source: "mmemory" });
	const client = await getOrCreateServerClient(config);
	try {
		const result = await client.query("build", {
			project_dir: paths.projectDir,
			dedup_threshold: config.deduplicationThreshold,
		}) as any;
		logger.debug(`[mmemory] build complete: new=${result?.new_chunks ?? "?"} total=${result?.total_chunks ?? "?"} deduped=${result?.deduped ?? "?"}`, { source: "mmemory" });
	} catch (err) {
		logger.warn(`[mmemory] build error: ${err}`, { source: "mmemory" });
	}
}

/** Format a recall result for system prompt injection. */
export function formatRecallForSystemPrompt(result: RecallResult): string | undefined {
	if (result.resultCount === 0) return undefined;
	return `<memories>\nRelevant context from past sessions:\n${result.text}\n</memories>`;
}

/**
 * Write a note file to queue/ for tool-initiated retains.
 * The server processes and deletes it on the next build.
 *
 * Strips <memories> and <mental_models> injection tags before writing.
 * The agent may call mmemory_retain with content that still contains recalled
 * memory blocks; without stripping those tags would get re-embedded and surface
 * in future recalls (same anti-feedback loop guarded in buildTranscript()).
 */
export async function executeMemoryRetain(
	content: string,
	config: MmemoryConfig,
): Promise<string> {
	const cleaned = content.replace(STRIP_TAGS_REGEX, "").trim();
	if (!cleaned) return "Nothing to retain after stripping memory injection tags.";

	const paths = resolvePaths(config);
	await fs.mkdir(paths.queueDir, { recursive: true });
	const filename = noteFilename();
	const filePath = path.join(paths.queueDir, filename);
	const today = new Date().toISOString().slice(0, 10);
	await fs.writeFile(filePath, `# Memory Note — ${today}\n\n${cleaned}`, "utf-8");
	logger.debug(`[mmemory] tool retain: wrote ${filename} (${cleaned.length} chars)`, { source: "mmemory" });
	void executeMemoryBuild(config).catch((e) => logger.warn(`[mmemory] build after retain failed: ${e}`, { source: "mmemory" }));
	return `Retained: ${filename}`;
}

/**
 * executeMemoryReflect — recall with synthesis framing.
 *
 * Returns memories formatted as a synthesis prompt so the calling LLM synthesizes
 * them in its response — the correct behaviour for an inline tool in an agent context.
 *
 * Phase 3: replace with a direct completeSimple() call once dual-system unification
 * (P3-6) cleanly exposes the model registry on the tool path.
 */
export async function executeMemoryReflect(
	query: string,
	scope: string | undefined,
	config: MmemoryConfig,
): Promise<RecallResult> {
	const result = await executeMemoryRecall(query, scope, {
		...config,
		recallLimit: Math.min(config.recallLimit * 2, 20),
	});
	if (result.resultCount === 0) {
		return { text: `No memories found to reflect on for: ${query}`, resultCount: 0 };
	}
	const synthesisText = [
		`Project memory synthesis for: "${query}"`,
		`Mission context: ${config.retainMission}`,
		"",
		result.text,
		"",
		`Based on the above project memories, synthesize a concise answer to: ${query}`,
	].join("\n");
	return { text: synthesisText, resultCount: result.resultCount };
}

// ── Mental models ─────────────────────────────────────────────────────────────

export interface MentalModelSeedResult {
	generated: string[];  // model ids written
	skipped: string[];    // model ids that failed
}

const BUILT_IN_MODELS = [
	{
		id: "user-preferences",
		query: "What does the user prefer in coding style, tooling, communication, and review? Capture only durable preferences.",
	},
	{
		id: "project-conventions",
		query: "What are this project conventions for code style, build, testing, release, and PR review?",
	},
	{
		id: "project-decisions",
		query: "What durable architectural or product decisions have been made, and what rationale was recorded?",
	},
];

/**
 * Seed mental model files from project memories.
 * `reflectFn` is provided by the caller and performs recall + LLM synthesis.
 * Returns which model ids written and which failed.
 */
export async function executeMemoryMentalModelSeed(
	config: MmemoryConfig,
	reflectFn: (query: string, systemPrompt: string) => Promise<string>,
): Promise<MentalModelSeedResult> {
	const { mentalModelsDir } = resolvePaths(config);
	await fs.mkdir(mentalModelsDir, { recursive: true });

	const generated: string[] = [];
	const skipped: string[] = [];

	for (const model of BUILT_IN_MODELS) {
		try {
			const systemPrompt =
				`Synthesize project memories into a concise reference document for: ${model.query} ` +
				`Write in present tense, plain prose, no filler. ` +
				`Only include information actually supported by the provided memories.`;
			const result = await reflectFn(model.query, systemPrompt);
			await fs.writeFile(path.join(mentalModelsDir, `${model.id}.md`), result, "utf-8");
			generated.push(model.id);
		} catch {
			skipped.push(model.id);
		}
	}

	return { generated, skipped };
}

/**
 * Load all .md files from mentalModelsDir, sorted by name.
 * Returns empty string when directory is missing or contains no .md files.
 */
export async function loadMentalModels(config: MmemoryConfig): Promise<string> {
	const { mentalModelsDir } = resolvePaths(config);
	let entries: string[];
	try {
		entries = (await fs.readdir(mentalModelsDir))
			.filter(f => f.endsWith(".md"))
			.sort();
	} catch {
		return "";
	}
	if (entries.length === 0) return "";

	const parts: string[] = [];
	for (const entry of entries) {
		try {
			const content = await fs.readFile(path.join(mentalModelsDir, entry), "utf-8");
			const id = entry.replace(/\.md$/, "");
			parts.push(`${id}:\n${content.trim()}`);
		} catch {
			// skip unreadable files
		}
	}
	return parts.join("\n\n");
}
