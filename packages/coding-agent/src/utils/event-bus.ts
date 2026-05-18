import { logger } from "@oh-my-pi/pi-utils";

// AWS-CORP: custom — merge with care
/**
 * Channel for tools to schedule a slash command to run after the current agent turn.
 * Payload: full slash command string including leading '/' (e.g. "/mreview /abs/path").
 * The TUI executes it once the agent is idle, as if the user typed it.
 */
export const SCHEDULE_SLASH_CHANNEL = "tui:schedule-slash";

/**
 * Channel for TUI output (showStatus / showError / showWarning) to flow back
 * through the RPC pipe to the parent mtuicontrol session.
 * Payload: TuiOutputPayload
 * Only emitted when the child is running with --rpc-pipe (headed+pipe mode).
 */
export const PIPE_TUI_OUTPUT_CHANNEL = "tui:pipe-output";
export type TuiOutputPayload = { level: "status" | "error" | "warning"; text: string };

export class EventBus {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();

	emit(channel: string, data: unknown): void {
		const handlers = this.#listeners.get(channel);
		if (handlers) {
			for (const handler of handlers) {
				handler(data);
			}
		}
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		if (!this.#listeners.has(channel)) {
			this.#listeners.set(channel, new Set());
		}
		const safeHandler = async (data: unknown) => {
			try {
				await handler(data);
			} catch (err) {
				logger.error("Event handler error", { channel, error: String(err) });
			}
		};
		this.#listeners.get(channel)!.add(safeHandler);
		return () => this.#listeners.get(channel)?.delete(safeHandler);
	}

	clear(): void {
		this.#listeners.clear();
	}
}
