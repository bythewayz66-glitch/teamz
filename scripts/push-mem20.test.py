#!/usr/bin/env python3
"""Tests for scripts/push-mem20.py — the governed batch push.

Runs the REAL script against throwaway directories: a local bare repo
stands in for the mem20 origin, so no real push ever happens. The
script's hardcoded paths (MEM20_ROOT / PATCH_DIR / STATE_PATH) are
monkeypatched to temp dirs before main() runs.

Usage: python3 scripts/push-mem20.test.py
Exit 0 = all pass; any failed assertion exits non-zero.
"""
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("push_mem20", HERE / "push-mem20.py")
push = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(push)


def sh(*args, cwd):
    subprocess.run(args, cwd=str(cwd), check=True, capture_output=True, text=True)


def make_repo(root: Path):
    """Bare origin + a work clone with 3 committable files on main."""
    origin = root / "origin.git"
    work = root / "work"
    sh("git", "init", "--bare", str(origin), cwd=root)
    sh("git", "clone", str(origin), str(work), cwd=root)
    sh("git", "config", "user.name", "Test Runner", cwd=work)
    sh("git", "config", "user.email", "test@example.com", cwd=work)
    sh("git", "checkout", "-b", "main", cwd=work)
    (work / "a.md").write_text("alpha line one\n", encoding="utf-8")
    (work / "b.md").write_text("beta line one\n", encoding="utf-8")
    (work / "c.md").write_text("dup line\ndup line\n", encoding="utf-8")
    sh("git", "add", ".", cwd=work)
    sh("git", "commit", "-m", "seed", cwd=work)
    sh("git", "push", "origin", "main", cwd=work)
    return origin, work


def state_with_jobs(job_ids, approved=True):
    jobs = []
    approvals = []
    for jid in job_ids:
        jobs.append({
            "id": jid,
            "stages": [{"stage": "design"}, {"stage": "upgrade"}, {"stage": "document"}],
            "currentStageIndex": 1,
        })
        if approved:
            approvals.append({
                "id": f"appr-{jid}",
                "jobId": jid,
                "stage": "upgrade",
                "status": "approved",
                "decidedBy": "reviewer",
                "consumedAt": None,
            })
    return {"jobs": jobs, "approvals": approvals}


def patch_for(job_id, filename, old, new):
    return {
        "jobId": job_id,
        "file": filename,
        "oldText": old,
        "newText": new,
        "message": f"test: {job_id} updates {filename}",
    }


def run_main():
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = push.main()
    return code, buf.getvalue()


def origin_commit_count(origin: Path):
    out = subprocess.run(
        ["git", "--git-dir", str(origin), "rev-list", "--count", "main"],
        check=True, capture_output=True, text=True,
    )
    return int(out.stdout.strip())


def setup(tmp: Path, patches, state):
    origin, work = make_repo(tmp)
    patch_dir = tmp / "patches"
    patch_dir.mkdir()
    for name, data in patches:
        (patch_dir / name).write_text(json.dumps(data), encoding="utf-8")
    state_path = tmp / "state.json"
    state_path.write_text(json.dumps(state), encoding="utf-8")
    push.MEM20_ROOT = work
    push.PATCH_DIR = patch_dir
    push.APPLIED_DIR = patch_dir / "applied"
    push.STATE_PATH = state_path
    return origin, work, patch_dir


def test_batch_pushes_two_approved_patches():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        patches = [
            ("job-alpha.json", patch_for("job-alpha", "a.md", "alpha line one\n", "alpha line TWO\n")),
            ("job-beta.json", patch_for("job-beta", "b.md", "beta line one\n", "beta line TWO\n")),
        ]
        origin, work, patch_dir = setup(tmp, patches, state_with_jobs(["job-alpha", "job-beta"]))
        code, output = run_main()
        assert code == 0, f"expected exit 0, got {code}: {output}"
        assert output.count("PUSHED") == 2, output
        assert "BATCH DONE: pushed 2 patch(es), skipped 0 not-ready" in output, output
        assert origin_commit_count(origin) == 3, "origin should have seed + 2 pushes"
        assert (work / "a.md").read_text() == "alpha line TWO\n"
        assert (work / "b.md").read_text() == "beta line TWO\n"
        assert list(patch_dir.glob("job-*.json")) == [], "pending patches must be archived"
        assert len(list((patch_dir / "applied").glob("*.json"))) == 2
        print("PASS batch pushes two approved patches")


def test_stops_on_first_failure_and_keeps_tree_clean():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        patches = [
            # Sorts FIRST in filename order, so the batch must stop
            # before either good patch runs.
            ("job-aaa-gamma.json", patch_for("job-gamma", "c.md", "dup line\n", "dup line TWO\n")),
            ("job-alpha.json", patch_for("job-alpha", "a.md", "alpha line one\n", "alpha line TWO\n")),
            ("job-beta.json", patch_for("job-beta", "b.md", "beta line one\n", "beta line TWO\n")),
        ]
        origin, work, patch_dir = setup(
            tmp, patches, state_with_jobs(["job-alpha", "job-beta", "job-gamma"]))
        code, output = run_main()
        assert code == 1, f"expected exit 1, got {code}: {output}"
        assert "PUSH REFUSED" in output, output
        assert "job-aaa-gamma.json" in output, output
        assert "pushed 0 before stopping" in output, output
        assert origin_commit_count(origin) == 1, "nothing may have pushed"
        assert (work / "a.md").read_text() == "alpha line one\n", "good patch after the failure must not run"
        assert (work / "b.md").read_text() == "beta line one\n"
        assert (work / "c.md").read_text() == "dup line\ndup line\n", "failed patch must be restored"
        remaining = sorted(p.name for p in patch_dir.glob("job-*.json"))
        assert remaining == ["job-aaa-gamma.json", "job-alpha.json", "job-beta.json"], remaining
        assert subprocess.run(
            ["git", "-C", str(work), "status", "--porcelain"],
            check=True, capture_output=True, text=True).stdout == ""
        print("PASS stops on first failure, keeps tree clean")


def test_nothing_to_push_with_two_pending_unapproved():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        patches = [
            ("job-alpha.json", patch_for("job-alpha", "a.md", "alpha line one\n", "alpha line TWO\n")),
            ("job-beta.json", patch_for("job-beta", "b.md", "beta line one\n", "beta line TWO\n")),
        ]
        origin, work, patch_dir = setup(
            tmp, patches, state_with_jobs(["job-alpha", "job-beta"], approved=False))
        code, output = run_main()
        assert code == 0, f"expected exit 0, got {code}: {output}"
        assert "PUSH REFUSED" not in output, output
        assert "NOTHING-TO-PUSH" in output, output
        assert origin_commit_count(origin) == 1, "nothing may have pushed"
        assert len(list(patch_dir.glob("job-*.json"))) == 2, "both patches stay queued"
        print("PASS nothing-to-push with two pending unapproved (no refusal)")


def test_batch_cap_is_honoured():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        patches = [
            ("job-alpha.json", patch_for("job-alpha", "a.md", "alpha line one\n", "alpha line TWO\n")),
            ("job-beta.json", patch_for("job-beta", "b.md", "beta line one\n", "beta line TWO\n")),
        ]
        origin, work, patch_dir = setup(tmp, patches, state_with_jobs(["job-alpha", "job-beta"]))
        old_cap = push.MAX_BATCH_PATCHES
        push.MAX_BATCH_PATCHES = 1
        try:
            code, output = run_main()
        finally:
            push.MAX_BATCH_PATCHES = old_cap
        assert code == 0, f"expected exit 0, got {code}: {output}"
        assert "BATCH DONE: pushed 1 patch(es)" in output, output
        assert "1 more queued beyond the 1-patch batch cap" in output, output
        assert origin_commit_count(origin) == 2
        assert len(list(patch_dir.glob("job-*.json"))) == 1
        print("PASS batch cap honoured (MAX_BATCH_PATCHES=106 in the script)")


def test_invalid_patch_stops_batch_and_blocked_path_refused():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        bad = patch_for("job-alpha", "a.md", "alpha line one\n", "alpha line TWO\n")
        bad["jobId"] = "not a job id!"
        patches = [
            ("job-alpha.json", bad),
            ("job-beta.json", patch_for("job-beta", "b.md", "beta line one\n", "beta line TWO\n")),
        ]
        origin, work, patch_dir = setup(tmp, patches, state_with_jobs(["job-alpha", "job-beta"]))
        code, output = run_main()
        assert code == 1, f"expected exit 1, got {code}: {output}"
        assert "PUSH REFUSED" in output, output
        assert origin_commit_count(origin) == 1, "invalid patch must push nothing"
        assert len(list(patch_dir.glob("job-*.json"))) == 2
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        blocked = patch_for("job-alpha", "requirements.txt", "x\n", "y\n")
        patches = [("job-alpha.json", blocked)]
        origin, work, patch_dir = setup(tmp, patches, state_with_jobs(["job-alpha"]))
        code, output = run_main()
        assert code == 1, f"expected exit 1, got {code}: {output}"
        assert "PUSH REFUSED" in output and "blocked" in output, output
        assert origin_commit_count(origin) == 1
        print("PASS invalid patch stops batch; blocked path still refused")


if __name__ == "__main__":
    test_batch_pushes_two_approved_patches()
    test_stops_on_first_failure_and_keeps_tree_clean()
    test_nothing_to_push_with_two_pending_unapproved()
    test_batch_cap_is_honoured()
    test_invalid_patch_stops_batch_and_blocked_path_refused()
    assert push.MAX_BATCH_PATCHES == 106, push.MAX_BATCH_PATCHES
    print("ALL push-mem20 batch tests passed (MAX_BATCH_PATCHES=106)")
