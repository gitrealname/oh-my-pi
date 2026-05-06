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
import { settings } from "../../config/settings";
import { MmemoryServerClient } from "./server-client";
import mmemoryServerPy from "./mmemory_server.py" with { type: "text" };
import { resolveTimeFilter } from "./time-filter";

import type { ModelRegistry } from "../../config/model-registry";
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
	deduplicationThreshold: number;
	serverIdleTimeoutMinutes: number;
	serverPort: number;
	serverLogFile: string | undefined;
	autoRetain: boolean;
	maxTranscriptChars: number;
	consolidationMinTurns: number;
	consolidationMaxTurns: number;
	consolidationPollIntervalMinutes: number;
	consolidationMaxObservationChars: number;
	recall: {
		limit: number;
		deadlineMs: number;
		maxQueryChars: number;
		recencyWeight: number;
		fileLimit: number;
		includeReadFiles: boolean;
		observationLimit: number;
	};
	vacuum: {
		enabled: boolean;
		intervalHours: number;
		sessionMaxAgeDays: number;
		observationMaxAgeDays: number;
		fileMaxAgeDays: number;
	};
	injection: {
		sessionLimit: number;
		observationLimit: number;
		fileLimit: number;
		maxChars: number;
	};
}

/** Normalize a filesystem path to a stable project label.
 *  Replaces backslashes with forward slashes; strips drive colon.
 *  `D:\.ai` → `D/.ai`, `C:\repos\carity2` → `C/repos/carity2` */
function normalizeCwd(p: string): string {
	return p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1");
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
		recall: {
			limit:            settings.get("mmemory.recall.limit"),
			deadlineMs:       settings.get("mmemory.recall.deadlineMs"),
			maxQueryChars:    settings.get("mmemory.recall.maxQueryChars"),
			recencyWeight:    settings.get("mmemory.recall.recencyWeight"),
			fileLimit:        settings.get("mmemory.recall.fileLimit"),
			includeReadFiles: settings.get("mmemory.recall.includeReadFiles"),
			observationLimit: settings.get("mmemory.recall.observationLimit"),
		},
		vacuum: {
			enabled:               settings.get("mmemory.vacuum.enabled"),
			intervalHours:         settings.get("mmemory.vacuum.intervalHours"),
			sessionMaxAgeDays:     settings.get("mmemory.vacuum.sessionMaxAgeDays"),
			observationMaxAgeDays: settings.get("mmemory.vacuum.observationMaxAgeDays"),
			fileMaxAgeDays:        settings.get("mmemory.vacuum.fileMaxAgeDays"),
		},
		injection: {
			sessionLimit:      settings.get("mmemory.injection.sessionLimit")      ?? 5,
			observationLimit:  settings.get("mmemory.injection.observationLimit")  ?? 3,
			fileLimit:         settings.get("mmemory.injection.fileLimit")         ?? 5,
			maxChars:          settings.get("mmemory.injection.maxChars")          ?? 8000,
		},
		deduplicationThreshold:  settings.get("mmemory.deduplicationThreshold"),
		serverIdleTimeoutMinutes: settings.get("mmemory.serverIdleTimeoutMinutes"),
		serverPort:              settings.get("mmemory.serverPort"),
		serverLogFile:           settings.get("mmemory.serverLogFile")?.replace(/^~/, os.homedir()),
		autoRetain:              settings.get("mmemory.autoRetain"),
		maxTranscriptChars:      settings.get("mmemory.maxTranscriptChars"),
		consolidationMinTurns:           settings.get("mmemory.consolidationMinTurns")           ?? 10,
		consolidationMaxTurns:           settings.get("mmemory.consolidationMaxTurns")           ?? 50,
		consolidationPollIntervalMinutes:    settings.get("mmemory.consolidationPollIntervalMinutes")    ?? 5,
		consolidationMaxObservationChars:    settings.get("mmemory.consolidationMaxObservationChars")    ?? 400,
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

export const STRIP_TAGS_REGEX = /<memories>[\s\S]*?<\/memories>|<mental_models>[\s\S]*?<\/mental_models>|<observations>[\s\S]*?<\/observations>|<referenced_files>[\s\S]*?<\/referenced_files>/g;

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
	await ensureScript("mmemory_bm25.py",   mmemoryBm25Py);
	await ensureScript("mmemory_vacuum.py", mmemoryVacuumPy);
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
	// LLMs sometimes prefix JSON with prose or wrap in markdown fences — strip those first.
	const trimmed       = raw.trim();
	const fenceStripped = trimmed.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
	const arrayStart  = fenceStripped.indexOf("[");
	const objectStart = fenceStripped.indexOf("{");
	const start =
		arrayStart === -1 ? objectStart
		: objectStart === -1 ? arrayStart
		: Math.min(arrayStart, objectStart);
	const jsonStr = start > 0 ? fenceStripped.slice(start) : fenceStripped;

	// Full parse — happy path.
	try {
		const parsed = JSON.parse(jsonStr);
		if (Array.isArray(parsed)) return parsed;
		const wrapped = (parsed as any)?.[wrapKey];
		return Array.isArray(wrapped) ? wrapped : [];
	} catch (_) {
		throw new Error(`Failed to parse LLM response as JSON — raw length=${raw.length} tail=${JSON.stringify(raw.slice(-80))}`);
	}
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



export interface RecallResult {
	/** Lines for <memories> block — session summary text, ts ASC (most recent last). */
	text: string;
	/** Entries for <observations> block — consolidated observations with date range. */
	observations: Array<{ text: string; start_ts: number; end_ts: number }>;
	/** Paths for <referenced_files> block — ts-sorted, most recently touched last. */
	referencedFiles: string[];
	resultCount: number;
}

/**
 * Query memory for relevant chunks.
 *
 * @param mode  "session" — time-ordered, no BM25/vector, used for auto-inject at session start.
 *              "query"   — BM25+vector+recency, used for user-driven /mmemory recall.
 *              undefined — defaults to "query".
 */
export async function executeMemoryRecall(
	query: string,
	scope: string | undefined | null,
	config: MmemoryConfig,
	registry?: import("../config/model-registry").ModelRegistry,
	settings?: import("../config/settings").Settings,
): Promise<RecallResult> {
	const EMPTY: RecallResult = { text: "", observations: [], referencedFiles: [], resultCount: 0 };
	const effectiveMode = mode ?? "query";
	// DEBUG (cleanup when stable): log every recall invocation
	logger.debug(`[mmemory] executeMemoryRecall: mode=${effectiveMode} scope=${scope ?? "default"} query="${query.slice(0,60)}..."`, { source: "mmemory" });
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

	// LLM time-filter: only applies to "query" mode (session inject has no user query)
	const timeFilter = (effectiveMode === "query" && registry)
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
		...(timeFilter.source    !== undefined ? { source:    [timeFilter.source]   } : {}),
	};
	const recallArgs = {
		query: resolvedQuery,
		project_dir: paths.projectDir,
		filter,
		limit: config.recallLimit * 3,
		recency_weight: config.recencyWeight,
	};

	let rawResults: any[];
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
			...EMPTY,
			text: `Memory recall unavailable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// DEBUG (cleanup when stable): log recall server result count
	logger.debug(`[mmemory] executeMemoryRecall: server returned rawResults=${rawResults.length}`, { source: "mmemory" });
	if (rawResults.length === 0) return EMPTY;

	// ── Split by source ────────────────────────────────────────────────────────
	// Session chunks → <memories> text + file aggregation
	// Observation chunks → <observations> lines
	// Fact chunks → merged into session text for now (factsLimit defaults to 0)

	const sessionResults  = rawResults.filter(r => !r.source || r.source === "session" || r.source === "fact");
	const observResults   = rawResults.filter(r => r.source === "observation");
	// DEBUG (cleanup when stable): log recall result split by source
	logger.debug(`[mmemory] executeMemoryRecall: session=${sessionResults.length} observations=${observResults.length}`, { source: "mmemory" });

	// ── Session text — ts ASC (oldest first, most recent last) ────────────────
	const sessionsAsc = [...sessionResults].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
	const memoryLines: string[] = [];
	for (const r of sessionsAsc) {
		const when = r.when ? ` [${r.when}]` : "";
		memoryLines.push(`• ${r.text}${when}`);
	}

	// ── Observation entries — up to observationLimit ─────────────────────────
	const obsSlice = observResults.slice(0, config.recall.observationLimit);
	const obsEntries: Array<{ text: string; start_ts: number; end_ts: number }> = obsSlice.map(r => {
		const o = r as any;
		const parts: string[] = [];
		if (o.entities?.length) parts.push(`entities: ${(o.entities as string[]).join(", ")}`);
		const label = `• ${o.text as string}` + (parts.length ? `  (${parts.join(" | ")})` : "");
		return {
			text: label,
			start_ts: (o.ts as number) ?? 0,
			end_ts: (o.end_ts as number) ?? (o.ts as number) ?? 0,
		};
	});

	// Query source:"file" chunks for <referenced_files> — ts-sorted, most recent last
	const fileArgs = {
		query: "",
		project_dir: paths.projectDir,
		filter: { ...scopeFilter, source: ["file"] },
		limit: config.recall.fileLimit,
		mode: "session",  // time-ordered, no BM25
	};
	let filePaths: string[] = [];
	try {
		const fileResponse = await Promise.race([
			client.query("recall", fileArgs),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("file recall timeout")), config.recall.deadlineMs)),
		]) as any;
		const fileResults: any[] = (fileResponse?.results ?? []);
		// Server returns ts DESC for mode:session; reverse to get ts ASC (most recent last)
		filePaths = fileResults.reverse().map((r: any) => r.path).filter(Boolean);
	} catch { /* skip file injection on timeout */ }

	const resultCount = sessionsAsc.length + obsSlice.length;
	return {
		text: memoryLines.join("\n"),
		observations: obsEntries,
		referencedFiles: filePaths,
		resultCount,
	};
}

// ── Observations (consolidated facts) ────────────────────────────────────────

export interface ObservationEntry {
	observation: string;
	entities?: string[];
	date?: string;
	consolidated_at?: string;
}



/**
 * Consolidate raw session chunks into higher-level observations.
 * Writes one queue file per observation; the server embeds them on the next build.
 *
 * `chunks` comes from the server's get_consolidation_chunks response.
 * `consolidateFn` receives JSON of {text, ts, path}[] and returns a JSON string.
 */
export async function executeMemoryConsolidate(
	chunks: Array<{ text: string; ts: number; end_ts: number; path: string }>,
	config: MmemoryConfig,
	consolidateFn: (sessionBlob: string) => Promise<string>,
	_force = false,
): Promise<{ skipped: boolean; message: string; observationCount: number }> {
	// DEBUG (cleanup when stable): log every consolidation attempt
	logger.debug(`[mmemory] executeMemoryConsolidate: chunks=${chunks.length}`, { source: "mmemory" });
	if (chunks.length === 0) {
		return { skipped: true, message: "no unprocessed turns", observationCount: 0 };
	}

	const start_ts = Math.min(...chunks.map(c => c.ts));
	const end_ts   = Math.max(...chunks.map(c => c.ts));

	let rawOutput: string;
	try {
		rawOutput = await consolidateFn(
			[...chunks].sort((a, b) => a.ts - b.ts).map(c => c.text).join("\n\n---\n\n"),
		);
	} catch (err) {
		return {
			skipped: false,
			observationCount: 0,
			message: `consolidateFn failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	// DEBUG (cleanup when stable): log raw LLM response to diagnose parse failures
	logger.debug(`[mmemory] consolidateFn raw response len=${rawOutput.length} tail=${JSON.stringify(rawOutput.slice(-80))}`, { source: "mmemory" });

	let observations: Array<{ observation: string; entities?: string[]; date?: string }>;
	try {
		const arr = parseJsonArrayOrWrapped(rawOutput, "observations");
		observations = arr.filter(
			(o): o is { observation: string; entities?: string[]; date?: string } =>
				typeof (o as any)?.observation === "string",
		);
	} catch (err) {
		return {
			skipped: false,
			observationCount: 0,
			message: `Failed to parse consolidation output: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (observations.length === 0) {
		return { skipped: false, observationCount: 0, message: "Consolidation produced no observations after filtering." };
	}

	const queueDir = path.join(config.storageRoot, "queue");
	await fs.mkdir(queueDir, { recursive: true });

	for (let i = 0; i < observations.length; i++) {
		const obs = observations[i];
		const entitiesYaml = obs.entities?.length
			? `[${obs.entities.map(e => `"${e}"`).join(", ")}]`
			: "[]";
		const fm = [
			"---",
			"source: observation",
			`ts: ${start_ts}`,
			`end_ts: ${end_ts}`,
			`project: ${config.projectLabel}`,
			`entities: ${entitiesYaml}`,
			`date: ${obs.date ?? new Date().toISOString().slice(0, 10)}`,
			"---",
		].join("\n");
		const fname = `${start_ts}-obs-${i.toString().padStart(4, "0")}.md`;
		// DEBUG (cleanup when stable): log each observation being queued
		logger.debug(`[mmemory] executeMemoryConsolidate: queueing obs="${String(obs.observation ?? "").slice(0,80)}" date=${obs.date}`, { source: "mmemory" });
		await fs.writeFile(path.join(queueDir, fname), `${fm}\n${obs.observation}`, "utf-8");
	}

	// DEBUG (cleanup when stable): log consolidation completion
	logger.debug(`[mmemory] executeMemoryConsolidate: complete observationCount=${observations.length} message="Consolidated ${chunks.length} turns into ${observations.length} observations."`, { source: "mmemory" });
	return {
		skipped: false,
		message: `Consolidated ${chunks.length} turns into ${observations.length} observations.`,
		observationCount: observations.length,
	};
}

/**
 * Build a consolidation function bound to the given config, registry, and settings.
 * Used by consolidate-tool.ts and mmemory-extension.ts (auto-consolidate after retain).
 */
export function buildConsolidateFn(
	config: MmemoryConfig,
	registry: ModelRegistry | undefined,
	_settings: Settings | undefined,
): (sessionBlob: string) => Promise<string> {
	const effectiveRegistry = registry;
	const effectiveSettings  = _settings ?? settings;
	return async (sessionBlob: string): Promise<string> => {
		if (!effectiveRegistry) throw new Error("No model registry for consolidation.");
		const systemPrompt = resolveConsolidationPrompt().replace(
			"{{maxObservationChars}}",
			String(config.consolidationMaxObservationChars),
		);
		// DEBUG (cleanup when stable): log consolidation LLM call details
		logger.debug(`[mmemory] buildConsolidateFn: calling LLM extraRoles=[${[config.consolidateModelRole, "memory"].filter(Boolean).join(",")}] blobLen=${sessionBlob.length}`, { source: "mmemory" });
		const result = await callWithRole(
			{
				systemPrompt,
				userMessage: `Session context:\n\n${sessionBlob}`,
				roleValue:   undefined,
				extraRoles:  [config.consolidateModelRole, "memory"].filter(Boolean) as string[],
				logPrefix:   "[mmemory consolidate]",
			},
			effectiveRegistry,
			effectiveSettings,
		);
		if (result === null) throw new Error("No model available for consolidation.");
		return result;
	};
}

/**
 * Trigger the server's background build for a project dir.
 * The server reads queue/*.md, processes into chunks, deletes .md files.
 */
export async function executeMemoryBuild(config: MmemoryConfig): Promise<void> {
	const paths = resolvePaths(config);
	logger.debug(`[mmemory] build: project=${paths.projectDir}`, { source: "mmemory" });
	// DEBUG (cleanup when stable): log every build trigger
	logger.debug(`[mmemory] executeMemoryBuild: triggered storageRoot=${config.storageRoot}`, { source: "mmemory" });
	const client = await getOrCreateServerClient(config);
	try {
		const result = await client.query("build", {
			project_dir: paths.projectDir,
			dedup_threshold: config.deduplicationThreshold,
			vacuum_config: {
				enabled: config.vacuum.enabled,
				interval_hours: config.vacuum.intervalHours,
				max_age_days: {
					session:     config.vacuum.sessionMaxAgeDays,
					observation: config.vacuum.observationMaxAgeDays,
					fact:        config.vacuum.factMaxAgeDays,
					file:        config.vacuum.fileMaxAgeDays,
				},
			},
		}) as any;
		logger.debug(`[mmemory] build complete: new=${result?.new_chunks ?? "?"} total=${result?.total_chunks ?? "?"} deduped=${result?.deduped ?? "?"} queueDeleted=${result?.queue_deleted ?? "?"}`, { source: "mmemory" });
	} catch (err) {
		logger.error(`EXCEPTION: [mmemory] build error: ${err instanceof Error ? err.stack : String(err)}`, { source: "mmemory" });
	}
}

/**
 * Format a recall result for system prompt injection.
 *
 * Emits up to three sibling blocks — each is omitted when empty:
 *   <memories>      session summaries, ts ASC (most recent last)
 *   <observations>  consolidated observations
 *   <referenced_files>  file paths, ts ASC (most recently touched last)
 */
export function formatRecallForSystemPrompt(result: RecallResult): string | undefined {
	if (result.resultCount === 0 && result.observations.length === 0 && result.referencedFiles.length === 0) {
		return undefined;
	}

	function tsToDate(ts: number): string {
		return new Date(ts * 1000).toISOString().slice(0, 10);
	}

	const obsLines = result.observations.map(o => {
		const range = `[${tsToDate(o.start_ts)} → ${tsToDate(o.end_ts)}]`;
		return `${range} ${o.text}`;
	});

	const obsBlock  = formatBlock("observations", obsLines);
	const memBlock  = result.text
		? formatBlock("memories", ["Relevant context from past sessions:", result.text])
		: "";
	const filesBlock = formatBlock("referenced_files", result.referencedFiles);

	// observations rendered ABOVE memories
	const parts = [obsBlock, memBlock, filesBlock].filter(Boolean);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export interface InjectionChunk {
	text: string;
	ts: number;
	end_ts?: number;
	path?: string;
	date?: string;
	action?: "read" | "modified" | "written";
}

export interface InjectionSnapshot {
	sessions:     InjectionChunk[];
	observations: InjectionChunk[];
	files:        InjectionChunk[];
	anchor_ts:    number;
}

/**
 * Format an InjectionSnapshot into the <observations>/<memories>/<referenced_files>
 * blocks for system prompt injection.
 * Returns undefined if the snapshot is empty.
 */
export function formatInjectionSnapshot(snap: InjectionSnapshot): string | undefined {
	const obsLines: string[] = snap.observations.map(c => {
		const when = c.date ? ` [${c.date}]` : "";
		return `• ${c.text.trim()}${when}`;
	});
	const memLines: string[] = snap.sessions.map(c => `• ${c.text.trim()}`);
	const fileLines: string[] = snap.files.map(c => c.path ?? c.text.trim());

	const parts: string[] = [];
	if (obsLines.length) parts.push(formatBlock("observations", obsLines));
	if (memLines.length) parts.push(formatBlock("memories", memLines));
	if (fileLines.length) parts.push(formatBlock("referenced_files", fileLines));
	if (!parts.length) return undefined;
	return parts.join("\n\n");
}

/**
 * Write a session queue file for tool-initiated retains.
 *
 * Uses the same session-chunk frontmatter as retainSession() so the server
 * embeds and deduplicates it identically to an auto-retained session file.
 * The agent-supplied `content` is appended after the body separator so it
 * survives tag-stripping — caller is responsible for stripping injection tags
 * before passing content here.
 *
 * NOTE: This function has no access to the live ExtensionContext (ToolSession
 * does not expose ctx). Once ToolSession gains a `ctx` field the retain-tool
 * should call executeManualRetain(ctx, content) instead and this function
 * can be removed. See mmemory-extension.ts executeManualRetain.
 */
export async function executeMemoryRetain(
	content: string,
	config: MmemoryConfig,
): Promise<string> {
	const cleaned = content.replace(STRIP_TAGS_REGEX, "").trim();
	if (!cleaned) return "Nothing to retain after stripping memory injection tags.";

	const paths = resolvePaths(config);
	await fs.mkdir(paths.queueDir, { recursive: true });

	const today    = new Date().toISOString().slice(0, 10);
	const ts       = Math.floor(Date.now() / 1000);
	// Unique per-call filename so multiple tool retains in one session don't overwrite
	const filename = `${today}-note-${ts}.md`;
	const filePath = path.join(paths.queueDir, filename);

	const frontmatter =
		`---\nproject: ${config.projectLabel}\nagent_tag: ${config.agentTag}\nsource: session\n` +
		`ts: ${ts}\nread_files: []\nmodified_files: []\nwritten_files: []\n---\n\n`;

	await fs.writeFile(
		filePath,
		`${frontmatter}# Memory Note — ${today}\n\n${cleaned}`,
		"utf-8",
	);
	logger.debug(`[mmemory] tool retain: wrote ${filename} (${cleaned.length} chars)`, { source: "mmemory" });
	void executeMemoryBuild(config).catch((e) => logger.error(`EXCEPTION: [mmemory] build after retain failed: ${e instanceof Error ? e.stack : String(e)}`, { source: "mmemory" }));
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
	const reflectConfig: MmemoryConfig = {
		...config,
		recall: { ...config.recall, limit: Math.min(config.recall.limit * 2, 20) },
	};
	const result = await executeMemoryRecall(query, scope, reflectConfig, undefined, undefined, "query");
	if (result.resultCount === 0) {
		return { text: `No memories found to reflect on for: ${query}`, observations: [], referencedFiles: [], resultCount: 0 };
	}
	const synthesisText = [
		`Project memory synthesis for: "${query}"`,
		`Mission context: ${config.retainMission}`,
		"",
		result.text,
		"",
		`Based on the above project memories, synthesize a concise answer to: ${query}`,
	].join("\n");
	return { text: synthesisText, observations: result.observations, referencedFiles: result.referencedFiles, resultCount: result.resultCount };
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
