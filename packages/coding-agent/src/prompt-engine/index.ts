/**
 * Prompt Engine — built-in module for OMP.
 *
 * Registers slash commands from prompt template .md files that support:
 * - `role` field → resolves via modelRoles config (single source of truth)
 * - `model` field → direct model spec (fallback)
 * - `skill` field → injects SKILL.md content into the message
 * - `thinking` field → sets thinking level for the command
 * - Auto-restore of model + thinking level after command completes
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../extensibility/extensions/types";
import { settings } from "../config/settings";
import { resolveConfiguredModelPatterns } from "../config/model-resolver";
import { type RegistryLike, selectModelCandidate, type SelectedModelCandidate } from "./model-selection";
import {
	type LoadPromptsResult,
	type PromptTemplate,
	loadPrompts,
	readSkillContent,
	resolveSkillPath,
} from "./prompt-loader";
import { DEFAULTS as SC_DEFAULTS, SessionState, type SessionContinuityConfig } from "./session-state";

// ── Arg substitution ────────────────────────────────────────────────────

function substituteArgs(content: string, args: string[]): string {
	let result = content;
	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) {
			return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
		}
		return args.slice(start).join(" ");
	});
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	result = result.replace(/@\$/g, allArgs);
	return result;
}

// ── Model resolution ────────────────────────────────────────────────────

function resolveModelSpecs(prompt: PromptTemplate): string[] {
	// Role takes precedence — resolve through modelRoles config
	if (prompt.role) {
		const configured = settings.getModelRole(prompt.role);
		if (configured) {
			const patterns = resolveConfiguredModelPatterns(configured, settings);
			if (patterns.length > 0) return patterns;
		}
		// Role not configured — fall through to model field
	}
	return prompt.models;
}

function sameModel(a: Model<Api> | undefined, b: Model<Api> | undefined): boolean {
	if (!a || !b) return a === b;
	return a.provider === b.provider && a.id === b.id;
}

async function resolveModel(
	prompt: PromptTemplate,
	currentModel: Model<Api> | undefined,
	registry: RegistryLike,
): Promise<SelectedModelCandidate | { message: string } | undefined> {
	const specs = resolveModelSpecs(prompt);
	if (specs.length === 0) {
		// No model/role specified — use current session model
		if (!currentModel) {
			return { message: `Prompt \`${prompt.name}\` has no role/model and no active session model.` };
		}
		return { model: currentModel, alreadyActive: true };
	}
	return selectModelCandidate(specs, currentModel, registry);
}

// ── Skill injection ─────────────────────────────────────────────────────

interface SkillMessage {
	customType: string;
	content: string;
	display: boolean;
	details: { skillName: string; skillContent: string; skillPath: string };
}

function resolveSkill(
	skillName: string | undefined,
	cwd: string,
	pi: ExtensionAPI,
): { kind: "none" } | { kind: "ready"; message: SkillMessage } | { kind: "error"; error: string } {
	if (!skillName) return { kind: "none" };

	const normalized = skillName.startsWith("skill:") ? skillName.slice(6) : skillName;
	if (!normalized) return { kind: "error", error: `Skill "${skillName}" not found.` };

	// Try registered skills first (from OMP's skill system)
	for (const command of pi.getCommands()) {
		if ((command as any).source !== "skill") continue;
		const sourceInfo = (command as any).sourceInfo as { path?: string } | undefined;
		if (!sourceInfo?.path) continue;
		if (command.name !== normalized && command.name !== `skill:${normalized}`) continue;
		try {
			const content = readSkillContent(sourceInfo.path);
			return {
				kind: "ready",
				message: {
					customType: "prompt-engine:skill-loaded",
					content: `<skill name="${normalized}">\n${content}\n</skill>`,
					display: true,
					details: { skillName: normalized, skillContent: content, skillPath: sourceInfo.path },
				},
			};
		} catch {
			return { kind: "error", error: `Failed to read skill "${skillName}".` };
		}
	}

	// Try filesystem resolution
	const skillPath = resolveSkillPath(normalized, cwd);
	if (!skillPath) return { kind: "error", error: `Skill "${skillName}" not found.` };

	try {
		const content = readSkillContent(skillPath);
		return {
			kind: "ready",
			message: {
				customType: "prompt-engine:skill-loaded",
				content: `<skill name="${normalized}">\n${content}\n</skill>`,
				display: true,
				details: { skillName: normalized, skillContent: content, skillPath },
			},
		};
	} catch {
		return { kind: "error", error: `Failed to read skill "${skillName}".` };
	}
}

// ── Skill loaded renderer ───────────────────────────────────────────────

function renderSkillLoaded(details: { skillName: string } | undefined): string | undefined {
	if (!details?.skillName) return undefined;
	return `📚 Loaded skill: ${details.skillName}`;
}

// ── Command description ─────────────────────────────────────────────────

function buildDescription(prompt: PromptTemplate): string {
	const parts: string[] = [];
	if (prompt.role) parts.push(prompt.role);
	else if (prompt.models.length > 0) parts.push(prompt.models.map(m => m.split("/").pop() || m).join("|"));
	else parts.push("current");
	if (prompt.thinking) parts.push(prompt.thinking);
	if (prompt.skill) parts.push(`+${prompt.skill}`);
	const details = `[${parts.join(" ")}] (${prompt.source})`;
	return prompt.description ? `${prompt.description} ${details}` : details;
}

// ── Notify helper ───────────────────────────────────────────────────────

function notify(ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error"): void {
	if (ctx?.hasUI) {
		(ctx as any).ui?.notify?.(message, type);
	} else {
		process.stderr.write(`[prompt-engine] ${type}: ${message}\n`);
	}
}

// ── Main entry point ────────────────────────────────────────────────────

export function createPromptEngine(pi: ExtensionAPI): void {
	let prompts = new Map<string, PromptTemplate>();
	let previousModel: Model<Api> | undefined;
	let previousThinking: ThinkingLevel | undefined;
	let runtimeModel: Model<Api> | undefined;

	// Session continuity — read config from settings
	function readSCConfig(): Partial<SessionContinuityConfig> {
		try {
			const raw = (settings as any).get("sessionContinuity") as Record<string, unknown> | undefined;
			if (!raw || typeof raw !== "object") return {};
			return {
				...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
				...(typeof raw.maxEvents === "number" ? { maxEvents: raw.maxEvents } : {}),
				...(typeof raw.maxContextLines === "number" ? { maxContextLines: raw.maxContextLines } : {}),
			};
		} catch { return {}; }
	}
	const sessionState = new SessionState(readSCConfig());

	function getCurrentModel(ctx: Pick<ExtensionContext, "model">): Model<Api> | undefined {
		return runtimeModel ?? ctx.model;
	}

	// Register skill-loaded renderer
	pi.registerMessageRenderer<{ skillName: string }>("prompt-engine:skill-loaded", renderSkillLoaded);

	function refreshPrompts(cwd: string, ctx?: ExtensionContext) {
		const result = loadPrompts(cwd);
		prompts = result.prompts;

		for (const [name, prompt] of prompts) {
			pi.registerCommand(name, {
				description: buildDescription(prompt),
				handler: async (args, cmdCtx) => {
					await runCommand(name, args, cmdCtx);
				},
			});
		}

		if (result.diagnostics.length > 0) {
			const summary = result.diagnostics.slice(0, 4)
				.map(d => `• ${d.message}`)
				.join("\n");
			notify(ctx, summary, "warning");
		}
	}

	async function waitForTurnStart(ctx: ExtensionContext) {
		while (ctx.isIdle()) {
			await new Promise(r => setTimeout(r, 10));
		}
	}

	async function restoreState(
		ctx: ExtensionContext,
		originalModel: Model<Api> | undefined,
		originalThinking: ThinkingLevel | undefined,
	) {
		if (originalModel && !sameModel(getCurrentModel(ctx), originalModel)) {
			const restored = await pi.setModel(originalModel);
			if (restored) {
				runtimeModel = originalModel;
			}
		}
		if (originalThinking !== undefined) {
			pi.setThinkingLevel(originalThinking);
		}
		previousModel = undefined;
		previousThinking = undefined;
	}

	async function runCommand(name: string, argsStr: string, ctx: ExtensionCommandContext) {
		const prompt = prompts.get(name);
		if (!prompt) {
			notify(ctx, `Prompt "${name}" not found.`, "error");
			return;
		}

		const currentModel = getCurrentModel(ctx);
		const args = argsStr.split(/\s+/).filter(Boolean);

		// Resolve model (role → config → registry)
		const resolved = await resolveModel(prompt, currentModel, ctx.modelRegistry);
		if (!resolved) {
			const specs = resolveModelSpecs(prompt);
			notify(ctx, `No available model from: ${specs.join(", ")}`, "error");
			return;
		}
		if ("message" in resolved) {
			notify(ctx, resolved.message, "error");
			return;
		}

		// Resolve skill
		const skillResolution = resolveSkill(prompt.skill, ctx.cwd, pi);
		if (skillResolution.kind === "error") {
			notify(ctx, skillResolution.error, "error");
			return;
		}

		// Save state for restore
		if (prompt.restore) {
			previousModel = currentModel;
			previousThinking = pi.getThinkingLevel();
		}

		// Switch model if needed
		if (!resolved.alreadyActive) {
			const switched = await pi.setModel(resolved.model);
			if (!switched) {
				notify(ctx, `Failed to switch to ${resolved.model.provider}/${resolved.model.id}`, "error");
				if (prompt.restore) {
					previousModel = undefined;
					previousThinking = undefined;
				}
				return;
			}
			runtimeModel = resolved.model;
			// Notify only when switching to a non-default model
			const roleLabel = prompt.role ? `role ${prompt.role}: ` : "";
			notify(ctx, `${roleLabel}${resolved.model.name ?? resolved.model.id}`, "info");
		}

		// Set thinking level
		if (prompt.thinking) {
			pi.setThinkingLevel(prompt.thinking);
		}

		// Inject skill context
		if (skillResolution.kind === "ready") {
			pi.sendMessage({
				customType: skillResolution.message.customType,
				content: skillResolution.message.content,
				display: true,
				details: skillResolution.message.details,
			});
		}

		// Render and send prompt
		const content = substituteArgs(prompt.content, args);
		if (!content.trim()) {
			notify(ctx, `Prompt "${name}" rendered to empty content.`, "error");
			if (prompt.restore) {
				await restoreState(ctx, previousModel, previousThinking);
			}
			return;
		}

		pi.sendUserMessage(content);
		await waitForTurnStart(ctx);
		await ctx.waitForIdle();

		// Restore
		if (prompt.restore && previousModel !== undefined) {
			await restoreState(ctx, previousModel, previousThinking);
		}
	}

	// ── Event handlers ────────────────────────────────────────────────────

	// Track skill roles from SKILL.md frontmatter
	const skillRoles = new Map<string, string>(); // skill name → role

	function discoverSkillRoles(cwd: string, agentDir?: string) {
		skillRoles.clear();
		const skillDirs = [
			agentDir ? join(agentDir, "skills") : join(homedir(), ".omp", "agent", "skills"),
			resolve(cwd, ".omp", "skills"),
		];
		for (const dir of skillDirs) {
			if (!existsSync(dir)) continue;
			let entries: string[];
			try { entries = readdirSync(dir); } catch { continue; }
			for (const entry of entries) {
				const skillMd = join(dir, entry, "SKILL.md");
				if (!existsSync(skillMd)) continue;
				try {
					const raw = readFileSync(skillMd, "utf-8");
					const { frontmatter } = parseFrontmatter(raw);
					if (frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter)) {
						const fm = frontmatter as Record<string, unknown>;
						if (typeof fm.role === "string" && fm.role.trim()) {
							skillRoles.set(entry, fm.role.trim());
						}
					}
				} catch { /* skip */ }
			}
		}
	}

	// Pending skill-role restore state
	let pendingSkillRestore: { model: Model<Api>; thinking: ThinkingLevel | undefined } | undefined;

	pi.on("session_start", async (_event, ctx) => {
		refreshPrompts(ctx.cwd, ctx);
		discoverSkillRoles(ctx.cwd);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Check if the prompt is a skill activation (from /skill:name or dot-prefix)
		const prompt = event.prompt?.trim();
		if (!prompt) return;

		// Detect skill name from:
		// 1. /skill:name prefix in prompt
		// 2. "Skill: <path>" metadata line (injected by OMP's skill command handler)
		// 3. .name dot-prefix (custom convention)
		let skillName: string | undefined;

		if (prompt.startsWith("/skill:")) {
			const spaceIdx = prompt.indexOf(" ");
			const cmd = spaceIdx === -1 ? prompt.slice(1) : prompt.slice(1, spaceIdx);
			skillName = cmd.startsWith("skill:") ? cmd.slice(6) : undefined;
		} else {
			// Check for "Skill: <path>/skills/<name>/SKILL.md" in the prompt body
			const skillMatch = prompt.match(/\nSkill:\s+.*[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md/);
			if (skillMatch) {
				skillName = skillMatch[1];
			} else if (prompt.startsWith(".")) {
				// Dot-prefix convention
				const spaceIdx = prompt.indexOf(" ");
				const dotName = spaceIdx === -1 ? prompt.slice(1) : prompt.slice(1, spaceIdx);
				if (dotName && skillRoles.has(dotName)) {
					skillName = dotName;
				}
			}
		}

		if (!skillName) return;

		const role = skillRoles.get(skillName);
		if (!role) return;

		// Resolve role to model
		const configured = settings.getModelRole(role);
		if (!configured) return;

		const patterns = resolveConfiguredModelPatterns(configured, settings);
		if (patterns.length === 0) return;

		const currentModel = getCurrentModel(ctx);
		const selected = await selectModelCandidate(patterns, currentModel, ctx.modelRegistry);
		if (!selected || selected.alreadyActive) return;

		// Switch model and schedule restore
		const switched = await pi.setModel(selected.model);
		if (switched) {
			runtimeModel = selected.model;
			pendingSkillRestore = { model: currentModel!, thinking: pi.getThinkingLevel() };
			notify(ctx, `role ${role}: ${selected.model.name ?? selected.model.id}`, "info");

			// Auto-inject skill content so the switched model has the instructions
			const agentDir = join(homedir(), ".omp", "agent");
			const skillPath = resolveSkillPath(skillName, ctx.cwd) ??
				(() => { const p = join(agentDir, "skills", skillName, "SKILL.md"); return existsSync(p) ? p : undefined; })();
			if (skillPath) {
				try {
					const content = readSkillContent(skillPath);
					return {
						message: {
							customType: "prompt-engine:skill-loaded",
							content: `<skill name="${skillName}">\n${content}\n</skill>`,
							display: true,
							details: { skillName, skillContent: content, skillPath },
						},
					};
				} catch { /* skip injection */ }
			}
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Restore model after skill-role switch
		if (pendingSkillRestore) {
			const { model, thinking } = pendingSkillRestore;
			pendingSkillRestore = undefined;
			await restoreState(ctx, model, thinking);
		}
	});

	// ── Session continuity handlers ─────────────────────────────────────

	pi.on("tool_result", async (event) => {
		if (!sessionState.enabled) return;
		const name = event.toolName;
		if (name === "bash") {
			const cmd = (event.input as { command?: string }).command;
			const cwd = (event.input as { working_dir?: string }).working_dir;
			if (cmd) sessionState.trackCommand(cmd, cwd);
		} else if (name === "read" || name === "edit" || name === "write") {
			const path = (event.input as { path?: string }).path;
			if (path) sessionState.trackFile(path, name as "read" | "edit" | "write");
		} else if (name === "grep" || name === "find") {
			// Track searched paths from results
			const path = (event.input as { path?: string }).path;
			if (path) sessionState.trackFile(path, name as "grep" | "find");
		}
	});

	pi.on("session.compacting", async (_event) => {
		if (!sessionState.enabled) return;
		// Re-read config in case it changed mid-session
		sessionState.updateConfig(readSCConfig());
		const context = sessionState.buildContextLines();
		const preserveData = sessionState.buildPreserveData();
		// Clear accumulated state — it's now captured in the summary
		sessionState.clear();
		if (context.length === 0) return;
		return { context, preserveData };
	});

	pi.on("session_compact", async (event) => {
		if (!sessionState.enabled) return;
		// Restore file tracking from previous compaction's preserveData
		const pd = (event.compactionEntry as any)?.preserveData;
		if (pd) sessionState.restoreFrom(pd);
	});
}
