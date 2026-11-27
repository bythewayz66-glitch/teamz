# Orchestrator

The Orchestrator (`agent-orchestrator`) triages mem20 work and keeps
the Build Room moving. It runs every 15 minutes (`cron-orchestrator-15m`,
schedule `*/15 * * * *`, channel `conv-build-room`).

## Standing orders (mission directive)

> Teamz owns mem20 and operates without a human in the loop,
> autonomously 24 hours a day, driving mem20 to success and completion.

This directive is in the Orchestrator's system prompt (identical in
`runner-agents.json` and `src/data/mock.ts`) and posted as the
Orchestrator's standing-orders message in the Build Room seed
(`conv-build-room`). The Orchestrator acts on it: it assigns work,
creates automations, and drives the pipeline on its own initiative —
while respecting the Reviewer's gates. Spending money, public releases,
and destructive actions still need the Reviewer's approval; everything
else, it drives itself.

## Mention flow (runner side)

After the Orchestrator's cron dispatch returns, the runner
(`scripts/runner-lib.ts`, `processDue`) parses its reply for
@mentions with the same parser the UI uses (`src/lib/mentions.ts`:
longest name wins, order of first appearance), resolves them to
runner agents, and dispatches each mentioned agent once with the
assignment in `conv-build-room`.

Bounds — the same shape as the UI's mention flow
(`src/lib/mentionFlow.ts`: depth 4, max 8 replies), in runner form:

- **max 8** mention dispatches per Orchestrator run;
- **one level only** — a mentioned agent's reply is not re-scanned for
  further mentions (no unbounded chaining);
- self-mentions are dropped; unknown names never resolve; an agent
  already dispatched in this run is not dispatched again;
- both mention forms resolve: the display name (`@QA Tester`, and its
  handle `@qa-tester`) and the agent id (`@agent-qa-tester`) — the
  Orchestrator writes the id form as often as the name, and the live
  test on Nov 26, 2026 caught the id form not resolving until this was
  added.
- a failed mention dispatch is recorded and logged; it never aborts
  the rest of the tick.

## Pre-send gates: no prompt reaches the room unreviewed

Before an assignment prompt goes to the room, it passes two gates
(`gateOrchestratorAssignment` in `scripts/runner-lib.ts`):

1. **Prompt Engineer** (`agent-prompt-engineer`) optimizes the
   Orchestrator's draft — shortest prompt that reliably produces the
   behaviour, system prompts / examples / output format kept
   separate. The room receives the OPTIMIZED prompt, never the raw
   draft.
2. **Reviewer** (`agent-reviewer`) reviews the optimized prompt with
   the same `APPROVE: <reason>` / `DENY: <reason>` one-line verdict
   as a stage review. Its prompt carries the core drive: mem20's
   success and livelihood is the only thing that matters, the only
   goal is making mem20 the best product of its kind and getting it
   actively making money.

- **Approve** → the prompt returns to the Orchestrator and is sent to
  the room as the @-mention, exactly as the room would have seen it.
- **Deny** → the prompt does NOT reach the room. The denied item plus
  the Reviewer's notes go to the **Triage Agent**
  (`agent-triage`, Gemini), which replies `REASSIGN: @<agent-id>`
  with a corrected prompt. The fixed item re-passes both gates once
  (optimizer → Reviewer); a second denial means it is not sent — it
  is recorded as a `kind: 'gate'` channel message and returns to the
  Orchestrator's next triage run. Nothing is ever silently dropped
  and nothing reaches the room unreviewed.
- **Fail closed**: if the Prompt Engineer, the Reviewer, or the
  Triage Agent is missing or unreachable, the assignment is not
  sent. Gate dispatches are prefixed `orchestrator gate:` in the
  runner log so they do not match the Slack poster's postable
  patterns — pipeline internals stay in the log, completed work
  still posts to `#mem20updates`.

The same deny → triage path applies to product-job stages: a
Reviewer-denied stage dispatches the Triage Agent and records its
reply as a `kind: 'triage'` channel message; the job stays parked.

## The Orchestrator's output reaches the room

Every cron reply is recorded as a channel message in the runner state
(`state.channelMessages`: orchestrator replies, mention dispatches,
researcher replies, resends), and `/runner-state` exposes the last 20
so the Teamz UI's "Runner automations" panel shows what the headless
agents actually said — not just the log.

## Creating automations (governed, no hand-editing state.json)

The Orchestrator creates new automations with the `create_automation`
tool, which calls `POST /automations` on the teamz-agent service
(localhost-only). The endpoint validates the proposal and appends it
to `state.json` with the runner's own load/save (atomic write):

- `type` is always `prompt` — command cron jobs are refused (no
  allowlist), as in the runner itself;
- `target` must be non-empty and at most 2000 chars — bounded and
  completable in one dispatch;
- `agentId` must exist in the runner state;
- `channelId` must be `conv-build-room`;
- `schedule` must be a valid 5-field cron expression;
- **refused** (403, routed to Jesse): anything that would spend money,
  publish publicly, release/deploy, or delete/destroy — matched on
  spend / pay / purchase / buy / charge / publish / public / release /
  deploy / delete / destroy / remove / wipe / drop.

The same rules live in `validateAutomationProposal` in
`scripts/runner-lib.ts` (tested in `src/lib/orchestrator.test.ts`) and
in the endpoint (`scripts/agent-endpoint/agent.mjs`, `validateAutomation`);
keep them in sync. A proposal the endpoint refuses is never written.

## Tests

`src/lib/orchestrator.test.ts` (mention resolution and caps,
automation validation, gate prompt parsing) and
`src/lib/runner-flows.test.ts` (the real `processDue` mention flow
end to end, with the channel record — including the gated flow:
approve, deny → triage → approve, deny twice, missing gate agents).
