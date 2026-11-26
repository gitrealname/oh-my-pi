#!/usr/bin/env python3
"""open-sdk fork — build and deploy.

Fork policy (see OPEN-SDK.md):
  main = exactly ONE commit on top of the upstream RELEASE POINT of the
  version the stock natives carry — never upstream main tip. Stock
  published natives + stock release JS always match by construction.

This script NEVER builds Rust. The exe embeds the stock published
natives (`omp update` installs them into ~/.omp/natives/<version>/`);
if the embed source is missing it is copied from that cache. A version
mismatch is a hard stop — do not "fix" it by building natives locally.

Future merge sequence (what this script automates):
    1. omp update                        # stock self-update: fresh natives + models
    2. python install-open-sdk.py
       -> git fetch upstream main
       -> rebase the ONE fork commit onto the latest upstream RELEASE commit
          (the `chore: bump version to <v>` commit on packages/natives/package.json,
          NEVER upstream main tip; pin a version with --to <version>)
       -> retire stale embedded addons, copy stock natives from the omp cache
       -> bun install --frozen-lockfile
       -> build the exe (embeds the stock addon)
       -> omp update + rotate .bak + hot-swap deploy

Usage:
    python install-open-sdk.py                  # fetch + rebase + build + deploy
    python install-open-sdk.py --skip-rebase    # local build + deploy only
    python install-open-sdk.py --to 18.16.0      # pin the target release
    python install-open-sdk.py --push-origin      # also force-push the fork
"""

import argparse
import json
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

# ---- Configuration ---------------------------------------------------------

OMP_REPO = Path(__file__).resolve().parent
BRANCH = "main"
UPSTREAM = "upstream"
UPSTREAM_BRANCH = "main"
NATIVES_PKG = OMP_REPO / "packages" / "natives" / "package.json"
NATIVES_DIR = OMP_REPO / "packages" / "natives" / "native"
DIST_PATH = OMP_REPO / "packages" / "coding-agent" / "dist" / (
    "omp.exe" if sys.platform == "win32" else "omp"
)

OMP_BIN = None  # resolved after arg parsing
TARGET_VERSION = None  # --to pin; None = latest upstream release


# -- Helpers -----------------------------------------------------------------

def run(cmd, cwd=None, check=True, capture=False):
    result = subprocess.run(
        cmd, cwd=cwd or OMP_REPO, shell=isinstance(cmd, str),
        capture_output=capture, text=True,
    )
    if check and result.returncode != 0:
        print(f"FAILED: {' '.join(cmd) if isinstance(cmd, list) else cmd}")
        if capture:
            print(f"stdout: {result.stdout}")
            print(f"stderr: {result.stderr}")
        sys.exit(1)
    return result


def git(*args, **kwargs):
    return run(["git"] + list(args), cwd=OMP_REPO, **kwargs)


def bun(*args, **kwargs):
    return run(["bun"] + list(args), cwd=OMP_REPO, **kwargs)


def detect_omp_binary():
    """Detect installed omp binary via where/which. Prefer non-.bun paths."""
    cmd = ["where", "omp.exe"] if sys.platform == "win32" else ["which", "omp"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        paths = [Path(p.strip()) for p in result.stdout.strip().splitlines() if p.strip()]
        for p in paths:
            if ".bun" not in str(p).lower():
                return p
        return paths[0] if paths else None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def natives_tag():
    """Platform tag for addon filenames (win32-x64 / linux-arm64 / ...)."""
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    return f"{sys.platform}-{arch}"


# -- Upstream release point --------------------------------------------------

def tree_version():
    """Version the tree carries (packages/natives/package.json)."""
    return json.loads(NATIVES_PKG.read_text(encoding="utf-8"))["version"]


def release_commit(version=None):
    """Upstream commit that released `version` (default: the LATEST release).

    The release point is the `chore: bump version to <v>` commit on
    `packages/natives/package.json` — never upstream main tip, which carries
    unreleased code the stock natives do not match.
    """
    log = git(
        "log", f"{UPSTREAM}/{UPSTREAM_BRANCH}", "--format=%H|%s",
        "--", "packages/natives/package.json", capture=True,
    ).stdout
    for line in log.splitlines():
        sha, sep, subject = line.partition("|")
        if not sep:
            continue
        subject = subject.strip()
        if version is not None:
            if subject == f"chore: bump version to {version}":
                return sha.strip()
        elif re.fullmatch(r"chore: bump version to \d+\.\d+\.\d+", subject):
            return sha.strip()
    wanted = f" for version {version}" if version else ""
    print(f"  [FAIL] No upstream release commit found{wanted}.")
    print("    The fork tracks RELEASED upstream versions only. Wait for the release")
    print("    (and run `omp update` first so the stock natives land in the omp cache).")
    sys.exit(1)


# -- Stock addon guard -------------------------------------------------------

def verify_stock_addon(version):
    """Ensure the exe will embed STOCK published natives for `version`.

    The embed source is packages/natives/native/pi_natives.<tag>*.node.
    Stale addons of a different version are retired (renamed aside — Windows
    locks mapped files against deletion, not rename) and the stock addons
    are copied from the omp-managed cache (~/.omp/natives/<version>/). A
    stamp mismatch after all that is a hard stop — NEVER fix it with Rust.
    """
    tag = natives_tag()
    needle = f"PI_NATIVES_VERSION_STAMP:{version}".encode()
    cache_dir = Path.home() / ".omp" / "natives" / version
    cached = sorted(cache_dir.glob(f"pi_natives.{tag}*.node")) if cache_dir.is_dir() else []
    if cached:
        for stale in sorted(NATIVES_DIR.glob(f"pi_natives.{tag}*.node")):
            if needle in stale.read_bytes():
                continue
            retired = stale.with_name(stale.name + ".stale.bak")
            shutil.move(str(stale), str(retired))
            print(f"  [OK] Retired stale addon -> {retired.name} (not version {version})")
        for src in cached:
            shutil.copy2(src, NATIVES_DIR / src.name)
            print(f"  [OK] Copied stock addon {src.name} from omp cache")
    stamped = [
        addon
        for addon in sorted(NATIVES_DIR.glob(f"pi_natives.{tag}*.node"))
        if needle in addon.read_bytes()
    ]
    if not stamped:
        print(f"  [FAIL] No stock addon for {tag} stamped {version} in {NATIVES_DIR}.")
        if not cached:
            print(f"    The omp cache {cache_dir} has none either.")
            print("    Run `omp update` first (installs stock natives), then re-run.")
        sys.exit(1)
    for addon in stamped:
        print(f"  [OK] {addon.name} = stock addon (stamp {version})")


# -- Steps -------------------------------------------------------------------

def install_deps():
    print("-> Installing dependencies...")
    bun("install", "--frozen-lockfile")


def fetch_upstream():
    print("-> Fetching upstream...")
    git("fetch", UPSTREAM, UPSTREAM_BRANCH)


def rebase_onto_release():
    """Rebase the fork commit onto the upstream RELEASE POINT (never main tip)."""
    sha = release_commit(TARGET_VERSION)
    label = f"v{TARGET_VERSION}" if TARGET_VERSION else "latest release"
    print(f"-> Rebasing {BRANCH} onto release point {sha[:10]} ({label})...")
    git("add", "--intent-to-add", ".")
    status = git("status", "--porcelain", capture=True)
    had_stash = False
    if status.stdout.strip():
        result = git("stash", capture=True)
        had_stash = "No local changes" not in result.stdout
    else:
        git("reset", check=False)
    result = git("rebase", sha, check=False, capture=True)
    if result.returncode != 0:
        git("rebase", "--abort", check=False)
        print("  [FAIL] Rebase produced conflicts. Resolve manually:")
        print(f"    cd {OMP_REPO}")
        print(f"    git rebase {sha}")
        sys.exit(1)
    if had_stash:
        pop = git("stash", "pop", check=False, capture=True)
        if pop.returncode != 0:
            print("  [FAIL] Stash pop conflicts after rebase. Changes in stash@{0}.")
            sys.exit(1)
    print("  [OK] Rebase clean")


def get_running_omp_pids():
    try:
        if sys.platform == "win32":
            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq omp.exe", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, check=False,
            )
            pids = []
            for line in result.stdout.strip().splitlines():
                if "omp.exe" in line.lower():
                    parts = [p.strip().strip('"') for p in line.split(",")]
                    if len(parts) >= 2:
                        pids.append(parts[1])
            return pids
        result = subprocess.run(["pgrep", "-f", "omp"], capture_output=True, text=True, check=False)
        return [l.strip() for l in result.stdout.strip().splitlines() if l.strip()]
    except Exception:
        return []


def _rotate_backup(backup_path):
    if not backup_path.exists():
        return
    ext = backup_path.suffix
    stem = backup_path.with_suffix("")
    n = 1
    while True:
        numbered = stem.with_suffix(f".{n}{ext}")
        if not numbered.exists():
            shutil.move(str(backup_path), str(numbered))
            print(f"  [OK] Rotated backup -> {numbered.name}")
            return
        n += 1


def deploy_binary():
    """omp update (fresh stock artifacts), then hot-swap our exe over it."""
    global OMP_BIN
    if OMP_BIN is None:
        print("  [FAIL] Could not detect omp binary (where omp / which omp). Use --omp-bin.")
        sys.exit(1)
    if not DIST_PATH.exists():
        print(f"  [FAIL] Build output not found: {DIST_PATH}")
        sys.exit(1)

    pids = get_running_omp_pids()
    if pids:
        print(f"\n  NOTE: {len(pids)} running OMP instance(s); they keep the old binary until restart.")
        for pid in pids[:10]:
            print(f"    PID {pid}")
        print("    Restart with: omp -c\n")

    backup_path = OMP_BIN.with_suffix(".exe.bak" if sys.platform == "win32" else ".bak")
    _rotate_backup(backup_path)

    print("-> Running omp update (fresh stock models.json + natives)...")
    result = subprocess.run([str(OMP_BIN), "update"], capture_output=True, text=True, check=False)
    if result.returncode == 0:
        print("  [OK] omp update complete")
    else:
        print(f"  [WARN] omp update failed (exit={result.returncode}), continuing")

    # Hot-swap: rename works on locked binaries, copy does not.
    shutil.move(str(OMP_BIN), str(backup_path))
    shutil.copy2(DIST_PATH, OMP_BIN)
    print(f"  [OK] Deployed open-sdk -> {OMP_BIN}")

    version_txt = OMP_BIN.parent / "VERSION.txt"
    commit = git("rev-parse", "--short", "HEAD", capture=True).stdout.strip()
    branch = git("rev-parse", "--abbrev-ref", "HEAD", capture=True).stdout.strip()
    from datetime import datetime
    built = datetime.now().strftime("%a %m/%d/%Y %H:%M:%S")
    version_txt.write_text(f"branch: \n{branch}\ncommit: \n{commit}\nbuilt: \n{built} \n", encoding="utf-8")
    print(f"  [OK] Wrote {version_txt.name} (branch={branch} commit={commit})")


def build_binary():
    """Compile the OMP exe (embeds the stock addon verified above)."""
    print("-> Building binary...")
    run(["bun", str(OMP_REPO / "packages" / "coding-agent" / "scripts" / "build-binary.ts")])


def push_to_origin():
    status = git("status", "--porcelain", capture=True)
    if status.stdout.strip():
        print("  [SKIP] Working tree not clean — commit before pushing")
        return
    print("-> Pushing fork to origin...")
    git("push", "origin", BRANCH, "--force-with-lease")
    print("  [OK] Pushed")


# -- Main --------------------------------------------------------------------

def main():
    global OMP_BIN
    parser = argparse.ArgumentParser(description="Build and deploy the open-sdk OMP binary (stock natives, no Rust)")
    parser.add_argument("--omp-bin", type=Path, default=None, help="Path to omp binary (auto-detected)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would happen")
    parser.add_argument("--push-origin", action="store_true", help="Force-push fork to origin after deploy")
    parser.add_argument("--skip-deploy", action="store_true", help="Skip binary deployment")
    parser.add_argument("--skip-rebase", action="store_true", help="Skip fetch + rebase (local build only)")
    parser.add_argument("--to", type=str, default=None, help="Pin the target upstream release (default: latest release commit)")
    args = parser.parse_args()

    global OMP_BIN, TARGET_VERSION
    OMP_BIN = args.omp_bin or detect_omp_binary()
    TARGET_VERSION = args.to

    print(f"OMP repo:    {OMP_REPO}")
    print(f"OMP binary:  {OMP_BIN or '(not found - use --omp-bin)'}")
    print(f"Branch:      {BRANCH}")
    print()

    if args.dry_run:
        print("DRY RUN - no changes will be made\n")

    if not args.skip_rebase:
        if not args.dry_run:
            fetch_upstream()
            rebase_onto_release()
        else:
            print(f"Would fetch {UPSTREAM}/{UPSTREAM_BRANCH} and rebase onto the latest upstream RELEASE commit (never main tip)")

    version = tree_version()
    if not args.dry_run:
        verify_stock_addon(version)
        install_deps()
        build_binary()
    else:
        print(f"Would verify stock addon v{version}, install deps, and build the exe")

    print()

    if not args.skip_deploy:
        if not args.dry_run:
            deploy_binary()
        else:
            print(f"Would deploy {DIST_PATH} -> {OMP_BIN}")

    if args.push_origin:
        if not args.dry_run:
            push_to_origin()
        else:
            print("Would push to origin")
    print("\n[OK] Done")


if __name__ == "__main__":
    main()