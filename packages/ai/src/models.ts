import { enrichModelThinking } from "./model-thinking";
import MODELS from "./models.json" with { type: "json" };
import type { Api, KnownProvider, Model, Usage } from "./types";

/**
 * Static bundled model registry loaded from `models.json`.
 *
 * This module intentionally exposes compile-time defaults only.
 * It does not include runtime discovery, models.dev overlays, or on-disk cache state.
 *
 * For runtime-aware resolution, use `createModelManager()` / `resolveProviderModels()`.
 */
const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, enrichModelThinking(model as Model<Api>));
	}
	modelRegistry.set(provider, providerModels);
}

export type GeneratedProvider = keyof typeof MODELS;

// Register aws-corp models (inference profiles fetched from account 412811460223)
// Friendly display names map to full inference profile IDs internally
{
	const corpModels = new Map<string, Model<Api>>();
	const thinking = { mode: "anthropic-budget-effort", minLevel: "minimal", maxLevel: "high" };
	const M = (friendly: string, profileId: string, name: string, reasoning: boolean, ctx: number, max: number, cost: { input: number; output: number; cacheRead: number; cacheWrite: number }) => {
		corpModels.set(friendly, {
			id: profileId, name, provider: "aws-corp", api: "bedrock-converse-stream" as Api,
			baseUrl: "", reasoning, thinking: reasoning ? thinking : undefined, input: ["text"], cost, contextWindow: ctx, maxTokens: max,
		} as Model<Api>);
	};
	// Anthropic Claude — current gen
	M("claude-sonnet-4-6",   "us.anthropic.claude-sonnet-4-6",                "Claude Sonnet 4.6",   true,  1000000, 64000, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	M("claude-sonnet-4-5",   "us.anthropic.claude-sonnet-4-5-20250929-v1:0",  "Claude Sonnet 4.5",   true,  200000, 64000, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	M("claude-sonnet-4",     "us.anthropic.claude-sonnet-4-20250514-v1:0",    "Claude Sonnet 4",     true,  200000, 64000, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	M("claude-opus-4-7",     "us.anthropic.claude-opus-4-7",                  "Claude Opus 4.7",     true,  1000000, 128000, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 });
	M("claude-opus-4-6",     "us.anthropic.claude-opus-4-6-v1",               "Claude Opus 4.6",     true,  1000000, 128000, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 });
	M("claude-opus-4-5",     "us.anthropic.claude-opus-4-5-20251101-v1:0",    "Claude Opus 4.5",     true,  200000, 64000, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 });
	M("claude-opus-4-1",     "us.anthropic.claude-opus-4-1-20250805-v1:0",    "Claude Opus 4.1",     true,  200000, 32000, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 });
	M("claude-opus-4",       "us.anthropic.claude-opus-4-20250514-v1:0",      "Claude Opus 4",       true,  200000, 32000, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 });
	M("claude-haiku-4-5",    "us.anthropic.claude-haiku-4-5-20251001-v1:0",   "Claude Haiku 4.5",    false, 200000, 8192,  { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 });
	M("claude-3-7-sonnet",   "us.anthropic.claude-3-7-sonnet-20250219-v1:0",  "Claude 3.7 Sonnet",   true,  200000, 64000, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	M("claude-3-5-haiku",    "us.anthropic.claude-3-5-haiku-20241022-v1:0",   "Claude 3.5 Haiku",    false, 200000, 8192,  { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 });
	// Amazon Nova
	M("nova-premier",        "us.amazon.nova-premier-v1:0",                   "Nova Premier",        false, 1000000, 40000, { input: 2.5, output: 12.5, cacheRead: 0, cacheWrite: 0 });
	M("nova-pro",            "us.amazon.nova-pro-v1:0",                       "Nova Pro",            false, 300000,  5000,  { input: 0.8, output: 3.2, cacheRead: 0, cacheWrite: 0 });
	M("nova-lite",           "us.amazon.nova-lite-v1:0",                      "Nova Lite",           false, 300000,  5000,  { input: 0.06, output: 0.24, cacheRead: 0, cacheWrite: 0 });
	M("nova-micro",          "us.amazon.nova-micro-v1:0",                     "Nova Micro",          false, 128000,  5000,  { input: 0.035, output: 0.14, cacheRead: 0, cacheWrite: 0 });
	M("nova-2-lite",         "us.amazon.nova-2-lite-v1:0",                    "Nova 2 Lite",         false, 300000,  5000,  { input: 0.06, output: 0.24, cacheRead: 0, cacheWrite: 0 });
	// Meta Llama
	M("llama4-maverick",     "us.meta.llama4-maverick-17b-instruct-v1:0",     "Llama 4 Maverick",    false, 1000000, 100000, { input: 0.2, output: 0.85, cacheRead: 0, cacheWrite: 0 });
	M("llama4-scout",        "us.meta.llama4-scout-17b-instruct-v1:0",        "Llama 4 Scout",       false, 512000,  100000, { input: 0.17, output: 0.68, cacheRead: 0, cacheWrite: 0 });
	M("llama3-3-70b",        "us.meta.llama3-3-70b-instruct-v1:0",            "Llama 3.3 70B",       false, 128000,  4096,   { input: 0.72, output: 0.72, cacheRead: 0, cacheWrite: 0 });
	// DeepSeek
	M("deepseek-r1",         "us.deepseek.r1-v1:0",                           "DeepSeek R1",         true,  128000, 32000, { input: 1.35, output: 5.4, cacheRead: 0, cacheWrite: 0 });
	// Mistral
	M("pixtral-large",       "us.mistral.pixtral-large-2502-v1:0",            "Pixtral Large",       false, 128000, 4096,  { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 });
	modelRegistry.set("aws-corp", corpModels);
}

export function getBundledModel(provider: GeneratedProvider, modelId: string): Model<Api> {

export function getBundledModel<TApi extends Api = Api>(provider: GeneratedProvider, modelId: string): Model<TApi> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId) as Model<TApi>;
}

export function getBundledProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getBundledModels(provider: GeneratedProvider): Model<Api>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}
/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
