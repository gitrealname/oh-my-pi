/**
 * Script executor keybinding definitions for aws-corp branch.
 * Kept separate to minimise upstream merge conflicts in keybindings.ts.
 *
 * keybindings.ts touches:
 *   1. `interface AppKeybindings extends AppScriptKeybindings { … }`
 *   2. `...SCRIPT_KEYBINDING_CONFIGS` spread at the end of KEYBINDINGS
 */

import type { KeyId } from "@oh-my-pi/pi-tui";
export interface AppScriptKeybindings {
	"app.script.1": true;
	"app.script.2": true;
	"app.script.3": true;
	"app.script.4": true;
	"app.script.5": true;
	"app.script.6": true;
	"app.script.7": true;
	"app.script.8": true;
	"app.script.9": true;
	"app.script.10": true;
}

/** Default: no key assigned. Bind in config keybindings: section, e.g.:
 *    "app.script.1": "ctrl+alt+v"
 */
export const SCRIPT_KEYBINDING_CONFIGS = {
	"app.script.1":  { defaultKeys: [] as KeyId[], description: "Run script 1" },
	"app.script.2":  { defaultKeys: [] as KeyId[], description: "Run script 2" },
	"app.script.3":  { defaultKeys: [] as KeyId[], description: "Run script 3" },
	"app.script.4":  { defaultKeys: [] as KeyId[], description: "Run script 4" },
	"app.script.5":  { defaultKeys: [] as KeyId[], description: "Run script 5" },
	"app.script.6":  { defaultKeys: [] as KeyId[], description: "Run script 6" },
	"app.script.7":  { defaultKeys: [] as KeyId[], description: "Run script 7" },
	"app.script.8":  { defaultKeys: [] as KeyId[], description: "Run script 8" },
	"app.script.9":  { defaultKeys: [] as KeyId[], description: "Run script 9" },
	"app.script.10": { defaultKeys: [] as KeyId[], description: "Run script 10" },
} as const;
