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
and destructive actions still need Jesse; everything else, it drives
itself.

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
automation validation) and `src/lib/runner-flows.test.ts` (the real
`processDue` mention flow end to end, with the channel record).
