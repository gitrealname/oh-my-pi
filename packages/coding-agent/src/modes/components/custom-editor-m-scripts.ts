/**
 * Script executor editor action definitions for aws-corp branch.
 * Kept separate to minimise upstream merge conflicts in custom-editor.ts.
 *
 * custom-editor.ts touches:
 *   1. `| ScriptEditorActions` appended to ConfigurableEditorAction union
 *   2. `...SCRIPT_DEFAULT_ACTION_KEYS` spread at the end of DEFAULT_ACTION_KEYS
 */

import type { KeyId } from "@oh-my-pi/pi-tui";

export type ScriptEditorActions =
	| "app.script.1"
	| "app.script.2"
	| "app.script.3"
	| "app.script.4"
	| "app.script.5"
	| "app.script.6"
	| "app.script.7"
	| "app.script.8"
	| "app.script.9"
	| "app.script.10";

/** No default key for any script slot; bind in config keybindings: section. */
export const SCRIPT_DEFAULT_ACTION_KEYS: Record<ScriptEditorActions, KeyId[]> = {
	"app.script.1":  [],
	"app.script.2":  [],
	"app.script.3":  [],
	"app.script.4":  [],
	"app.script.5":  [],
	"app.script.6":  [],
	"app.script.7":  [],
	"app.script.8":  [],
	"app.script.9":  [],
	"app.script.10": [],
};
