#!/usr/bin/env python3
"""paste_clipboard - Smart clipboard paste for OMP script slots.

Priority:
  1. Image in clipboard  → resize to 1568px, write PNG
  2. Text in clipboard   → output text
  3. Empty / unsupported → exit 1

Output modes (controlled by --omp flag):
  default  : bare output (image path or text) — useful for standalone use / debugging
  --omp    : @omp: protocol lines — image becomes @omp:image:<path>,
             text becomes @omp:text:<content>

Exit codes:  0 = success,  1 = nothing in clipboard

Dependencies: Pillow (already required). ctypes and tempfile are stdlib.
"""

import os
import sys
import tempfile
from datetime import datetime

from PIL import Image, ImageGrab

MAX_DIM = 1568


def get_clipboard_text() -> str | None:
    """Read text from clipboard via Windows API (CF_UNICODETEXT).
    restype must be c_void_p — default c_int truncates pointers on 64-bit.
    """
    import ctypes
    CF_UNICODETEXT = 13
    try:
        GetClipboardData = ctypes.windll.user32.GetClipboardData
        GetClipboardData.argtypes = [ctypes.c_uint]
        GetClipboardData.restype  = ctypes.c_void_p
        GlobalLock = ctypes.windll.kernel32.GlobalLock
        GlobalLock.argtypes = [ctypes.c_void_p]
        GlobalLock.restype  = ctypes.c_void_p
        GlobalUnlock = ctypes.windll.kernel32.GlobalUnlock
        GlobalUnlock.argtypes = [ctypes.c_void_p]

        if not ctypes.windll.user32.OpenClipboard(0):
            return None
        try:
            h = GetClipboardData(CF_UNICODETEXT)
            if not h:
                return None
            ptr = GlobalLock(h)
            if not ptr:
                return None
            try:
                return ctypes.wstring_at(ptr).replace('\r\n', '\n').replace('\r', '\n').strip() or None
            finally:
                GlobalUnlock(h)
        finally:
            ctypes.windll.user32.CloseClipboard()
    except Exception:
        return None


IMAGE_FORMATS = (2, 8, 17)  # CF_BITMAP, CF_DIB, CF_DIBV5


def clipboard_has_image() -> bool:
    """Non-blocking pre-check — avoids Pillow stall when clipboard has no image."""
    import ctypes
    return any(ctypes.windll.user32.IsClipboardFormatAvailable(f) for f in IMAGE_FORMATS)


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", "-o", metavar="DIR",
                        help="Save a timestamped copy of the image to this directory")
    parser.add_argument("--omp", action="store_true",
                        help="Emit @omp: protocol lines for OMP script slot consumption")
    args = parser.parse_args()

    # ── Try image (only if a bitmap format is actually present) ────────────────
    if clipboard_has_image():
        clip = ImageGrab.grabclipboard()
        if isinstance(clip, Image.Image):
            img = clip
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")
            img.thumbnail((MAX_DIM, MAX_DIM), Image.LANCZOS)

            if args.out:
                os.makedirs(args.out, exist_ok=True)
                stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                out_path = os.path.join(args.out, f"{stamp}.png")
            else:
                if args.omp:
                    fd, out_path = tempfile.mkstemp(suffix=".png", prefix="clipboard_")
                    os.close(fd)
                else:
                    out_path = os.path.join(tempfile.gettempdir(), "clipboard_image.png")

            img.save(out_path, "PNG", optimize=True)
            path = out_path.replace("\\", "/")
            if args.omp:
                print(f"@omp:image:{path}")
            else:
                print(path)
            return

    # ── Fall back to text ──────────────────────────────────────────────────────
    text = get_clipboard_text()
    if text:
        if args.omp:
            escaped = text.replace("\\", "\\\\").replace("\n", "\\n")
            print(f"@omp:text:{escaped}")
        else:
            print(text)
        return

    print("Error: clipboard is empty or contains no image or text", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
