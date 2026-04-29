/**
 * Model selection for prompt engine.
 * Resolves model specs against the registry, preferring certain providers.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";

const PREFERRED_PROVIDERS = ["openai-codex", "anthropic", "github-copilot", "openrouter"];

export interface SelectedModelCandidate {
	model: Model<Api>;
	alreadyActive: boolean;
}

export type RegistryLike = Pick<ModelRegistry, "find" | "getAll" | "getAvailable" | "isUsingOAuth">;

function isSameModel(a: Model<Api>, b: Model<Api>): boolean {
	return a.provider === b.provider && a.id === b.id;
}

function modelSpecMatches(spec: string, model: Model<Api>): boolean {
	const slashIndex = spec.indexOf("/");
	if (slashIndex !== -1) {
		const provider = spec.slice(0, slashIndex);
		const modelId = spec.slice(slashIndex + 1);
		return provider === model.provider && modelId === model.id;
	}
	return spec === model.id;
}

function orderByProviderPreference(models: Model<Api>[]): Model<Api>[] {
	const prioritized: Model<Api>[] = [];
	const seen = new Set<string>();
	for (const provider of PREFERRED_PROVIDERS) {
		for (const model of models) {
			const key = `${model.provider}/${model.id}`;
			if (model.provider === provider && !seen.has(key)) {
				prioritized.push(model);
				seen.add(key);
			}
		}
	}
	for (const model of models) {
		const key = `${model.provider}/${model.id}`;
		if (!seen.has(key)) {
			prioritized.push(model);
			seen.add(key);
		}
	}
	return prioritized;
}

function getCandidates(spec: string, registry: RegistryLike): Model<Api>[] {
	const slashIndex = spec.indexOf("/");
	if (slashIndex !== -1) {
		// Try provider/modelId split. For OpenRouter-style IDs (openrouter/org/model),
		// first try splitting on the first slash, then use registry.find() which
		// handles multi-segment model IDs internally.
		const provider = spec.slice(0, slashIndex);
		const modelId = spec.slice(slashIndex + 1);
		if (!provider || !modelId) return [];
		const model = registry.find(provider, modelId);
		return model ? [model] : [];
	}
	const matches = registry.getAll().filter(m => m.id === spec);
	return matches.length <= 1 ? matches : orderByProviderPreference(matches);
}

function isAvailable(model: Model<Api>, registry: RegistryLike): boolean {
	return registry.getAvailable().some(m => isSameModel(m, model));
}

export async function selectModelCandidate(
	specs: string[],
	currentModel: Model<Api> | undefined,
	registry: RegistryLike,
): Promise<SelectedModelCandidate | undefined> {
	// If current model matches any spec, keep it
	if (currentModel && specs.some(spec => modelSpecMatches(spec, currentModel))) {
		return { model: currentModel, alreadyActive: true };
	}
	// Try each spec in order
	for (const spec of specs) {
		for (const model of getCandidates(spec, registry)) {
			if (isAvailable(model, registry)) {
				return { model, alreadyActive: false };
			}
		}
	}
	return undefined;
}
