/**
 * oh-my-pi/pi-coding-agent/open-sdk — exports for external extensions.
 *
 * Re-exports ALL open-sdk surfaces from pi-ai and pi-tui so extensions
 * can access everything via `pi.pi.*` in compiled-binary mode.
 *
 * Usage (via ExtensionAPI in extensions):
 *   const m = pi.pi;
 *   await m.complete({ model: "...", messages: [...] });
 *   const creds = await m.resolveAwsCredentials({ region: "us-east-1" });
 *   const killRing = new m.KillRing();
 */
export { complete, completeSimple, streamSimple } from "@oh-my-pi/pi-ai";
export { resolveRoleSelection } from "./config/model-resolver";
export { settings, isSettingsInitialized } from "./config/settings";

// ── Open-sdk helper functions ──────────────────────────────────────────────

import type { Settings as SettingsType } from "./config/settings";
import type { AgentSession } from "./session/agent-session";
import type { SettingPath } from "./config/settings-schema";

/**
 * Apply multiple runtime overrides in a single transaction.
 * Calls `settings.override()` for each key, optionally firing side-effect
 * hooks for known settings (theme, symbols, tabWidth, etc.) via
 * `{ fireHooks: true }`.
 *
 * Runtime-only — not persisted to config.yml.
 */
export function applyOverrides(
	settings: SettingsType,
	overrides: Record<string, unknown>,
	options?: { fireHooks?: boolean },
): { applied: string[]; skipped: { key: string; reason: string }[] } {
	const applied: string[] = [];
	const skipped: { key: string; reason: string }[] = [];
	for (const [key, value] of Object.entries(overrides)) {
		try {
			settings.override(key as SettingPath, value, { fireHook: options?.fireHooks });
			applied.push(key);
		} catch (err) {
			skipped.push({ key, reason: String(err) });
		}
	}
	return { applied, skipped };
}

/**
 * Dispatch a slash command without sending to the LLM.
 * Checks if the command is a registered extension command first,
 * then delegates to `session.prompt()` which handles the full dispatch chain.
 * Returns true if the command was recognized and dispatched.
 *
 * Limitation: only checks extension commands (registered via pi.registerCommand).
 * Custom and file-based commands are handled by prompt() but won't be pre-validated.
 * Unrecognized commands fall through to the LLM — this is the documented prompt() behavior.
 */
export async function dispatchSlashCommand(
	session: AgentSession,
	text: string,
): Promise<boolean> {
	if (!text.startsWith("/")) return false;
	// Check if it's a registered extension command
	const runner = session.extensionRunner;
	if (runner) {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (runner.getCommand(commandName)) {
			await session.prompt(text);
			return true;
		}
	}
	// Let prompt() handle the full dispatch chain (extension → custom → file-based → LLM)
	// Unrecognized /commands go to the LLM — this is the documented behavior
	await session.prompt(text);
	return true;
}

// Re-export ALL pi-ai open-sdk exports (AWS internals, stream utils, etc.)
export * from "@oh-my-pi/pi-ai/open-sdk";
// Re-export ALL pi-tui open-sdk exports (KillRing, BracketedPasteHandler)
export * from "@oh-my-pi/pi-tui/open-sdk";
