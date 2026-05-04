import { describe, expect, it } from "bun:test";
import { normalizeCommandForWindows } from "../../src/exec/bash-win-normalize";

// ─────────────────────────────────────────────────────────────────────────────
// normalizeCommandForWindows
//
// Three transforms applied in order on Windows only:
//   1. /dev/null  → NUL
//   2. Backslashes → forward slashes  (except inside single-quoted strings
//      and except explicit double-backslash \\)
//   3. Bare *.cmd invocations → cmd /c <invocation>
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeCommandForWindows", () => {
	// ── 1. /dev/null ──────────────────────────────────────────────────────────

	describe("/dev/null → NUL", () => {
		it("replaces stdout redirect", () => {
			expect(normalizeCommandForWindows("cat foo > /dev/null")).toBe("cat foo > NUL");
		});
		it("replaces stderr redirect 2>/dev/null", () => {
			expect(normalizeCommandForWindows("cmd 2>/dev/null")).toBe("cmd 2>NUL");
		});
		it("replaces stderr redirect with spaces", () => {
			expect(normalizeCommandForWindows("cmd 2> /dev/null")).toBe("cmd 2> NUL");
		});
		it("replaces multiple redirects in one command", () => {
			expect(normalizeCommandForWindows("cmd > /dev/null 2>/dev/null")).toBe("cmd > NUL 2>NUL");
		});
		it("does not touch /dev/null inside single-quoted string", () => {
			// Single-quoted: kept verbatim (it's a pattern/string arg, not a redirect)
			expect(normalizeCommandForWindows("grep '/dev/null' file")).toBe("grep '/dev/null' file");
		});
	});

	// ── 2. Backslash normalization ────────────────────────────────────────────

	describe("backslash → forward slash", () => {
		it("normalizes simple relative path in cd", () => {
			expect(normalizeCommandForWindows("cd research\\omp && ls")).toBe("cd research/omp && ls");
		});
		it("normalizes absolute Windows drive path", () => {
			expect(normalizeCommandForWindows("cd D:\\Users\\foo && pwd")).toBe("cd D:/Users/foo && pwd");
		});
		it("normalizes deep path", () => {
			expect(normalizeCommandForWindows("cat a\\b\\c\\d.txt")).toBe("cat a/b/c/d.txt");
		});
		it("normalizes path argument to script", () => {
			expect(normalizeCommandForWindows("python script.py D:\\data\\file.csv")).toBe(
				"python script.py D:/data/file.csv",
			);
		});
		it("leaves already-forward-slashed paths unchanged", () => {
			expect(normalizeCommandForWindows("cat src/foo/bar.ts")).toBe("cat src/foo/bar.ts");
		});
		it("leaves commands with no backslashes unchanged", () => {
			expect(normalizeCommandForWindows("git status")).toBe("git status");
		});

		// ── single-quoted strings: pattern args preserved ──────────────────────

		it("preserves \\w inside single-quoted grep pattern", () => {
			expect(normalizeCommandForWindows("grep '\\w+' src\\foo.ts")).toBe("grep '\\w+' src/foo.ts");
		});
		it("preserves \\n inside single-quoted sed pattern, normalizes file path", () => {
			expect(normalizeCommandForWindows("sed 's/\\n/ /g' file\\path.txt")).toBe(
				"sed 's/\\n/ /g' file/path.txt",
			);
		});
		it("preserves backslash escapes inside single-quoted python -c script", () => {
			// The python script is single-quoted; \\d, \\n etc. must survive.
			expect(
				normalizeCommandForWindows("python -c 'import re; re.sub(r\"\\d+\", \"x\", s)'"),
			).toBe("python -c 'import re; re.sub(r\"\\d+\", \"x\", s)'");
		});
		it("preserves path inside single-quoted open() call, normalizes outer path", () => {
			// Script in single quotes → preserved. Outer file path → normalized.
			expect(
				normalizeCommandForWindows("python -c 'open(\"data\\file.txt\")' data\\file.txt"),
			).toBe("python -c 'open(\"data\\file.txt\")' data/file.txt");
		});
		it("handles multiple disjoint single-quoted regions", () => {
			expect(normalizeCommandForWindows("sed 's/\\n/\\t/g' path\\a && sed 's/\\r/\\n/g' path\\b")).toBe(
				"sed 's/\\n/\\t/g' path/a && sed 's/\\r/\\n/g' path/b",
			);
		});
		it("handles unclosed single quote gracefully (treats rest as quoted)", () => {
			// Unclosed quote → rest is treated as quoted → preserved verbatim
			expect(normalizeCommandForWindows("echo 'hello\\world")).toBe("echo 'hello\\world");
		});

		// ── double-backslash: preserved ────────────────────────────────────────

		it("preserves explicit double-backslash", () => {
			expect(normalizeCommandForWindows("echo 'a\\\\b'")).toBe("echo 'a\\\\b'");
		});
		it("preserves double-backslash in unquoted context", () => {
			// \\\\ in source = two backslashes; both preserved as \\
			expect(normalizeCommandForWindows("echo a\\\\b")).toBe("echo a\\\\b");
		});

		// ── known limitation: double-quoted strings ────────────────────────────
		// Backslashes inside "..." ARE normalised (we only protect '...').
		// In practice, grep/sed/python patterns should use single quotes.

		it("KNOWN: normalizes backslash inside double-quoted string", () => {
			// "D:\path" in double quotes → "D:/path" — correct for path args
			expect(normalizeCommandForWindows('echo "D:\\path"')).toBe('echo "D:/path"');
		});
		it("KNOWN: normalizes \\w inside double-quoted grep pattern", () => {
			// Double-quoted patterns are unusual; single quotes should be used instead
			expect(normalizeCommandForWindows('grep "\\w+" file')).toBe('grep "/w+" file');
		});
	});

	// ── 3. .cmd auto-prefix ───────────────────────────────────────────────────

	describe(".cmd → cmd /c", () => {
		it("prefixes bare .cmd at start of command", () => {
			expect(normalizeCommandForWindows("bundle.cmd")).toBe("cmd /c bundle.cmd");
		});
		it("prefixes .cmd with arguments", () => {
			expect(normalizeCommandForWindows("foo.cmd --arg val")).toBe("cmd /c foo.cmd --arg val");
		});
		it("prefixes .cmd after && with spaces", () => {
			expect(normalizeCommandForWindows("cd src && build.cmd")).toBe("cd src && cmd /c build.cmd");
		});
		it("prefixes .cmd after || ", () => {
			expect(normalizeCommandForWindows("build.cmd || fallback.cmd")).toBe(
				"cmd /c build.cmd || cmd /c fallback.cmd",
			);
		});
		it("prefixes .cmd after semicolon", () => {
			expect(normalizeCommandForWindows("setup.cmd; run.cmd")).toBe(
				"cmd /c setup.cmd; cmd /c run.cmd",
			);
		});
		it("prefixes each .cmd in multi-operator chain", () => {
			expect(normalizeCommandForWindows("build.cmd && test.cmd && deploy.cmd")).toBe(
				"cmd /c build.cmd && cmd /c test.cmd && cmd /c deploy.cmd",
			);
		});
		it("prefixes .cmd with no space before &&", () => {
			expect(normalizeCommandForWindows("build.cmd&&deploy.cmd")).toBe(
				"cmd /c build.cmd&&cmd /c deploy.cmd",
			);
		});
		it("prefixes .cmd with subpath", () => {
			expect(normalizeCommandForWindows("scripts/build.cmd")).toBe("cmd /c scripts/build.cmd");
		});
		it("prefixes .cmd after backslash path normalization", () => {
			// Backslash is normalized first, then .cmd is wrapped
			expect(normalizeCommandForWindows("cd research\\omp && bundle.cmd")).toBe(
				"cd research/omp && cmd /c bundle.cmd",
			);
		});
		it("prefixes .CMD (case-insensitive)", () => {
			expect(normalizeCommandForWindows("BUILD.CMD")).toBe("cmd /c BUILD.CMD");
		});
		it("does not double-wrap already-prefixed cmd /c", () => {
			expect(normalizeCommandForWindows("cmd /c bundle.cmd")).toBe("cmd /c bundle.cmd");
		});
		it("does not double-wrap already-prefixed cmd /C (uppercase)", () => {
			expect(normalizeCommandForWindows("cmd /C bundle.cmd")).toBe("cmd /C bundle.cmd");
		});
		it("does not wrap .cmd inside single-quoted string", () => {
			// 'bundle.cmd' is a string argument, not an invocation
			expect(normalizeCommandForWindows("echo 'bundle.cmd'")).toBe("echo 'bundle.cmd'");
		});
		it("does not wrap .cmd after pipe (piping to .cmd makes no sense)", () => {
			expect(normalizeCommandForWindows("cat file | bundle.cmd")).toBe("cat file | bundle.cmd");
		});
	});

	// ── 4. Combined transforms ────────────────────────────────────────────────

	describe("combined transforms", () => {
		it("normalizes path + wraps .cmd + replaces /dev/null", () => {
			expect(normalizeCommandForWindows("cd src\\app && build.cmd > /dev/null")).toBe(
				"cd src/app && cmd /c build.cmd > NUL",
			);
		});
		it("grep with single-quoted pattern, backslash path, stderr redirect", () => {
			expect(normalizeCommandForWindows("grep '\\w+' src\\main.ts 2>/dev/null")).toBe(
				"grep '\\w+' src/main.ts 2>NUL",
			);
		});
		it("python with single-quoted script and Windows file arg", () => {
			expect(
				normalizeCommandForWindows(
					"python -c 'import sys; sys.exit(0 if open(\"f\") else 1)' && run.cmd D:\\data\\input.csv",
				),
			).toBe(
				"python -c 'import sys; sys.exit(0 if open(\"f\") else 1)' && cmd /c run.cmd D:/data/input.csv",
			);
		});
		it("mixed &&/|| chain with paths and .cmd", () => {
			expect(
				normalizeCommandForWindows("cd D:\\project && build.cmd || cd D:\\backup && build.cmd"),
			).toBe("cd D:/project && cmd /c build.cmd || cd D:/backup && cmd /c build.cmd");
		});
	});

	// ── 5. No-op cases ────────────────────────────────────────────────────────

	describe("no-op on already-clean input", () => {
		it("leaves POSIX-style commands unchanged", () => {
			expect(normalizeCommandForWindows("ls -la src/tools | grep '.ts'")).toBe(
				"ls -la src/tools | grep '.ts'",
			);
		});
		it("leaves git commands unchanged", () => {
			expect(normalizeCommandForWindows("git commit -m 'fix: correct path handling'")).toBe(
				"git commit -m 'fix: correct path handling'",
			);
		});
		it("leaves empty string unchanged", () => {
			expect(normalizeCommandForWindows("")).toBe("");
		});
	});
});
