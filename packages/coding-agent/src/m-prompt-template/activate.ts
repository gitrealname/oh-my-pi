// m-prompt-template barrel — wires the prompt template extension into OMP startup.
// The extension registers slash commands from ~/.pi/prompts/*.md template files.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import promptModelExtension from "./index";

export async function createPromptTemplateExtension(api: ExtensionAPI): Promise<void> {
	// Silently ignore model_select registrations — not yet emitted by OMP.
	// Phase 2: add model_select to ExtensionAPI and emit from session model-switch path.
	const _on = api.on?.bind(api);
	if (_on) {
		(api as unknown as Record<string, unknown>)["on"] = (event: string, handler: unknown) => {
			if (event === "model_select") return undefined;
			return _on(event as Parameters<typeof _on>[0], handler as Parameters<typeof _on>[1]);
		};
	}
	await promptModelExtension(api);
}
