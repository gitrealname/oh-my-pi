# Custom Scripts

OMP supports up to 10 configurable script executor slots (`app.script.1` – `app.script.10`). Each slot runs a command when a bound key is pressed and routes the output according to the `@omp:` protocol.

## Output protocol

Scripts communicate structured output to OMP via lines prefixed with `@omp:`. Any line **not** starting with `@omp:` is treated as bare stdout.

| Output line | Result |
|---|---|
| `@omp:image:<path>` | Load `<path>` as pending image → `[Image #N]` placeholder at cursor |
| `@omp:text:<content>` | Insert `<content>` into the prompt editor at cursor |
| `@omp:!!:<content>` | Display in chat with dim border — visible to user, **excluded from LLM context** (same as `!!` bash) |
| bare text (no `@omp:` prefix) | Submit as user message — **LLM-visible** (like tool stdout) |

A single script run may emit multiple `@omp:` directives in any order. Bare-text lines are collected, joined, and submitted as one user message after all directives are processed.

Scripts that produce no output at all (empty stdout, exit 0) show a transient status: `Script N: no output`.

Non-zero exit code throws an error shown in the status bar: `Script N failed: <stderr>`.

## Command dispatch

| Prefix | Dispatch |
|---|---|
| `py: <code>` | Inline Python via the existing IPython kernel (stateful, fast after warm-up) |
| `js: <code>` | Inline JS via `bun --eval` (subprocess, stateless) |
| *(anything else)* | Direct spawn — command split on whitespace. Use `py:`/`js:` for paths with spaces. |

## Configuration

In your `config.yml`:

```yaml
scripts:
  1:
    command: "python D:/.ai/scripts/paste_image.py --omp"
    description: Paste image or text from clipboard
  2:
    command: "py: import datetime; print(f'@omp:text:{datetime.date.today()}')"
    description: Insert today's date
  3:
    command: "js: console.log(`@omp:text:${new Date().toISOString()}`)"
    description: Insert ISO timestamp
```

```json
// keybindings.json  (same directory as config.yml)
{
  "app.script.1": "ctrl+alt+v",
  "app.script.2": "ctrl+alt+d",
  "app.script.3": "ctrl+alt+t"
}
```

## Bundled scripts

Scripts in `src/tools/custom-scripts/` ship with the repo.

### `paste_image.py` — Clipboard paste (Windows)

Reads the Windows clipboard and outputs image or text via the `@omp:` protocol.

**Requirements:** Windows, Python 3.9+, Pillow (`pip install pillow`)

**Flags:**

| Flag | Description |
|---|---|
| `--omp` | Emit `@omp:` protocol lines (required for OMP script slot use) |
| `--out <dir>` | Save a timestamped copy of the image to `<dir>` in addition to the temp file |

**Without `--omp`** (bare output): image path printed to stdout, text printed to stdout. Useful for standalone testing outside OMP.

**Setup:**

1. Copy `paste_image.py` to a convenient location (e.g. `D:/.ai/scripts/`).
2. Configure:

```yaml
scripts:
  1:
    command: "python D:/.ai/scripts/paste_image.py --omp"
    description: Paste image or text from clipboard
```

```json
// keybindings.json
{ "app.script.1": "ctrl+alt+v" }
```

3. Copy an image to the clipboard (e.g. Win+Shift+S), then press `Ctrl+Alt+V` in the OMP editor.

**Text paste behavior with `--omp`:**  
Multi-line text is emitted as a single `@omp:text:` line with newlines escaped as `\n`. OMP unescapes before inserting, preserving line breaks.

**Standalone test:**
```bash
# With image in clipboard:
python paste_image.py --omp
# → @omp:image:C:/Users/…/clipboard_image.png

# With text in clipboard:
python paste_image.py --omp
# → @omp:text:first line\nsecond line

# Without --omp (bare, for debugging):
python paste_image.py
# → C:/Users/…/clipboard_image.png   (or raw text)
```
