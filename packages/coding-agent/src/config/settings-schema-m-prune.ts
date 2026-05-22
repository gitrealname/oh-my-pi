/**
 * Settings schema entries for the mprune dynamic context-pruning extension.
 * Kept separate to minimise upstream merge conflicts in settings-schema.ts.
 *
 * settings-schema.ts touches:
 *   `...PRUNE_SCHEMA_ENTRIES` spread at the end of SETTINGS_SCHEMA
 */

export const PRUNE_SCHEMA_ENTRIES = {
	"mprune.enabled":            { type: "boolean" as const, default: false },
	"mprune.showStatusLine":     { type: "boolean" as const, default: true },
	// AWS-CORP: custom — merge with care
	// How many recent turns to keep unpruned (sliding window). Applies to both batch
	// summarization and image aging unless overridden by the specific sub-setting.
	"mprune.keepTurns":          { type: "number"  as const, default: 10 },
	// images.keepTurns: 0 = inherit from mprune.keepTurns; positive = explicit override
	"mprune.images.keepTurns":   { type: "number"  as const, default: 0 },
	"mprune.trim.softTrimChars": { type: "number"  as const, default: 12000 },
} as const;
