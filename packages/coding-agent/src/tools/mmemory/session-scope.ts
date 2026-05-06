/**
 * Shared mmemory recall-scope state.
 *
 * Keyed by sessionManager object (same reference used in both mmemory-extension.ts
 * and builtin-registry.ts mmemoryHandler). WeakMap ensures no memory leak — scope
 * is released when the session is GC'd.
 *
 * Scope values:
 *   undefined  — not set; use per-project default
 *   null       — global (no project filter)
 *   string     — named project label (e.g. "carity2")
 */

export type MmemoryScope = null | string;

const _map = new WeakMap<object, MmemoryScope>();

/** Returns the explicit scope set for this session, or undefined if not overridden. */
export function getRecallScope(sessionKey: object): MmemoryScope | undefined {
	return _map.get(sessionKey);
}

/** Override recall scope for this session. Pass undefined to reset to project default. */
export function setRecallScope(sessionKey: object, scope: MmemoryScope | undefined): void {
	if (scope === undefined) {
		_map.delete(sessionKey);
	} else {
		_map.set(sessionKey, scope);
	}
}

/** Human-readable label for display in status / status bar. */
export function scopeLabel(sessionKey: object, defaultProjectLabel: string): string {
	const s = _map.get(sessionKey);
	if (s === undefined) return defaultProjectLabel;
	if (s === null) return "/";
	return s;
}
