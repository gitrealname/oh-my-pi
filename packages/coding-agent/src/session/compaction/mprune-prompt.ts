import rawPrompt from "../../sidecars/mprune-summarizer.prompt.md" with { type: "text" };
import { createSidecar, sidecarPath } from "../../utils/m-utils";

/** System prompt for the mprune summarizer LLM call. Sidecar-overridable. */
const resolvePrompt = createSidecar(sidecarPath("mprune-summarizer.prompt.md"), rawPrompt);

export function buildSummarizerPrompt(): string {
	return resolvePrompt();
}
