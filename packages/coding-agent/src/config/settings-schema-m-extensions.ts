/**
 * Settings schema entries for aws-corp "m" extensions:
 *   - mmemory  (local semantic memory — BM25 + fastembed)
 *
 * Kept in a separate file so that upstream merges of settings-schema.ts
 * touch only the single spread line, not every individual entry.
 *
 * mbrowser and mreview keys that were already present in settings-schema.ts
 * remain there; only the mmemory sub-keys (beyond mmemory.enabled, which is
 * also already there) live here.
 */

// ── mmemory ───────────────────────────────────────────────────────────────────

export const MMEMORY_SCHEMA_ENTRIES = {
	"mmemory.storageRoot": {
		type: "string" as const,
		default: undefined as string | undefined,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Storage root",
			description:
				"Full path to mmemory storage root. All session memories, queue files, and indexes are stored here. Supports ~.",
		},
	},


	"mmemory.agentTag": {
		type: "string" as const,
		default: "default" as string,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Agent tag",
			description:
				"Isolates memories within the same project by agent identity. Multiple OMP agents in the same working directory can use different tags to maintain separate memory spaces. Default: \"default\" (shared by all untagged agents).",
		},
	},

	"mmemory.modelRole": {
		type: "string" as const,
		default: "memory" as string | undefined,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Model role",
			description:
				"Model role used for fact extraction and recall synthesis. Must match a key in modelRoles.",
		},
	},

	"mmemory.timeFilterModelRole": {
		type: "string" as const,
		default: undefined as string | undefined,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Time-filter model role",
			description:
				"Model role for temporal query preprocessing (converts 'last week' → timestamps). Falls back to mmemory.modelRole. Use a cheap/fast model — this fires on every recall query that contains a time hint.",
		},
	},

	"mmemory.consolidateModelRole": {
		type: "string" as const,
		default: undefined as string | undefined,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Consolidate model role",
			description:
				"Model role used for /mmemory consolidate. Falls back to mmemory.modelRole when unset.",
		},
	},

	"mmemory.retainMission": {
		type: "string" as const,
		default: undefined as string | undefined,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Retain mission",
			description:
				"Instruction injected into the extraction prompt. Guides what the LLM considers worth retaining.",
		},
	},

	"mmemory.extractionMode": {
		type: "enum" as const,
		values: ["verbatim", "structured"] as const,
		default: "verbatim" as "verbatim" | "structured",
		ui: {
			tab: "tools" as const,
			label: "MMemory: Extraction mode",
			description:
				"verbatim — save raw turn transcripts (Phase 2, cheaper). structured — LLM-extracted facts (Phase 3, richer).",
		},
	},

	"mmemory.scoping": {
		type: "enum" as const,
		values: ["per-project", "per-project-tagged", "global"] as const,
		default: "per-project" as "per-project" | "per-project-tagged" | "global",
		ui: {
			tab: "tools" as const,
			label: "MMemory: Default recall scope",
			description:
				"per-project — project filter only. per-project-tagged — project + agent tag filter. global — no filter. Overridable per-session with /mmemory / or /mmemory .",
		},
	},

	"mmemory.retainEveryNTurns": {
		type: "number" as const,
		default: 3,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Auto-retain interval (turns)",
			description: "Auto-retain fires every N agent turns. Set to 1 to retain after every turn.",
		},
	},

	"mmemory.retainContextTurns": {
		type: "number" as const,
		default: 3,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Retain context window (turns)",
			description: "Number of turns included in each auto-retain transcript.",
		},
	},

	"mmemory.recall.maxQueryChars": {
		type: "number" as const,
		default: 2000,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Recall query max chars",
			description: "Maximum characters fed to the BM25 recall query.",
		},
	},

	"mmemory.recall.limit": {
		type: "number" as const,
		default: 10,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Recall result limit",
			description: "Maximum number of chunks returned per recall query.",
		},
	},

	"mmemory.recall.deadlineMs": {
		type: "number" as const,
		default: 10000,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Recall deadline (ms)",
			description: "Hard timeout for the recall server call. Recall is skipped if not answered in time.",
		},
	},

	"mmemory.recall.recencyWeight": {
		type: "number" as const,
		default: 0.3,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Recency weight",
			description:
				"Blend factor for time-decay in scoring: 0 = pure BM25, 1 = pure recency. Recommended: 0.2–0.4.",
		},
	},

	"mmemory.recall.fileLimit": {
		type: "number" as const,
		default: 20,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Recall file limit",
			description: "Max paths injected into <referenced_files>; sorted ts ASC (most recent last).",
		},
	},

	"mmemory.recall.includeReadFiles": {
		type: "boolean" as const,
		default: false,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Include read-only files",
			description: "Include read-only files alongside modified/written in <referenced_files>. Default: false.",
		},
	},

	"mmemory.recall.observationLimit": {
		type: "number" as const,
		default: 10,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Observation limit",
			description: "Max observations injected into <observations>. 0 = disabled.",
		},
	},

	"mmemory.injection.sessionLimit": {
		type: "number" as const,
		default: 5,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Injection session limit",
			description: "Max session chunks injected into system prompt via get_injection_snapshot. Newest N retained.",
		},
	},

	"mmemory.injection.observationLimit": {
		type: "number" as const,
		default: 3,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Injection observation limit",
			description: "Max observations injected. Selected as the K nearest before the session window (end_ts < oldest session ts).",
		},
	},

	"mmemory.injection.fileLimit": {
		type: "number" as const,
		default: 5,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Injection file limit",
			description: "Max file chunks injected into <referenced_files>. Newest M retained. Never dropped by max_chars.",
		},
	},

	"mmemory.injection.maxChars": {
		type: "number" as const,
		default: 8000,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Injection max chars",
			description: "Total character budget for injection snapshot. If exceeded, newest session chunks are dropped first. Files and observations are never dropped.",
		},
	},
	"mmemory.vacuum.enabled": {
		type: "boolean" as const,
		default: true,
		ui: { tab: "tools" as const, label: "MMemory: Vacuum enabled",
			  description: "Enable periodic age-based purge of stale chunks and vectors." },
	},
	"mmemory.vacuum.intervalHours": {
		type: "number" as const,
		default: 24,
		ui: { tab: "tools" as const, label: "MMemory: Vacuum interval (hours)",
			  description: "Minimum hours between automatic vacuum runs." },
	},
	"mmemory.vacuum.sessionMaxAgeDays": {
		type: "number" as const,
		default: 365,
		ui: { tab: "tools" as const, label: "MMemory: Session max age (days)",
			  description: "Purge source:session chunks older than this." },
	},
	"mmemory.vacuum.observationMaxAgeDays": {
		type: "number" as const,
		default: 90,
		ui: { tab: "tools" as const, label: "MMemory: Observation max age (days)",
			  description: "Purge source:observation chunks older than this." },
	},
	"mmemory.vacuum.fileMaxAgeDays": {
		type: "number" as const,
		default: 180,
		ui: { tab: "tools" as const, label: "MMemory: File max age (days)",
			  description: "Purge source:file chunks older than this." },
	},
	"mmemory.deduplicationThreshold": {
		type: "number" as const,
		default: 0.92,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Deduplication threshold",
			description:
				"Jaccard similarity threshold above which two chunks are considered duplicates. Range 0–1; higher = stricter.",
		},
	},

	"mmemory.serverIdleTimeoutMinutes": {
		type: "number" as const,
		default: 10,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Server idle timeout (minutes)",
			description: "The Python mmemory server is shut down after this many minutes of inactivity.",
		},
	},

	"mmemory.autoRetain": {
		type: "boolean" as const,
		default: true,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Auto-retain",
			description: "Automatically retain session transcripts every retainEveryNTurns turns.",
		},
	},

	"mmemory.maxTranscriptChars": {
		type: "number" as const,
		default: 0,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Max transcript chars",
			description:
				"Truncate retained transcripts to this length. 0 = no limit. Useful when sessions are very long.",
		},
	},

	"mmemory.consolidationMinTurns": {
		type: "number" as const,
		default: 10,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Consolidation min turns",
			description: "Min unprocessed turn chunks before auto-consolidation fires",
		},
	},

	"mmemory.consolidationMaxTurns": {
		type: "number" as const,
		default: 50,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Consolidation max turns",
			description: "Max turn chunks passed to LLM per consolidation run",
		},
	},

	"mmemory.consolidationPollIntervalMinutes": {
		type: "number" as const,
		default: 5,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Consolidation poll interval (minutes)",
			description: "How often (minutes) to poll server for consolidation eligibility after each retain",
		},
	},

	"mmemory.consolidationMaxObservationChars": {
		type: "number" as const,
		default: 400,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Consolidation max observation chars",
			description: "Max characters for the observation text produced per consolidation call. Passed into the LLM prompt — the model self-limits.",
		},
	},

	"mmemory.serverPort": {
		type: "number" as const,
		default: 49200,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Server port",
			description:
				"Fixed TCP port for the mmemory Python server. Change if 49200 is already in use. The server is shared across all projects; project identity is sent per-request.",
		},
	},

	"mmemory.serverLogFile": {
		type: "string" as const,
		default: undefined as string | undefined,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Server log file",
			description:
				"Path for mmemory Python server stderr output. Defaults to <storageRoot>/mmemory-server.log. Supports ~.",
		},
	},
} as const;

/** Typed interface for getGroup("mmemory") */
export interface MmemorySettings {
	enabled: boolean;
	storageRoot: string | undefined;
	modelRole: string | undefined;
	consolidateModelRole: string | undefined;
	timeFilterModelRole: string | undefined;
	retainMission: string | undefined;
	extractionMode: "verbatim" | "structured";
	scoping: "per-project" | "per-project-tagged" | "global";
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
	agentTag: string;
	recall: {
		maxQueryChars: number;
		limit: number;
		deadlineMs: number;
		recencyWeight: number;
		fileLimit: number;
		includeReadFiles: boolean;
		observationLimit: number;
		factsLimit: number;
	};
	vacuum: {
		enabled: boolean;
		intervalHours: number;
		sessionMaxAgeDays: number;
		observationMaxAgeDays: number;
		factMaxAgeDays: number;
		fileMaxAgeDays: number;
	};
}