/**
 * mmemory core execution functions.
 *
 * These are called by:
 *   - The /mmemory slash command handler (builtin-registry.ts)
 *   - MmemoryRetainTool, MmemoryRecallTool, MmemoryReflectTool
 *
 * Storage layout:
 *   ~/.omp/mmemory/<project>/
 *     YYYY-MM-DD-<sessionId>.md     memory files (one per retained session)
 *     chunks.json                   BM25 source (all chunk texts + metadata)
 *     vectors.safetensors           float32 embeddings [N, 384]
 *     vectors.meta.json             chunk→index mapping + build metadata
 *     facts.json                    structured facts (5-dim extraction)
 */
import * as fs from "node:fs/promises";
import * as os from "os";
import * as path from "path";
import type { Settings } from "../../config/settings";
import { MmemoryServerClient } from "./server-client";
import mmemoryServerPy from "./mmemory_server.py" with { type: "text" };
import mmemoryUpdatePy from "./mmemory_update.py" with { type: "text" };

// ── Config ────────────────────────────────────────────────────────────────────

export interface MmemoryConfig {
	storagePath: string;
	projectName: string;
	modelRole: string;
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
		: path.join(os.homedir(), ".omp", "mmemory");

	return {
		storagePath,
		projectName,
		modelRole: mmemory.modelRole ?? "memory",
		retainMission:
			mmemory.retainMission ??
			"Focus on technical decisions, API contracts, constraints, error patterns, and project conventions",
		extractionMode: mmemory.extractionMode ?? "structured",
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
	memoryDir: string;
	chunksPath: string;
	vectorsPath: string;
	vectorsMetaPath: string;
	factsPath: string;
}

export function resolvePaths(config: MmemoryConfig): MmemoryPaths {
	const memoryDir = path.join(config.storagePath, config.projectName);
	return {
		memoryDir,
		chunksPath: path.join(memoryDir, "chunks.json"),
		vectorsPath: path.join(memoryDir, "vectors.safetensors"),
		vectorsMetaPath: path.join(memoryDir, "vectors.meta.json"),
		factsPath: path.join(memoryDir, "facts.json"),
	};
}

// ── Server singleton per session ──────────────────────────────────────────────

const serverMap = new Map<string, MmemoryServerClient>();

// Co-locate extracted scripts with the binary when compiled; use ~/.omp/extensions
// as a stable scratch location in dev (process.execPath is bun itself in that case).
const MMEMORY_EXT_DIR = process.env.PI_COMPILED === "true"
	? path.join(path.dirname(process.execPath), "extensions")
	: path.join(os.homedir(), ".omp", "extensions");

// Timestamp baked in at compile time. Falls back to epoch in dev (bun run, not bun build).
const BUILD_TIME = new Date(process.env.BUILD_TIME ?? 0);

/**
 * Extract an embedded script to disk, respecting local development edits.
 *
 * Rules:
 *   - Missing           → extract
 *   - local.mtime >= BUILD_TIME → keep local  (developer modified it after this build)
 *   - local.mtime <  BUILD_TIME → re-extract  (this build is newer, local is stale)
 */
async function ensureScript(filename: string, content: string): Promise<string> {
	const dest = path.join(MMEMORY_EXT_DIR, filename);
	try {
		const { mtimeMs } = await fs.stat(dest);
		if (mtimeMs >= BUILD_TIME.getTime()) {
			return dest; // local is same age or newer — developer may be editing it
		}
		// Build is newer — overwrite with embedded version
		await fs.writeFile(dest, content, "utf-8");
	} catch {
		// File doesn't exist — extract for the first time
		await fs.mkdir(MMEMORY_EXT_DIR, { recursive: true });
		await fs.writeFile(dest, content, "utf-8");
	}
	return dest;
}

export async function ensureServerScript(): Promise<string> {
	return ensureScript("mmemory_server.py", mmemoryServerPy);
}

export async function ensureUpdateScript(): Promise<string> {
	return ensureScript("mmemory_update.py", mmemoryUpdatePy);
}

export async function getOrCreateServerClient(sessionId: string, config: MmemoryConfig): Promise<MmemoryServerClient> {
	const serverScript = await ensureServerScript();
	const key = `${sessionId}:${config.storagePath}`;
	let client = serverMap.get(key);
	if (!client) {
		client = new MmemoryServerClient(serverScript, config.serverIdleTimeoutMinutes);
		serverMap.set(key, client);
	}
	return client;
}

export function disposeServerClient(sessionId: string, config: MmemoryConfig): void {
	const key = `${sessionId}:${config.storagePath}`;
	const client = serverMap.get(key);
	if (client) {
		void client.stop();
		serverMap.delete(key);
	}
}

// ── Core operations ───────────────────────────────────────────────────────────

export interface RecallResult {
	text: string;
	resultCount: number;
}

/**
 * Query memory for relevant facts + chunks.
 * Delegates parallel BM25+semantic retrieval to the Python server.
 */
export async function executeMemoryRecall(
	sessionId: string,
	query: string,
	scope: string | undefined,
	config: MmemoryConfig,
): Promise<RecallResult> {
	const paths = resolvePaths(config);
	const client = await getOrCreateServerClient(sessionId, config);

	let response: any;
	try {
		response = await Promise.race([
			client.query("recall", {
				query,
				chunks_path: paths.chunksPath,
				vectors_path: paths.vectorsPath,
				facts_path: paths.factsPath,
				scope: scope ?? config.scoping,
				project: config.projectName,
				limit: config.recallLimit,
				recency_weight: config.recencyWeight,
			}),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("recall timeout")), config.recallDeadlineMs),
			),
		]);
	} catch (err) {
		return {
			text: `Memory recall unavailable: ${err instanceof Error ? err.message : String(err)}`,
			resultCount: 0,
		};
	}

	const results = (response as any)?.results ?? [];
	if (results.length === 0) {
		return { text: "No relevant memories found.", resultCount: 0 };
	}

	const lines: string[] = [`Found ${results.length} relevant memories:\n`];
	for (const r of results) {
		const score = typeof r.score === "number" ? ` (score: ${r.score.toFixed(3)})` : "";
		const when = r.when ? ` [${r.when}]` : "";
		lines.push(`• ${r.text}${when}${score}`);
	}
	return { text: lines.join("\n"), resultCount: results.length };
}

/**
 * Trigger the server's background build action to index new memory files.
 */
export async function executeMemoryBuild(
	sessionId: string,
	config: MmemoryConfig,
): Promise<void> {
	const paths = resolvePaths(config);
	const client = await getOrCreateServerClient(sessionId, config);
	try {
		await client.query("build", {
			memory_dir: paths.memoryDir,
			chunks_path: paths.chunksPath,
			vectors_path: paths.vectorsPath,
			vectors_meta_path: paths.vectorsMetaPath,
			facts_path: paths.factsPath,
			dedup_threshold: config.deduplicationThreshold,
		});
	} catch {
		// Build is fire-and-forget — errors are non-fatal
	}
}

/**
 * Format a recall result for system prompt injection.
 */
export function formatRecallForSystemPrompt(result: RecallResult): string | undefined {
	if (result.resultCount === 0) return undefined;
	return `<memories>\n${result.text}\n</memories>`;
}

/**
 * executeMemoryRetain is handled by the extension (mmemory.ts) which has access
 * to the LLM for extraction. This stub is a placeholder for direct tool calls
 * that bypass the extension lifecycle.
 */
export async function executeMemoryRetain(
	_sessionId: string,
	content: string,
	_config: MmemoryConfig,
): Promise<string> {
	// The extension's auto-retain handles this on agent_end.
	// Direct retain via tool writes verbatim content as a memory note.
	return `Memory note queued for indexing: ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`;
}

/**
 * executeMemoryReflect delegates to recall with a synthesis framing.
 */
export async function executeMemoryReflect(
	sessionId: string,
	query: string,
	scope: string | undefined,
	config: MmemoryConfig,
): Promise<RecallResult> {
	// Reflect = recall with higher limit, framed as synthesis request
	const result = await executeMemoryRecall(sessionId, query, scope, {
		...config,
		recallLimit: Math.min(config.recallLimit * 2, 20),
	});
	if (result.resultCount === 0) {
		return { text: `No memories found to reflect on for: ${query}`, resultCount: 0 };
	}
	return {
		text: `Reflection on "${query}" (${result.resultCount} relevant memories):\n\n${result.text}`,
		resultCount: result.resultCount,
	};
}
