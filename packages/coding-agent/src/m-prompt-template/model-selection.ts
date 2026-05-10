import type { Model } from "@oh-my-pi/pi-ai";
import type { ResolvedModelRef } from "./template-conditionals.js";

const PREFERRED_PROVIDERS = ["openai-codex", "anthropic", "aws-corp", "bedrock-converse-stream", "github-copilot", "openrouter"];

// Module-level role resolver — set once at activate time from OMP settings.
// Translates pi/ role prefixes to concrete model strings before registry lookup.
let _roleResolver: ((role: string) => string | undefined) | undefined;
export function setRoleResolver(fn: (role: string) => string | undefined): void {
	_roleResolver = fn;
}

export interface SelectedModelCandidate {
	model: Model<any>;
	alreadyActive: boolean;
}

export interface RegistryLike {
	find(provider: string, modelId: string): Model<any> | undefined;
	getAll(): Model<any>[];
	getAvailable(): Model<any>[];
	isUsingOAuth(model: Model<any>): boolean;
	hasConfiguredAuth?: (model: Model<any>) => boolean;
	getApiKeyAndHeaders?: (model: Model<any>) => Promise<{
		ok: boolean;
		apiKey?: string;
		headers?: Record<string, string>;
		error?: string;
	}>;
}

function isSameModel(a: Model<any>, b: Model<any>): boolean {
	return a.provider === b.provider && a.id === b.id;
}

function modelSpecMatches(modelSpec: string, model: Model<any>): boolean {
	const slashIndex = modelSpec.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelSpec.slice(0, slashIndex);
		const modelId = modelSpec.slice(slashIndex + 1);
		return provider === model.provider && modelId === model.id;
	}

	return modelSpec === model.id;
}

function orderMatchesByProviderPreference(models: Model<any>[]): Model<any>[] {
	const prioritized: Model<any>[] = [];
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

function getModelCandidates(modelSpec: string, registry: Pick<RegistryLike, "find" | "getAll">): Model<any>[] {
	const slashIndex = modelSpec.indexOf("/");

	if (slashIndex !== -1) {
		const provider = modelSpec.slice(0, slashIndex);
		const modelId = modelSpec.slice(slashIndex + 1);
		if (!provider || !modelId) return [];
		const model = registry.find(provider, modelId);
		return model ? [model] : [];
	}

	const allMatches = registry.getAll().filter((model) => model.id === modelSpec);
	if (allMatches.length <= 1) return allMatches;
	return orderMatchesByProviderPreference(allMatches);
}

async function hasUsableAuth(model: Model<any>, registry: RegistryLike): Promise<boolean> {
	const availableMatch = registry.getAvailable().some((candidate) => isSameModel(candidate, model));
	if (availableMatch) return true;
	if (!registry.isUsingOAuth(model)) return false;
	if (registry.hasConfiguredAuth) return registry.hasConfiguredAuth(model);
	if (registry.getApiKeyAndHeaders) {
		const auth = await registry.getApiKeyAndHeaders(model);
		return auth.ok;
	}
	return false;
}

export async function selectModelCandidate(
	modelSpecs: string[],
	currentModel: Model<any> | undefined,
	registry: RegistryLike,
	roleSpec?: string,
): Promise<SelectedModelCandidate | undefined> {
	// Build the effective spec list:
	// - roleSpec (from role: frontmatter) → resolved via _roleResolver, no fallback to raw
	// - modelSpecs (from model: frontmatter) → used as-is, no role resolution
	// Precedence: roleSpec wins if present
	const effectiveSpecs: string[] = [];
	if (roleSpec) {
		const resolved = _roleResolver ? _roleResolver(roleSpec) : undefined;
		if (!resolved) {
			// Role not found in config — nothing to try
			return undefined;
		}
		effectiveSpecs.push(resolved);
	} else {
		// model: field — use directly without role resolution
		effectiveSpecs.push(...modelSpecs);
	}

	if (currentModel && effectiveSpecs.some((spec) => modelSpecMatches(spec, currentModel))) {
		return { model: currentModel, alreadyActive: true };
	}

	for (const spec of effectiveSpecs) {
		for (const model of getModelCandidates(spec, registry)) {
			if (await hasUsableAuth(model, registry)) {
				return { model, alreadyActive: false };
			}
		}
	}
	return undefined;
}

export function getResolvedModelRef(model: Model<any>): ResolvedModelRef {
	return { provider: model.provider, id: model.id };
}
