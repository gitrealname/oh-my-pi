import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import browserDescription from "../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { acquireBrowser, type BrowserHandle, type BrowserKind, type BrowserKindTag } from "./browser/registry";
import type { Observation, ScreenshotResult } from "./browser/tab-protocol";
import { acquireTab, dropHeadlessTabs, getTab, releaseAllTabs, releaseTab, runInTab } from "./browser/tab-supervisor";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./browser/readable";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";

const appSchema = Type.Object({
	path: Type.Optional(
		Type.String({
			description: "absolute path to a binary to spawn (single-instance reuse)",
			examples: ["/Applications/Cursor.app/Contents/MacOS/Cursor"],
		}),
	),
	cdp_url: Type.Optional(
		Type.String({
			description: "existing CDP endpoint to connect to (e.g. http://127.0.0.1:9222)",
		}),
	),
	args: Type.Optional(Type.Array(Type.String(), { description: "extra CLI args when spawning" })),
	target: Type.Optional(Type.String({ description: "substring matched against url+title to pick a BrowserWindow" })),
});

const browserSchema = Type.Object({
	action: StringEnum(["open", "close", "run"], { description: "tab/browser operation" }),
	name: Type.Optional(
		Type.String({
			description: "tab id; default 'main'. Multiple tabs can coexist; reusable across run() calls and subagents.",
			examples: ["main", "docs", "gh"],
		}),
	),
	url: Type.Optional(Type.String({ description: "open: navigate after acquiring tab" })),
	app: Type.Optional(appSchema),
	viewport: Type.Optional(
		Type.Object({
			width: Type.Number(),
			height: Type.Number(),
			scale: Type.Optional(Type.Number()),
		}),
	),
	wait_until: Type.Optional(
		StringEnum(["load", "domcontentloaded", "networkidle0", "networkidle2"], {
			description: "navigation wait condition for url",
		}),
	),
	dialogs: Type.Optional(
		StringEnum(["accept", "dismiss"], {
			description: "open: auto-handle alert/confirm/beforeunload dialogs (default: leave for caller to handle)",
		}),
	),
	code: Type.Optional(
		Type.String({
			description:
				"run: JS body executed with `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. Treated as the body of an async function. Use `display(value)` to attach text/JSON/images; the function's return value is JSON-serialized as a final block.",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "timeout in seconds", default: 30 })),
	all: Type.Optional(Type.Boolean({ description: "close: close every tab" })),
	kill: Type.Optional(Type.Boolean({ description: "close: also kill spawned-app browsers (default: leave running)" })),
});

/** Input schema for the browser tool. */
export type BrowserParams = Static<typeof browserSchema>;

/** Details describing a browser tool execution result (for renderers + transcript). */
export interface BrowserToolDetails {
	action: BrowserParams["action"];
	name?: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	observation?: Observation;
	screenshots?: ScreenshotResult[];
	result?: string;
	meta?: OutputMeta;
}

function resolveBrowserKind(params: BrowserParams, session: ToolSession): BrowserKind {
	const app = params.app;
	if (app?.cdp_url) {
		return { kind: "connected", cdpUrl: app.cdp_url.replace(/\/+$/, "") };
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		return { kind: "spawned", path: exe };
	}
	const headless = session.settings.get("browser.headless") as boolean;
	return { kind: "headless", headless };
}

/**
 * Browser tool: stateful, multi-tab. Three actions:
 * - `open`  → acquire/create a named tab on a browser kind (headless | spawned | connected) and optionally goto a url.
 * - `close` → release a named tab (or all tabs); dispose browser when refcount hits 0.
 * - `run`   → execute JS code against an existing tab with `page`/`browser`/`tab` helpers in scope.
 */
export class BrowserTool implements AgentTool<typeof browserSchema, BrowserToolDetails> {
	readonly name = "browser";
	readonly label = "Browser";
	readonly loadMode = "discoverable";
	readonly summary = "Control a headless browser to navigate and interact with web pages";
	readonly parameters = browserSchema;
	readonly strict = true;
	#browser: Browser | null = null;
	#page: Page | null = null;
	#currentHeadless: boolean | null = null;
	#isConnected = false;
	#browserSession: CDPSession | null = null;
	#userAgentOverride: UserAgentOverride | null = null;
	#elementIdCounter = 0;
	readonly #elementCache = new Map<number, ElementHandle>();
	readonly #patchedClients = new WeakSet<object>();

	constructor(private readonly session: ToolSession) {}
	#description?: string;
	get description(): string {
		this.#description ??= prompt.render(browserDescription, {});
		return this.#description;
	}

	async #closeBrowser(): Promise<void> {
		await this.#clearElementCache();
		if (this.#page && !this.#page.isClosed()) {
			await this.#page.close();
		}
		this.#page = null;
		if (this.#browser?.connected) {
			if (this.#isConnected) {
				this.#browser.disconnect();
			} else {
				await this.#browser.close();
			}
		}
		this.#browser = null;
		this.#browserSession = null;
		this.#userAgentOverride = null;
		this.#isConnected = false;
	}

	async #resetBrowser(params?: BrowserParams): Promise<Page> {
		await this.#closeBrowser();
		this.#currentHeadless = this.session.settings.get("browser.headless");
		const vp = params?.viewport;
		const initialViewport = vp
			? {
					width: vp.width,
					height: vp.height,
					deviceScaleFactor: vp.device_scale_factor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
				}
			: DEFAULT_VIEWPORT;
		const puppeteer = await loadPuppeteer();
		const launchArgs = [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-blink-features=AutomationControlled",
			`--window-size=${initialViewport.width},${initialViewport.height}`,
		];
		const proxy = process.env.PUPPETEER_PROXY;
		if (proxy) {
			launchArgs.push(`--proxy-server=${proxy}`);
			// Chrome (since v72) bypasses proxies for localhost by default. When PUPPETEER_PROXY_BYPASS_LOOPBACK
			// is true, add <-loopback> so traffic to localhost reaches the proxy (e.g. for mitmdump/auth capture).
			const bypassLoopback = process.env.PUPPETEER_PROXY_BYPASS_LOOPBACK?.toLowerCase();
			if (
				bypassLoopback === "true" ||
				bypassLoopback === "1" ||
				bypassLoopback === "yes" ||
				bypassLoopback === "on"
			) {
				launchArgs.push("--proxy-bypass-list=<-loopback>");
			}
		}
		const ignoreCert = process.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS?.toLowerCase();
		if (ignoreCert === "true" || ignoreCert === "1" || ignoreCert === "yes" || ignoreCert === "on") {
			launchArgs.push("--ignore-certificate-errors");
		}
		const connectUrl = this.session.settings.get("browser.connectUrl") as string | undefined;
		if (connectUrl) {
			try {
				this.#browser = await puppeteer.connect({ browserURL: connectUrl, defaultViewport: null });
				this.#isConnected = true;
				const pages = await this.#browser.pages();
				this.#page = pages[0] ?? await this.#browser.newPage();
				return this.#page;
			} catch {
				logger.debug("Could not connect to browser at", { url: connectUrl }, "— falling back to launch");
			}
		}
		this.#isConnected = false;
		this.#browser = await puppeteer.launch({
			headless: this.#currentHeadless,
			defaultViewport: this.#currentHeadless ? initialViewport : null,
			executablePath: await ensureChromiumExecutable(),
			args: launchArgs,
			ignoreDefaultArgs: [...STEALTH_IGNORE_DEFAULT_ARGS],
		});
		this.#page = await this.#browser.newPage();
		await this.#applyStealthPatches(this.#page);
		if (this.#currentHeadless || params?.viewport) {
			await this.#applyViewport(this.#page, params?.viewport);
		}
		return this.#page;
	}

	async #ensurePage(params?: BrowserParams): Promise<Page> {
		const desiredHeadless = this.session.settings.get("browser.headless");
		if (!this.#isConnected && this.#currentHeadless !== null && this.#currentHeadless !== desiredHeadless) {
			return this.#resetBrowser(params);
		}
		if (this.#page && !this.#page.isClosed()) {
			return this.#page;
		}
		if (!this.#browser?.isConnected()) {
			return this.#resetBrowser(params);
		}
		this.#page = await this.#browser.newPage();
		await this.#applyStealthPatches(this.#page);
		if (this.#currentHeadless || params?.viewport) {
			await this.#applyViewport(this.#page, params?.viewport);
		}
		return this.#page;
	}

	async #applyViewport(page: Page, viewport?: BrowserParams["viewport"]): Promise<void> {
		if (!viewport) {
			await page.setViewport(DEFAULT_VIEWPORT);
			return;
		}
		await page.setViewport({
			width: viewport.width,
			height: viewport.height,
			deviceScaleFactor: viewport.device_scale_factor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
		});
	}

	async #clearElementCache(): Promise<void> {
		if (this.#elementCache.size === 0) {
			this.#elementIdCounter = 0;
			return;
		}
		const handles = Array.from(this.#elementCache.values());
		this.#elementCache.clear();
		this.#elementIdCounter = 0;
		await Promise.all(
			handles.map(async handle => {
				try {
					await handle.dispose();
				} catch {
					return;
				}
			}),
		);
	}

	async #resolveCachedHandle(id: number): Promise<ElementHandle> {
		const handle = this.#elementCache.get(id);
		if (!handle) {
			throw new ToolError(`Unknown element_id ${id}. Run observe to refresh the element list.`);
		}
		try {
			const isConnected = (await handle.evaluate(el => el.isConnected)) as boolean;
			if (!isConnected) {
				await this.#clearElementCache();
				throw new ToolError(`Element_id ${id} is stale. Run observe again.`);
			}
		} catch {
			await this.#clearElementCache();
			throw new ToolError(`Element_id ${id} is stale. Run observe again.`);
		}
		return handle;
	}

	#isInteractiveNode(node: SerializedAXNode): boolean {
		if (INTERACTIVE_AX_ROLES.has(node.role)) return true;
		return (
			node.checked !== undefined ||
			node.pressed !== undefined ||
			node.selected !== undefined ||
			node.expanded !== undefined ||
			node.focused === true
		);
	}

	async #collectObservationEntries(
		node: SerializedAXNode,
		entries: ObservationEntry[],
		options: { viewportOnly: boolean; includeAll: boolean },
	): Promise<void> {
		if (options.includeAll || this.#isInteractiveNode(node)) {
			const handle = await node.elementHandle();
			if (handle) {
				let inViewport = true;
				if (options.viewportOnly) {
					try {
						inViewport = await handle.isIntersectingViewport();
					} catch {
						inViewport = false;
					}
				}
				if (inViewport) {
					const id = ++this.#elementIdCounter;
					const states: string[] = [];
					if (node.disabled) states.push("disabled");
					if (node.checked !== undefined) states.push(`checked=${String(node.checked)}`);
					if (node.pressed !== undefined) states.push(`pressed=${String(node.pressed)}`);
					if (node.selected !== undefined) states.push(`selected=${String(node.selected)}`);
					if (node.expanded !== undefined) states.push(`expanded=${String(node.expanded)}`);
					if (node.required) states.push("required");
					if (node.readonly) states.push("readonly");
					if (node.multiselectable) states.push("multiselectable");
					if (node.multiline) states.push("multiline");
					if (node.modal) states.push("modal");
					if (node.focused) states.push("focused");
					this.#elementCache.set(id, handle);
					entries.push({
						id,
						role: node.role,
						name: node.name,
						value: node.value,
						description: node.description,
						keyshortcuts: node.keyshortcuts,
						states,
					});
				} else {
					await handle.dispose();
				}
			}
		}
		for (const child of node.children ?? []) {
			await this.#collectObservationEntries(child, entries, options);
		}
	}

	#formatObservation(observation: Observation): string {
		const viewport = `${observation.viewport.width}x${observation.viewport.height}`;
		const scroll = `x=${observation.scroll.x} y=${observation.scroll.y} viewport=${observation.scroll.width}x${observation.scroll.height} doc=${observation.scroll.scrollWidth}x${observation.scroll.scrollHeight}`;
		const lines = [
			`URL: ${observation.url}`,
			observation.title ? `Title: ${observation.title}` : "Title:",
			`Viewport: ${viewport}`,
			`Scroll: ${scroll}`,
			"Elements:",
		];
		for (const entry of observation.elements) {
			const name = entry.name ? ` "${entry.name}"` : "";
			const value = entry.value !== undefined ? ` value=${JSON.stringify(entry.value)}` : "";
			const description = entry.description ? ` desc=${JSON.stringify(entry.description)}` : "";
			const shortcuts = entry.keyshortcuts ? ` shortcuts=${JSON.stringify(entry.keyshortcuts)}` : "";
			const state = entry.states.length ? ` (${entry.states.join(", ")})` : "";
			lines.push(`${entry.id}. ${entry.role}${name}${value}${description}${shortcuts}${state}`);
		}
		return lines.join("\n");
	}

	/**
	 * Restart the browser to apply changes like headless mode.
	 */
	async restartForModeChange(): Promise<void> {
		await dropHeadlessTabs();
	}

	async execute(
		_toolCallId: string,
		params: BrowserParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BrowserToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		try {
			throwIfAborted(signal);
			const timeoutSeconds = clampTimeout("browser", params.timeout);
			const timeoutMs = timeoutSeconds * 1000;
			const name = params.name ?? DEFAULT_TAB_NAME;
			const details: BrowserToolDetails = { action: params.action, name };

			switch (params.action) {
				case "open":
					return await this.#open(name, params, details, timeoutMs, signal);
				case "close":
					return await this.#close(name, params, details, signal);
				case "run":
					return await this.#run(name, params, details, timeoutMs, signal);
				default:
					throw new ToolError(`Unsupported action: ${(params as BrowserParams).action}`);
			}
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			if (error instanceof Error && error.name === "AbortError") {
				throw new ToolAbortError();
			}
			throw error;
		}
	}

	async #open(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kind = resolveBrowserKind(params, this.session);
		details.browser = kind.kind;

		// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
		const existing = getTab(name);
		if (existing && !sameBrowserKind(existing.browser.kind, kind)) {
			throw new ToolError(
				`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
			);
		}

		const browser = await untilAborted(signal, () =>
			acquireBrowser(kind, {
				cwd: this.session.cwd,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				appArgs: params.app?.args,
				signal,
			}),
		);

		const result = await untilAborted(signal, () =>
			acquireTab(name, browser, {
				url: params.url,
				waitUntil: params.wait_until,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				target: params.app?.target,
				timeoutMs,
				dialogs: params.dialogs,
				signal,
			}),
		);
		const tab = result.tab;
		const url = tab.info.url;
		const title = tab.info.title ?? "";
		details.url = url;
		details.viewport = tab.info.viewport;
		const verb = result.created ? "Opened" : "Reused";
		const lines = [
			`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}`,
			`URL: ${url}`,
			title ? `Title: ${title}` : null,
		].filter((l): l is string => typeof l === "string");
		details.result = lines.join("\n");
		return toolResult(details).text(lines.join("\n")).done();
	}

	async #close(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kill = !!params.kill;
		if (params.all) {
			const count = await untilAborted(signal, () => releaseAllTabs({ kill }));
			details.result = `Closed ${count} tab(s)`;
			return toolResult(details).text(details.result).done();
		}
		const closed = await untilAborted(signal, () => releaseTab(name, { kill }));
		details.result = closed ? `Closed tab ${JSON.stringify(name)}` : `No tab named ${JSON.stringify(name)}`;
		return toolResult(details).text(details.result).done();
	}

	async #run(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (!params.code?.trim()) {
			throw new ToolError("Missing required parameter 'code' for action 'run'.");
		}
		const tab = getTab(name);
		if (tab) {
			details.browser = tab.browser.kind.kind;
			details.url = tab.info.url;
		}

		const { displays, returnValue, screenshots } = await runInTab(name, {
			code: params.code,
			timeoutMs,
			signal,
			session: this.session,
		});

		if (screenshots.length) details.screenshots = screenshots;

		const content = [...displays];
		if (returnValue !== undefined) {
			content.push({ type: "text", text: stringifyReturnValue(returnValue) });
		}
		if (!content.length) {
			content.push({ type: "text", text: `Ran code on tab ${JSON.stringify(name)}` });
		}
		const textOnly = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		details.result = textOnly;
		return toolResult(details).content(content).done();
	}
}

function describeBrowser(handle: BrowserHandle): string {
	switch (handle.kind.kind) {
		case "headless":
			return `headless browser (${handle.kind.headless ? "hidden" : "visible"})`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
	}
}

function sameBrowserKind(a: BrowserKind, b: BrowserKind): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "headless" && b.kind === "headless") return a.headless === b.headless;
	if (a.kind === "spawned" && b.kind === "spawned") return a.path === b.path;
	if (a.kind === "connected" && b.kind === "connected") return a.cdpUrl === b.cdpUrl;
	return false;
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
