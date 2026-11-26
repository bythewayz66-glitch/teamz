# Reviewer policy

The Reviewer (`agent-reviewer`) is the approval gate for **routine
operational decisions** in Teamz. It exists so Jesse does not have to
weigh in on every small choice the runner makes — while making sure he
always decides the ones that matter.

## What the Reviewer may approve

Routine operational decisions only: code changes, docs, plans, and
other non-public, non-spending, non-destructive work. A stage reaches
the Reviewer only when it is gated (it needs a decision) but is **not**
a carve-out (below). The gate is marked on the stage with
`flags: { requiresReview: true }` — see `src/lib/governance.ts`
(`GateFlags.requiresReview`, `stageRequiresApproval`).

An approved stage's actions may **execute** — write permission means an
approved stage's work actually runs (writes, builds, changes), not just
reads. The approval is recorded in the runner state with
`decidedBy: 'reviewer'` and the Reviewer's reason, so an audit can tell
a Reviewer approval from a Jesse approval.

## The carve-outs — always Jesse, never the Reviewer

Checked **first**, before the Reviewer is ever asked
(`isCarveOut` in `src/lib/governance.ts`):

- the stage is `release`, `advertise`, or `sell`;
- the stage would spend money (`spendsMoney`);
- the stage would publish something public (`publishesPublic`);
- the stage would delete or destroy something (`destructive`).

A carve-out always creates a pending approval request for Jesse, in
the state file, exactly as before. The Reviewer is never dispatched
for it — the runner does not even ask.

## How a review runs (runner side, `scripts/runner-lib.ts`)

1. A product-job stage is blocked on `startStage` with `needsApproval`.
2. If a pending approval already exists for that job + stage, the job
   stays parked — the Reviewer is not asked twice.
3. Carve-out? → Jesse approval request, job parked.
4. Otherwise the runner dispatches the stage details to the Reviewer
   agent with one instruction: reply with exactly one line,
   `APPROVE: <reason>` or `DENY: <reason>`. The request carries the
   completed stage outputs (`reviewContext` in
   `scripts/runner-lib.ts`), so the Reviewer judges the actual work —
   e.g. the staged patch summary from the implement stage — not just
   the stage description. The prompt also tells the Reviewer it must
   never approve a carve-out and must deny with
   `DENY: carve-out — needs Jesse` if the request touches one.
5. **Approve** → an approval record is written (`status: 'approved'`,
   `decidedBy: 'reviewer'`, reason attached) and the stage starts
   immediately in the same tick.
6. **Deny** → a denied approval record is written (`decidedBy:
   'reviewer'`) and the job parks in `awaiting_approval`.
7. **Reviewer unreachable, or reply unreadable** (no `APPROVE:` /
   `DENY:` line) → the runner files a Jesse approval request instead.
   It never silently approves.

## What the Reviewer itself must do

Its system prompt (in `runner-agents.json` and `src/data/mock.ts`,
identical in both) says the same thing: approve most routine choices
quickly, never approve spending, public releases, or destructive or
deletion actions, and approve in writing with the decision and its
reason so there is a record.

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

One distinction the Reviewer's prompt draws explicitly (added Nov 26,
2026, after the first live run): pushing a routine code or doc change
to the team's own repo through the governed push path is a routine
decision the Reviewer MAY approve — it is a commit to the repo, not
a public release. A public release means release notes, an
announcement, publishing the docs site, or selling something (the
release / advertise / sell stages); those always need Jesse. The
first live push request was denied by the Reviewer as "carve-out —
needs Jesse (push to GitHub remote main is a public release)" because
the old wording left the line blurry; the denial is preserved in the
approval record, and the clarified prompt was deployed before the
retry. The Reviewer still denies anything bigger, destructive, or
release-shaped.

## Tests

`src/lib/reviewer.test.ts` (carve-out table, review marker, decision
records) and `src/lib/runner-flows.test.ts` (approve / deny / carve-out
/ unreachable / unreadable, all through the real `processDue`).
