/**
 * tree-peek — Enhanced tree selector with collapsible content preview.
 *
 * Wraps TreeSelectorComponent. Identical behavior until Ctrl+↓ opens preview.
 *
 * Ctrl+↑/↓         open/scroll preview
 * Ctrl+Alt+↑/↓     navigate tree with preview open
 * Ctrl+Alt+Home/End/PgUp/PgDn  jump with preview open
 * Any other key     close preview, forward to tree
 */

import { Container, type TUI } from "@oh-my-pi/pi-tui";
import { matchesKey, wrapTextWithAnsi, Markdown } from "@oh-my-pi/pi-tui";
import { TreeSelectorComponent } from "./tree-selector";
import { getMarkdownTheme, getLanguageFromPath, theme } from "../theme/theme";

const PREVIEW_ROWS = 12;
const SCROLL_STEP = 3;
const TREE_OVERHEAD = 10;

type AnyEntry = Record<string, any>;

function formatToolLabel(name: string, args: AnyEntry): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const shorten = (p: string) => {
		const s = String(p).replace(/\\/g, "/");
		return home ? s.replace(home.replace(/\\/g, "/"), "~") : s;
	};
	switch (name) {
		case "bash": return `bash ${String(args.command ?? "").replace(/[\n\t]/g, " ").trim()}`;
		case "read": {
			const p = shorten(String(args.path ?? args.file_path ?? ""));
			const offset = args.offset, limit = args.limit;
			const range = (offset != null || limit != null)
				? `:${offset ?? 1}${limit != null ? `-${(offset ?? 1) + limit - 1}` : ""}`
				: "";
			return `read ${p}${range}`;
		}
		case "write": return `write ${shorten(String(args.path ?? args.file_path ?? ""))}`;
		case "edit": return `edit ${shorten(String(args.path ?? args.file_path ?? ""))}`;
		default: return `${name} ${JSON.stringify(args ?? {})}`;
	}
}

function buildPreview(
	entry: AnyEntry | undefined,
	width: number,
	toolCallMap: Map<string, { name: string; arguments: AnyEntry }>,
): string[] {
	if (!entry) return [""];
	const lines: string[] = [];
	const PAD = "  ";
	const avail = Math.max(0, width - PAD.length);

	const emit = (text: string, fg: string, bg?: string) => {
		for (const raw of String(text ?? "").trimEnd().split("\n")) {
			const plain = raw.replace(/\t/g, "  ");
			const wrapped = plain.length > 0 ? wrapTextWithAnsi(plain, avail) : [""];
			for (const seg of wrapped)
				lines.push(PAD + (bg ? theme.bg(bg as any, theme.fg(fg as any, seg.padEnd(avail))) : theme.fg(fg as any, seg)));
		}
	};

	const ln = (text: string, fg: string, bg?: string) => {
		const s = text.slice(0, avail);
		lines.push(PAD + (bg ? theme.bg(bg as any, theme.fg(fg as any, s.padEnd(avail))) : theme.fg(fg as any, s)));
	};

	const gap = (bg?: string) =>
		lines.push(bg ? PAD + theme.bg(bg as any, " ".repeat(avail)) : "");
	const textOf = (content: unknown): string => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return (content as AnyEntry[]).filter(c => c?.type === "text").map(c => String(c.text ?? "")).join("\n");
	};

	if (entry.type !== "message") {
		for (const [k, v] of Object.entries(entry)) {
			if (["id", "parentId", "timestamp", "type"].includes(k)) continue;
			emit(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`, "dim");
		}
		return lines.length ? lines : [""];
	}

	const msg = entry.message;
	if (!msg) return ["  (empty)"];

	if (msg.role === "user") {
		emit(textOf(msg.content) || "(empty)", "accent", "userMessageBg");
	} else if (msg.role === "assistant") {
		const mdTheme = getMarkdownTheme();
		const blks: AnyEntry[] = Array.isArray(msg.content) ? msg.content : [];
		const text = blks.filter(b => b?.type === "text").map(b => String(b.text ?? "")).join("\n");
		if (text.trim()) lines.push(...new Markdown(text.trim(), 2, 0, mdTheme).render(width));
		for (const b of blks) {
			if (b?.type === "thinking" && String(b.thinking ?? "").trim()) {
				gap(); ln("· thinking:", "thinkingText");
				lines.push(...new Markdown(String(b.thinking).trim(), 2, 0, mdTheme, {
					color: (t: string) => theme.fg("thinkingText", t),
					italic: true,
				}).render(width));
			}
		}
		for (const b of blks) {
			if (b?.type === "toolCall") {
				gap(); ln(`· ${b.name}:`, "muted"); emit(JSON.stringify(b.arguments ?? {}, null, 2), "dim");
			}
		}
	} else if (msg.role === "toolResult") {
		const isError = !!msg.isError;
		const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : undefined;
		const toolName = toolCall?.name ?? msg.toolName ?? "tool";
		const toolBg = isError ? "toolErrorBg" : "toolSuccessBg";

		if (toolName === "bash" && toolCall) {
			const cmdLines = String(toolCall.arguments?.command ?? "").split("\n").filter((l: string) => l.trim());
			cmdLines.forEach((line: string, i: number) => ln((i === 0 ? "$ " : "  ") + line, "accent", toolBg));
		} else {
			ln(toolCall ? formatToolLabel(toolName, toolCall.arguments ?? {}) : toolName,
				isError ? "toolDiffRemoved" : "muted", toolBg);
		}
		gap(toolBg);

		const diff = (msg as AnyEntry).details?.diff as string | undefined;
		if (diff) {
			for (const raw of diff.trimEnd().split("\n")) {
				const plain = raw.replace(/\t/g, "  ");
				const isAdded = plain.startsWith("+");
				const isRemoved = plain.startsWith("-");
				const fg = isAdded ? "toolDiffAdded" : isRemoved ? "toolDiffRemoved" : "toolDiffContext";
				const bg = isAdded ? "toolSuccessBg" : isRemoved ? "toolErrorBg" : toolBg;
				const wrapped = plain.length > 0 ? wrapTextWithAnsi(plain, avail) : [""];
				for (const seg of wrapped)
					lines.push(PAD + theme.bg(bg, theme.fg(fg, seg.padEnd(avail))));
			}
		} else {
			const outText = (msg.content ?? [] as AnyEntry[]).filter((c: AnyEntry) => c?.type === "text").map((c: AnyEntry) => String(c.text ?? "")).join("");
			if (toolName === "read" && outText.trim()) {
				const filePath = String(toolCall?.arguments?.path ?? "");
				const lang = getLanguageFromPath(filePath) ?? "";
				lines.push(...new Markdown(`\`\`\`${lang}\n${outText.trimEnd()}\n\`\`\``, 0, 0, getMarkdownTheme()).render(width));
			} else if (toolName === "write" && toolCall?.arguments?.content) {
				const filePath = String(toolCall.arguments.path ?? "");
				const lang = getLanguageFromPath(filePath) ?? "";
				lines.push(...new Markdown(`\`\`\`${lang}\n${String(toolCall.arguments.content).trimEnd()}\n\`\`\``, 0, 0, getMarkdownTheme()).render(width));
			} else {
				for (const c of (msg.content ?? []) as AnyEntry[])
					if (c?.type === "text") emit(String(c.text ?? ""), isError ? "error" : "toolOutput", toolBg);
			}
		}
	} else if (msg.role === "bashExecution") {
		const isErr = msg.exitCode != null && msg.exitCode !== 0;
		const bashBg = isErr ? "toolErrorBg" : "toolSuccessBg";
		ln(`$ ${String(msg.command ?? "")}`, "accent", bashBg);
		gap(bashBg);
		if (msg.output) emit(String(msg.output), "toolOutput", bashBg);
		if (isErr) ln(`exit: ${msg.exitCode}`, "error", bashBg);
	} else {
		ln(String(msg.role), "muted");
	}

	return lines.length ? lines : [""];
}

export class TreePeekComponent extends Container {
	private readonly treeComp: TreeSelectorComponent;
	private readonly treeH: number;
	private previewOpen = false;
	private previewScroll = 0;
	private previewTotal = 0;
	private readonly tui: { requestRender(): void };

	constructor(
		tree: any[],
		leafId: string | null,
		private readonly termHeight: number,
		tui: { requestRender(): void },
		onNavigate: (id: string) => void,
		onClose: () => void,
	) {
		super();
		this.tui = tui;
		this.treeH = Math.max(TREE_OVERHEAD + 3, termHeight - PREVIEW_ROWS - 1);
		this.treeComp = new TreeSelectorComponent(tree, leafId, termHeight, onNavigate, onClose, undefined);
		this.setListRows(termHeight - TREE_OVERHEAD);
	}

	private setListRows(listRows: number): void {
		(this.treeComp as any).getTreeList().maxVisibleLines = Math.max(3, listRows);
	}

	private openPreview(): void {
		if (this.previewOpen) return;
		this.previewOpen = true;
		this.setListRows(this.treeH - TREE_OVERHEAD);
	}

	private closePreview(): void {
		if (!this.previewOpen) return;
		this.previewOpen = false;
		this.previewScroll = 0;
		this.setListRows(this.termHeight - TREE_OVERHEAD);
	}

	render(width: number): string[] {
		const treeLines: string[] = (this.treeComp as any).render(width);
		if (!this.previewOpen) return treeLines;

		const top = treeLines.slice(0, this.treeH);
		while (top.length < this.treeH) top.push("");

		const treeList = (this.treeComp as any).getTreeList();
		const selected = treeList.getSelectedNode?.();
		const tcMap: Map<string, { name: string; arguments: AnyEntry }> = treeList.toolCallMap ?? new Map();
		const allLines = buildPreview(selected?.entry, width, tcMap);
		const total = allLines.length;
		this.previewTotal = total;
		const clamped = Math.max(0, Math.min(this.previewScroll, total - PREVIEW_ROWS));
		const slice = allLines.slice(clamped, clamped + PREVIEW_ROWS);

		const scrollTag = total > PREVIEW_ROWS
			? ` ${clamped + 1}–${Math.min(clamped + PREVIEW_ROWS, total)}/${total} `
			: "  Ctrl+↑/↓ to scroll  ";
		const sepBase = `─ preview${scrollTag}`;
		const sep = (sepBase + "─".repeat(Math.max(0, width - sepBase.length))).slice(0, width);

		const out = [...top, sep, ...slice];
		while (out.length < this.termHeight) out.push(" ".repeat(width));
		return out.slice(0, this.termHeight);
	}

	private jumpTo(index: number): void {
		const tl = (this.treeComp as any).getTreeList();
		tl.setSelectedIndex(index);
	}

	private pageSize(): number {
		const tl = (this.treeComp as any).getTreeList();
		return tl.maxVisibleLines || 10;
	}

	// Raw escape sequences for keys matchesKey may not handle
	private isHome(data: string): boolean { return matchesKey(data, "home") || matchesKey(data, "ctrl+home") || data === "\x1b[H" || data === "\x1b[1~" || data === "\x1b[1;5H"; }
	private isEnd(data: string): boolean { return matchesKey(data, "end") || matchesKey(data, "ctrl+end") || data === "\x1b[F" || data === "\x1b[4~" || data === "\x1b[1;5F"; }
	private isPageUp(data: string): boolean { return matchesKey(data, "pageUp") || matchesKey(data, "ctrl+pageUp") || data === "\x1b[5~" || data === "\x1b[5;5~"; }
	private isPageDown(data: string): boolean { return matchesKey(data, "pageDown") || matchesKey(data, "ctrl+pageDown") || data === "\x1b[6~" || data === "\x1b[6;5~"; }

	handleInput(data: string): void {
		// Ctrl+up/down: open or scroll preview content
		if (matchesKey(data, "ctrl+up")) {
			if (!this.previewOpen) { this.openPreview(); }
			else { this.previewScroll = Math.max(0, this.previewScroll - SCROLL_STEP); }
			this.tui.requestRender();
		} else if (matchesKey(data, "ctrl+down")) {
			if (!this.previewOpen) { this.openPreview(); }
			else { this.previewScroll = Math.min(this.previewScroll + SCROLL_STEP, Math.max(0, this.previewTotal - PREVIEW_ROWS)); }
			this.tui.requestRender();
		} else if (this.isHome(data)) {
			this.jumpTo(0);
			if (this.previewOpen) this.previewScroll = 0;
			this.tui.requestRender();
		} else if (this.isEnd(data)) {
			this.jumpTo(Number.MAX_SAFE_INTEGER);
			if (this.previewOpen) this.previewScroll = 0;
			this.tui.requestRender();
		} else if (this.isPageUp(data)) {
			const tl = (this.treeComp as any).getTreeList();
			this.jumpTo(tl.getSelectedIndex() - (tl.maxVisibleLines || 10));
			if (this.previewOpen) this.previewScroll = 0;
			this.tui.requestRender();
		} else if (this.isPageDown(data)) {
			const tl = (this.treeComp as any).getTreeList();
			this.jumpTo(tl.getSelectedIndex() + (tl.maxVisibleLines || 10));
			if (this.previewOpen) this.previewScroll = 0;
			this.tui.requestRender();
		} else if (this.previewOpen && matchesKey(data, "escape")) {
			// Esc closes preview, stays in tree
			this.closePreview();
			this.tui.requestRender();
		} else if (this.previewOpen) {
			// Preview open: forward to tree, keep preview, reset scroll
			(this.treeComp as any).handleInput(data);
			this.previewScroll = 0;
			this.tui.requestRender();
		} else {
			// Preview closed: forward to tree as-is
			(this.treeComp as any).handleInput(data);
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		(this.treeComp as any).invalidate();
	}
}
