/**
 * Session State — in-memory event accumulator for session continuity.
 *
 * Tracks files modified, commands run, and key decisions during a session.
 * On compaction, builds context lines that get injected into the summarization
 * prompt via session.compacting → context: string[].
 *
 * Config (in config.yml):
 *   sessionContinuity:
 *     enabled: true          # master toggle
 *     maxEvents: 200         # cap per category before oldest are dropped
 *     maxContextLines: 30    # max lines injected into compaction prompt
 */

export interface SessionContinuityConfig {
	enabled: boolean;
	maxEvents: number;
	maxContextLines: number;
}

export const DEFAULTS: SessionContinuityConfig = {
	enabled: false,
	maxEvents: 200,
	maxContextLines: 30,
};

interface FileEvent {
	path: string;
	op: "read" | "edit" | "write" | "grep" | "find";
	count: number;
	lastTs: number;
}

interface CmdEvent {
	command: string;
	cwd?: string;
	ts: number;
}

export class SessionState {
	#files = new Map<string, FileEvent>();
	#commands: CmdEvent[] = [];
	#config: SessionContinuityConfig;

	constructor(config: Partial<SessionContinuityConfig> = {}) {
		this.#config = { ...DEFAULTS, ...config };
	}

	get enabled(): boolean {
		return this.#config.enabled;
	}

	updateConfig(config: Partial<SessionContinuityConfig>): void {
		this.#config = { ...this.#config, ...config };
	}

	trackFile(path: string, op: FileEvent["op"]): void {
		const existing = this.#files.get(path);
		if (existing) {
			existing.count++;
			existing.lastTs = Date.now();
			// Upgrade op: write/edit > read
			if (op === "edit" || op === "write") existing.op = op;
		} else {
			this.#files.set(path, { path, op, count: 1, lastTs: Date.now() });
			this.#evictFiles();
		}
	}

	trackCommand(command: string, cwd?: string): void {
		this.#commands.push({ command, cwd, ts: Date.now() });
		if (this.#commands.length > this.#config.maxEvents) {
			this.#commands = this.#commands.slice(-this.#config.maxEvents);
		}
	}

	/**
	 * Build context lines for injection into the compaction summarization prompt.
	 * Returns string[] where each entry becomes a bullet in <additional-context>.
	 */
	buildContextLines(): string[] {
		const max = this.#config.maxContextLines;
		const lines: string[] = [];

		// Files: split into modified vs read-only, sorted by recency
		const allFiles = [...this.#files.values()].sort((a, b) => b.lastTs - a.lastTs);
		const modified = allFiles.filter(f => f.op === "edit" || f.op === "write");
		const readOnly = allFiles.filter(f => f.op === "read");

		if (modified.length > 0) {
			const budget = Math.min(modified.length, Math.floor(max * 0.4));
			lines.push(`Files modified (${modified.length} total, showing ${budget} most recent):`);
			for (const f of modified.slice(0, budget)) {
				lines.push(`  ${f.path} (${f.count}x)`);
			}
		}

		if (readOnly.length > 0 && lines.length < max - 2) {
			const budget = Math.min(readOnly.length, Math.floor(max * 0.15));
			lines.push(`Files read (${readOnly.length} total, showing ${budget} most recent):`);
			for (const f of readOnly.slice(0, budget)) {
				lines.push(`  ${f.path}`);
			}
		}

		// Commands: most recent, deduplicated by command string
		if (this.#commands.length > 0 && lines.length < max - 2) {
			const seen = new Set<string>();
			const unique: CmdEvent[] = [];
			for (let i = this.#commands.length - 1; i >= 0 && unique.length < Math.floor(max * 0.3); i--) {
				const short = this.#commands[i].command.slice(0, 80);
				if (!seen.has(short)) {
					seen.add(short);
					unique.push(this.#commands[i]);
				}
			}
			if (unique.length > 0) {
				lines.push(`Recent commands (${this.#commands.length} total, showing ${unique.length} unique):`);
				for (const c of unique) {
					const cmd = c.command.length > 120 ? c.command.slice(0, 117) + "..." : c.command;
					lines.push(`  ${cmd}`);
				}
			}
		}

		return lines.slice(0, max);
	}

	/**
	 * Build preserveData for lossless survival across compactions.
	 */
	buildPreserveData(): Record<string, unknown> {
		const modified = [...this.#files.values()]
			.filter(f => f.op === "edit" || f.op === "write")
			.sort((a, b) => b.lastTs - a.lastTs)
			.slice(0, 50)
			.map(f => f.path);

		return {
			"prompt-engine:session-state": {
				modifiedFiles: modified,
				commandCount: this.#commands.length,
				fileCount: this.#files.size,
			},
		};
	}

	/** Restore from previous compaction's preserveData */
	restoreFrom(data: Record<string, unknown> | undefined): void {
		const saved = data?.["prompt-engine:session-state"] as {
			modifiedFiles?: string[];
		} | undefined;
		if (!saved?.modifiedFiles) return;
		// Re-seed file map with previously modified files (lower priority than live events)
		for (const path of saved.modifiedFiles) {
			if (!this.#files.has(path)) {
				this.#files.set(path, { path, op: "edit", count: 1, lastTs: 0 });
			}
		}
	}

	/** Clear all accumulated state (e.g., on session end) */
	clear(): void {
		this.#files.clear();
		this.#commands = [];
	}

	#evictFiles(): void {
		if (this.#files.size <= this.#config.maxEvents) return;
		// Drop oldest entries
		const sorted = [...this.#files.entries()].sort((a, b) => a[1].lastTs - b[1].lastTs);
		const toRemove = sorted.slice(0, this.#files.size - this.#config.maxEvents);
		for (const [key] of toRemove) {
			this.#files.delete(key);
		}
	}
}
