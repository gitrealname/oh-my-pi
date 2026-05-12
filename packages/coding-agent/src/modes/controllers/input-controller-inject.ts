/**
 * RPC input-injection helpers for InputController.
 *
 * Extracted from input-controller.ts to keep that file merge-friendly.
 * Mirrors the pattern of input-controller-m-scripts.ts.
 *
 * Exposed as methods on InputController via thin wrappers that delegate here.
 */
import type { InteractiveModeContext } from "../types";

/**
 * Inject a keypress through the full TUI input pipeline.
 * Routes to the currently focused component (editor, panel, overlay, etc.).
 * ESC works in both editor context (aborts task) and panel context (closes panel).
 */
export function injectKey(key: string, ctx: InteractiveModeContext): void {
	const k = key.toLowerCase();

	// Map named keys to their terminal escape sequences
	const sequence = (k === "escape" || k === "esc") ? "\x1b"
		: (k === "enter" || k === "return") ? "\r"
		: (k === "ctrl-c" || k === "\x03") ? "\x03"
		: key; // raw sequence (e.g. \x1b[A for UP) passed as-is

	// Route through the full TUI input pipeline — handles navigation, panels, overlays
	const ui = ctx.ui as unknown as { simulateInput?: (s: string) => void };
	if (typeof ui.simulateInput === "function") {
		ui.simulateInput(sequence);
	} else {
		// Fallback: editor-only shortcuts if TUI simulateInput not available
		if (k === "\x1b" || k === "escape" || k === "esc") {
			ctx.editor.onEscape?.();
		} else if (k === "\n" || k === "\r" || k === "enter" || k === "return") {
			ctx.editor.onEnter?.();
		}
		// Other keys are no-ops without simulateInput
	}
}

/**
 * Inject text into the editor at cursor position (triggers render).
 */
export function injectText(text: string, ctx: InteractiveModeContext): void {
	ctx.editor.insertText(text);
}

/**
 * Inject a command as if the user typed it and pressed Enter.
 * Routes through the editor's submit handler — slash commands are handled
 * by the TUI layer, never reaching the LLM.
 */
export function injectCommand(text: string, ctx: InteractiveModeContext): void {
	void ctx.editor.onSubmit?.(text);
}
