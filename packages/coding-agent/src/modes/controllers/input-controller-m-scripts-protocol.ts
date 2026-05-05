/**
 * Pure @omp: output protocol parser — no native deps, safe to import in tests.
 * The controller (input-controller-m-scripts.ts) re-exports from here.
 */

const OMP_PREFIX = "@omp:";

export type OmpDirective =
	| { kind: "image"; path: string }
	| { kind: "text"; content: string }
	| { kind: "excluded"; content: string }
	| { kind: "stdout"; content: string };

/** Parse stdout into a list of directives. */
export function parseOutput(raw: string): OmpDirective[] {
	const directives: OmpDirective[] = [];
	const stdoutLines: string[] = [];

	for (const line of raw.split("\n")) {
		if (!line.startsWith(OMP_PREFIX)) {
			stdoutLines.push(line);
			continue;
		}
		const rest = line.slice(OMP_PREFIX.length);
		if (rest.startsWith("image:")) {
			directives.push({ kind: "image", path: rest.slice("image:".length).trim() });
		} else if (rest.startsWith("text:")) {
			// Unescape in one pass: \n → newline, \\ → backslash.
			// Two-pass replace is incorrect — it mis-handles \\n (escaped backslash + n).
			const raw = rest.slice("text:".length);
			const content = raw.replace(/\\(n|\\)/g, (_, c) => c === "n" ? "\n" : "\\");
			directives.push({ kind: "text", content });
		} else if (rest.startsWith("!!:")) {
			directives.push({ kind: "excluded", content: rest.slice("!!:".length) });
		} else {
			// Unknown @omp: tag — treat as stdout so it's visible/debuggable
			stdoutLines.push(line);
		}
	}

	const stdout = stdoutLines.join("\n").trim();
	if (stdout) {
		directives.push({ kind: "stdout", content: stdout });
	}

	return directives;
}

/** Threshold: text at or below this inserts inline; above → bracketed-paste indicator. */
export const INLINE_LIMIT = 1000;
