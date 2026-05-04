/**
 * mmemory core execution functions.
 *
 * These are called by:
 *   - The /mmemory slash command handler (builtin-registry.ts)
 *   - MmemoryRetainTool, MmemoryRecallTool, MmemoryReflectTool
 *
 * Storage layout (`<storagePath>/<projectName>/`):
 *   queue/                      transient .md files; deleted after build processes them
 *     YYYYMMDD-HHMMSS-<sessionId>.md   auto-retain (overwritten each cycle)
 *     YYYYMMDD-HHMMSS-note-<id>.md     tool-initiated retains
 *   index/                      fully derived; delete and rebuild at any time
 *     chunks.json               DURABLE STORE — full chunk texts, append-only
 *     vectors.safetensors       rebuildable from chunks.json
 *     vectors.meta.json         chunk hashes for incremental embedding
 *   facts.json                  Phase 3: extracted facts
 *   mental_models/              Phase 3: seeded summaries
 *   kb_config.yaml              auto-generated registry entry
 *
 * storagePath defaults to $PI_CODING_AGENT_DIR/mmemory/ (launched via o/ow),
 * <exe-dir>/extensions/mmemory/ (compiled), or ~/.omp/mmemory/ (dev).
 */
import * as fs from "node:fs/promises";
import * as os from "os";
import * as path from "path";
import type { Settings } from "../../config/settings";
import { MmemoryServerClient } from "./server-client";
import mmemoryServerPy from "./mmemory_server.py" with { type: "text" };

// ── Config ────────────────────────────────────────────────────────────────────

export interface MmemoryConfig {
	storagePath: string;
	projectName: string;
	modelRole: string;
	consolidateModelRole: string;
	retainMission: string;
	extractionMode: "structured" | "verbatim";
	scoping: "per-project" | "per-project-tagged" | "global";
	retainEveryNTurns: number;
	retainContextTurns: number;
	recallLimit: number;
	recallDeadlineMs: number;
	recencyWeight: number;
	deduplicationThreshold: number;
	serverIdleTimeoutMinutes: number;
	autoRetain: boolean;
}

export function loadMmemoryConfig(settings: Settings, cwd?: string): MmemoryConfig | null {
	if (!settings.get("mmemory.enabled" as any)) return null;
	const raw = (settings as any).getRaw?.() ?? {};
	const mmemory = raw.mmemory ?? {};

	const projectName = mmemory.projectName ?? path.basename(cwd ?? process.cwd());
	const storagePath = mmemory.storagePath
		? (mmemory.storagePath as string).replace(/^~/, os.homedir())
		: process.env.PI_CODING_AGENT_DIR
			? path.join(process.env.PI_CODING_AGENT_DIR, "mmemory")
			: process.env.PI_COMPILED === "true"
				? path.join(path.dirname(process.execPath), "extensions", "mmemory")
				: path.join(os.homedir(), ".omp", "mmemory");

	return {
		storagePath,
		projectName,
		modelRole: mmemory.modelRole ?? "smol",
		consolidateModelRole: mmemory.consolidateModelRole ?? mmemory.modelRole ?? "smol",
		retainMission:
			mmemory.retainMission ??
			"Focus on technical decisions, API contracts, constraints, error patterns, and project conventions",
		extractionMode: mmemory.extractionMode ?? "verbatim",
		scoping: mmemory.scoping ?? "per-project-tagged",
		retainEveryNTurns: mmemory.retainEveryNTurns ?? 3,
		retainContextTurns: mmemory.retainContextTurns ?? 0,
		recallLimit: mmemory.recallLimit ?? 10,
		recallDeadlineMs: mmemory.recallDeadlineMs ?? 10_000,
		recencyWeight: mmemory.recencyWeight ?? 0.3,
		deduplicationThreshold: mmemory.deduplicationThreshold ?? 0.92,
		serverIdleTimeoutMinutes: mmemory.serverIdleTimeoutMinutes ?? 10,
		autoRetain: mmemory.autoRetain !== false,
	};
}

/** Resolved storage paths for a project. */
export interface MmemoryPaths {
	projectDir: string;       // storagePath/projectName
	queueDir: string;         // projectDir/queue  (transient .md files, deleted after build)
	indexDir: string;         // projectDir/index
	chunksPath: string;       // indexDir/chunks.json  (durable store)
	vectorsPath: string;      // indexDir/vectors.safetensors
	vectorsMetaPath: string;  // indexDir/vectors.meta.json
	factsPath: string;        // projectDir/facts.json  (Phase 3)
	mentalModelsDir: string;  // projectDir/mental_models  (Phase 3)
}

export function resolvePaths(config: MmemoryConfig): MmemoryPaths {
	const projectDir = path.join(config.storagePath, config.projectName);
	const indexDir = path.join(projectDir, "index");
	return {
		projectDir,
		queueDir: path.join(projectDir, "queue"),
		indexDir,
		chunksPath: path.join(indexDir, "chunks.json"),
		vectorsPath: path.join(indexDir, "vectors.safetensors"),
		vectorsMetaPath: path.join(indexDir, "vectors.meta.json"),
		factsPath: path.join(projectDir, "facts.json"),
		mentalModelsDir: path.join(projectDir, "mental_models"),
	};
}

/** Returns paths for the global project dir (cross-project per-project-tagged scope). */
export function resolveGlobalPaths(config: MmemoryConfig): MmemoryPaths {
	return resolvePaths({ ...config, projectName: "global" });
}

// ── Server singleton per storage root ────────────────────────────────────────

const serverMap = new Map<string, MmemoryServerClient>();
const serverCreating = new Map<string, Promise<MmemoryServerClient>>();

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
	const key = config.storagePath;
	const existing = serverMap.get(key);
	if (existing) return existing;
	let creating = serverCreating.get(key);
	if (!creating) {
		creating = (async () => {
			const serverScript = await ensureServerScript();
			const client = new MmemoryServerClient(serverScript, config.serverIdleTimeoutMinutes);
			serverMap.set(key, client);
			serverCreating.delete(key);
			return client;
		})();
		serverCreating.set(key, creating);
	}
	return creating;
}

export function disposeServerClient(config: MmemoryConfig): void {
	const key = config.storagePath;
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
	scope: string | undefined,
	config: MmemoryConfig,
): Promise<RecallResult> {
	const paths = resolvePaths(config);
	const client = await getOrCreateServerClient(config);
	const effectiveScope = scope ?? config.scoping;

	const recallArgs = {
		query,
		project_dir: paths.projectDir,
		scope: effectiveScope,
		project: config.projectName,
		limit: config.recallLimit * 3,
		recency_weight: config.recencyWeight,
	};

	let results: any[];
	try {
		if (effectiveScope === "per-project-tagged") {
			const globalPaths = resolveGlobalPaths(config);
			const [projectResponse, globalResponse] = await Promise.race([
				Promise.all([
					client.query("recall", recallArgs),
					client.query("recall", {
						...recallArgs,
						project_dir: globalPaths.projectDir,
						scope: "global",
						project: "global",
					}),
				]),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("recall timeout")), config.recallDeadlineMs),
				),
			]);
			const combined = [
				...((projectResponse as any)?.results ?? []),
				...((globalResponse as any)?.results ?? []),
			];
			const seen = new Set<string>();
			results = combined
				.filter(r => {
					const key = String(r.text).slice(0, 80);
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				})
				.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
				.slice(0, config.recallLimit);
		} else {
			const response = await Promise.race([
				client.query("recall", recallArgs),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("recall timeout")), config.recallDeadlineMs),
				),
			]);
			results = ((response as any)?.results ?? []).slice(0, config.recallLimit);
		}
	} catch (err) {
		return {
			text: `Memory recall unavailable: ${err instanceof Error ? err.message : String(err)}`,
			resultCount: 0,
		};
	}

	if (results.length === 0) return { text: "No relevant memories found.", resultCount: 0 };

	const lines: string[] = [`Found ${results.length} relevant memories:\n`];
	for (const r of results) {
		const score = typeof r.score === "number" ? ` (score: ${r.score.toFixed(3)})` : "";
		const when = r.when ? ` [${r.when}]` : "";
		lines.push(`• ${r.text}${when}${score}`);
	}
	return { text: lines.join("\n"), resultCount: results.length };
}

/**
 * Trigger the server's background build for a project dir.
 * The server reads queue/*.md, processes into chunks, deletes .md files.
 */
export async function executeMemoryBuild(config: MmemoryConfig): Promise<void> {
	const paths = resolvePaths(config);
	const client = await getOrCreateServerClient(config);
	try {
		await client.query("build", {
			project_dir: paths.projectDir,
			dedup_threshold: config.deduplicationThreshold,
		});
	} catch {
		// Build is fire-and-forget — errors are non-fatal
	}
}

/** Format a recall result for system prompt injection. */
export function formatRecallForSystemPrompt(result: RecallResult): string | undefined {
	if (result.resultCount === 0) return undefined;
	return `<memories>\n${result.text}\n</memories>`;
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
	const STRIP_TAGS = /<memories>[\s\S]*?<\/memories>|<mental_models>[\s\S]*?<\/mental_models>/g;
	const cleaned = content.replace(STRIP_TAGS, "").trim();
	if (!cleaned) return "Nothing to retain after stripping memory injection tags.";

	const paths = resolvePaths(config);
	await fs.mkdir(paths.queueDir, { recursive: true });
	const filename = noteFilename();
	const filePath = path.join(paths.queueDir, filename);
	const today = new Date().toISOString().slice(0, 10);
	await fs.writeFile(filePath, `# Memory Note — ${today}\n\n${cleaned}`, "utf-8");
	void executeMemoryBuild(config).catch(() => {});
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
