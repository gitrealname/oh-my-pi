// m-prompt-template barrel — wires the prompt template extension into OMP startup.
// The extension registers slash commands from ~/.pi/prompts/*.md template files.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import promptModelExtension from "./index";
import { setRoleResolver } from "./model-selection";
import { resolveTemplateModelSpec } from "../utils/m-utils";
import type { Settings } from "../config/settings";

export async function createPromptTemplateExtension(api: ExtensionAPI): Promise<void> {
	// Wire OMP's role resolver so role names work in template model: field.
	// e.g. model: slow  ->  settings.modelRoles["slow"]  ->  concrete provider/model string.
	// Concrete strings like "openrouter/xiaomi/mimo-v2-flash" pass through unchanged.
	const settings = (api as unknown as Record<string, unknown>)["settings"] as Settings | undefined;
	if (settings) {
		setRoleResolver((spec: string) => {
			const resolved = resolveTemplateModelSpec(spec, settings);
			return resolved !== spec ? resolved : undefined;
		});
	}

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
