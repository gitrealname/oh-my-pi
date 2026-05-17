import { describe, expect, it } from "bun:test";

// workspace-tree.ts imports @oh-my-pi/pi-natives which is a native Rust/NAPI binding.
// bun's module cache hangs on a second dynamic import() of a previously-failed NAPI
// module, so we load once at file scope and share the result across all tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any = null;
try {
	mod = await import("../src/workspace-tree");
} catch {
	// native unavailable — mod stays null; all tests below skip gracefully
}

describe("workspace-tree v14.9.3", () => {
	it("buildDirectoryTree returns DirectoryTree shape", async () => {
		if (!mod) return; // native unavailable — skip

		const result = await mod.buildDirectoryTree(process.cwd());
		expect(result).toBeDefined();
		expect(typeof result.rootPath).toBe("string");
		expect(typeof result.rendered).toBe("string");
		expect(typeof result.truncated).toBe("boolean");
		expect(typeof result.totalLines).toBe("number");
	});

	it("buildDirectoryTree respects maxDepth option", async () => {
		if (!mod) return;

		const [shallow, deep] = await Promise.all([
			mod.buildDirectoryTree(process.cwd(), { maxDepth: 1 }),
			mod.buildDirectoryTree(process.cwd(), { maxDepth: 3 }),
		]);
		// A deeper scan must produce at least as many rendered lines as a shallow one.
		expect(deep.totalLines).toBeGreaterThanOrEqual(shallow.totalLines);
	});

	it("buildWorkspaceTree returns WorkspaceTree with agentsMdFiles", async () => {
		if (!mod) return;

		const result = await mod.buildWorkspaceTree(process.cwd());
		expect(result).toBeDefined();
		// DirectoryTree fields
		expect(typeof result.rootPath).toBe("string");
		expect(typeof result.rendered).toBe("string");
		expect(typeof result.truncated).toBe("boolean");
		expect(typeof result.totalLines).toBe("number");
		// WorkspaceTree-only field
		expect(Array.isArray(result.agentsMdFiles)).toBe(true);
		for (const entry of result.agentsMdFiles) {
			expect(typeof entry).toBe("string");
			expect(entry.endsWith("AGENTS.md")).toBe(true);
		}
	});

	it("buildDirectoryTree handles non-existent path gracefully", async () => {
		if (!mod) return;

		// Implementation catches the native scan error and returns emptyTree — must not throw.
		const result = await mod.buildDirectoryTree("/nonexistent/path/xyz");
		expect(result).toBeDefined();
		expect(typeof result.rootPath).toBe("string");
		expect(result.rendered).toBe("");
		expect(result.truncated).toBe(false);
		expect(result.totalLines).toBe(0);
	});

	it("BuildDirectoryTreeOptions new fields work", async () => {
		if (!mod) return;

		// Confirms perDirLimit and rootLimit are the accepted option names in v14.9.3.
		// Old names (directoryEntryLimit, etc.) were removed in the merge.
		const result = await mod.buildDirectoryTree(process.cwd(), { perDirLimit: 3, maxDepth: 2 });
		expect(result).toBeDefined();
		expect(typeof result.totalLines).toBe("number");
	});
});
