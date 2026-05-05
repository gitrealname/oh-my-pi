/**
 * Settings schema entries for aws-corp script executor slots (app.script.1-10).
 * Kept separate to minimise upstream merge conflicts in settings-schema.ts.
 *
 * settings-schema.ts touches:
 *   `...SCRIPT_SCHEMA_ENTRIES` spread at the end of SETTINGS_SCHEMA
 */

export const SCRIPT_SCHEMA_ENTRIES = {
	"scripts.1.command":      { type: "string" as const, default: undefined as string | undefined },
	"scripts.1.description":  { type: "string" as const, default: "Script 1" as string | undefined },
	"scripts.2.command":      { type: "string" as const, default: undefined as string | undefined },
	"scripts.2.description":  { type: "string" as const, default: "Script 2" as string | undefined },
	"scripts.3.command":      { type: "string" as const, default: undefined as string | undefined },
	"scripts.3.description":  { type: "string" as const, default: "Script 3" as string | undefined },
	"scripts.4.command":      { type: "string" as const, default: undefined as string | undefined },
	"scripts.4.description":  { type: "string" as const, default: "Script 4" as string | undefined },
	"scripts.5.command":      { type: "string" as const, default: undefined as string | undefined },
	"scripts.5.description":  { type: "string" as const, default: "Script 5" as string | undefined },
	"scripts.6.command":      { type: "string" as const, default: undefined as string | undefined },
	"scripts.6.description":  { type: "string" as const, default: "Script 6" as string | undefined },
	"scripts.7.command":      { type: "string" as const, default: undefined as string | undefined },
	"scripts.7.description":  { type: "string" as const, default: "Script 7" as string | undefined },
	"scripts.8.command":      { type: "string" as const, default: undefined as string | undefined },
	"scripts.8.description":  { type: "string" as const, default: "Script 8" as string | undefined },
	"scripts.9.command":      { type: "string" as const, default: undefined as string | undefined },
	"scripts.9.description":  { type: "string" as const, default: "Script 9" as string | undefined },
	"scripts.10.command":     { type: "string" as const, default: undefined as string | undefined },
	"scripts.10.description": { type: "string" as const, default: "Script 10" as string | undefined },
} as const;
