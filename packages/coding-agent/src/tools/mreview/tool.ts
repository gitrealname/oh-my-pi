import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { openMReviewSession } from "./index";
import { toolResult } from "../tool-result";

const schema = Type.Object({
	file_path: Type.String({ description: "Absolute path to the markdown file to review" }),
});

export class MReviewTool implements AgentTool<typeof schema> {
	name = "mreview" as const;
	label = "Markdown Review";
	description =
		"Review a markdown file with the user in a browser UI with annotation tools and AI chat.\n\n" +
		"<conditions>\n" +
		"- User asks to review, discuss, annotate, or comment on a markdown file\n" +
		"- User types .review\n" +
		"</conditions>\n\n" +
		"<critical>\n" +
		"- file_path is **required** \u2014 **MUST NOT** call with an empty argument object {}\n" +
		"- file_path **MUST** be an absolute path\n" +
		"</critical>";
	parameters = schema;
	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	static createIf(session: ToolSession): MReviewTool | null {
		if (!session.settings.get("mreview.enabled" as any)) return null;
		return new MReviewTool(session);
	}

	async execute(
		_toolCallId: string,
		params: { file_path: string },
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
	): Promise<AgentToolResult> {
		const filePath = resolvePath(this.#session.cwd, params.file_path);
		if (!existsSync(filePath)) {
			return toolResult().text(`File not found: ${filePath}`).done();
		}

		let markdown: string;
		try {
			markdown = readFileSync(filePath, "utf-8");
		} catch {
			return toolResult().text(`Cannot read file: ${filePath}`).done();
		}

		const openInBrowser = (url: string) => {
			try {
				Bun.spawn(["cmd.exe", "/c", "start", "", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
			} catch {}
		};

		const result = await openMReviewSession(
			{
				cwd: this.#session.cwd,
				openInBrowser,
				showStatus: () => {},
				showWarning: () => {},
			},
			filePath,
			markdown,
			{}, // no agent — AI chat disabled in tool mode
		);

		if (result.exit) {
			return toolResult().text("User closed the review without submitting comments.").done();
		}
		if (result.approved) {
			return toolResult().text("User approved the document without comments.").done();
		}
		if (result.feedback?.trim()) {
			return toolResult().text(result.feedback.trim()).done();
		}
		return toolResult().text("Review completed with no comments.").done();
	}
}