import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { applyOverrides } from "@oh-my-pi/pi-coding-agent/open-sdk";
import { getProjectAgentDir, Snowflake } from "@oh-my-pi/pi-utils";

describe("applyOverrides (open-sdk)", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		resetSettingsForTest();
		testDir = path.join(os.tmpdir(), "test-apply-overrides", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");
		if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(() => {
		try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
	});

	it("applies overrides and returns applied keys", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const result = applyOverrides(settings, {
			"memory.backend": "off",
			"display.tabWidth": 4,
		});
		expect(result.applied).toContain("memory.backend");
		expect(result.applied).toContain("display.tabWidth");
		expect(result.skipped).toHaveLength(0);
		expect(settings.get("memory.backend")).toBe("off");
		expect(settings.get("display.tabWidth")).toBe(4);
	});

	it("overrides are runtime-only — not persisted to config.yml", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir, inMemory: true });
		applyOverrides(settings, { "memory.backend": "off" });
		const configPath = path.join(agentDir, "config.yml");
		expect(fs.existsSync(configPath)).toBe(false);
		expect(settings.get("memory.backend")).toBe("off");
	});

	it("does not fire hooks by default", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const result = applyOverrides(settings, { "display.tabWidth": 8 });
		expect(result.applied).toContain("display.tabWidth");
		expect(settings.get("display.tabWidth")).toBe(8);
	});

	it("fires hooks when fireHooks=true", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const result = applyOverrides(
			settings,
			{ "display.tabWidth": 8 },
			{ fireHooks: true },
		);
		expect(result.applied).toContain("display.tabWidth");
		expect(result.skipped).toHaveLength(0);
		expect(settings.get("display.tabWidth")).toBe(8);
	});

	it("multiple known keys are applied in batch", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const result = applyOverrides(settings, {
			"memory.backend": "off",
			"display.tabWidth": 2,
		});
		expect(result.applied).toContain("memory.backend");
		expect(result.applied).toContain("display.tabWidth");
		expect(result.skipped).toHaveLength(0);
	});

	it("single call applies batch of overrides", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.set("memory.backend", "lancedb");
		const result = applyOverrides(settings, {
			"memory.backend": "off",
			"display.tabWidth": 2,
		});
		expect(result.applied).toHaveLength(2);
		expect(settings.get("memory.backend")).toBe("off");
		expect(settings.get("display.tabWidth")).toBe(2);
	});

	it("clearOverride removes the override and falls back to global", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.set("memory.backend", "lancedb");
		applyOverrides(settings, { "memory.backend": "off" });
		expect(settings.get("memory.backend")).toBe("off");
		settings.clearOverride("memory.backend" as never);
		expect(settings.get("memory.backend")).toBe("lancedb");
	});
});
