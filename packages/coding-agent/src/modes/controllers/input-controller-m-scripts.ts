/**
 * Script executor slot handler for aws-corp branch.
 * Kept separate to minimise upstream merge conflicts in input-controller.ts.
 *
 * input-controller.ts touches:
 *   1. `import { runScriptSlot } from "./input-controller-m-scripts"`
 *   2. Key-handler loop that calls `runScriptSlot(slot, this.ctx)`
 *   3. Thin `handleScript(slot)` delegating to `runScriptSlot`
 */

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import { executePython } from "../../eval/py/executor";
import { BashExecutionComponent } from "../components/bash-execution";
import { ensureSupportedImageInput } from "../../utils/image-loading";
import { resizeImage } from "../../utils/image-resize";
import type { InteractiveModeContext } from "../types";

// ─── @omp: output protocol ────────────────────────────────────────────────────
//
// Scripts communicate structured output to OMP via lines prefixed with `@omp:`.
// Any line NOT starting with `@omp:` is treated as bare text (LLM-visible stdout).
//
//   @omp:image:<path>    Attach <path> as a pending image → [Image #N] placeholder
//   @omp:text:<content>  Insert <content> at cursor (prompt editor)
//   @omp:!!:<content>    Show in chat as LLM-excluded output (same as !! bash)
//
// A script may emit multiple @omp: directives.  All non-@omp lines are joined
// and submitted as a user message (LLM sees them as tool-result style input).
//
// Pure parser lives in input-controller-m-scripts-protocol.ts (no native deps).
import type { OmpDirective } from "./input-controller-m-scripts-protocol";
import { parseOutput } from "./input-controller-m-scripts-protocol";
export type { OmpDirective };
export { parseOutput };

// ─── Command runner ───────────────────────────────────────────────────────────

/**
 * Run a command string and return its raw stdout (not trimmed — protocol needs newlines).
 *
 * Prefix dispatch:
 *   `py: <code>`    — executePython via existing IPython kernel (stateful)
 *   `js: <code>`    — bun --eval subprocess (stateless)
 *   anything else   — direct spawn, whitespace-split args
 *                     (use py:/js: for commands with space-containing paths)
 */
async function runScriptCommand(cmd: string, cwd: string): Promise<string> {
	const trimmed = cmd.trim();

	if (trimmed.startsWith("py:")) {
		const code = trimmed.slice(3).trimStart();
		const result = await executePython(code, { cwd });
		return result.output;
	}

	if (trimmed.startsWith("js:")) {
		const code = trimmed.slice(3).trimStart();
		const proc = Bun.spawn(["bun", "--eval", code], { stdout: "pipe", stderr: "pipe", cwd });
		const [out, err, code_] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code_ !== 0) throw new Error(err.trim() || `exit code ${code_}`);
		return out;
	}

	// Generic shell command
	const parts = trimmed.split(/\s+/);
	const proc = Bun.spawn(parts, { stdout: "pipe", stderr: "pipe", cwd });
	const [out, err, code_] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code_ !== 0) throw new Error(err.trim() || `exit code ${code_}`);
	return out;
}

// ─── MIME helper ──────────────────────────────────────────────────────────────

function mimeFromPath(p: string): string {
	const ext = nodePath.extname(p).toLowerCase();
	return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
		: ext === ".gif"  ? "image/gif"
		: ext === ".webp" ? "image/webp"
		: ext === ".bmp"  ? "image/bmp"
		: "image/png";
}

// ─── Directive handlers ───────────────────────────────────────────────────────

/** Threshold: text at or below this inserts inline; above → bracketed-paste indicator. */
export const INLINE_LIMIT = 1000;

async function handleImageDirective(path: string, ctx: InteractiveModeContext, desc: string): Promise<void> {
	const bytes = await fs.readFile(path);
	let imageData = await ensureSupportedImageInput({
		type: "image",
		data: bytes.toBase64(),
		mimeType: mimeFromPath(path),
	});
	if (!imageData) {
		ctx.showStatus(`${desc}: unsupported image format`);
		return;
	}
	if (settings.get("images.autoResize")) {
		try {
			const resized = await resizeImage(imageData);
			imageData = { type: "image", data: Buffer.from(resized.buffer).toString("base64"), mimeType: resized.mimeType };
		} catch { /* keep original */ }
	}
	ctx.pendingImages.push(imageData);
	ctx.editor.insertText(`[Image #${ctx.pendingImages.length}] `);
}

function handleTextDirective(content: string, ctx: InteractiveModeContext): void {
	if (content.length <= INLINE_LIMIT) {
		ctx.editor.insertText(content);
	} else {
		ctx.editor.handleInput(`\x1b[200~${content}\x1b[201~`);
	}
}

/** Display output in chat with dim border — visible to user, excluded from LLM context. */
function handleExcludedDirective(content: string, ctx: InteractiveModeContext, label: string): void {
	const comp = new BashExecutionComponent(label, ctx.ui, true /* excludeFromContext */);
	ctx.chatContainer.addChild(comp);
	comp.setComplete(0, false, { output: content });
}

/** Submit as user message — LLM sees it as tool-result style input. */
async function handleStdoutDirective(content: string, ctx: InteractiveModeContext): Promise<void> {
	if (!ctx.onInputCallback) return;
	const submission = ctx.startPendingSubmission({ text: content });
	ctx.onInputCallback(submission);
	ctx.editor.addToHistory(content);
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Execute script slot N and route output via the @omp: protocol.
 *
 * Output routing (per line):
 *   @omp:image:<path>    → attach image as [Image #N] pending attachment
 *   @omp:text:<content>  → insert <content> into prompt editor
 *   @omp:!!:<content>    → show in chat (dim border), excluded from LLM context
 *   bare text            → submit as user message (LLM-visible, like tool stdout)
 */
export async function runScriptSlot(slot: number, ctx: InteractiveModeContext): Promise<void> {
	const cmd = settings.get(`scripts.${slot}.command` as "scripts.1.command");
	const desc = settings.get(`scripts.${slot}.description` as "scripts.1.description") ?? `Script ${slot}`;
	logger.debug("[script] runScriptSlot", { slot, cmd, desc });

	if (!cmd) {
		ctx.showStatus(`${desc}: no command configured (scripts.${slot}.command)`);
		return;
	}

	try {
		const raw = await runScriptCommand(cmd, ctx.sessionManager.getCwd());
		logger.debug("[script] command output", { slot, bytes: raw.length });

		if (!raw.trim()) {
			ctx.showStatus(`${desc}: no output`);
			return;
		}

		const directives = parseOutput(raw);
		logger.debug("[script] directives", { slot, count: directives.length, kinds: directives.map(d => d.kind) });

		for (const directive of directives) {
			switch (directive.kind) {
				case "image":
					await handleImageDirective(directive.path, ctx, desc);
					break;
				case "text":
					handleTextDirective(directive.content, ctx);
					break;
				case "excluded":
					handleExcludedDirective(directive.content, ctx, desc);
					break;
				case "stdout":
					await handleStdoutDirective(directive.content, ctx);
					break;
			}
		}

		ctx.ui.requestRender();
	} catch (err) {
		ctx.showStatus(`${desc} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
