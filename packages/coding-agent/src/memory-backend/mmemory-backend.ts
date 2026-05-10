/**
 * mmemory MemoryBackend.
 *
 * Wires mmemory recall into the standard MemoryBackend lifecycle so memories
 * inject into the base system prompt via buildDeveloperInstructions — the
 * same path used by AGENTS.md, rules, and the hindsight backend.
 *
 * State is owned by this backend in a WeakMap<AgentSession, BackendState>.
 * It is written in start() and beforeAgentStartPrompt(), and read in
 * buildDeveloperInstructions(). No dependency on extension timing.
 *
 * Lifecycle:
 *   start()                      → init build, eager recall, consolidation poll
 *   beforeAgentStartPrompt()     → recall with user prompt → refreshes snippet
 *   buildDeveloperInstructions() → reads snippet → returns preamble + memories
 */

import { logger } from "@oh-my-pi/pi-utils";
import { settings as globalSettings } from "../config/settings";
import {
	createSidecar,
	sidecarPath,
} from "../utils/m-utils";
import {
	executeMemoryBuild,
	formatInjectionSnapshot,
	getOrCreateServerClient,
	loadMmemoryConfig,
} from "../tools/mmemory/index";
import type { MemoryBackend, MemoryBackendStartOptions } from "./types";
import type { AgentSession } from "../session/agent-session";
import type { InjectionSnapshot, MmemoryConfig } from "../tools/mmemory/index";
import embeddedInjectionPreamble from "../sidecars/mme-injection-preamble.md" with { type: "text" };
const resolveInjectionPreamble = createSidecar(sidecarPath("mme-injection-preamble.md"), embeddedInjectionPreamble);

interface BackendState {
	config:            MmemoryConfig;
	lastRecallSnippet: string | undefined;
}

// State stored ON the AgentSession object — same pattern as hindsight backend.
// WeakMap breaks when sdk.ts wraps session in a different reference per callsite.
function getState(session: AgentSession): BackendState | undefined {
	return session.getMmemoryBackendState() as BackendState | undefined;
}
function setState(session: AgentSession, state: BackendState): void {
	session.setMmemoryBackendState(state);
}

async function fetchInjectionSnapshot(
	config: MmemoryConfig,
): Promise<InjectionSnapshot | null> {
	try {
		const client = await getOrCreateServerClient(config);
		return (await client.query("get_injection_snapshot", {
			project_dir:        config.storageRoot,
			project:            config.projectLabel,
			session_limit:      config.injection.sessionLimit,
			observation_limit:  config.injection.observationLimit,
			file_limit:         config.injection.fileLimit,
			max_chars:          config.injection.maxChars,
		})) as InjectionSnapshot;
	} catch (e) {
		logger.error(`EXCEPTION: [mmemory-backend] fetchInjectionSnapshot failed: ${e instanceof Error ? e.stack : String(e)}`, { source: "mmemory" });
		return null;
	}
}

export const mmemoryBackend: MemoryBackend = {
	id: "mmemory",

	async start(options: MemoryBackendStartOptions): Promise<void> {
		const { session, settings } = options;
		const config = loadMmemoryConfig(settings, session.sessionManager.getCwd());
		if (!config) {
			logger.debug("[mmemory-backend] start: mmemory not enabled in config — skipping", { source: "mmemory" });
			return;
		}

		const state: BackendState = {
			config,
			lastRecallSnippet: undefined,
		};
		setState(session, state);

		logger.debug(
			`[mmemory-backend] start: session=${session.sessionId} storageRoot=${config.storageRoot}`,
			{ source: "mmemory" },
		);

		// Await build so snapshot is ready when buildDeveloperInstructions fires.
		// sdk.ts awaits start() before building the system prompt — making this void
		// caused a race where the prompt was built before the snapshot arrived.
		try {
			await executeMemoryBuild(config);
			logger.debug("[mmemory-backend] start: build complete, fetching injection snapshot", { source: "mmemory" });

			const snap    = await fetchInjectionSnapshot(config);
			const snippet = snap ? formatInjectionSnapshot(snap) : undefined;
			state.lastRecallSnippet = snippet;
			logger.debug(
				`[mmemory-backend] start: snapshot ready sessions=${snap?.sessions.length ?? 0}` +
				` obs=${snap?.observations.length ?? 0} files=${snap?.files.length ?? 0}` +
				` snippetLen=${snippet?.length ?? 0}`,
				{ source: "mmemory" },
			);
		} catch (e) {
			logger.error(`EXCEPTION: [mmemory-backend] start: build/snapshot failed: ${e instanceof Error ? e.stack : String(e)}`, { source: "mmemory" });
		}
	},

	async buildDeveloperInstructions(_agentDir, _settings, session): Promise<string | undefined> {
		// DEBUG (cleanup when stable): first line — fires regardless of session/state
		logger.debug(
			`[mmemory-backend] buildDeveloperInstructions: session=${session?.sessionId ?? "NONE"} hasState=${!!session && !!getState(session)}`,
			{ source: "mmemory" },
		);
		const preamble = resolveInjectionPreamble();
		if (!session) return preamble;
		const state   = getState(session);
		const snippet = state?.lastRecallSnippet;
		logger.debug(
			`[mmemory-backend] buildDeveloperInstructions: snippetLen=${snippet?.length ?? 0}`,
			{ source: "mmemory" },
		);
		if (!snippet) return preamble;
		return [preamble, snippet].join("\n\n");
	},

	async beforeAgentStartPrompt(session, promptText): Promise<string | undefined> {
		const state = getState(session);
		if (!state) return undefined;

		const { config } = state;
		const snap = await fetchInjectionSnapshot(config);
		const snippet = snap ? formatInjectionSnapshot(snap) : undefined;
		state.lastRecallSnippet = snippet;
		logger.debug(
			`[mmemory-backend] beforeAgentStartPrompt: sessions=${snap?.sessions.length ?? 0}` +
			` obs=${snap?.observations.length ?? 0} files=${snap?.files.length ?? 0}` +
			` snippetLen=${snippet?.length ?? 0}`,
			{ source: "mmemory" },
		);
		// Trigger system prompt rebuild so buildDeveloperInstructions picks up the
		// new snippet — same pattern as hindsight/state.ts #refreshBaseSystemPromptAfter
		await session.refreshBaseSystemPrompt().catch(e =>
			logger.error(`EXCEPTION: [mmemory-backend] refreshBaseSystemPrompt failed: ${e instanceof Error ? e.stack : String(e)}`, { source: "mmemory" }),
		);
		return undefined;
	},

	async clear(_agentDir, _cwd, _session): Promise<void> {
		logger.warn("[mmemory-backend] clear: use /mmemory clear instead.", { source: "mmemory" });
	},

	async enqueue(_agentDir, _cwd, _session): Promise<void> {
		logger.warn("[mmemory-backend] enqueue: use /mmemory retain instead.", { source: "mmemory" });
	},
};

/** Read the backend state for a session — used by mmemory-extension for consolidation drain. */
export function getMmemoryBackendState(session: AgentSession): BackendState | undefined {
	return getState(session);
}