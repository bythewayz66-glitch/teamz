# Metering, budgets and fleet health (Phase 5)

Opens from **Usage & health** in the top bar. Standalone Teamz, browser only: nothing here writes to the runner, spends anything, or changes a provider. Code: `src/lib/metering.ts` (pure, tested in `metering.test.ts`), `src/store/useMetering.ts`, `src/components/MeteringPanel.tsx`.

## What it answers

| Question | Where | Source |
|---|---|---|
| Spend and tokens by agent, model, provider, day | Usage | the Phase 1 usage ledger (`/usage` days this browser fetched) |
| Which provider carries the fleet, and what share is the Orchestrator | Usage, "Concentration" | same ledger, shares of calls and tokens in the 14-day window |
| Is a provider about to run dry | Providers & credit | a balance **you enter** + observed burn |
| Is a limit approved | Budgets | proposals + a recorded Reviewer decision |
| Which agents are asleep, starved, parked or never ran | Fleet health | runner-state (jobs, crons, runs, channel messages), in-tab autonomy, ledger |
| What does the 900 s spacing cost in drain time | Pacing | runner-state jobs and the runner's published pacing constants |

## Honest limits (read these)

- **Everything is a lower bound.** `/usage` only holds today; the ledger counts the days this browser fetched it. The panel says how many of the 14 days were observed, and shows unobserved days as "not observed", never zero.
- **Provider and model are a configured route.** The ledger records tokens per agent only. Provider/model figures attribute each agent's tokens to the provider/model the runner lists for it. A call rescued onto another provider is invisible here (finding 11). Agents the runner does not list are "unattributed" and never trigger the concentration line.
- **No price list.** Dollars appear only after a cost rate is entered (Workspace & API). Dollar budgets and dollar balances show "unknown" without one.
- **Provider credit is user-entered.** No endpoint in this repo exposes a balance (`probe-provider-health.py` pings; `capacity-meter.py` models RPM). You enter a balance in tokens, calls or dollars; Teamz subtracts observed use since, whole entry day included (conservative: it can only warn early), and projects days left from the mean of up to 7 observed days. Warning lines: `low` at 3 days, `critical` at 1 day, `exhausted` at 0. With no observed usage the status is `unknown` with the reason.
- **Budgets are proposals.** The Reviewer's decision is recorded by typing who and why, the same trust model as the Team Library review. Approved budgets are shown against use and flagged near (80%) or over; Teamz warns, it does not stop the runner.
- **Pacing changes nothing.** The 900 s spacing is the documented runner setting (`scripts/runner.ts`), not read live; a test fails if the constants here drift from the runner's. The spacing control records a proposal only. Drain time is arithmetic: a range from "every dispatch instant" to "every dispatch takes the full 330 s budget", because the runner does not tell the browser real dispatch durations. The Phase 0 `runner-events.jsonl` is on jnet1 and not reachable from the browser.
- **Run records are what runner-state carries.** Cron runs, job stage runs and the last 20 channel messages. History older than that is not recoverable.

## Health states

Checked in this order; the first that applies wins. Thresholds live in `METERING` in `metering.ts` and are asserted at their boundaries in the tests.

1. **Parked**: one of the agent's enabled jobs is `awaiting_approval`, or a stage run has been `dispatched` for more than 30 minutes (the dispatch deadline is 330 s; findings 13 and 39).
2. **Never run**: scheduled work exists (enabled cron, interval trigger, or an active/awaiting job it owns a stage of) and there is no run record, no ledger call and no channel message for it at all (findings 7, 8, 9).
3. **Starved**: scheduled work with a known cadence, and nothing recorded for more than 2 x the shortest cadence + 1 hour.
4. **Sleeping**: nothing scheduled and no activity in 14 days. Marked "so far" when the history seen is shorter than 14 days.
5. **Active**: none of the above. "Last run failed" is shown alongside, not as a state.

Spot-check: each row's "Why" names the numbers it used, so it can be compared by hand with the agent's home and run record.

## Gate (not claimed here)

The gate needs the live runner and a ledger that has accumulated: reproducing the scan's concentration and Orchestrator-share findings from the product alone, a low-credit warning triggered in test before a provider fails (done in unit tests and in a browser stub run, not live), and every agent's health matching a spot-check against real run records. That is for the Reviewer after deploy.
