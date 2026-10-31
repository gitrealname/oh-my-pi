"""PTY probe for the DELIVERED omp binary (Windows, ConPTY).

Boots the TUI with a launcher-style overlay, drives real /modelpreset switch
interactions, prints the final visible screen. Usage:

  py.exe scripts/tui_switch_probe.py <omp.exe> <overlay.yml> <preset> [preset2 ...]
"""
import os
import re
import shutil
import sys
import tempfile
import time

import pyte
from winpty import PtyProcess

COLS, ROWS = 180, 50


def screen_text(screen):
    return "\n".join(screen.display[i] for i in range(ROWS))


def main():
    if len(sys.argv) < 4:
        print("usage: tui_switch_probe.py <omp.exe> <overlay.yml> <preset...>", file=sys.stderr)
        return 1

    bin_path = os.path.abspath(sys.argv[1])
    overlay = os.path.abspath(sys.argv[2])
    presets = sys.argv[3:]

    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.Stream(screen)

    tmp = tempfile.mkdtemp(prefix="omp-switch-probe-")
    env = {k: v for k, v in os.environ.items() if k != "PI_TEST_RUNTIME"}
    env["TERM"] = "xterm-256color"

    cmd = f'{bin_path} --config {overlay} --profile {os.path.basename(tmp)} --cwd {os.path.dirname(overlay)}'
    proc = PtyProcess.spawn(
        cmd,
        dimensions=(ROWS, COLS),
        cwd=os.path.dirname(overlay),
        env=env,
    )

    def pump(duration):
        end = time.time() + duration
        while time.time() < end:
            data = proc.read(4096)
            if data:
                stream.feed(data)
            else:
                time.sleep(0.05)

    def wait_for(pattern, timeout=12):
        rx = re.compile(pattern)
        end = time.time() + timeout
        while time.time() < end:
            if not proc.isalive():
                print('process died during wait_for')
                # drain remaining output
                try:
                    for _ in range(20):
                        data = proc.read(4096)
                        if not data: break
                        stream.feed(data)
                except EOFError:
                    pass
                print('=== DIED SCREEN ===')
                print(screen_text(screen))
                return False
            try:
                data = proc.read(4096)
            except EOFError:
                print('EOF during read')
                break
            if data:
                stream.feed(data)
                if rx.search(screen_text(screen)):
                    return True
            else:
                time.sleep(0.05)
        return rx.search(screen_text(screen)) is not None

    try:
        print('booting, alive =', proc.isalive())
        # Boot: wait for any status line content.
        wait_for(r"·\s*\S+\s*·|directory|no-model|GLM|Qwen|OpenRouter", timeout=20) or pump(3)
        results = {}
        for preset in presets:
            proc.write(f"/modelpreset switch {preset}")
            time.sleep(0.15)
            proc.write("\r")
            ok = wait_for(rf'Switched to preset "{preset}"|not applied|not found', timeout=12)
            results[preset] = "reported" if ok else "NO REPORT"
        pump(2.5)
        text = screen_text(screen)
        print("=== RESULTS ===")
        for preset, state in results.items():
            print(f"{preset}: {state}")
        print("=== SCREEN ===")
        print(text)
        return 0
    finally:
        try:
            proc.terminate(force=True)
        except Exception:
            pass
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
