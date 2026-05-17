/**
 * Corporate (aws-corp) extension wiring for createAgentSession.
 *
 * All our custom extension imports and session-setup logic live here so that
 * sdk.ts — a high-churn upstream file — carries only a single import line,
 * a single interface field (memory?), and three one-liner call sites.
 * This minimises merge conflicts on every upstream pull.
 *
 * Rules:
 *  - This file is ours; edit freely.
 *  - sdk.ts must not grow beyond its three call sites (populateCorpSkillRoles,
 *    registerCorpExtensions, applyCorpExtensionRunner).
 */

import { createMmemoryExtension } from "./mmemory-extension";
import { createPromptTemplateExtension, setMPromptTemplateRoleResolver } from "./m-prompt-template/activate";
import { resolveTemplateModelSpec } from "./utils/m-utils";
import { createMpruneExtension } from "./extensibility/extensions/m-prune-extension";
import { createPromptEngine } from "./prompt-engine";
import { type Settings, type SettingPath } from "./config/settings";
import type { ExtensionFactory, ExtensionRunner } from "./extensibility/extensions";
import type { Skill } from "./extensibility/skills";
import type { ToolSession } from "./tool-session";

// ---------------------------------------------------------------------------
// 1. populateCorpSkillRoles
//    Reads each skill's frontmatter for `role` + `tools` and populates the
//    toolSession.activeSkillRoles map.  Skills that declare:
//      role: "slow"
//      tools: ["recall", "reflect"]
//    cause those tool calls to be dispatched against the "slow" model role.
// ---------------------------------------------------------------------------

export function populateCorpSkillRoles(
	skills: Skill[],
	toolSession: ToolSession,
): void {
	const activeSkillRoles = new Map<string, string>();
	for (const skill of skills as Array<{ frontmatter?: Record<string, unknown> }>) {
		if (!skill.frontmatter) continue;
		const role = skill.frontmatter["role"] as string | undefined;
		const tools = skill.frontmatter["tools"] as string[] | undefined;
		if (role && Array.isArray(tools)) {
			for (const toolName of tools) {
				activeSkillRoles.set(toolName, role);
			}
		}
	}
	toolSession.activeSkillRoles = activeSkillRoles;
}

// ---------------------------------------------------------------------------
// 2. registerCorpExtensions
//    Appends our gated extensions to the inlineExtensions array that sdk.ts
//    builds just before calling loadExtensions.  Each extension is guarded by
//    its settings key so users can opt-out via config.yml.
//    Note: createAutoresearchExtension is NOT pushed here — sdk.ts already
//    handles it (it is an upstream extension).  We only push ours.
// ---------------------------------------------------------------------------

export function registerCorpExtensions(
	inlineExtensions: ExtensionFactory[],
	settings: Settings,
): void {
	if (settings.get("promptEngine.enabled" as SettingPath) !== false) {
		inlineExtensions.push(createPromptEngine);
	}
	if (settings.get("mmemory.enabled" as SettingPath) !== false) {
		inlineExtensions.push(createMmemoryExtension);
	}
	if (settings.get("mprune.enabled" as SettingPath) !== false) {
		inlineExtensions.push(createMpruneExtension);
	}
	if (settings.get("promptTemplates.enabled" as SettingPath) !== false) {
		setMPromptTemplateRoleResolver((spec) => resolveTemplateModelSpec(spec, settings));
		inlineExtensions.push(createPromptTemplateExtension);
	}

}

// ---------------------------------------------------------------------------
// 3. applyCorpExtensionRunner
//    Called after the ExtensionRunner is constructed.  Sets the task recursion
//    depth so nested subagents can report correct depth to extensions.
// ---------------------------------------------------------------------------

export function applyCorpExtensionRunner(
	extensionRunner: ExtensionRunner | undefined,
	taskDepth: number,
): void {
	extensionRunner?.setTaskDepth(taskDepth);
}
