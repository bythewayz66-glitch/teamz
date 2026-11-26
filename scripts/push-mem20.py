#!/usr/bin/env python3
"""push-mem20.py — the governed push step for the Teamz runner.

Runs as root via sudo (teamz may run ONLY this file, NOPASSWD — see
deploy/teamz-push-mem20.sudoers). It commits and pushes ONE staged patch
to the mem20 repo on GitHub, and only when every check below passes:

  1. Exactly one patch is pending under /var/lib/teamz-runner/patches/
     (zero -> NOTHING-TO-PUSH, exit 0; more than one -> refuse).
  2. The patch itself is valid: a well-formed job id, a repo-relative
     path that stays inside /opt/mem20, and a one-line message.
     Blocked, always: .github/ and .git/ paths, requirements.txt (the
     starlette cap lives there — Jesse decides that one), anything under
     secrets/, and *.env files.
  3. The runner state shows the job sitting on its push stage
     ('upgrade') AND a live approval for that job + stage: approved,
     decidedBy 'reviewer', not yet consumed. The runner's governance
     gate is the primary enforcement; this is the on-disk re-check —
     the runner persists state before the gated command stage runs, so
     the approval is on disk by the time this script reads it.
  4. The repo is on branch main, the tree is clean, and HEAD equals
     origin/main (fetched first) — a moved remote means re-sync first.
  5. The patch applies cleanly: oldText occurs exactly once in the
     current file. The resulting diff touches exactly one file, changes
     at most 50 lines, deletes no files, and touches no blocked path.
  6. The push itself is verified: ls-remote origin main must equal the
     new HEAD after pushing.

Idempotent: if the patch's change is already the HEAD commit (same job
id in the commit message), the script reports ALREADY-PUSHED, archives
the patch, and exits 0 instead of failing the stage forever.

The patch file is treated as untrusted input throughout: it is written
by the teamz-owned endpoint, and this script runs as root. Nothing in
it reaches a shell — git is invoked by argv list only — and no secret
is ever printed. The GitHub token is root's own (gh auth / the git
credential store); it is never read, copied, or written anywhere by
this script.
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MEM20_ROOT = Path("/opt/mem20")
PATCH_DIR = Path("/var/lib/teamz-runner/patches")
APPLIED_DIR = PATCH_DIR / "applied"
STATE_PATH = Path("/var/lib/teamz-runner/state.json")
PUSH_STAGE = "upgrade"
MAX_DIFF_LINES = 50
MAX_OLD_TEXT_CHARS = 2000
MAX_NEW_TEXT_CHARS = 5000
MAX_MESSAGE_CHARS = 200
GIT_TIMEOUT_S = 60

BLOCKED_PREFIXES = (".github/", ".git/")
BLOCKED_NAMES = {"requirements.txt"}
BLOCKED_SEGMENTS = {"secrets", ".git"}
BLOCKED_SUFFIXES = (".env",)

JOB_ID_RE = re.compile(r"^job-[a-z0-9][a-z0-9-]*$")
GIT_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/root", "LC_ALL": "C"}


def out(line):
    print(line, flush=True)


def refuse(reason):
    out(f"PUSH REFUSED: {reason}")
    return 1


def git(*args):
    """Run git in the repo by argv list only — never a shell."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(MEM20_ROOT), *args],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_S,
            env=GIT_ENV,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"git {' '.join(args)} timed out after {GIT_TIMEOUT_S}s")
    return proc


def git_ok(*args):
    proc = git(*args)
    if proc.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed (exit {proc.returncode}): "
            f"{(proc.stdout + proc.stderr).strip()[:300]}"
        )
    return proc.stdout.strip()


def validate_rel_path(rel):
    """Repo-relative path, or None when malformed / escaping / blocked."""
    if not isinstance(rel, str) or not rel or "\0" in rel or "\\" in rel:
        return None
    if rel.startswith("/"):
        return None
    parts = rel.split("/")
    if any(p in ("..", "") for p in parts):
        return None
    if any(p in BLOCKED_SEGMENTS for p in parts):
        return None
    if any(rel.startswith(pre) for pre in BLOCKED_PREFIXES):
        return None
    if parts[-1] in BLOCKED_NAMES:
        return None
    if any(rel.endswith(suf) for suf in BLOCKED_SUFFIXES):
        return None
    try:
        root = MEM20_ROOT.resolve()
        target = (root / rel).resolve()
    except (OSError, RuntimeError):
        return None
    if target != root and root not in target.parents:
        return None
    return target


def load_pending_patch():
    """Exactly one pending patch, or (None, reason) when there is none."""
    if not PATCH_DIR.is_dir():
        return None, "no patches directory"
    pending = sorted(p for p in PATCH_DIR.glob("job-*.json") if p.is_file())
    if not pending:
        return None, "no staged patch"
    if len(pending) > 1:
        names = ", ".join(p.name for p in pending)
        raise RuntimeError(f"ambiguous: {len(pending)} patches pending ({names}) — refusing")
    try:
        patch = json.loads(pending[0].read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise RuntimeError(f"cannot read pending patch {pending[0].name}: {err}")
    return (pending[0], patch), None


def validate_patch(patch):
    job_id = patch.get("jobId")
    if not isinstance(job_id, str) or not JOB_ID_RE.match(job_id):
        raise RuntimeError(f"bad jobId in patch: {job_id!r}")
    rel = patch.get("file")
    target = validate_rel_path(rel)
    if target is None:
        raise RuntimeError(f"bad or blocked path in patch: {rel!r}")
    old_text = patch.get("oldText")
    new_text = patch.get("newText")
    message = patch.get("message")
    if not isinstance(old_text, str) or not old_text or len(old_text) > MAX_OLD_TEXT_CHARS:
        raise RuntimeError("bad oldText in patch (must be 1-2000 chars)")
    if not isinstance(new_text, str) or not new_text or len(new_text) > MAX_NEW_TEXT_CHARS:
        raise RuntimeError("bad newText in patch (must be 1-5000 chars)")
    if (
        not isinstance(message, str)
        or not message.strip()
        or len(message.strip()) > MAX_MESSAGE_CHARS
        or "\n" in message
    ):
        raise RuntimeError("bad message in patch (must be one line, 1-200 chars)")
    return job_id, rel, target, old_text, new_text, message.strip()


def check_approval(job_id):
    """Live Reviewer approval for (job_id, 'upgrade') on disk, plus the
    job sitting on its push stage. Returns the approval id."""
    try:
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise RuntimeError(f"cannot read runner state: {err}")
    job = next((j for j in state.get("jobs", []) if j.get("id") == job_id), None)
    if job is None:
        raise RuntimeError(f"unknown job {job_id} in runner state")
    stages = job.get("stages", [])
    idx = job.get("currentStageIndex")
    current = stages[idx].get("stage") if isinstance(idx, int) and 0 <= idx < len(stages) else None
    if current != PUSH_STAGE:
        raise RuntimeError(f"job {job_id} is not on its push stage (current: {current})")
    for approval in state.get("approvals", []):
        if (
            approval.get("jobId") == job_id
            and approval.get("stage") == PUSH_STAGE
            and approval.get("status") == "approved"
            and approval.get("decidedBy") == "reviewer"
            and approval.get("consumedAt") is None
        ):
            return approval.get("id")
    raise RuntimeError(
        f"no live Reviewer approval for job {job_id} stage '{PUSH_STAGE}' — refusing"
    )


def archive_patch(patch_path, job_id):
    APPLIED_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = APPLIED_DIR / f"{job_id}-{stamp}.json"
    patch_path.replace(dest)
    return dest


def main():
    try:
        found, no_patch = load_pending_patch()
    except RuntimeError as err:
        return refuse(str(err))
    if found is None:
        out(f"NOTHING-TO-PUSH: {no_patch}")
        return 0
    patch_path, patch = found
    try:
        job_id, rel, target, old_text, new_text, message = validate_patch(patch)
        approval_id = check_approval(job_id)

        # Repo preconditions: main, clean tree, HEAD == origin/main.
        branch = git_ok("rev-parse", "--abbrev-ref", "HEAD")
        if branch != "main":
            raise RuntimeError(f"repo is on branch {branch!r}, not 'main'")
        if git_ok("status", "--porcelain"):
            raise RuntimeError("working tree is not clean — refusing to push on top of unrelated changes")
        git_ok("fetch", "origin", "main")
        head = git_ok("rev-parse", "HEAD")
        origin_main = git_ok("rev-parse", "origin/main")
        if head != origin_main:
            raise RuntimeError(
                f"HEAD {head[:12]} != origin/main {origin_main[:12]} — remote moved, re-sync first"
            )

        current = target.read_text(encoding="utf-8")
        occurrences = current.count(old_text)
        if occurrences == 0 and new_text in current:
            # Already pushed (e.g. a previous run was killed after the
            # push but before archiving): verify HEAD is the push commit
            # and report it instead of failing the stage forever.
            last_msg = git_ok("log", "-1", "--format=%B")
            if job_id in last_msg:
                origin = git_ok("ls-remote", "origin", "main").split()[0]
                if origin == head:
                    archive_patch(patch_path, job_id)
                    out(f"ALREADY-PUSHED: {head} {rel} (job {job_id}, approval {approval_id})")
                    return 0
            raise RuntimeError(
                f"oldText not found in {rel} and the change does not match the HEAD commit — refusing"
            )
        if occurrences != 1:
            raise RuntimeError(f"oldText occurs {occurrences} times in {rel} — must occur exactly once")

        # Apply, then guard the resulting diff before anything is staged.
        target.write_text(current.replace(old_text, new_text, 1), encoding="utf-8")
        numstat = git_ok("diff", "--numstat")
        changed = [line for line in numstat.splitlines() if line.strip()]
        if len(changed) != 1:
            raise RuntimeError(f"diff touches {len(changed)} files, expected exactly 1 — refusing")
        added_s, removed_s, changed_file = changed[0].split("\t")
        if changed_file != rel:
            raise RuntimeError(f"diff touches {changed_file!r}, expected {rel!r} — refusing")
        try:
            added_n, removed_n = int(added_s), int(removed_s)
        except ValueError:
            raise RuntimeError(f"diff is not a text diff ({changed[0]!r}) — refusing")
        if added_n + removed_n > MAX_DIFF_LINES:
            raise RuntimeError(
                f"diff changes {added_n + removed_n} lines, cap is {MAX_DIFF_LINES} — refusing"
            )
        if git_ok("diff", "--diff-filter=D", "--name-only"):
            raise RuntimeError("diff deletes a file — refusing")
        if validate_rel_path(changed_file) is None:
            raise RuntimeError(f"diff touches blocked path {changed_file!r} — refusing")

        # Commit (repo identity when set, else a clearly-marked runner
        # identity) and push, then verify the remote actually moved.
        name = git("config", "user.name").stdout.strip()
        email = git("config", "user.email").stdout.strip()
        full_message = (
            f"{message}\n\n"
            f"Pushed via the Teamz governed push path "
            f"(Reviewer approval {approval_id}, job {job_id})."
        )
        git_ok("add", "--", rel)
        git_ok(
            "-c",
            f"user.name={name or 'Teamz Runner'}",
            "-c",
            f"user.email={email or 'teamz@mem20.com'}",
            "commit",
            "-m",
            full_message,
        )
        new_head = git_ok("rev-parse", "HEAD")
        git_ok("push", "origin", "main")
        remote = git_ok("ls-remote", "origin", "main").split()[0]
        if remote != new_head:
            raise RuntimeError(
                f"push verification failed: origin/main is {remote[:12]}, expected {new_head[:12]}"
            )
        archive_patch(patch_path, job_id)
        out(
            f"PUSHED {new_head} {rel} +{added_s}/-{removed_s} "
            f"origin/main={remote} approval={approval_id} job={job_id}"
        )
        return 0
    except RuntimeError as err:
        # A half-applied patch must never linger in the tree: restore it
        # so the next run (or a human) sees a clean repo.
        try:
            if git("status", "--porcelain").stdout.strip():
                git("checkout", "--", ".")
        except Exception:
            pass
        return refuse(str(err))
    except OSError as err:
        return refuse(f"filesystem error: {err}")


if __name__ == "__main__":
    sys.exit(main())
