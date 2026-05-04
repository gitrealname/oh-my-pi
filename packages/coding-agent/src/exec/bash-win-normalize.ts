/**
 * Normalise a shell command string for Windows / Git Bash execution.
 *
 * Three transforms applied in order:
 *
 * 1. `/dev/null` → `NUL`  (Git Bash maps /dev/null to a drive path; use the
 *    real Windows null device so redirects work at the Bun/brush layer.)
 *
 * 2. Backslashes → forward slashes, except:
 *    - Inside single-quoted strings  `'…'`  (regex/pattern args for sed, grep,
 *      python -c, etc. — the model intentionally writes `\w`, `\d`, `\n` there)
 *    - The escape pair `\\`  (explicit double-backslash stays as-is)
 *
 * 3. Bare `.cmd` / `.CMD` invocations → prefixed with `cmd /c`  (Git Bash
 *    cannot execute .cmd files natively; cmd.exe must be the interpreter.)
 *
 * This module is intentionally dependency-free so it can be unit-tested
 * without loading the native addon.
 */
export function normalizeCommandForWindows(command: string): string {
	// ── 1. /dev/null → NUL ──────────────────────────────────────────────────
	let result = command.replace(/(2\s*>|>\s*)\/dev\/null\b/g, (_, prefix) => `${prefix}NUL`);

	// ── 2. Backslashes → forward slashes (outside single-quoted strings) ────
	//
	// Walk the string character by character:
	//   'quoted'   — copy verbatim (preserve regex/pattern escapes inside)
	//   \\         — copy verbatim (explicit double-backslash)
	//   \<char>    — emit /<char>  (Windows path separator)
	//   other      — copy verbatim
	{
		let out = "";
		let i = 0;
		while (i < result.length) {
			if (result[i] === "'") {
				// Single-quoted region: copy everything verbatim until the closing '
				const end = result.indexOf("'", i + 1);
				if (end === -1) {
					// Unclosed quote — treat the rest as quoted (safe fallback)
					out += result.slice(i);
					i = result.length;
				} else {
					out += result.slice(i, end + 1);
					i = end + 1;
				}
			} else if (result[i] === "\\" && i + 1 < result.length && result[i + 1] === "\\") {
				// Explicit double-backslash — preserve both
				out += "\\\\";
				i += 2;
			} else if (result[i] === "\\") {
				// Single backslash — treat as Windows path separator
				out += "/";
				i += 1;
			} else {
				out += result[i];
				i += 1;
			}
		}
		result = out;
	}

	// ── 3. Bare .cmd invocations → cmd /c <invocation> ──────────────────────
	//
	// Match at: start of string  |  after &&  |  after ||  |  after ;
	// Skip if already preceded by "cmd /c" or "cmd /C".
	// Invocation = path + filename.cmd + optional non-empty args, but NOT
	// trailing whitespace (kept so shell operators stay properly spaced).
	result = result.replace(
		/(^|&&\s*|\|\|\s*|;\s*)(?!cmd\s+\/[cC]\s)([\w./\\-]*\w\.cmd\b(?:\s+[^\s&|;][^&|;]*)?)/gi,
		(_, sep, invocation) => `${sep}cmd /c ${invocation}`,
	);

	return result;
}
