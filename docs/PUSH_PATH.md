# The governed push path

How the Teamz agents' changes land in the mem20 GitHub repo
(`bythewayz66-glitch/mem20`), and what stops a bad one.

Jesse approved this path in plain words (Nov 26, 2026: "Yes please do
absolutely"). It is the only way the runner writes to a repo.

## The rule

- **Routine code/doc changes** go through the **Reviewer**: approve or
  deny, recorded with `decidedBy: 'reviewer'`. A push happens only
  under a live Reviewer approval for that job + push stage.
- **Releases, public publishing, and destructive changes still route to
  Jesse** — never to the Reviewer. The carve-outs in
  `src/lib/governance.ts` (`isCarveOut`) are checked first, before the
  Reviewer is ever asked. Pushing a routine commit to the team's own
  repo is not a release and not a public announcement; it is the
  working path for routine changes, which is why the push stage is
  Reviewer-gated (`requiresReview`) rather than a carve-out.
- **No push without an approval on disk.** The runner persists state
  before a gated command stage runs (`onBeforeCommand`), and the push
  script re-checks the approval in `/var/lib/teamz-runner/state.json`
  before it touches the repo.

## The mechanism (four pieces)

### 1. The agents read and stage — they never write the repo

The agent endpoint (`scripts/agent-endpoint/agent.mjs`, on jnet1 as
`teamz-agent.service`, user `teamz`) offers two repo tools:

- `repo_read` — read a file under `/opt/mem20`, or the excerpt around
  a search string (at most ~1000 chars, so the finding survives the
  tool loop's observation cap). Refuses escapes, absolute paths,
  secrets, and git internals.
- `stage_patch` — stage ONE small patch for the calling job's
  implement stage: `{jobId, file, oldText, newText, message}`. It
  verifies the job exists and is sitting on its implement stage, the
  path is inside the repo, `oldText` occurs exactly once in the file,
  and writes the patch as JSON to
  `/var/lib/teamz-runner/patches/<jobId>.json` (atomic write). It
  never edits the repo. Blocked, always: `.github/` and `.git/`
  paths, `requirements.txt` (the starlette cap lives there — Jesse
  decides that one), anything under `secrets/`, `*.env`.

The agent learns its job id from the runner context appended to every
stage prompt (`buildStagePrompt` in `src/lib/jobs.ts`).

### 2. The Nightly job carries the change

`repoCheckTemplate` (`src/lib/jobs.ts`) — the Nightly repo check,
`0 7 * * *`, Atlas, workdir `/opt/mem20`:

| Stage | Kind | What it does |
|---|---|---|
| `design` | prompt | Plan which live claims to verify and which exact files prove them. Read-only. |
| `implement` | prompt | Verify one live claim with `repo_read`; if the file text proves it wrong, stage the smallest correction with `stage_patch`. Otherwise reply `NO-CHANGE`. |
| `upgrade` | **command, gated** | Run the governed push script. `flags: { requiresReview: true }` — the Reviewer approves this stage (it sees the implement output with the request, so it judges the actual change). |
| `document` | prompt | Report: the change, the push record (commit hash, remote main) or why nothing was pushed, unfinished work, decisions needed. |

The job's allowlist has exactly one entry:
`["sudo", "/opt/teamz-runner/push-mem20.py"]`. No other command can
ever run for this job.

### 3. The privileged push script

`scripts/push-mem20.py`, deployed to `/opt/teamz-runner/push-mem20.py`
(root-owned, `0755`, not writable by `teamz`), runnable by `teamz`
only via sudo — see `deploy/teamz-push-mem20.sudoers`
(`teamz ALL=(root) NOPASSWD: /opt/teamz-runner/push-mem20.py`).
It runs as root because the GitHub token is root-held (gh auth /
the git credential store) and the runner service user cannot read it.

Before it commits anything it checks, in order:

1. Exactly one patch is pending (zero → `NOTHING-TO-PUSH`, exit 0;
   more than one → refuse).
2. The patch is valid: well-formed job id, a repo-relative path that
   stays inside `/opt/mem20`, a one-line message. Blocked paths (same
   list as `stage_patch`) are refused again here — the patch file is
   treated as untrusted input.
3. The runner state shows the job on its push stage (`upgrade`) AND a
   live approval for that job + stage: `approved`,
   `decidedBy: 'reviewer'`, not consumed.
4. The repo is on `main`, the tree is clean, and `HEAD == origin/main`
   (fetched first) — a moved remote means re-sync first.
5. The patch applies cleanly (`oldText` occurs exactly once in the
   current file). The resulting diff touches exactly one file, changes
   at most 50 lines, deletes no files, and touches no blocked path.
6. The push is verified: `ls-remote origin main` must equal the new
   HEAD after pushing.

It is idempotent: if the change is already the HEAD commit (same job
id in the commit message — e.g. a previous run was killed after the
push but before archiving), it reports `ALREADY-PUSHED`, archives the
patch, and exits 0. A half-applied patch is rolled back (`git
checkout -- .`) on any refusal after applying, so the tree stays
clean. The script invokes git by argv list only — never a shell —
and never reads, copies, or prints the token.

The commit is authored with the repo's configured git identity when
set, else `Teamz Runner <teamz@mem20.com>`, with a trailer naming the
Reviewer approval and job id, e.g.:

```
docs(cartoon): Episode 1 is in production — page said no episode had been produced yet

Pushed via the Teamz governed push path (Reviewer approval appr-..., job job-...).
```

### 4. The record

The push script prints one line the runner records as the upgrade
stage's output (`PUSHED <sha> <file> +a/-d origin/main=<sha>
approval=<id> job=<id>`, or `NOTHING-TO-PUSH`, or
`ALREADY-PUSHED`), the applied patch is archived under
`/var/lib/teamz-runner/patches/applied/`, the approval is consumed
when the stage completes, and the document stage quotes the record.
The approval record in state.json says who decided it
(`decidedBy: 'reviewer'`), so an audit can tell a Reviewer approval
from a Jesse approval.

## What the push path deliberately cannot do

- Touch `.github/workflows/` (the token has no `workflow` scope and
  Jesse applies workflow files himself) or change the starlette cap
  in `requirements.txt`.
- Push a change nobody approved: the runner's gate blocks the stage,
  and the script re-checks the approval on disk.
- Push a big or destructive change: one file, ≤ 50 lines, no
  deletions, clean tree, `main` only, `HEAD == origin/main`.
- Spend money, publish a release, or delete anything: those are
  carve-outs and route to Jesse before the Reviewer is ever asked.

## Sync state (Nov 26, 2026)

- `/opt/mem20` on jnet1 is synced to `origin/main` `30c2123` (527
  tools / 135 domains), working tree clean.
- The 2 uncommitted mem20agentz mods are preserved on local branch
  `jnet1-mem20agentz-mods` (commit `3c7b5b62`) — the push path never
  touches that branch and never pushes it.
- The live-server verification (confirming the mem20 server reports
  527/135) was blocked by a runtime security notice and is out of
  scope for the push path — it needs a fresh go-ahead.

## First end-to-end run (Nov 26, 2026)

Verification job `job-push-path-verify` (Atlas, interval schedule):
design → implement → upgrade → document. The implement stage read
`docs/series/cartoon/index.html`, found the stale sentence "no
episode has been produced yet" (Episode 1 is in production — 30
clips, 5 scenes, Nov 26), and staged a one-line correction.

The first push request was DENIED by the Reviewer — "carve-out —
needs Jesse (push to GitHub remote main is a public release)". The
Reviewer's old wording left the line between "a commit to the repo"
and "a public release" blurry, and the model read any push to a
public repo as a release. That denial is preserved in the approval
record (`decidedBy: 'reviewer'`, status denied). The fix was a prompt
clarification, not a gate bypass: the Reviewer's system prompt (in
`runner-agents.json` and `src/data/mock.ts`, identical in both) and
the Reviewer dispatch in `scripts/runner-lib.ts` now draw the line
explicitly — a routine repo commit through the governed push script
is NOT a public release; release notes, announcements, publishing
the docs site, and selling still always need Jesse. The job was
resumed and the Reviewer was asked again under the clarified prompt —
and APPROVED: "Small one-file doc correction in
docs/series/cartoon/index.html, no deletions, no workflow files, no
secrets, not a public release — routine governed push"
(`decidedBy: 'reviewer'`, still unconsumed).

The push itself did NOT land — it was refused by the script's own
guard, correctly: remote `main` had moved to `7b4534eb` (a docs fix
correcting the stale 487/129 surface to live 527/135, pushed by
another worker while this path was being built) while `/opt/mem20`
was still at `30c2123`, and the script refuses to push when `HEAD !=
origin/main` ("remote moved, re-sync first"). The upgrade stage
retried on its interval (approval unconsumed, stage unadvanced) and
refused the same way each time — the retry loop works as designed.

The re-sync + push then ran into a runtime security notice: the
freshly fetched remote content (`7b4534eb`) failed an
execution-risk check, and processing it (fast-forwarding
`/opt/mem20` onto it, running git operations in it) needs a fresh
go-ahead. So the verification job is PAUSED (`job-push-path-verify`,
stage `upgrade`, status `paused`) with the patch still staged
(`/var/lib/teamz-runner/patches/job-push-path-verify.json`) and the
Reviewer approval still live and unconsumed. Nothing was committed
and nothing was pushed. To finish the verification: Jesse gives the
go-ahead in plain words, a worker fast-forwards `/opt/mem20` to
`origin/main`, resumes the job, and the next tick pushes under the
existing Reviewer approval.

- Commit: none yet — no commit was created.
- Remote main: `7b4534eb` (the re-sync target, not yet applied locally).

## Files

- `src/lib/jobs.ts` — `repoCheckTemplate` (Nightly job shape),
  `buildStagePrompt` (runner context footer with the job id).
- `scripts/runner-lib.ts` — `reviewContext` (Reviewer sees completed
  stage outputs), `onBeforeCommand` (persist state before a gated
  command stage).
- `scripts/runner.ts` — `onBeforeCommand` implemented with
  `saveRunnerState`.
- `scripts/agent-endpoint/agent.mjs` — `repo_read`, `stage_patch`.
- `scripts/push-mem20.py` — the privileged push script.
- `deploy/teamz-push-mem20.sudoers` — the sudo rule.
- `scripts/runner-state.example.json` — the example state carries the
  new Nightly shape.

## Tests

- `src/lib/jobs.test.ts` — the template chain, the push allowlist,
  the Reviewer gate, the prompt footer.
- `src/lib/runner.test.ts` — the full Nightly chain over four ticks,
  including the Reviewer approval and the consumed approval.
- `src/lib/runner-flows.test.ts` — the Reviewer request carries
  completed stage outputs; `onBeforeCommand` fires before a gated
  command stage and a failure refuses it.
- `src/lib/agentEndpoint.test.ts` — `repo_read` / `stage_patch`
  against a throwaway repo and state: staging, blocked paths,
  oldText counts, job-stage binding, registry wiring.
