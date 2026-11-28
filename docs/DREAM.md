# Dream: scheduled self-review that reports (Phase 2)

An enrolled agent periodically re-reads its own recent sessions and writes a short,
strict report: what it noticed, and what (if anything) it would change. The report is
pinned on the agent's home. A Dream **never edits the agent**; a change is a
*proposal* for Jesse or the Reviewer to decide on.

Stacked on Phase 1 (sessions and agent home): a Dream reads sessions, and its card
lives on the agent home.

## Who is enrolled

Only the **Orchestrator, the Reviewer and the Website Currency Agent**
(`DREAM_ENROLLABLE` in `src/lib/dream.ts`). Nobody is enrolled by default: Dream is off
until someone presses **Switch Dream on** on that agent's home. Every other agent shows
"not open to this agent yet". Widening this to the fleet is a one-line change, to be made
only after the starters' Dreams prove stable. Enrolment is enforced three times: the
switch refuses other agents, saved state naming other agents is dropped on load, and the
planner ignores them.

## What a Dream is, end to end

1. **Trigger.** A cron cadence per agent: default `0 */6 * * *` (6-hourly), adjustable
   on the home (3h, 6h, 12h, daily). A schedule faster than hourly is refused.
2. **Skill.** An enrolled agent's home lists "Dream: scheduled self-review" under Skills and
   "Dream" under Triggers (with its next slot).
3. **Review input.** The agent's own non-archived sessions with messages newer than its last
   successful Dream (the first Dream looks back 24 hours), bounded to about 8,000 characters.
4. **The call.** One plain model call through `sendToAgent` with tools off, so the reply is
   the report. The agent's own system prompt applies.
5. **The report.** One JSON object: `changed`, `summary`, `findings[]`, `proposals[]`
   (`target`, `change`, `why`). `changed` is true only with at least one proposal.
6. **Pinned on the home.** The newest report is pinned at the top of the agent's home, with
   earlier reports under it. A report that proposes changes also raises a notice at the top
   of the app ("Orchestrator's Dream proposed 2 changes"). A Dream with nothing to change
   says so on the home ("Nothing to change") and does **not** notify.

## Run record: planned / ran / skipped / failed

Every planned slot ends in exactly one of these, shown on the card over a trailing 7 days
(`1 planned · 1 ran · 0 skipped · 0 failed`):

| State | Meaning |
|---|---|
| ran | A valid report was written. |
| skipped | Always carries a reason: Teamz was not open (the slot folded into the next Dream), nothing new to review (no model call), or provider in mock mode (no model call). |
| failed | Carries the error: a model call that threw, or a reply that is not a valid report. |
| missed | A past slot with no record and no reason. This is the one *unexplained* state; the gate requires zero. |
| due now | A slot inside its grace window, not yet attempted. Not counted as planned. |

**Refusal is never success.** An empty reply, prose, a provider refusal ("I'm sorry…"), a
provider error ("out of credits", rate limits), JSON that breaks the contract, or a
summary that is itself a refusal is a **failed** run with the reason recorded, and no
report is pinned. This is tested (`src/lib/dream.test.ts`).

## Where it runs

- **In the browser tab** (`src/store/useDream.ts`): reconciles every minute while Teamz is
  open. Closed tab, no Dream; the gap is recorded as skipped on the next open. State is in
  `localStorage` (`teamz:dream:v1`); a second tab re-reads it before running a slot.
- **On the runner** (opt-in): `node scripts/build-runner-state.mjs ... --dream` adds a
  6-hourly `cron-dream-<agent>` job for the three starters (the Website Currency Agent
  needs `--extra-agents`). The runner agent reads the Build Room with `room_read` and
  replies with the same JSON. The home counts the runner's own run list in the same
  format, and pins runner replies that parse as reports. A rebuild keeps an existing Dream
  job's run history. **Nothing is deployed by this PR**; running the builder and
  restarting the service is the Reviewer's call.

## Honest limits

- **No real Dream has been run.** Everything here is tested with an injected model
  function and against a local stub endpoint in a browser. No live model, no live runner
  and no spend has been involved. Whether real models produce useful reports, or follow the
  JSON contract at all, is exactly what the gate measures.
- **The browser Dream only runs while Teamz is open.** The runner job covers the closed-tab
  case but cannot see browser-only chats; it reads the Build Room.
- **Runner reports are only visible while the runner's last ~20 channel messages still hold
  them**, so a report is pinned the first time the browser sees it. A runner Dream
  that completed while nobody had Teamz open for hours may count as "ran" without a pinned
  report.
- **Runner slots are inferred from run gaps**, not from a runner-side record of skips. A
  runner gap of several periods shows as `missed` (unexplained): the runner records no
  reason for it. The runner marks any dispatch that returned text as ok; refusal-shaped
  excerpts are reclassified as failed here, but only from the 200-character excerpt it keeps.
- **Cron slots use the browser's local time zone**, like the rest of the in-tab scheduler;
  the runner's use its host's.
- **Search does not index Dream reports yet**, and Dream proposals are not routed to the
  Reviewer automatically. They are pinned for a human, which is the roadmap's wording.
- Dream prompts and replies are not added to any session, so a Dream does not appear in
  chat history or inflate message counts.

## How the gate will be checked live (not claimed by this PR)

Roadmap gate: *three agents complete four consecutive Dreams with reports a human judges
useful or honestly empty; zero missed runs unexplained.*

1. Reviewer approves and deploys. Switch Dream on for the three starters (and, if the runner
   path is wanted, rebuild the runner state with `--dream` and restart the runner).
2. After 24 hours at the default cadence, open each agent's home: the card must show 4
   planned slots, with `ran + skipped + failed = planned` and `missed = 0`. Every skipped
   or failed slot must read as a plausible reason.
3. Read each of the four reports per agent. A human judges each one useful or honestly
   empty ("nothing to change" with a sensible summary counts). A report that invents events
   not in the sessions fails the check.
4. Any failed Dream is a finding about the model or prompt, not something to hide: the
   reason is on the card.

## Files

- `src/lib/dream.ts`: parser, planner, run-record ledger, runner ingestion (pure).
- `src/store/useDream.ts`: the in-tab runner and persistence.
- `src/components/DreamCard.tsx`, `DreamNotices.tsx`, `src/dream.css`: the UI.
- `src/lib/agentHome.ts`: Dream on the home model (card, trigger, skill).
- `scripts/build-runner-state.mjs`: `--dream`.
- Tests: `dream.test.ts`, `agentHomeDream.test.ts`, `dream-runner.test.ts`.
