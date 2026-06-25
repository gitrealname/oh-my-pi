#!/usr/bin/env python3
"""
install-open-sdk.py - Fetch upstream OMP, rebase open-sdk, build, deploy.

Place this script at the OMP repo root on the open-sdk branch.

Usage:
    python install-open-sdk.py                          # rebase + rebuild
    python install-open-sdk.py --omp-bin /path/to/omp   # specify omp binary
    python install-open-sdk.py --skip-rebase            # local rebuild only
    python install-open-sdk.py --dry-run                # show what would happen

Prerequisites:
    - bun installed and on PATH
    - omp binary on PATH (or specify with --omp-bin)

Flags:
    --skip-natives       Skip Rust native compilation
    --skip-rebase        Skip fetch + rebase (local rebuild only)
    --skip-deploy        Build but don't replace installed binary
    --push-origin        Push to origin after deploy
    --dry-run            Show what would happen without doing it
"""
import argparse
import subprocess
import shutil
import sys
import os
from pathlib import Path

# ---- Configuration -------------------------------------------------------

# Script lives at the OMP repo root - repo root is this script's directory.
OMP_REPO = Path(__file__).resolve().parent
BRANCH = "main"
UPSTREAM = "upstream"
UPSTREAM_BRANCH = "main"
DIST_PATH = OMP_REPO / "packages" / "coding-agent" / "dist" / ("omp.exe" if sys.platform == "win32" else "omp")

# Cargo.lock path - changes here indicate native rebuild needed
CARGO_LOCK = OMP_REPO / "Cargo.lock"
CARGO_LOCK_SNAPSHOT = OMP_REPO / ".open-sdk-cargo-lock"

def detect_omp_binary():
    """Detect installed omp binary via where/which. Prefer AppData over .bun/bin."""
    cmd = ["where", "omp.exe"] if sys.platform == "win32" else ["which", "omp"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        paths = [Path(p.strip()) for p in result.stdout.strip().splitlines() if p.strip()]
        # Prefer AppData/Local path over .bun/bin
        for p in paths:
            if ".bun" not in str(p).lower():
                return p
        return paths[0] if paths else None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


OMP_BIN = None  # resolved after arg parsing in main()


# -- Helpers -------------------------------------------------------------------

def run(cmd, cwd=None, check=True, capture=False):
    """Run a command, optionally capturing output."""
    result = subprocess.run(
        cmd, cwd=cwd or OMP_REPO, shell=isinstance(cmd, str),
        capture_output=capture, text=True
    )
    if check and result.returncode != 0:
        print(f"FAILED: {' '.join(cmd) if isinstance(cmd, list) else cmd}")
        if capture:
            print(f"stdout: {result.stdout}")
            print(f"stderr: {result.stderr}")
        sys.exit(1)
    return result


def git(*args, **kwargs):
    """Run a git command in the OMP repo."""
    return run(["git"] + list(args), cwd=OMP_REPO, **kwargs)


def bun(*args, **kwargs):
    """Run a bun command in the OMP repo."""
    return run(["bun"] + list(args), cwd=OMP_REPO, **kwargs)


def get_running_omp_pids():
    """Return list of running OMP process IDs."""
    try:
        if sys.platform == "win32":
            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq omp.exe", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, check=False
            )
            pids = []
            for line in result.stdout.strip().splitlines():
                if "omp.exe" in line.lower():
                    parts = [p.strip().strip('"') for p in line.split(",")]
                    if len(parts) >= 2:
                        pids.append(parts[1])
            return pids
        else:
            result = subprocess.run(
                ["pgrep", "-f", "omp"],
                capture_output=True, text=True, check=False
            )
            return [l.strip() for l in result.stdout.strip().splitlines() if l.strip()]
    except Exception:
        return []


def print_running_omp_warning(pids):
    """Print running OMP instances and suggest restart."""
    if not pids:
        return
    print(f"\n  NOTE: {len(pids)} running OMP instance(s) using old binary:")
    for pid in pids[:10]:
        print(f"    PID {pid}")
    if len(pids) > 10:
        print(f"    ... and {len(pids) - 10} more")
    print(f"\n  Running instances will continue with the old binary.")
    print(f"  Restart with: omp -c")
    print()

def needs_native_rebuild():
    """Check if Cargo.lock changed since last build - indicates native deps changed."""
    if not CARGO_LOCK.exists():
        return True
    if not CARGO_LOCK_SNAPSHOT.exists():
        return True
    current = CARGO_LOCK.read_text()
    snapshot = CARGO_LOCK_SNAPSHOT.read_text()
    return current != snapshot


def save_cargo_lock_snapshot():
    """Save current Cargo.lock state for future comparison."""
    if CARGO_LOCK.exists():
        shutil.copy2(CARGO_LOCK, CARGO_LOCK_SNAPSHOT)


def install_deps():
    """Install JS dependencies."""
    print("-> Installing dependencies...")
    bun("install", "--frozen-lockfile")

# -- Steps ---------------------------------------------------------------------

def fetch_upstream():
    """Fetch latest from upstream main."""
    print("-> Fetching upstream...")
    git("fetch", UPSTREAM, UPSTREAM_BRANCH)


def rebase_open_sdk():
    """Rebase open-sdk onto latest upstream main."""
    print(f"-> Rebasing {BRANCH} onto {UPSTREAM}/{UPSTREAM_BRANCH}...")
    # Check if there are local changes worth stashing
    git("add", "--intent-to-add", ".")  # track untracked for stash
    status = git("status", "--porcelain", capture=True)
    had_stash = False
    if status.stdout.strip():
        result = git("stash", capture=True)
        had_stash = "No local changes" not in result.stdout
    else:
        git("reset", check=False)  # undo intent-to-add
    # Rebase
    result = git("rebase", f"{UPSTREAM}/{UPSTREAM_BRANCH}", check=False, capture=True)
    if result.returncode != 0:
        # Rebase produced conflicts — leave them for user to resolve
        # Abort the rebase to leave repo in a clean state
        git("rebase", "--abort", check=False)
        print(f"  [FAIL] Rebase produced merge conflicts in:")
        for line in result.stdout.splitlines():
            if "CONFLICT" in line:
                print(f"    {line.strip()}")
        print(f"  Resolve manually:")
        print(f"    cd {OMP_REPO}")
        print(f"    git rebase {UPSTREAM}/{UPSTREAM_BRANCH}")
        sys.exit(1)
    # Pop stash only if we actually created one
    if had_stash:
        pop = git("stash", "pop", check=False, capture=True)
        if pop.returncode != 0:
            # Stash pop had conflicts — abort and report
            # The rebase succeeded; user needs to re-apply stash manually
            print(f"  [FAIL] Stash pop produced conflicts after rebase.")
            print(f"  Your changes are preserved in stash@{{0}}. Resolve manually:")
            print(f"    cd {OMP_REPO}")
            print(f"    git stash pop")
            sys.exit(1)
    print("  [OK] Rebase clean")


def build_natives():
    """Compile Rust native bindings (only when Cargo.lock changed)."""
    print("-> Building native bindings (Rust compilation)...")
    bun("--cwd=packages/natives", "run", "build")


def build_binary():
    """Compile the OMP binary using the existing build script."""
    print("-> Building binary...")
    run(["bun", str(OMP_REPO / "packages" / "coding-agent" / "scripts" / "build-binary.ts")])


def deploy_binary():
    """Copy built binary and VERSION.txt to the detected omp location."""
    if OMP_BIN is None:
        print("  [FAIL] Could not detect omp binary location (where omp / which omp failed)")
def _rotate_backup(backup_path):
    """Rename existing .bak to .1.bak, .2.bak, etc. to preserve previous backups."""
    if not backup_path.exists():
        return
    ext = backup_path.suffix  # .bak or .exe.bak
    stem = backup_path.with_suffix("")  # remove .bak
    # Find next available number
    n = 1
    while True:
        numbered = stem.with_suffix(f".{n}{ext}")
        if not numbered.exists():
            shutil.move(str(backup_path), str(numbered))
            print(f"  [OK] Rotated backup -> {numbered.name}")
            return
        n += 1


def deploy_binary():
    """Hot-swap deploy: omp update (fresh models) then overlay our binary."""
    if OMP_BIN is None:
        print("  [FAIL] Could not detect omp binary location (where omp / which omp failed)")
        print("    Use --omp-bin to specify")
        sys.exit(1)
    if not DIST_PATH.exists():
        print(f"  [FAIL] Build output not found: {DIST_PATH}")
        sys.exit(1)

    bak_ext = ".exe.bak" if sys.platform == "win32" else ".bak"
    backup_path = OMP_BIN.with_suffix(bak_ext)

    # 1. Detect running instances and warn (no waiting — hot-swap)
    pids = get_running_omp_pids()
    print_running_omp_warning(pids)

    # 2. Rotate existing .bak to .1.bak, .2.bak, etc.
    _rotate_backup(backup_path)

    # 3. Run omp update (gets fresh official binary with latest models.json)
    print("-> Running omp update (fresh models.json)...")
    result = subprocess.run(
        [str(OMP_BIN), "update"],
        capture_output=True, text=True, check=False
    )
    if result.returncode == 0:
        print("  [OK] omp update complete")
    else:
        print(f"  [WARN] omp update failed (exit={result.returncode}), continuing with deploy")
        if result.stderr.strip():
            print(f"         {result.stderr.strip()[:200]}")

    # 4. Hot-swap: rename locked binary out of the way, copy new one in
    #    On Windows, rename works on locked files but copy2 does not
    _rotate_backup(backup_path)
    shutil.move(str(OMP_BIN), str(backup_path))
    shutil.copy2(DIST_PATH, OMP_BIN)
    print(f"  [OK] Deployed open-sdk -> {OMP_BIN.name}")

    # 5. Generate and copy VERSION.txt
    version_txt = OMP_BIN.parent / "VERSION.txt"
    commit = git("rev-parse", "--short", "HEAD", capture=True).stdout.strip()
    branch = git("rev-parse", "--abbrev-ref", "HEAD", capture=True).stdout.strip()
    from datetime import datetime
    built = datetime.now().strftime("%a %m/%d/%Y %H:%M:%S")
    version_txt.write_text(f"branch: \n{branch}\ncommit: \n{commit}\nbuilt: {built} \n", encoding="utf-8")
    print(f"  [OK] Wrote {version_txt.name} (branch={branch} commit={commit})")
# -- Main ----------------------------------------------------------------------

def push_to_origin():
    """Push to origin only if working tree is clean."""
    status = git("status", "--porcelain", capture=True)
    if status.stdout.strip():
        print("  [SKIP] Working tree not clean — commit or stash changes before pushing")
        print(f"    {status.stdout.strip()[:200]}")
        return
    print("-> Pushing to origin...")
    git("push", "origin", BRANCH, "--force-with-lease")
    print("  [OK] Pushed to origin")
def main():
    global OMP_BIN
    parser = argparse.ArgumentParser(description="Build and deploy open-sdk OMP binary")
    parser.add_argument("--omp-bin", type=Path, default=None, help="Path to omp binary (auto-detected if not provided)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would happen without doing it")
    parser.add_argument("--push-origin", action="store_true", help="Push to origin after deploy")
    parser.add_argument("--skip-deploy", action="store_true", help="Skip binary deployment")
    parser.add_argument("--skip-natives", action="store_true", help="Skip Rust native compilation (use when Cargo.lock unchanged)")
    parser.add_argument("--skip-rebase", action="store_true", help="Skip fetch + rebase (local rebuild only)")
    args = parser.parse_args()

    OMP_BIN = args.omp_bin or detect_omp_binary()

    print(f"OMP repo:    {OMP_REPO}")
    print(f"OMP binary:  {OMP_BIN or '(not found - use --omp-bin to specify)'}")
    print(f"Branch:      {BRANCH}")
    print()

    if args.dry_run:
        print("DRY RUN - no changes will be made")
        print()

    if not args.dry_run:
        if not args.skip_rebase:
            fetch_upstream()
            rebase_open_sdk()
        # Check if rebase changed anything - if not, no rebuild needed
        result = git("diff", f"{UPSTREAM}/{UPSTREAM_BRANCH}", "HEAD", check=False, capture=True)
        up_to_date = result.returncode == 0 and not result.stdout.strip()
    else:
        print(f"Would fetch {UPSTREAM}/{UPSTREAM_BRANCH} and rebase {BRANCH}")
        up_to_date = False
    print()
    if up_to_date and not args.skip_deploy:
        print("-> open-sdk is already up to date with upstream - no changes to build or deploy.")
        if args.push_origin and not args.dry_run:
            push_to_origin()
        elif args.dry_run and args.push_origin:
            print("Would push to origin")
        print()
        return
    need_rust_build = needs_native_rebuild()
    if not need_rust_build:
        print("-> Cargo.lock unchanged, skipping Rust compilation")
    if args.skip_natives:
        need_rust_build = False
        print("-> Skipping Rust compilation (--skip-natives)")

    if need_rust_build and not args.dry_run:
        build_natives()
    elif args.dry_run and need_rust_build:
        print("Would compile Rust natives")

    # Install JS dependencies (needed for build)
    if not args.dry_run:
        install_deps()
    else:
        print("Would install dependencies (bun install --frozen-lockfile)")

    if not args.dry_run:
        build_binary()
    else:
        print("Would build binary (embed + compile + reset via build-binary.ts)")
    print()

    if not args.skip_deploy:
        if not args.dry_run:
            deploy_binary()
            save_cargo_lock_snapshot()
        else:
            print(f"Would deploy {DIST_PATH} -> {OMP_BIN}")
    print()


    if args.push_origin and not args.dry_run:
        push_to_origin()
    elif args.dry_run and args.push_origin:
        print("Would push to origin")
    print("[OK] Done")
if __name__ == "__main__":
    main()
