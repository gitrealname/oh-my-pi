import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { hasMReviewHtml, openMReviewSession } from "../tools/mreview/index";
import { invalidateMentalModelsCache } from "../mmemory-extension";
import {
	executeMemoryBuild,
	executeMemoryConsolidate,
	executeMemoryMentalModelSeed,
	executeMemoryRecall,
	executeMemoryReflect,
	formatRecallForSystemPrompt,
	getOrCreateServerClient,
	loadFacts,
	loadMentalModels,
	loadMmemoryConfig,
	resolvePaths,
} from "../tools/mmemory/index";
import { getRecallScope, setRecallScope, scopeLabel } from "../tools/mmemory/session-scope";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { resolveModelRoleValue } from "../config/model-resolver";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Spacer, Text } from "@oh-my-pi/pi-tui";
import { DynamicBorder } from "../modes/components/dynamic-border";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/utils/oauth";
import type { SettingPath, SettingValue } from "../config/settings";
import { settings } from "../config/settings";
import { serializeBatchForSummarizer } from "../session/compaction/mprune-batch";
import { buildSummarizerPrompt } from "../session/compaction/mprune-prompt";
import { buildStatsLines, loadPersistentStats } from "../session/compaction/mprune-stats";
import { getMpruneSessionStats } from "../extensibility/extensions/m-prune-extension";
import {
	clearPluginRootsAndCaches,
	resolveActiveProjectRegistryPath,
	resolveOrDefaultProjectRegistryPath,
} from "../discovery/helpers.js";
import { PluginManager } from "../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../extensibility/plugins/marketplace";
import type { InteractiveModeContext } from "../modes/types";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "./marketplace-install-parser";

function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.updateEditorTopBorder();
	ctx.ui.requestRender();
}

/** Declarative subcommand definition for commands like /mcp. */
export interface SubcommandDef {
	name: string;
	description: string;
	/** Usage hint shown as dim ghost text, e.g. "<name> [--scope project|user]". */
	usage?: string;
}

/** Declarative builtin slash command definition used by autocomplete and help UI. */
export interface BuiltinSlashCommand {
	name: string;
	description: string;
	/** Subcommands for dropdown completion (e.g. /mcp add, /mcp list). */
	subcommands?: SubcommandDef[];
	/** Static inline hint when command takes a simple argument (no subcommands). */
	inlineHint?: string;
}

interface ParsedBuiltinSlashCommand {
	name: string;
	args: string;
	text: string;
}

interface BuiltinSlashCommandSpec extends BuiltinSlashCommand {
	aliases?: string[];
	allowArgs?: boolean;
	/**
	 * Handle the command. Return a string to pass remaining text through as prompt input.
	 * Return void/undefined to consume the input entirely.
	 */
	handle: (
		command: ParsedBuiltinSlashCommand,
		runtime: BuiltinSlashCommandRuntime,
		// biome-ignore lint/suspicious/noConfusingVoidType: void needed so async handlers returning nothing are assignable
	) => Promise<string | void> | string | void;
}

export interface BuiltinSlashCommandRuntime {
	ctx: InteractiveModeContext;
	handleBackgroundCommand: () => void;
}

function parseBuiltinSlashCommand(text: string): ParsedBuiltinSlashCommand | null {
	if (!text.startsWith("/")) return null;
	const body = text.slice(1);
	if (!body) return null;

	const firstWhitespace = body.search(/\s/);
	const firstColon = body.indexOf(":");
	const firstSeparator =
		firstWhitespace === -1 ? firstColon : firstColon === -1 ? firstWhitespace : Math.min(firstWhitespace, firstColon);

	if (firstSeparator === -1) {
		return {
			name: body,
			args: "",
			text,
		};
	}

	return {
		name: body.slice(0, firstSeparator),
		args: body.slice(firstSeparator + 1).trim(),
		text,
	};
}

const shutdownHandler = (_command: ParsedBuiltinSlashCommand, runtime: BuiltinSlashCommandRuntime): void => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
};



async function callLLMForMemory(
	role: string,
	systemPrompt: string,
	userPrompt: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string> {
	const registry = runtime.ctx.session.modelRegistry;
	const resolved = resolveModelRoleValue(role, registry.getAll(), { modelRegistry: registry });
	const model = resolved.model ?? runtime.ctx.session.model;
	if (!model) throw new Error(`No model for role: ${role}`);
	const sessionId = runtime.ctx.sessionManager.getSessionId();
	const apiKey = await registry.getApiKey(model, sessionId);
	if (!apiKey) throw new Error(`No API key for model: ${model.provider}/${model.id}`);
	const response = await completeSimple(
		model,
		{
			systemPrompt,
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{ apiKey },
	);
	if (response.stopReason === "error" || !response.content) throw new Error("LLM call failed");
	return response.content
		.filter((c: { type: string; text?: string }) => c.type === "text")
		.map((c: { type: string; text?: string }) => c.text ?? "")
		.join("");
}

const mmemoryHandler = async (command: ParsedBuiltinSlashCommand, runtime: BuiltinSlashCommandRuntime): Promise<string | undefined> => {
	const args = command.args.trim();
	const [subcommand, ...rest] = args.split(/\s+/);
	const restStr = rest.join(" ");
	const cwd = runtime.ctx.sessionManager.getCwd();
	const config = loadMmemoryConfig(settings as any, cwd);
	runtime.ctx.editor.setText("");

	if (!config) {
		runtime.ctx.showWarning("mmemory: not enabled. Set mmemory.enabled: true in config.");
		return;
	}

	switch (subcommand) {
		case "recall": {
			if (!restStr) {
				runtime.ctx.showStatus("Usage: /mmemory recall <query>   or   /mmemory recall / <global query>");
				return;
			}
			let scope: string | null | undefined;
			let query: string;
			if (restStr.startsWith("/ ") || restStr === "/") {
				scope = null;
				query = restStr.slice(2).trim() || "recent context";
			} else {
				const scopeMatch = restStr.match(/--scope\s+(\S+)/);
				scope = scopeMatch ? scopeMatch[1] : getRecallScope(runtime.ctx.sessionManager);
				query = restStr.replace(/--scope\s+\S+/, "").trim();
			}
			runtime.ctx.showStatus(`mmemory: recalling "${query}"...`);
			const result = await executeMemoryRecall(query, scope, config, runtime.ctx.session.modelRegistry, settings);
			runtime.ctx.showStatus(result.resultCount > 0
				? `mmemory: ${result.resultCount} memories found.`
				: "mmemory: no memories found.");
			await runtime.ctx.session.agent.prompt(
				`[Memory recall result for "${query}"]\n\n${result.text}`,
			);
			break;
		}
		case "reflect": {
			if (!restStr) { runtime.ctx.showStatus("Usage: /mmemory reflect <query>"); return; }
			const scopeMatch = restStr.match(/--scope\s+(\S+)/);
			const scope = scopeMatch ? scopeMatch[1] : undefined;
			const query = restStr.replace(/--scope\s+\S+/, "").trim();
			runtime.ctx.showStatus(`mmemory: reflecting on "${query}"...`);
			const result = await executeMemoryReflect(query, scope, config);
			runtime.ctx.showStatus(`mmemory: reflect done (${result.resultCount} memories).`);
			await runtime.ctx.session.agent.prompt(
				`[Memory reflection on "${query}"]\n\n${result.text}`,
			);
			break;
		}
		case "retain": {
			runtime.ctx.showStatus("mmemory: retain is handled automatically by the extension.");
			break;
		}
		case "view": {
			const viewResult = await executeMemoryRecall("recent context", undefined, config, runtime.ctx.session.modelRegistry, settings);
			const snippet = formatRecallForSystemPrompt(viewResult);
			runtime.ctx.showStatus(snippet ? "mmemory: showing recall snippet." : "mmemory: no memories loaded.");
			if (snippet) {
				await runtime.ctx.session.agent.prompt(`[Current memory recall snippet]\n\n${snippet}`);
			}
			break;
		}
		case "status": {
			const mmPaths = resolvePaths(config);
			const enabled = settings.get("mmemory.enabled" as SettingPath);
			const hasChunks = existsSync(mmPaths.chunksPath);
			const chunkCount = hasChunks
				? (() => { try { return (JSON.parse(readFileSync(mmPaths.chunksPath, "utf-8")) as unknown[]).length; } catch { return "?"; } })()
				: 0;
			const proj = config.projectLabel;
			const scope = scopeLabel(runtime.ctx.sessionManager, proj);
			runtime.ctx.showStatus(
				`mmemory: enabled=${String(enabled)}, scope=${scope}, chunks=${chunkCount}, path=${mmPaths.projectDir}`,
			);
			break;
		}
		case "clear": {
			const fromMatch    = restStr.match(/--from\s+(\S+)/);
			const toMatch      = restStr.match(/--to\s+(\S+)/);
			const sessionMatch = restStr.match(/--session\s+(\S+)/);
			if (!fromMatch && !toMatch && !sessionMatch) {
				runtime.ctx.showWarning(
					"mmemory clear requires --from DATE, --to DATE, or --session ID. Full deletion is not supported.",
				);
				return;
			}
			const from      = fromMatch?.[1];
			const to        = toMatch?.[1];
			const sessionId = sessionMatch?.[1];
			const mmPaths   = resolvePaths(config);
			const rangeDesc = sessionId ? `session ${sessionId}` : `${from ?? "*"} → ${to ?? "*"}`;

			runtime.ctx.showStatus(`mmemory: clearing ${rangeDesc}...`);
			try {
				// Delegate to server — runs under _build_lock, preventing race with in-flight builds
				const client = await getOrCreateServerClient(config);
				const resp = await client.query("clear", {
					project_dir: mmPaths.projectDir,
					from_date:   from,
					to_date:     to,
					session_id:  sessionId,
				}) as { status?: string; deleted?: number; remaining?: number; error?: string };

				if (resp.error) {
					runtime.ctx.showWarning(`mmemory clear: ${resp.error}`);
					break;
				}
				const deleted = resp.deleted ?? 0;
				if (deleted > 0) {
					// Vectors were deleted by the server; trigger rebuild so next recall re-embeds
					void executeMemoryBuild(config).catch(() => {});
					runtime.ctx.showStatus(
						`mmemory: cleared ${deleted} chunk(s) matching ${rangeDesc} ` +
						`(${resp.remaining ?? 0} remain). Rebuilding index.`,
					);
				} else {
					runtime.ctx.showStatus(`mmemory: no chunks matched ${rangeDesc}.`);
				}
			} catch (e) {
				runtime.ctx.showWarning(`mmemory clear: server error — ${String(e)}`);
			}
			break;
		}
		case "enqueue": {
			runtime.ctx.showStatus("mmemory: enqueue — use the extension to trigger a retain cycle.");
			break;
		}
		case "consolidate": {
			const maxRawFactsOverride = restStr.match(/--max-facts\s+(\d+)/)?.[1];
			const effectiveConfig = maxRawFactsOverride
				? { ...config, maxRawFacts: parseInt(maxRawFactsOverride, 10) }
				: config;
			runtime.ctx.showStatus(`mmemory: consolidating (threshold: ${effectiveConfig.maxRawFacts} facts)...`);
			try {
				const facts = await loadFacts(config);
				const systemPrompt = [
					"You are a precise knowledge consolidator. Merge the raw facts below into a smaller set of higher-level observations.",
					"Return ONLY a JSON array (no markdown fences, no prose) of objects with exactly these fields:",
					'{"observation": string (one concise declarative sentence), "entities": string[] (key concepts), "date": string (YYYY-MM-DD)}',
					"Deduplicate. Merge related facts. Discard resolved ephemeral items. Target: ~20% of input count.",
				].join(" ");
				const userPrompt = `Facts (${facts.length} items):\n\n${JSON.stringify(facts, null, 2).slice(0, 15000)}`;
				const responseText = await callLLMForMemory(effectiveConfig.consolidateModelRole, systemPrompt, userPrompt, runtime);
				const result = await executeMemoryConsolidate(effectiveConfig, async () => responseText);
				runtime.ctx.showStatus(
					result.skipped
						? result.message
						: `mmemory: consolidated ${result.factsConsumed} facts into ${result.observationCount} observations.`,
				);
			} catch (e) {
				runtime.ctx.showWarning(`mmemory consolidate: ${String(e)}`);
			}
			break;
		}
		case "global":
		case "/": {
			setRecallScope(runtime.ctx.sessionManager, null);
			runtime.ctx.showStatus("mmemory: recall scope → global. Use /mmemory . to reset.");
			break;
		}
		case "project":
		case ".": {
			const proj = config.projectLabel;
			setRecallScope(runtime.ctx.sessionManager, proj);
			runtime.ctx.showStatus(`mmemory: recall scope → ${proj}. Use /mmemory / for global.`);
			break;
		}
		case "mm": {
			const mmSub = rest[0];
			const mmPaths = resolvePaths(config);
			if (mmSub === "list") {
				try {
					const files = readdirSync(mmPaths.mentalModelsDir).filter(f => f.endsWith(".md")).sort();
					if (files.length === 0) {
						runtime.ctx.showStatus("mmemory mm: no mental model files. Run /mmemory mm regenerate.");
					} else {
						for (const f of files) {
							const st = statSync(path.join(mmPaths.mentalModelsDir, f));
							runtime.ctx.showStatus(`mmemory mm: ${f}  ${st.size}B  ${st.mtime.toISOString().slice(0, 19).replace("T", " ")}`);
						}
					}
				} catch {
					runtime.ctx.showStatus("mmemory mm: mental_models/ directory not found.");
				}
			} else if (mmSub === "regenerate") {
				runtime.ctx.showStatus("mmemory mm: regenerating mental models...");
				try {
					const recallResult = await executeMemoryRecall(
						"project context preferences conventions decisions", undefined, config, runtime.ctx.session.modelRegistry, settings,
					);
					const memoriesText = recallResult.resultCount > 0 ? recallResult.text : "";
					const result = await executeMemoryMentalModelSeed(config, async (query, systemPrompt) => {
						const userPrompt = memoriesText
							? `Available memories:\n${memoriesText}\n\nQuery: ${query}`
							: `No memories available yet.\n\nQuery: ${query}`;
						return callLLMForMemory(config.consolidateModelRole, systemPrompt, userPrompt, runtime);
					});
					const ok = result.generated.length;
					const fail = result.skipped.length;
					runtime.ctx.showStatus(
						`mmemory mm: regenerated ${ok} model(s)${fail > 0 ? `, ${fail} failed (${result.skipped.join(", ")})` : ""}.`,
					);
				if (ok > 0) invalidateMentalModelsCache(mmPaths.projectDir);
				} catch (e) {
					runtime.ctx.showWarning(`mmemory mm regenerate: ${String(e)}`);
				}
			} else {
				runtime.ctx.showStatus("Usage: /mmemory mm list | /mmemory mm regenerate");
			}
			break;
		}
		default: {
			if (subcommand && !subcommand.startsWith("-")) {
				setRecallScope(runtime.ctx.sessionManager, subcommand);
				runtime.ctx.showStatus(`mmemory: recall scope → ${subcommand}. Use /mmemory . to reset.`);
			} else {
				runtime.ctx.showStatus(
					"Usage: /mmemory <recall|retain|reflect|view|clear|enqueue|consolidate|mm|status|/|.> [args]",
				);
			}
		}
	}
};

const mpruneHandler = async (command: ParsedBuiltinSlashCommand, runtime: BuiltinSlashCommandRuntime): Promise<void> => {
	const args = command.args.trim();
	runtime.ctx.editor.setText("");

	const entries = runtime.ctx.sessionManager.getBranch();
	const enabled = settings.get("mprune.enabled" as SettingPath);

	switch (args || "flush") {
		case "flush":
		case "": {
			if (!enabled) {
				runtime.ctx.showStatus("mprune: not enabled. Set mprune.enabled: true in config.");
				return;
			}
			const unprunedEntries = entries.filter(e => {
				if (e.type !== "message") return false;
				const msg = e.message as { role: string; prunedAt?: number };
				return msg.role === "toolResult" && msg.prunedAt === undefined;
			});
			if (unprunedEntries.length === 0) {
				runtime.ctx.showStatus("mprune: nothing to prune.");
				return;
			}
			runtime.ctx.showStatus(`mprune: summarizing ${unprunedEntries.length} unpruned tool result(s)...`);
			try {
				const registry = runtime.ctx.session.modelRegistry;
				const roleValue = settings.get("modelRoles.prune" as "modelRoles.smol") ?? settings.get("modelRoles.smol") ?? settings.get("modelRoles.default" as "modelRoles.smol");
				const resolved = resolveModelRoleValue(roleValue, registry.getAvailable(), { modelRegistry: registry });
				const model = resolved.model;
				if (!model) { runtime.ctx.showStatus("mprune: no model configured (set modelRoles.prune)."); return; }

				const toolResults = unprunedEntries.map(e => {
					const msg = e.message as { toolCallId: string; toolName: string; content: unknown; prunedAt?: number };
					const textParts: string[] = [];
					if (typeof msg.content === "string") { textParts.push(msg.content); }
					else if (Array.isArray(msg.content)) {
						for (const b of msg.content as Array<{ type: string; text?: string }>) {
							if (b.type === "text" && b.text) textParts.push(b.text);
						}
					}
					const content = textParts.join("\n");
					return { toolCallId: msg.toolCallId, toolName: msg.toolName, content, charCount: content.length, prunedAt: msg.prunedAt };
				});
				const batch = { turnIndex: -1, toolResults };
				const serialized = serializeBatchForSummarizer(batch);
				const response = await completeSimple(
					model,
					{
						systemPrompt: buildSummarizerPrompt(),
						messages: [{ role: "user", content: [{ type: "text", text: serialized }], timestamp: Date.now() }],
					},
				{ },
				);
				if (response.stopReason === "error" || !response.content) {
					runtime.ctx.showStatus("mprune: summarizer returned no content.");
					return;
				}
				const summary = response.content
					.filter((c: { type: string }) => c.type === "text")
					.map((c: { type: string; text?: string }) => c.text ?? "")
					.join("");
				runtime.ctx.chatContainer.addChild(new Text(`mprune summary:\n${summary}`, 1, 0));
				runtime.ctx.chatContainer.addChild(new Spacer(1));
				runtime.ctx.ui.requestRender();
				const prunedAt = Date.now();
				for (const entry of unprunedEntries) {
					(entry.message as { prunedAt?: number }).prunedAt = prunedAt;
				}
				await (runtime.ctx.sessionManager as any).rewriteEntries();
				runtime.ctx.showStatus(`mprune: pruned ${unprunedEntries.length} tool result(s).`);
			} catch (err) {
				runtime.ctx.showStatus(`mprune: error — ${String(err)}`);
			}
			break;
		}
		case "stats": {
			try {
				const agentDir = getAgentDir();
				const lifetime = loadPersistentStats(agentDir);
				const session = getMpruneSessionStats(runtime.ctx.sessionManager) ?? {
					tokensSavedTrim: 0, tokensSavedBatch: 0, tokensSavedImages: 0,
					trimEvents: 0, batchFlushes: 0, imagesPruned: 0,
				};
				const lines = buildStatsLines(session, lifetime);
				runtime.ctx.chatContainer.addChild(new Spacer(1));
				runtime.ctx.chatContainer.addChild(new DynamicBorder());
				runtime.ctx.chatContainer.addChild(new Text("mprune stats", 1, 0));
				runtime.ctx.chatContainer.addChild(new Spacer(1));
				runtime.ctx.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
				runtime.ctx.chatContainer.addChild(new DynamicBorder());
				runtime.ctx.ui.requestRender();
			} catch (err) {
				runtime.ctx.showStatus(`mprune stats: error — ${String(err)}`);
			}
			break;
		}
		case "status": {
			const prunedCount = entries.filter(e =>
				e.type === "message" && (e.message as { prunedAt?: number }).prunedAt !== undefined,
			).length;
			const keepTurns = settings.get("mprune.images.keepTurns" as SettingPath);
			const softTrimChars = settings.get("mprune.trim.softTrimChars" as SettingPath);
			runtime.ctx.showStatus(
				`mprune: enabled=${String(enabled)}, images.keepTurns=${keepTurns}, trim.softTrimChars=${softTrimChars}, ${prunedCount} entries pruned`,
			);
			break;
		}
		default:
			runtime.ctx.showStatus("Usage: /mprune [flush|stats|status]");
	}
};
const mreviewHandler = async (command: ParsedBuiltinSlashCommand, runtime: BuiltinSlashCommandRuntime): Promise<void> => {
	const args = command.args.trim().replace(/^@/, ""); // strip leading @ from @file mentions
	if (!args) {
		runtime.ctx.showStatus(`Usage: /${command.name} <file.md>`);
		runtime.ctx.editor.setText("");
		return;
	}
	if (!hasMReviewHtml()) {
		runtime.ctx.showWarning("mreview: UI asset (mreview-ui.html) missing — ensure it is placed next to the omp binary.");
		runtime.ctx.editor.setText("");
		return;
	}
	const filePath = resolvePath(runtime.ctx.sessionManager.getCwd(), args);
	if (!existsSync(filePath)) {
		runtime.ctx.showWarning(`mreview: file not found: ${filePath}`);
		runtime.ctx.editor.setText("");
		return;
	}
	let markdown: string;
	try {
		markdown = readFileSync(filePath, "utf-8");
	} catch {
		runtime.ctx.showWarning(`mreview: cannot read file: ${filePath}`);
		runtime.ctx.editor.setText("");
		return;
	}
	const browserPath = settings.get("mreview.browser" as SettingPath) as string | undefined;

	const openInBrowser = (url: string) => {
		if (browserPath) {
			try {
				Bun.spawn(["cmd.exe", "/c", "start", "", browserPath, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
			} catch {
				runtime.ctx.openInBrowser(url);
			}
		} else {
			runtime.ctx.openInBrowser(url);
		}
	};
	// Inject file content into the agent's context before opening the browser
	const agent = runtime.ctx.session.agent;
	agent.state.messages.push({
		role: "user",
		content: [{ type: "text", text: `Opening ${filePath} for review. File content:\n\n${markdown}` }],
		timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as any);
	agent.state.messages.push({
		role: "assistant",
		content: [{ type: "text", text: `I've read ${filePath} (${markdown.split("\n").length} lines). Opening the review UI — I'll respond to any questions or annotations in the browser.` }],
		timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as any);

	const result = await openMReviewSession(
		{
			cwd: runtime.ctx.sessionManager.getCwd(),
			openInBrowser,
			showStatus: (msg) => runtime.ctx.showStatus(msg),
			showWarning: (msg) => runtime.ctx.showWarning(msg),
		},
		filePath,
		markdown,
		{ browserPath, agent: runtime.ctx.session.agent },
	);
	if (result.exit) {
		runtime.ctx.showStatus("mreview: closed.");
	} else if (result.approved) {
		runtime.ctx.showStatus("mreview: approved.");
	} else if (result.feedback?.trim()) {
		// Auto-send feedback to the agent so the user gets an immediate response
		runtime.ctx.showStatus("mreview: processing review comments...");
		await runtime.ctx.session.agent.prompt(result.feedback.trim());
	}
};

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<BuiltinSlashCommandSpec> = [
	{
		name: "settings",
		description: "Open settings menu",
		handle: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan",
		description: "Toggle plan mode (agent plans before executing)",
		inlineHint: "[prompt]",
		allowArgs: true,
		handle: async (command, runtime) => {
			await runtime.ctx.handlePlanModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "loop",
		description:
			"Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Esc cancels the current iteration; /loop again to disable.",
		inlineHint: "[count|duration]",
		allowArgs: true,
		handle: async (command, runtime) => {
			await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "model",
		aliases: ["models"],
		description: "Select model (opens selector UI)",
		handle: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fast",
		description: "Toggle fast mode (OpenAI service tier priority)",
		subcommands: [
			{ name: "on", description: "Enable fast mode" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
		allowArgs: true,
		handle: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode enabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode disabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				const enabled = runtime.ctx.session.isFastModeEnabled();
				runtime.ctx.showStatus(`Fast mode is ${enabled ? "on" : "off"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "export",
		description: "Export session to HTML file",
		inlineHint: "[path]",
		allowArgs: true,
		handle: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "dump",
		description: "Copy session transcript to clipboard",
		handle: async (_command, runtime) => {
			await runtime.ctx.handleDumpCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "share",
		description: "Share session as a secret GitHub gist",
		handle: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "browser",
		description: "Toggle browser headless vs visible mode",
		subcommands: [
			{ name: "headless", description: "Switch to headless mode" },
			{ name: "visible", description: "Switch to visible mode" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!(settings.get("browser.enabled" as SettingPath) as boolean)) {
				runtime.ctx.showWarning("Browser tool is disabled (enable in settings)");
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg) {
				next = !current;
			} else if (["headless", "hidden"].includes(arg)) {
				next = true;
			} else if (["visible", "show", "headful"].includes(arg)) {
				next = false;
			} else {
				runtime.ctx.showStatus("Usage: /browser [headless|visible]");
				runtime.ctx.editor.setText("");
				return;
			}
			settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.ctx.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (error) {
					runtime.ctx.showWarning(
						`Failed to restart browser: ${error instanceof Error ? error.message : String(error)}`,
					);
					runtime.ctx.editor.setText("");
					return;
				}
			}
			runtime.ctx.showStatus(`Browser mode: ${next ? "headless" : "visible"}`);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "copy",
		description: "Copy last agent message to clipboard",
		subcommands: [
			{ name: "last", description: "Copy full last agent message" },
			{ name: "code", description: "Copy last code block" },
			{ name: "all", description: "Copy all code blocks from last message" },
			{ name: "cmd", description: "Copy last bash/python command" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || undefined;
			await runtime.ctx.handleCopyCommand(sub);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "todo",
		description: "View or modify the agent's todo list",
		subcommands: [
			{ name: "edit", description: "Open todos in $EDITOR (Markdown round-trip)" },
			{ name: "copy", description: "Copy todos as Markdown to clipboard" },
			{ name: "export", description: "Write todos as Markdown to a file (default: TODO.md)", usage: "[<path>]" },
			{ name: "import", description: "Replace todos from a Markdown file (default: TODO.md)", usage: "[<path>]" },
			{
				name: "append",
				description: "Append a task; phase fuzzy-matched or auto-created",
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: "Mark task in_progress (fuzzy-matched)", usage: "<task>" },
			{ name: "done", description: "Mark task/phase/all completed (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "drop", description: "Mark task/phase/all abandoned (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "rm", description: "Remove task/phase/all (fuzzy-matched)", usage: "[<task|phase>]" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "session",
		description: "Session management commands",
		subcommands: [
			{ name: "info", description: "Show session info and stats" },
			{ name: "delete", description: "Delete current session and return to selector" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || "info";
			if (sub === "delete") {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			// Default: show session info
			await runtime.ctx.handleSessionCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "jobs",
		description: "Show async background jobs status",
		handle: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "usage",
		description: "Show provider usage and limits",
		handle: async (_command, runtime) => {
			await runtime.ctx.handleUsageCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "changelog",
		description: "Show changelog entries",
		subcommands: [{ name: "full", description: "Show complete changelog" }],
		allowArgs: true,
		handle: async (command, runtime) => {
			const showFull = command.args.split(/\s+/).filter(Boolean).includes("full");
			await runtime.ctx.handleChangelogCommand(showFull);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hotkeys",
		description: "Show all keyboard shortcuts",
		handle: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		description: "Show tools currently visible to the agent",
		handle: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "context",
		description: "Show estimated context usage breakdown",
		handle: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		description: "Open Extension Control Center dashboard",
		handle: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "agents",
		description: "Open Agent Control Center dashboard",
		handle: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "branch",
		description: "Create a new branch from a previous message",
		handle: (_command, runtime) => {
			if (settings.get("doubleEscapeAction") === "tree") {
				runtime.ctx.showTreeSelector();
			} else {
				runtime.ctx.showUserMessageSelector();
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fork",
		description: "Create a new fork from a previous message",
		handle: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		description: "Navigate session tree",
		handle: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "mtree",
		description: "Session tree with Ctrl+↓ peek preview",
		handle: (_command, runtime) => {
			(runtime.ctx as unknown as { showMTreeSelector(): void }).showMTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		description: "Login with OAuth provider",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
		handle: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? `OAuth login already in progress for ${pendingProvider}. Paste the redirect URL with /login <url>.`
							: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus("OAuth callback received; completing login…");
				} else {
					runtime.ctx.showWarning("No OAuth login is waiting for a manual callback.");
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? `OAuth login already in progress for ${provider}. Paste the redirect URL with /login <url>.`
					: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "logout",
		description: "Logout from OAuth provider",
		handle: (_command, runtime) => {
			void runtime.ctx.showOAuthSelector("logout");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "mcp",
		description: "Manage MCP servers (add, list, remove, test)",
		subcommands: [
			{
				name: "add",
				description: "Add a new MCP server",
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{
				name: "smithery-search",
				description: "Search Smithery registry and deploy an MCP server",
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: "Login to Smithery and cache API key" },
			{ name: "smithery-logout", description: "Remove cached Smithery API key" },
			{ name: "reconnect", description: "Reconnect to a specific MCP server", usage: "<name>" },
			{ name: "reload", description: "Force reload MCP runtime tools" },
			{ name: "resources", description: "List available resources from connected servers" },
			{ name: "prompts", description: "List available prompts from connected servers" },
			{ name: "notifications", description: "Show notification capabilities and subscriptions" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
	{
		name: "ssh",
		description: "Manage SSH hosts (add, list, remove)",
		subcommands: [
			{
				name: "add",
				description: "Add an SSH host",
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]",
			},
			{ name: "list", description: "List all configured SSH hosts" },
			{ name: "remove", description: "Remove an SSH host", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		description: "Start a new session",
		handle: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleClearCommand();
		},
	},
	{
		name: "drop",
		description: "Delete the current session and start a new one",
		handle: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleDropCommand();
		},
	},
	{
		name: "compact",
		description: "Manually compact the session context",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleCompactCommand(customInstructions);
		},
	},
	{
		name: "handoff",
		description: "Hand off session context to a new session",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	{
		name: "resume",
		description: "Resume a different session",
		handle: (_command, runtime) => {
			runtime.ctx.showSessionSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "btw",
		description: "Ask an ephemeral side question using the current session context",
		inlineHint: "<question>",
		allowArgs: true,
		handle: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleBtwCommand(question);
		},
	},
	{
		name: "retry",
		description: "Retry the last failed agent turn",
		handle: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus("Nothing to retry");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "background",
		aliases: ["bg"],
		description: "Detach UI and continue running in background",
		handle: (_command, runtime) => {
			runtime.ctx.editor.setText("");
			runtime.handleBackgroundCommand();
		},
	},
	{
		name: "debug",
		description: "Open debug tools selector",
		handle: (_command, runtime) => {
			runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "memory",
		description: "Inspect and operate memory maintenance",
		subcommands: [
			{ name: "view", description: "Show current memory injection payload" },
			{ name: "clear", description: "Clear persisted memory data and artifacts" },
			{ name: "reset", description: "Alias for clear" },
			{ name: "enqueue", description: "Enqueue memory consolidation maintenance" },
			{ name: "rebuild", description: "Alias for enqueue" },
			{ name: "mm list", description: "List mental models on the active bank" },
			{ name: "mm show", description: "Show one mental model (id required)" },
			{
				name: "mm refresh",
				description: "Refresh auto-refresh models bank-wide, or one model by id",
			},
			{ name: "mm history", description: "Diff the change history of a mental model" },
			{ name: "mm seed", description: "Create any built-in mental models that are missing" },
			{ name: "mm delete", description: "Delete a mental model from the bank (id required)" },
			{ name: "mm reload", description: "Re-pull the cached <mental_models> block" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	{
		name: "rename",
		description: "Rename the current session",
		inlineHint: "<title>",
		allowArgs: true,
		handle: async (command, runtime) => {
			const title = command.args.trim();
			if (!title) {
				runtime.ctx.showError("Usage: /rename <title>");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleRenameCommand(title);
		},
	},

	{
		name: "move",
		description: "Move session to a different working directory",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			const targetPath = command.args;
			if (!targetPath) {
				runtime.ctx.showError("Usage: /move <path>");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMoveCommand(targetPath);
		},
	},
	{
		name: "exit",
		description: "Exit the application",
		handle: shutdownHandler,
	},
	{
		name: "marketplace",
		description: "Manage marketplace plugin sources and installed plugins",
		subcommands: [
			{ name: "add", description: "Add a marketplace source", usage: "<source>" },
			{ name: "remove", description: "Remove a marketplace source", usage: "<name>" },
			{ name: "update", description: "Update marketplace catalog(s)", usage: "[name]" },
			{ name: "list", description: "List configured marketplaces" },
			{ name: "discover", description: "Browse available plugins", usage: "[marketplace]" },
			{
				name: "install",
				description: "Install a plugin (interactive browser if no args)",
				usage: "[--force] [name@marketplace]",
			},
			{ name: "uninstall", description: "Uninstall a plugin (selector if no args)", usage: "[name@marketplace]" },
			{ name: "installed", description: "List installed marketplace plugins" },
			{ name: "upgrade", description: "Upgrade outdated plugins", usage: "[name@marketplace]" },
			{ name: "help", description: "Show usage guide" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "install";
			const rest = args.slice(1).join(" ").trim();

			// /marketplace (no args) or /marketplace install (no args) → interactive browser
			if ((sub === "install" && !rest) || (!args[0] && !command.args.trim())) {
				try {
					runtime.ctx.showPluginSelector("install");
				} catch (err) {
					runtime.ctx.showStatus(`Marketplace error: ${err}`);
				}
				return;
			}

			const mgr = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
					runtime.ctx.sessionManager.getCwd(),
				),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});

			try {
				switch (sub) {
					case "add": {
						if (!rest) {
							runtime.ctx.showStatus("Usage: /marketplace add <source>");
							return;
						}
						const entry = await mgr.addMarketplace(rest);
						runtime.ctx.showStatus(`Added marketplace: ${entry.name}`);
						break;
					}
					case "remove":
					case "rm": {
						if (!rest) {
							runtime.ctx.showStatus("Usage: /marketplace remove <name>");
							return;
						}
						await mgr.removeMarketplace(rest);
						runtime.ctx.showStatus(`Removed marketplace: ${rest}`);
						break;
					}
					case "update": {
						if (rest) {
							await mgr.updateMarketplace(rest);
							runtime.ctx.showStatus(`Updated marketplace: ${rest}`);
						} else {
							const results = await mgr.updateAllMarketplaces();
							runtime.ctx.showStatus(`Updated ${results.length} marketplace(s)`);
						}
						break;
					}
					case "discover": {
						const plugins = await mgr.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await mgr.listMarketplaces();
							if (marketplaces.length === 0) {
								runtime.ctx.showStatus(
									"No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official",
								);
							} else {
								runtime.ctx.showStatus("No plugins available in configured marketplaces");
							}
						} else {
							const lines = plugins.map(
								p =>
									`  ${p.name}${p.version ? `@${p.version}` : ""}${p.description ? ` - ${p.description}` : ""}`,
							);
							runtime.ctx.showStatus(`Available plugins:\n${lines.join("\n")}`);
						}
						break;
					}
					case "install": {
						// Parse: /marketplace install [--force] [--scope user|project] name@marketplace
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const atIdx = parsed.installSpec.lastIndexOf("@");
						const name = parsed.installSpec.slice(0, atIdx);
						const marketplace = parsed.installSpec.slice(atIdx + 1);
						await mgr.installPlugin(name, marketplace, { force: parsed.force, scope: parsed.scope });
						runtime.ctx.showStatus(`Installed ${name} from ${marketplace}`);
						break;
					}
					case "uninstall": {
						if (!rest) {
							// No args → open interactive uninstall selector
							runtime.ctx.showPluginSelector("uninstall");
							return;
						}
						const uninstArgs = parsePluginScopeArgs(
							rest,
							"Usage: /marketplace uninstall [--scope user|project] <name@marketplace>",
						);
						if ("error" in uninstArgs) {
							runtime.ctx.showStatus(uninstArgs.error);
							return;
						}
						await mgr.uninstallPlugin(uninstArgs.pluginId, uninstArgs.scope);
						runtime.ctx.showStatus(`Uninstalled ${uninstArgs.pluginId}`);
						break;
					}
					case "installed": {
						const installed = await mgr.listInstalledPlugins();
						if (installed.length === 0) {
							runtime.ctx.showStatus("No marketplace plugins installed");
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							runtime.ctx.showStatus(`Installed plugins:\n${lines.join("\n")}`);
						}
						break;
					}
					case "upgrade": {
						if (rest) {
							const upArgs = parsePluginScopeArgs(
								rest,
								"Usage: /marketplace upgrade [--scope user|project] <name@marketplace>",
							);
							if ("error" in upArgs) {
								runtime.ctx.showStatus(upArgs.error);
								return;
							}
							const result = await mgr.upgradePlugin(upArgs.pluginId, upArgs.scope);
							runtime.ctx.showStatus(`Upgraded ${upArgs.pluginId} to ${result.version}`);
						} else {
							const results = await mgr.upgradeAllPlugins();
							if (results.length === 0) {
								runtime.ctx.showStatus("All marketplace plugins are up to date");
							} else {
								const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
								runtime.ctx.showStatus(`Upgraded ${results.length} plugin(s):\n${lines.join("\n")}`);
							}
						}
						break;
					}
					case "help": {
						runtime.ctx.showStatus(
							[
								"Marketplace commands:",
								"  /marketplace                              Browse and install plugins",
								"  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)",
								"  /marketplace remove <name>                 Remove a marketplace",
								"  /marketplace update [name]                 Re-fetch catalog(s)",
								"  /marketplace list                          List configured marketplaces",
								"  /marketplace discover [marketplace]        Browse available plugins",
								"  /marketplace install <name@marketplace>    Install a plugin",
								"  /marketplace uninstall <name@marketplace>  Uninstall a plugin",
								"  /marketplace installed                     List installed plugins",
								"  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)",
								"",
								"Quick start:",
								"  /marketplace add anthropics/claude-plugins-official",
								"  /marketplace                               (opens interactive browser)",
							].join("\n"),
						);
						break;
					}
					default: {
						const marketplaces = await mgr.listMarketplaces();
						if (marketplaces.length === 0) {
							runtime.ctx.showStatus(
								"No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse plugins with /marketplace or /marketplace discover",
							);
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							runtime.ctx.showStatus(
								`Marketplaces:\n${lines.join("\n")}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands`,
							);
						}
						break;
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				runtime.ctx.showStatus(`Marketplace error: ${msg}`);
			}
		},
	},
	{
		name: "plugins",
		description: "View and manage installed plugins",
		subcommands: [
			{ name: "list", description: "List all installed plugins (npm + marketplace)" },
			{ name: "enable", description: "Enable a marketplace plugin", usage: "<name@marketplace>" },
			{ name: "disable", description: "Disable a marketplace plugin", usage: "<name@marketplace>" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "list";
			const rest = args.slice(1).join(" ").trim();

			try {
				const mgr = new MarketplaceManager({
					marketplacesRegistryPath: getMarketplacesRegistryPath(),
					installedRegistryPath: getInstalledPluginsRegistryPath(),
					projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
						runtime.ctx.sessionManager.getCwd(),
					),
					marketplacesCacheDir: getMarketplacesCacheDir(),
					pluginsCacheDir: getPluginsCacheDir(),
					clearPluginRootsCache: clearPluginRootsAndCaches,
				});

				switch (sub) {
					case "enable":
					case "disable": {
						const parsed = parsePluginScopeArgs(
							rest ?? "",
							`Usage: /plugins ${sub} [--scope user|project] <name@marketplace>`,
						);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const isEnable = sub === "enable";
						await mgr.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
						runtime.ctx.showStatus(`${isEnable ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
						break;
					}
					default: {
						const lines: string[] = [];

						const npm = new PluginManager();
						const npmPlugins = await npm.list();
						if (npmPlugins.length > 0) {
							lines.push("npm plugins:");
							for (const p of npmPlugins) {
								const status = p.enabled === false ? " (disabled)" : "";
								lines.push(`  ${p.name}@${p.version}${status}`);
							}
						}

						const mktPlugins = await mgr.listInstalledPlugins();
						if (mktPlugins.length > 0) {
							if (lines.length > 0) lines.push("");
							lines.push("marketplace plugins:");
							for (const p of mktPlugins) {
								const entry = p.entries[0];
								const status = entry?.enabled === false ? " (disabled)" : "";
								const shadowed = p.shadowedBy ? " [shadowed]" : "";
								lines.push(`  ${p.id} v${entry?.version ?? "?"}${status} [${p.scope}]${shadowed}`);
							}
						}

						if (lines.length === 0) {
							runtime.ctx.showStatus("No plugins installed");
						} else {
							runtime.ctx.showStatus(lines.join("\n"));
						}
						break;
					}
				}
			} catch (err) {
				runtime.ctx.showStatus(`Plugin error: ${err}`);
			}
		},
	},
	{
		name: "reload-plugins",
		description: "Reload all plugins (skills, commands, hooks, tools, agents, MCP)",
		handle: async (_command, runtime) => {
			// Invalidate registry fs caches and the plugin roots cache so
			// listClaudePluginRoots re-reads from disk on next access.
			const projectPath = await resolveActiveProjectRegistryPath(runtime.ctx.sessionManager.getCwd());
			clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
			await runtime.ctx.refreshSlashCommandState();
			runtime.ctx.showStatus("Plugins reloaded.");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "force",
		description: "Force next turn to use a specific tool",
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		handle: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(error instanceof Error ? error.message : String(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return prompt;
		},
	},
	{
		name: "quit",
		description: "Quit the application",
		handle: shutdownHandler,
	},
	{
		name: "mreview",
		description: "Open a markdown file in the browser review UI with AI chat",
		inlineHint: "<file.md>",
		allowArgs: true,
		handle: mreviewHandler,
	},

	{
		name: "mmemory",
		description: "Memory operations: recall, retain, reflect, view, clear, enqueue, consolidate, mm, status",
		inlineHint: "<recall|retain|reflect|view|clear|enqueue|consolidate|mm|status> [args]",
		allowArgs: true,
		subcommands: [
			{ name: "recall",      description: "Search memories with BM25+semantic retrieval" },
			{ name: "retain",      description: "Store information (auto-triggered by extension)" },
			{ name: "reflect",     description: "Synthesize memories on a topic" },
			{ name: "view",        description: "Show current recall snippet" },
			{ name: "clear",       description: "Delete memories (--from DATE [--to DATE] | --session ID)" },
			{ name: "enqueue",     description: "Force retain now" },
			{ name: "consolidate", description: "Merge raw facts into observations (--max-facts N, default 100)" },
			{ name: "mm",          description: "Mental models: list | regenerate" },
			{ name: "status",      description: "Show memory system status" },
			{ name: "global",      description: "Switch to global scope this session" },
			{ name: "project",     description: "Switch back to per-project-tagged scope" },
		],
		handle: mmemoryHandler,
	},

	{
		name: "mprune",
		description: "Dynamic context pruning: flush summarization or show status",
		inlineHint: "[flush|stats|status]",
		allowArgs: true,
		subcommands: [
			{ name: "flush",  description: "Summarize and prune unpruned tool results (default)" },
			{ name: "stats",  description: "Show per-session and lifetime token savings" },
			{ name: "status", description: "Show mprune config and pruned entry count" },
		],
		handle: mpruneHandler,
	},

];

function isCommandEnabled(name: string): boolean {
	const disabled = settings.get("disabledCommands" as SettingPath) as string[] | undefined;
	return !disabled?.includes(name);
}

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, BuiltinSlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

/** Builtin command metadata used for slash-command autocomplete and help text. */
export function getBuiltinSlashCommandDefs(): ReadonlyArray<BuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_REGISTRY
		.filter(c => isCommandEnabled(c.name))
		.map(command => ({
			name: command.name,
			description: command.description,
			subcommands: command.subcommands,
			inlineHint: command.inlineHint,
		}));
}

/** @deprecated Use getBuiltinSlashCommandDefs() for filtered list */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
	}),
);

/**
 * Execute a builtin slash command when it matches known command syntax.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command consumed
 * the input entirely. Returns a `string` when the command was handled but remaining
 * text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseBuiltinSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (!isCommandEnabled(command.name)) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}

	const remaining = await command.handle(parsed, runtime);
	return remaining ?? true;
}
