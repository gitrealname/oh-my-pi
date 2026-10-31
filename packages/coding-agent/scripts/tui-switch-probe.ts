/**
 * PTY probe for the DELIVERED binary: boots the TUI with the launcher-style
 * overlay, drives a real `/modelpreset switch <name>` interaction, and asserts
 * the switch report + status line. Usage:
 *
 *   bun scripts/tui-switch-probe.ts <omp-binary> <overlay.yml> <preset> [preset2]
 */
import { Terminal as VirtualTerminal } from "@oh-my-pi/pi-utils/vterm";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const COLUMNS = 180;
const ROWS = 50;

function screenText(terminal: VirtualTerminal): string {
	const rows: string[] = [];
	for (let i = 0; i < terminal.buffer.active.length; i++) {
		rows.push(terminal.buffer.active.getLine(i)?.translateToString(true) ?? "");
	}
	return rows.join("\n");
}

const [binArg, overlayArg, ...presets] = process.argv.slice(2);
if (!binArg || !overlayArg || presets.length === 0) {
	console.error("usage: bun scripts/tui-switch-probe.ts <omp-binary> <overlay.yml> <preset...>");
	process.exit(1);
}
const bin = path.resolve(binArg);
const overlayPath = path.resolve(overlayArg);

const screen = new VirtualTerminal({ cols: COLUMNS, rows: ROWS, scrollback: 500 });
const settled = Promise.withResolvers<string>();
let settledOnce = false;
let acc = "";

await using terminal = new Bun.Terminal({
	cols: COLUMNS,
	rows: ROWS,
	data(_t, data) {
		screen.write(data, () => {
			acc = screenText(screen);
			if (settledOnce) return;
			// Resolve when the last requested preset's switch report appears.
			const last = presets[presets.length - 1];
			if (new RegExp(`Switched to preset "${last}"`).test(acc)) {
				settledOnce = true;
				settled.resolve(acc);
			}
		});
	},
});

const home = os.homedir();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-switch-probe-"));
const proc = Bun.spawn([bin, "--config", overlayPath, "--no-session"], {
	cwd: path.dirname(overlayPath),
	stdio: ["ignore", "ignore", "ignore"],
	terminal,
	env: {
		...process.env,
		TERM: "xterm-256color",
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: tmp,
		PI_TEST_RUNTIME: undefined as unknown as string,
	},
});

try {
	// Boot; dismiss the setup overlay so the slash input reaches the app.
	await Bun.sleep(4000);
	for (let i = 0; i < 14; i++) {
		terminal.write("\x1b"); // Esc — "skip" each setup step
		await Bun.sleep(200);
		acc = screenText(screen);
		if (/Setup step/i.test(acc) === false) break;
	}
	for (const preset of presets) {
		terminal.write(`/modelpreset switch ${preset}\r`);
		await Bun.sleep(60);
		// Wait for this preset's report to appear before the next command.
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			await Bun.sleep(200);
			acc = screenText(screen);
			if (new RegExp(`Switched to preset "${preset}"|not applied|not found`).test(acc)) break;
		}
	}
	// Give the status line a beat to repaint, then grab the screen.
	await Bun.sleep(1500);
	const text = settledOnce ? await settled.promise : acc;
	console.log("=== SCREEN ===");
	console.log(text);
} finally {
	proc.kill();
	try {
		await proc.exited;
	} catch {}
	fs.rmSync(tmp, { recursive: true, force: true });
}
