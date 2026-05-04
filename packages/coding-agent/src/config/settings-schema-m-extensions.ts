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
	"mmemory.storagePath": {
		type: "string" as const,
		default: undefined as string | undefined,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Storage path",
			description:
				"Root directory for mmemory storage. Defaults to $PI_CODING_AGENT_DIR/mmemory/ when launched via o/ow, or ~/.omp/mmemory/ otherwise. Supports ~.",
		},
	},

	"mmemory.projectName": {
		type: "string" as const,
		default: undefined as string | undefined,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Project name",
			description:
				"Memory bucket name. Defaults to the basename of the working directory. Changing this starts a fresh memory set.",
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
		default: "per-project-tagged" as "per-project" | "per-project-tagged" | "global",
		ui: {
			tab: "tools" as const,
			label: "MMemory: Scoping",
			description:
				"per-project — recall from this project only. per-project-tagged — recall from this project + global/. global — single shared store.",
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

	"mmemory.recallMaxQueryChars": {
		type: "number" as const,
		default: 2000,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Recall query max chars",
			description: "Maximum characters fed to the BM25 recall query.",
		},
	},

	"mmemory.recallLimit": {
		type: "number" as const,
		default: 10,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Recall result limit",
			description: "Maximum number of chunks returned per recall query.",
		},
	},

	"mmemory.recallDeadlineMs": {
		type: "number" as const,
		default: 10000,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Recall deadline (ms)",
			description: "Hard timeout for the recall server call. Recall is skipped if not answered in time.",
		},
	},

	"mmemory.recencyWeight": {
		type: "number" as const,
		default: 0.3,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Recency weight",
			description:
				"Blend factor for time-decay in scoring: 0 = pure BM25, 1 = pure recency. Recommended: 0.2–0.4.",
		},
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

	"mmemory.maxRawFacts": {
		type: "number" as const,
		default: 100,
		ui: {
			tab: "tools" as const,
			label: "MMemory: Max raw facts",
			description:
				"facts.json entries before /mmemory consolidate is offered. Only relevant in structured mode.",
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
				"Path for mmemory Python server stderr output. Defaults to <storagePath>/mmemory-server.log. Supports ~.",
		},
	},
} as const;

/** Typed interface for getGroup("mmemory") */
export interface MmemorySettings {
	enabled: boolean;
	storagePath: string | undefined;
	projectName: string | undefined;
	modelRole: string | undefined;
	consolidateModelRole: string | undefined;
	retainMission: string | undefined;
	extractionMode: "verbatim" | "structured";
	scoping: "per-project" | "per-project-tagged" | "global";
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
