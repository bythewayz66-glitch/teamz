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
   `APPROVE: <reason>` or `DENY: <reason>`. The prompt also tells the
   Reviewer it must never approve a carve-out and must deny with
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

## Tests

`src/lib/reviewer.test.ts` (carve-out table, review marker, decision
records) and `src/lib/runner-flows.test.ts` (approve / deny / carve-out
/ unreachable / unreadable, all through the real `processDue`).
