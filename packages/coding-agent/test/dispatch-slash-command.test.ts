import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { dispatchSlashCommand } from "@oh-my-pi/pi-coding-agent/open-sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("dispatchSlashCommand (open-sdk)", () => {
	let session: AgentSession;
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = path.join(tmpdir(), `dispatch-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
	});

	function createSession(extensionRunner?: ExtensionRunner): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		return session;
	}

	it("returns false for non-slash input", async () => {
		createSession();
		const result = await dispatchSlashCommand(session, "hello world");
		expect(result).toBe(false);
	});

	it("dispatches registered extension command via prompt", async () => {
		const handlerSpy = vi.fn().mockResolvedValue(undefined);
		const extensionRunner = {
			getCommand: vi.fn((name: string) => {
				if (name === "test-cmd") {
					return { name: "test-cmd", description: "Test", handler: handlerSpy };
				}
				return undefined;
			}),
			createCommandContext: vi.fn(() => ({
				ui: { notify: vi.fn(), setStatus: vi.fn() },
				hasUI: false,
				cwd: tempDir,
			})),
			emitError: vi.fn(),
		} as unknown as ExtensionRunner;

		createSession(extensionRunner);
		const result = await dispatchSlashCommand(session, "/test-cmd arg1 arg2");

		expect(result).toBe(true);
		expect(handlerSpy).toHaveBeenCalledWith("arg1 arg2", expect.objectContaining({ cwd: tempDir }));
	});

	it("dispatches command with no args", async () => {
		const handlerSpy = vi.fn().mockResolvedValue(undefined);
		const extensionRunner = {
			getCommand: vi.fn((name: string) => {
				if (name === "no-args") {
					return { name: "no-args", description: "No args", handler: handlerSpy };
				}
				return undefined;
			}),
			createCommandContext: vi.fn(() => ({
				ui: { notify: vi.fn(), setStatus: vi.fn() },
				hasUI: false,
				cwd: tempDir,
			})),
			emitError: vi.fn(),
		} as unknown as ExtensionRunner;

		createSession(extensionRunner);
		const result = await dispatchSlashCommand(session, "/no-args");

		expect(result).toBe(true);
		expect(handlerSpy).toHaveBeenCalledWith("", expect.anything());
	});

	it("returns true even when command handler throws (command was recognized)", async () => {
		const extensionRunner = {
			getCommand: vi.fn((name: string) => {
				if (name === "failing-cmd") {
					return { name: "failing-cmd", description: "Fails", handler: vi.fn().mockRejectedValue(new Error("boom")) };
				}
				return undefined;
			}),
			createCommandContext: vi.fn(() => ({
				ui: { notify: vi.fn(), setStatus: vi.fn() },
				hasUI: false,
				cwd: tempDir,
			})),
			emitError: vi.fn(),
		} as unknown as ExtensionRunner;

		createSession(extensionRunner);
		const result = await dispatchSlashCommand(session, "/failing-cmd");
		expect(result).toBe(true);
	});
});
