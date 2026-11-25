"""Shared set-up for the browser tests: where the repository is, which browser
to use, and building the app (the working tree, or an older version from git).

Each test serves a build with `vite preview` on port 4199 and stands in for
TMDB, OMDb and TVmaze with hand-written responses, so nothing reaches a live
service.
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# The tests were written against Google Chrome: CHROME_PATH, else the usual
# Linux install, else Playwright's own Chromium (`python3 -m playwright install chromium`).
CHROME = os.environ.get("CHROME_PATH") or ("/usr/bin/google-chrome" if os.path.exists("/usr/bin/google-chrome") else None)


def build(revision=None):
    """Builds the app into a new temporary folder and returns its path.

    With a git revision, builds that version instead, from a temporary
    worktree that borrows this checkout's node_modules.
    """
    out = tempfile.mkdtemp(prefix="e2e-dist-")
    source, worktree = ROOT, None
    if revision:
        worktree = tempfile.mkdtemp(prefix="e2e-src-")
        subprocess.run(["git", "worktree", "add", "--detach", "--force", worktree, revision],
                       cwd=ROOT, check=True, capture_output=True)
        os.symlink(ROOT / "node_modules", Path(worktree) / "node_modules")
        source = Path(worktree)
    try:
        result = subprocess.run(["npx", "vite", "build", "--outDir", out, "--emptyOutDir"],
                                cwd=source, capture_output=True, text=True)
        if result.returncode != 0:
            sys.exit(f"Build failed{f' for {revision}' if revision else ''}:\n{result.stdout[-2000:]}{result.stderr[-2000:]}")
    finally:
        if worktree:
            subprocess.run(["git", "worktree", "remove", "--force", worktree], cwd=ROOT, capture_output=True)
    return out


def dist():
    """The build named as the second argument, or a fresh build of the working tree."""
    return sys.argv[2] if len(sys.argv) > 2 else build()
