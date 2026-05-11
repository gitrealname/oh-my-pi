// m-prompt-template barrel — wires the prompt template extension into OMP startup.
// The extension registers slash commands from ~/.pi/prompts/*.md template files.
// Role resolver is initialized from sdk.ts (has settings access) via setMPromptTemplateRoleResolver.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import promptModelExtension from "./index";
export { setRoleResolver as setMPromptTemplateRoleResolver } from "./model-selection";

export async function createPromptTemplateExtension(api: ExtensionAPI): Promise<void> {
	// OMP adapter patches — isolate OMP-specific behavioral differences from PT logic.

	// 1. Drop model_select events: not yet emitted by OMP.
	//    Phase 2: add model_select to ExtensionAPI and emit from session model-switch path.
	const _on = api.on?.bind(api);
	if (_on) {
		(api as unknown as Record<string, unknown>)["on"] = (event: string, handler: unknown) => {
			if (event === "model_select") return undefined;
			return _on(event as Parameters<typeof _on>[0], handler as Parameters<typeof _on>[1]);
		};
	}

	// 2. Wrap sendUserMessage to always use deliverAs:"followUp".
	//    OMP's waitForIdle() resolves before the model turn truly completes. Without this,
	//    chained steps hit "Agent is already processing" when sending the next step's message.
	//    Native pi does not have this problem — pt/index.ts uses plain sendUserMessage.
	const _sendUserMessage = api.sendUserMessage?.bind(api);
	if (_sendUserMessage) {
		(api as unknown as Record<string, unknown>)["sendUserMessage"] = (
			content: string,
			options?: Parameters<typeof _sendUserMessage>[1],
		) => _sendUserMessage(content, { ...options, deliverAs: "followUp" });
	}

	await promptModelExtension(api);
}