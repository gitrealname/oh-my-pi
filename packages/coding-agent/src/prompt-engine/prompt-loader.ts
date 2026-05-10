/**
 * Prompt engine — template loader and frontmatter parser.
 * Discovers .md files from commands directories, parses frontmatter with
 * role/model/skill/thinking fields.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

const VALID_THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

// Built-in OMP commands that must never be shadowed
const RESERVED_NAMES = new Set([
	"settings", "plan", "model", "models", "fast", "export", "dump", "share",
	"browser", "copy", "todo", "session", "jobs", "usage", "changelog", "hotkeys",
	"tools", "extensions", "agents", "branch", "fork", "tree", "tree-old",
	"login", "logout", "mcp", "ssh", "new", "drop", "compact", "handoff",
	"resume", "btw", "background", "bg", "debug", "memory", "rename", "move",
	"marketplace", "plugins", "reload-plugins", "force", "exit", "quit",
	// Extension's own meta-commands
	"chain-prompts", "prompt-tool", "scoped-models",
	// mreview slash command (prevent user prompt templates from shadowing)
	"mreview",
]);

export type PromptSource = "user" | "project";

export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	role?: string;
	models: string[];
	skill?: string;
	thinking?: ThinkingLevel;
	restore: boolean;
	source: PromptSource;
	filePath: string;
}

export interface PromptLoaderDiagnostic {
	code: string;
	message: string;
	filePath: string;
	key: string;
}

export interface LoadPromptsResult {
	prompts: Map<string, PromptTemplate>;
	diagnostics: PromptLoaderDiagnostic[];
}

function diag(code: string, filePath: string, message: string): PromptLoaderDiagnostic {
	return { code, message, filePath, key: `${code}:${filePath}:${message}` };
}

function isValidModelSpec(spec: string): boolean {
	if (!spec || spec.includes("*") || /\s/.test(spec)) return false;
	const segments = spec.split("/");
	if (segments.length === 1) return true;
	if (segments.length !== 2) return false;
	return segments[0].length > 0 && segments[1].length > 0;
}

function parseModelField(
	value: unknown,
	filePath: string,
	diagnostics: PromptLoaderDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(diag("invalid-model", filePath, `"model" must be a string.`));
		return undefined;
	}
	const models = value.split(",").map(s => s.trim()).filter(Boolean);
	if (models.length === 0) {
		diagnostics.push(diag("empty-model", filePath, `"model" is empty.`));
		return undefined;
	}
	const invalid = models.find(m => !isValidModelSpec(m));
	if (invalid) {
		diagnostics.push(diag("invalid-model-spec", filePath, `Invalid model spec: ${JSON.stringify(invalid)}`));
		return undefined;
	}
	return models;
}

function parseRoleField(
	value: unknown,
	filePath: string,
	diagnostics: PromptLoaderDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		diagnostics.push(diag("invalid-role", filePath, `"role" must be a non-empty string.`));
		return undefined;
	}
	const role = value.trim();
	if (role.includes("/") || /\s/.test(role)) {
		diagnostics.push(diag("invalid-role", filePath, `"role" must not contain slashes or whitespace.`));
		return undefined;
	}
	return role;
}

function parseThinkingField(
	value: unknown,
	filePath: string,
	diagnostics: PromptLoaderDiagnostic[],
): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !VALID_THINKING_LEVELS.includes(value)) {
		diagnostics.push(diag("invalid-thinking", filePath,
			`"thinking" must be one of: ${VALID_THINKING_LEVELS.join(", ")}`));
		return undefined;
	}
	return value as ThinkingLevel;
}

function parseBoolField(value: unknown, defaultValue: boolean): boolean {
	if (value === true || value === false) return value;
	return defaultValue;
}

function parseStringField(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim() || undefined : undefined;
}

function loadPromptFile(
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): PromptTemplate | undefined {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	const { frontmatter: fm, body } = parseFrontmatter(raw);
	if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
		// No frontmatter or not an object — not a prompt engine template.
		// Return undefined so OMP's default slash command handler picks it up.
		return undefined;
	}

	const frontmatter = fm as Record<string, unknown>;

	const role = parseRoleField(frontmatter.role, filePath, diagnostics);
	const models = parseModelField(frontmatter.model, filePath, diagnostics);
	const skill = parseStringField(frontmatter.skill);
	const thinking = parseThinkingField(frontmatter.thinking, filePath, diagnostics);

	// Only claim this file if it uses prompt-engine features
	if (!role && !models && !skill && thinking === undefined) {
		return undefined;
	}

	const name = basename(filePath, ".md");
	const description = parseStringField(frontmatter.description) ?? "";
	const restore = parseBoolField(frontmatter.restore, true);

	return {
		name,
		description,
		content: body,
		role,
		models: models ?? [],
		skill,
		thinking,
		restore,
		source,
		filePath,
	};
}

function scanDir(dir: string, source: PromptSource, diagnostics: PromptLoaderDiagnostic[]): Map<string, PromptTemplate> {
	const prompts = new Map<string, PromptTemplate>();
	if (!existsSync(dir)) return prompts;

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return prompts;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const filePath = join(dir, entry);
		try {
			if (!statSync(filePath).isFile()) continue;
		} catch {
			continue;
		}

		const name = basename(entry, ".md");
		if (RESERVED_NAMES.has(name)) {
			diagnostics.push(diag("reserved-name", filePath, `"${name}" is a reserved command name.`));
			continue;
		}

		const prompt = loadPromptFile(filePath, source, diagnostics);
		if (!prompt) continue;

		if (!prompts.has(name)) {
			prompts.set(name, prompt);
		}
	}

	return prompts;
}

export function loadPrompts(cwd: string, agentDir?: string): LoadPromptsResult {
	const diagnostics: PromptLoaderDiagnostic[] = [];
	const prompts = new Map<string, PromptTemplate>();

	// Scan directories in order of priority (project > user)
	// Per spec: {cwd}/.pi/prompts/, {cwd}/.pi/, ~/.pi/prompts/, ~/.pi/
	const scanDirs = [
		{ path: resolve(cwd, ".pi", "prompts"), source: "project" as const },
		{ path: resolve(cwd, ".pi"), source: "project" as const },
		{ path: join(homedir(), ".pi", "prompts"), source: "user" as const },
		{ path: join(homedir(), ".pi"), source: "user" as const },
	];

	for (const { path, source } of scanDirs) {
		for (const [name, prompt] of scanDir(path, source, diagnostics)) {
			if (!prompts.has(name)) {
				prompts.set(name, prompt);
			}
		}
	}

	return { prompts, diagnostics };
}

// Skill resolution — find SKILL.md by name
function getSkillCandidates(baseDir: string, skillName: string): string[] {
	return [join(baseDir, skillName, "SKILL.md"), join(baseDir, `${skillName}.md`)];
}

function findFirst(paths: string[]): string | undefined {
	return paths.find(p => existsSync(p));
}

export function resolveSkillPath(skillName: string, cwd: string): string | undefined {
	const projectDir = resolve(cwd);

	// Project .pi/skills/
	const projectSkill = findFirst(getSkillCandidates(join(projectDir, ".pi", "skills"), skillName));
	if (projectSkill) return projectSkill;

	// User ~/.pi/agent/skills/
	const userSkill = findFirst(getSkillCandidates(join(homedir(), ".pi", "agent", "skills"), skillName));
	if (userSkill) return userSkill;

	return undefined;
}

export function readSkillContent(skillPath: string): string {
	const raw = readFileSync(skillPath, "utf-8");
	return parseFrontmatter(raw).body;
}
