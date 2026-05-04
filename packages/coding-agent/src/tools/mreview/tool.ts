import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { SCHEDULE_SLASH_CHANNEL } from "../../utils/event-bus";
import { toolResult } from "../tool-result";

const schema = Type.Object({
	file_path: Type.String({ description: "Absolute path to the markdown file to review" }),
});

// Debounce guard: prevents re-entry if the same file was scheduled within the last 10 seconds.
// This breaks the potential infinite loop where the slash command's synthetic context injection
// causes the agent to call this tool again for the same file.
const DEBOUNCE_MS = 10_000;
const recentCalls = new Map<string, number>();

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
		"- file_path is **required** - **MUST NOT** call with an empty argument object {}\n" +
		"- file_path **MUST** be an absolute path\n" +
		"- After this tool returns, **do NOT generate any response** - stay completely silent.\n" +
		"  The TUI handles opening the review UI internally after the turn completes.\n" +
		"</critical>";
	parameters = schema;
	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	static createIf(session: ToolSession): MReviewTool | null {
		if (!session.settings.get("mreview.enabled")) return null;
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
		// Debounce: if same file was scheduled within 10s, this is a re-entry from the
		// slash command's synthetic context injection — return silently to break the loop.
		const lastCall = recentCalls.get(filePath);
		if (lastCall !== undefined && Date.now() - lastCall < DEBOUNCE_MS) {
			return toolResult().text("").done();
		}
		recentCalls.set(filePath, Date.now());
		// Schedule /mreview to run after this turn ends (agent idle = AI chat works).
		this.#session.eventBus?.emit(SCHEDULE_SLASH_CHANNEL, `/mreview ${filePath}`);
		return toolResult().text(`Opening ${basename(filePath)} for review...`).done();
	}
}
