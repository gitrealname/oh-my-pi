/**
 * Keeps a switched-to preset's roles in effect even when a `--config` overlay
 * would otherwise shadow them.
 *
 * Layer precedence (runtime override → config overlay → project → global) means
 * an overlay that defines ambient `modelRoles` (a launcher's model hint) wins
 * over the roles a preset switch persists into the global config. The user
 * manages their preset catalog *in* the overlay on purpose — "global config is
 * constantly overwritten and all my comments are gone" — so the fix is not to
 * move the presets but to make the overlay's in-memory layer reflect the last
 * switched preset until the next switch. The overlay file on disk is never
 * touched; the global config keeps recording the intent (last roles written).
 *
 * The patch is captured when a preset is applied and re-applied by `Settings`
 * itself after every layer reload (watcher or init), so a re-read of the
 * unchanged — or changed — overlay cannot resurrect the pre-switch roles.
 * Editing the overlay's ambient `modelRoles` while a preset is active has no
 * effect until another switch; restart behavior is unchanged.
 */

import type { Settings } from "./settings";

/** Process-wide active patch: role → selector, from the last applied preset. */
let activePatch: Record<string, string> | undefined;

/** Capture `presetRoles` as the patch re-applied after every overlay reload. */
export function captureOverlayPresetRoles(presetRoles: Record<string, string>): void {
	activePatch = { ...presetRoles };
}

/** Current patch, for tests and status consumers; `undefined` when none is active. */
export function overlayPresetRolesPatch(): Readonly<Record<string, string>> | undefined {
	return activePatch;
}

/**
 * Apply the active patch onto `settings`' in-memory overlay layer. Called by
 * `Settings` after every overlay (re)load; a no-op without a patch.
 */
export function applyOverlayPresetRolesPatch(settings: Settings): void {
	if (activePatch === undefined) return;
	settings.patchOverlayModelRoles(activePatch);
}
