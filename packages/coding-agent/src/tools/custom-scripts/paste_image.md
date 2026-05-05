# paste_image.py

Clipboard paste utility for OMP script slots. Reads the Windows clipboard and outputs via the `@omp:` protocol.

## Usage

```bash
python paste_image.py [--omp] [--out <dir>]
```

| Flag | Description |
|---|---|
| `--omp` | Emit `@omp:` protocol lines for OMP script slot consumption (required for OMP use) |
| `--out <dir>` | Save a timestamped copy of the image to `<dir>` in addition to temp file |

## Output

### With `--omp` (OMP script slot mode)

| Clipboard | Output |
|---|---|
| Image | `@omp:image:C:/…/clipboard_image.png` |
| Text | `@omp:text:<content with \n escaped>` |
| Empty | exit 1 |

### Without `--omp` (standalone / debug mode)

| Clipboard | Output |
|---|---|
| Image | `C:/…/clipboard_image.png` (bare path) |
| Text | raw text to stdout |
| Empty | exit 1 |

## OMP configuration

`config.yml`:
```yaml
scripts:
  1:
    command: "python D:/.ai/scripts/paste_image.py --omp"
    description: Paste image or text from clipboard
```

`keybindings.json` (same dir as config.yml):
```json
{ "app.script.1": "ctrl+alt+v" }
```

## Image processing

- Long edge capped at **1568 px** with Lanczos resampling. Never upscales.
- Saved as lossless PNG (`optimize=True`) to `%TEMP%\clipboard_image.png` (or `--out <dir>/YYYYMMDD_HHMMSS.png`).
- Exotic colour modes normalised to RGB; RGBA preserved.

## Requirements

- Windows
- Python 3.9+
- Pillow: `pip install pillow`
