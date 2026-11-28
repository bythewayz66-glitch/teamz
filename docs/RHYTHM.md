# Runner rhythm (Phase 0, part 2)

Roadmap Phase 0 is "make the rhythm trustworthy". Part 1 (PR #6, merged) added the telemetry log and the Website Currency Agent job fix. Since then `main` also gained per-dispatch checkpointing (`onCheckpoint`) and the `act()` test setup. This PR is what was still open, each item verified against the code first.

The rules live in `scripts/runner-rhythm.ts` (pure, tested in `src/lib/runner-rhythm.test.ts`). `scripts/runner-tick.ts` applies them around `processDue` (`processDueWithRhythm`) before it dispatches anything, and the live runner reports their events to `runner-events.jsonl`. `runner-lib.ts` (113 KB) and the agent endpoint are not edited at all: the rules wrap `processDue` instead of changing it.

## What changed, and why

| Item | Finding | Change |
|---|---|---|
| Orphaned runs | `processDue` skips every job that has a `dispatched` run, in two places (`countDueProductJobs`, the job loop). Checkpointing writes `dispatched` to disk before the stage runs, so a restart mid-stage leaves a run nothing will ever complete: the job is skipped forever. Checkpointing made this more likely, not less. | `reapOrphansOnDisk` (runner-tick.ts) runs at runner boot (nothing can be in flight in a new process) and fails every `dispatched` run. `processDueWithRhythm` also reaps any run older than 2 h as a backstop. A failed run does not advance the stage and does not consume a gated stage's approval, so the retry needs no second review. Event: `run_reaped`. |
| Refusal as success | The endpoint already turns Pollinations' 200-with-refusal into a 402 (`isUpstreamErrorReply`). Nothing at the runner boundary checked any other provider. | `isCreditRefusalReply` is applied to every reply (in the runner's telemetry-wrapped dispatch, so the log records the dispatch as failed, and again in `processDueWithRhythm`): a short reply that reads as an out-of-credits refusal is thrown as a 402 and recorded as a failed run. Replies over 600 chars are never treated as refusals, so an agent writing about credits is not caught. |
| Rescue into a dead provider | The rescue prompt listed a provider as "healthy" unless it was in backoff, and backoff only exists after a failed rescue. A provider that just returned 402s was offered as a target. | Providers with a credit-exhaustion event in the last 6 h are moved from "healthy" to "rate-limited" in the Provider Researcher's rescue prompt, which also gets a "never reassign anyone to: ..." sentence. **This is advice to the Researcher, not enforcement**: `reassign_agent` in `agent.mjs` still accepts any valid provider. Enforcing it there is a small change (read the rate-limit events file, refuse a provider with a recent credit event) that I did not make: it means re-uploading the 143 KB endpoint file, and I would rather the Reviewer decide. |
| Stale backoff | Backoff entries were never removed, so a failure after a quiet day resumed a doubling count from the old failure. | Entries quiet for a full max-backoff window (4 h) past `nextAllowedTs` are dropped. |
| Starvation | The product-job loop took the first N due jobs in array order. Jobs early in the list that come due again always beat later ones. With 163 hourly jobs and about 4 dispatches an hour, the tail never runs. | `pickJobsToStart`: never-run jobs first, then the job that has waited longest, array order as tiebreak. `processDueWithRhythm` sorts the job array that way for the tick (processDue starts the first due jobs in array order) and restores the original order afterwards, so the state file's order does not churn. A deterministic test reproduces the old rule starving all 49 never-run jobs over 400 ticks, and shows the new rule running every one of them. |
| Backlog honesty | Pacing was invisible. | A `backlog` event (due jobs, estimated drain hours at the current gap and slots) is written when it changes. 163 due jobs at one slot and a 15 min gap take more than 40 h. |
| Stale approvals | Approved-but-unconsumed and pending approvals lived forever. | `ApprovalRequest.expiredAt`. After 12 h unused an approval is expired (`approval_expired`); it is neither live nor pending, so the stage is re-reviewed and a parked job is resumed to ask the Reviewer again. Denied and consumed approvals are never touched. |
| Parked behind a denial | A denial is terminal by design (and is never auto-approved). | Not changed. A job parked behind one for over 48 h is reported (`job_parked_stale`, at most every 6 h) so the fleet-health view can show it. A Reviewer decides what to do with it. |
| Tests / CI | `NODE_ENV=production` in a shell made React load its production build and fail 3 `useAutonomy` tests. No guard stopped a test calling a live provider. | `vitest.config.ts` pins `NODE_ENV=test`. `src/test-setup.ts` blocks any non-loopback `fetch` that a test did not stub, so a test can no longer depend on a provider's balance. The full suite passes under both `NODE_ENV=test` and `NODE_ENV=production`. |

## Hypotheses, not facts

- That orphaned runs are why jobs stall is derived from the code, not observed live. The `lost_tick` and `run_reaped` events will show it after deploy.
- The 2 h backstop assumes no stage legitimately stays `dispatched` that long (dispatch budget 330 s, a slot wait is under an hour). If a real stage can, raise `ORPHAN_RUN_MAX_AGE_MS`.
- The 12 h approval TTL, 6 h credit window, 48 h parked report and 600-char refusal limit are my choices. They are named constants for the Reviewer to change.

## An open question this PR does not decide

`startStage` stamps `lastRunAt` when a stage starts, and an interval or cron job is due again only after its interval or next slot. So a recurring job with N stages needs N intervals to finish one cycle: a 3-stage hourly job completes a cycle in 3 h at the very best. Together with about 4 dispatches an hour, that is a likely reason "no job has ever completed a cycle". Changing it alters job semantics (stages would run back to back), so I left it for the Reviewer.

## Not done

- No deploy. Rebuilding the runner and restarting the service is a manual Reviewer step.
- No endpoint-side enforcement of the out-of-credits rule (see above).
- `.github/workflows/ci.yml` still names its step "Set up Node 20" although it installs 22. Workflow files are out of scope for this integration, so I did not touch it.
- The roadmap gate is not claimed: CI green on `main`, the Currency Agent completing a real run, a recurring job completing a full cycle and auto-resetting, and a 7-day record of planned / ran / skipped / failed. All need the live runner.

## Deploy checklist (Reviewer)

1. `npm ci && npm run build:runner`, copy `dist/runner.mjs` to jnet1 (the endpoint is unchanged).
2. Restart `teamz-runner`. Boot writes `boot` and any `run_reaped` events to `runner-events.jsonl`.
3. Expect on the first tick: `approval_expired` for the three approvals that had sat 15 to 17 h, and `backlog` with the drain estimate.
4. Watch for a recurring job logging a cycle reset, and for the never-run jobs getting their first run (`dispatch_start`).
5. Roll back by restoring the previous `runner.mjs`. State files stay compatible: `expiredAt` is an optional field and the loader keeps it.
