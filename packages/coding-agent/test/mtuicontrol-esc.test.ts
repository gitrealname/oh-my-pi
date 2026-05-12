/**
 * mtuicontrol — RPC inject commands test.
 *
 * Tests the inject_key / inject_text / inject_slash RPC commands added
 * by rpc-inject-handler.ts. Uses raw subprocess + JSONL to avoid the
 * pi_natives ESM/require conflict that blocks direct RpcClient imports
 * in bun:test.
 *
 * The abort-timing test (parallel.ts race fix) is validated separately
 * via the parallel.ts unit tests which run without a binary.
 *
 * Run:
 *   OMP_BINARY=%LOCALAPPDATA%\omp\omp.exe bun test packages/coding-agent/test/mtuicontrol-esc.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";

const OMP_BINARY = process.env.OMP_BINARY;
const SKIP = !OMP_BINARY;

// ── Minimal raw RPC client ───────────────────────────────────────────────────

interface RawRpc {
	send(cmd: object): void;
	receive(filter: (obj: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>>;
	kill(): void;
}

async function startRaw(): Promise<RawRpc> {
	return new Promise((resolve, reject) => {
		const proc = spawn(OMP_BINARY!, ["--mode", "rpc", "--no-lsp"], {
			cwd: "D:/.ai",
			stdio: ["pipe", "pipe", "pipe"],
		});

		const listeners: Array<(o: Record<string, unknown>) => void> = [];
		let buf = "";

		proc.stdout.on("data", (chunk: Buffer) => {
			buf += chunk.toString("utf8");
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl === -1) break;
				const raw = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!raw) continue;
				try {
					const obj = JSON.parse(raw) as Record<string, unknown>;
					for (const fn of listeners.slice()) fn(obj);
				} catch { /* ignore */ }
			}
		});

		proc.on("error", reject);

		const rpc: RawRpc = {
			send(cmd) { proc.stdin.write(`${JSON.stringify(cmd)}\n`); },
			receive(filter, timeoutMs) {
				return new Promise((res, rej) => {
					const timer = setTimeout(() => rej(new Error(`receive timed out after ${timeoutMs}ms`)), timeoutMs);
					const handler = (obj: Record<string, unknown>) => {
						if (filter(obj)) {
							clearTimeout(timer);
							listeners.splice(listeners.indexOf(handler), 1);
							res(obj);
						}
					};
					listeners.push(handler);
				});
			},
			kill() { proc.kill(); },
		};

		// Wait for ready
		const timer = setTimeout(() => reject(new Error("ready timeout")), 15_000);
		const handler = (obj: Record<string, unknown>) => {
			if (obj.type === "ready") {
				clearTimeout(timer);
				listeners.splice(listeners.indexOf(handler), 1);
				resolve(rpc);
			}
		};
		listeners.push(handler);
	});
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("mtuicontrol — RPC inject commands", () => {
	let rpc: RawRpc | null = null;

	beforeEach(async () => {
		if (!SKIP) rpc = await startRaw();
	});

	afterEach(() => {
		rpc?.kill();
		rpc = null;
	});

	it.skipIf(SKIP)("get_state responds with success", async () => {
		rpc!.send({ type: "get_state", id: "s1" });
		const resp = await rpc!.receive(
			o => o.type === "response" && o.id === "s1",
			10_000,
		);
		expect(resp.success).toBe(true);
		expect(resp.data).toBeTruthy();
	}, 15_000);

	it.skipIf(SKIP)("inject_key unknown key returns success (no-op in headless)", async () => {
		rpc!.send({ type: "inject_key", key: "ArrowUp", id: "k1" });
		const resp = await rpc!.receive(
			o => o.type === "response" && o.id === "k1",
			5_000,
		);
		expect(resp.success).toBe(true);
		expect(resp.command).toBe("inject_key");
	}, 10_000);

	it.skipIf(SKIP)("inject_key Escape returns success", async () => {
		rpc!.send({ type: "inject_key", key: "Escape", id: "k2" });
		const resp = await rpc!.receive(
			o => o.type === "response" && o.id === "k2",
			5_000,
		);
		expect(resp.success).toBe(true);
		expect(resp.command).toBe("inject_key");
	}, 10_000);

	it.skipIf(SKIP)("inject_key \\x1b (raw ESC) returns success", async () => {
		rpc!.send({ type: "inject_key", key: "\x1b", id: "k3" });
		const resp = await rpc!.receive(
			o => o.type === "response" && o.id === "k3",
			5_000,
		);
		expect(resp.success).toBe(true);
	}, 10_000);

	it.skipIf(SKIP)("inject_text returns success", async () => {
		rpc!.send({ type: "inject_text", text: "hello world", id: "t1" });
		const resp = await rpc!.receive(
			o => o.type === "response" && o.id === "t1",
			5_000,
		);
		expect(resp.success).toBe(true);
		expect(resp.command).toBe("inject_text");
	}, 10_000);

	it.skipIf(SKIP)("inject_slash returns success", async () => {
		rpc!.send({ type: "inject_slash", command: "/mtuicontrol list", id: "sl1" });
		const resp = await rpc!.receive(
			o => o.type === "response" && o.id === "sl1",
			5_000,
		);
		expect(resp.success).toBe(true);
		expect(resp.command).toBe("inject_slash");
	}, 10_000);

	it.skipIf(SKIP)("unknown inject command falls through to error", async () => {
		// Unknown commands get error response; id is not echoed (pre-existing rpc-mode behaviour)
		const errPromise = rpc!.receive(
			o => o.type === "response" && o.success === false,
			5_000,
		);
		rpc!.send({ type: "inject_unknown_xyz", id: "u1" });
		const resp = await errPromise;
		expect(resp.success).toBe(false);
	}, 10_000);
});
