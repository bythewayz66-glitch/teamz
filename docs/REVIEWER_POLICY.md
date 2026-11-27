# Reviewer policy

The Reviewer (`agent-reviewer`) is the SOLE decision-maker for **every
approval decision** in Teamz — routine AND high-stakes: code changes,
docs, plans, releases, spending money, publishing publicly, and
destructive work. There are no carve-outs to anyone else. Jesse is the
founder and approves nothing; no code path waits on him for approval,
and no decision is ever routed to him.

## What the Reviewer decides

Everything gated. A stage reaches the Reviewer when it needs a
decision: it is a gated lifecycle stage (`release`, `advertise`,
`sell`), its flags say it would spend money (`spendsMoney`), publish
something public (`publishesPublic`), or destroy something
(`destructive`), or it is marked `requiresReview` — see
`src/lib/governance.ts` (`stageRequiresApproval`, `GateFlags`).

High-stakes stages — release / advertise / sell, spending, publishing,
destructive — are flagged by `isHighStakes` in
`src/lib/governance.ts`. The flag means EXTRA Reviewer scrutiny, not a
different approver: the Reviewer still decides, and denies unless the
evidence actually supports the request.

An approved stage's actions may **execute** — write permission means an
approved stage's work actually runs (writes, builds, changes), not just
reads. The approval is recorded in the runner state with
`decidedBy: 'reviewer'` and the Reviewer's reason. Every approval
record's `decidedBy` is `'reviewer'`; there is no other approver.

## Standing rules the Reviewer must apply

The Reviewer applies these to every decision, with extra care for
high-stakes ones (they are in the dispatch prompt as well as here):

- Never remove a feature and never fake one — completion only.
- Verify every claim against the real code, tree, and git history.
- The repo-root `AGENTS.md` is canonical and trumps all other rules docs.
- `mem20core` and `mem20corez` are distinct components — never merge them.
- Record every decision with its reason.

## How a review runs (runner side, `scripts/runner-lib.ts`)

1. A product-job stage is blocked on `startStage` with `needsApproval`.
2. If a pending approval already exists for that job + stage, the job
   stays parked — the Reviewer is not asked twice.
3. Otherwise the runner dispatches the stage details to the Reviewer
   agent with one instruction: you are the SOLE decision-maker for this
   stage — there is no other approver, no human approval, no escalation,
   no one else to route it to; reply with exactly one line,
   `APPROVE: <reason>` or `DENY: <reason>`. The request carries the
   completed stage outputs (`reviewContext` in
   `scripts/runner-lib.ts`), so the Reviewer judges the actual work —
   e.g. the staged patch summary from the implement stage — not just
   the stage description. High-stakes requests are marked
   `HIGH-STAKES` in the prompt. The prompt also carries the standing
   rules above.
4. **Approve** → an approval record is written (`status: 'approved'`,
   `decidedBy: 'reviewer'`, reason attached) and the stage starts
   immediately in the same tick.
5. **Deny** → a denied approval record is written (`decidedBy:
   'reviewer'`) and the job parks in `awaiting_approval`. A denial is
   terminal until the job is resumed by hand; the Reviewer is not
   re-asked for the same stage on the next tick.
6. **Reviewer unreachable, or reply unreadable** (no `APPROVE:` /
   `DENY:` line) → the job parks in `awaiting_approval` and NO
   approval request is filed. A later tick resumes the job (a parked
   job with no pending or denied approval for its current stage is
   resumed by `processDue`) and asks the Reviewer again. It never
   silently approves, and it never falls back to anyone else — there
   is nobody else to fall back to.
7. **No Reviewer agent configured** → the job parks and the runner
   logs `NO REVIEWER CONFIGURED` as a config error. No approval
   request is filed. Once a Reviewer is configured, a later tick
   retries it the same way as (6).

## What the Reviewer itself must do

Its system prompt (in `runner-agents.json` and `src/data/mock.ts`,
identical in both, and in the runner state on jnet1) says the same
thing: it is the sole decision-maker for all approvals, routine and
high-stakes alike; it decides in writing, with the decision and its
reason, so there is a record; and it applies the standing rules above.

## The push stage

The Nightly repo check's `upgrade` stage is the governed push
(`docs/PUSH_PATH.md`): it runs the privileged push script, and it is
gated with `requiresReview`, so the Reviewer approves it. The
Reviewer sees the implement stage's output — the staged patch
summary — with the request, and should deny when the change touches
a blocked path, is bigger than a small correction, deletes anything,
or looks like a release or a public announcement rather than a
routine repo change. The script re-checks the approval on disk, the
branch, and the diff before it pushes anything, so a mistaken
approval still cannot push a destructive change — but the Reviewer
is the judgment, and it should use it.

One distinction the Reviewer's prompt draws explicitly: pushing a
routine code or doc change to the team's own repo through the
governed push path is a routine decision the Reviewer MAY approve —
it is a commit to the repo, not a public release. A public release
means release notes, an announcement, publishing the docs site, or
selling something (the release / advertise / sell stages); those
still need the Reviewer's approval, with extra scrutiny as
high-stakes decisions. The Reviewer still denies anything bigger,
destructive, or release-shaped.

## Tests

`src/lib/reviewer.test.ts` (high-stakes flag, review marker, decision
records) and `src/lib/runner-flows.test.ts` (approve / deny /
high-stakes-to-Reviewer / unreachable / unreadable / no-Reviewer /
retry, all through the real `processDue`).
