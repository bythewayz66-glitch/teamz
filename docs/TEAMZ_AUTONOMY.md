# Teamz autonomy — the 24/7 runner, the agents, and the Build Room

This is the overview for the autonomous half of Teamz: the headless
runner on jnet1, the 31 agents it drives, their automations, the
Reviewer gate, the Orchestrator, the Provider Researcher, and the
Keymaster. The detail docs are:

- `docs/REVIEWER_POLICY.md` — what the Reviewer may approve, the
  carve-outs, the fallback.
- `docs/ORCHESTRATOR.md` — the mission directive, the mention flow,
  governed automation creation.
- `docs/PROVIDER_RESEARCHER.md` — the provider registry, load
  balancing, the rate-limit rescue loop, the rate-limit assessment.
- `docs/KEYMASTER.md` — the credential inventory and the secrets
  store (`docs/credential-inventory.json`).

## The roster (31 runner agents)

`runner-agents.json` is the single source of truth. All 31 point at
`http://127.0.0.1:8897/chat` (the teamz-agent endpoint on jnet1) with
model `openai-fast`, and every system prompt there is identical to
the one in the UI seed (`src/data/mock.ts`) — tested in
`src/lib/roster.test.ts`.

- **The 26 Teamily agents** (Nov 26, 2026): Mem20 Assistant, Daily
  Planner, Research Assistant, Writing Assistant, Code Reviewer, QA
  Tester, Bug Analysis Agent, Frontend Developer, Backend Architect,
  Data Engineer, AI Engineer, Prompt Engineer, Minimal Change
  Engineer, Git Workflow Master, Codebase Onboarding Engineer,
  Technical Writer, Application Security Engineer, Product Researcher,
  Analytics Reporter, Reading Companion, Reality Checker, Content
  Creator, Meeting Notes Specialist, CEO Assistant, Senior Project
  Manager, Personal Growth Mentor. Each has skills and the tool set
  (`wikipedia`, `weather`, `calculator` — plus `web_search`,
  `create_automation`, `add_provider`, `reassign_agent`,
  `repo_read`, `stage_patch` on the endpoint side; the last two are
  the governed push path's read/stage half — see
  `docs/PUSH_PATH.md`).
- **Reviewer** (`agent-reviewer`): the approval gate for routine
  operational decisions. See `docs/REVIEWER_POLICY.md`.
- **Orchestrator** (`agent-orchestrator`): triage and assignment in
  the Build Room, every 15 minutes. See `docs/ORCHESTRATOR.md`.
- **Provider Researcher** (`agent-provider-researcher`): keyless
  provider research, load balancing, rate-limit rescue. See
  `docs/PROVIDER_RESEARCHER.md`.
- **Keymaster** (`agent-keymaster`): credential custodian — inventory
  only, never values. See `docs/KEYMASTER.md`.
- **Atlas** (`agent-atlas`): the original seed engineer; also runs
  the Nightly repo check product job.

Teamz and Teamily are strictly separate: the agents were added to
Teamz with their skills, tools, and prompts; there is no Teamily
connection of any kind.

## The automations (29 cron jobs + 1 product job)

Built by `scripts/build-runner-state.mjs` from the roster (never
hand-edited into `state.json`); the runner state on jnet1 is
`/var/lib/teamz-runner/state.json`.

| Job | Schedule | Agent | Channel |
|---|---|---|---|
| Hourly: <each of the 26> | `0 * * * *` | the agent | `conv-build-room` |
| Orchestrator triage | `*/15 * * * *` | Orchestrator | `conv-build-room` |
| Provider research sweep | `0 */6 * * *` | Provider Researcher | `conv-build-room` |
| Keymaster credential audit | `0 8 * * *` | Keymaster | `conv-build-room` |
| Nightly repo check (product job) | `0 7 * * *` | Atlas | `conv-build-room` |

Hourly work is scheduler CronJobs (type `prompt`), not ProductJobs:
a ProductJob runs one stage per tick and is done forever once its
last stage completes; CronJobs repeat every time their cron expression
matches. Every hourly target is a concrete, bounded task the agent
can finish in one dispatch, read-only against `/opt/mem20` — see the
`HOURLY_TASKS` table in `scripts/build-runner-state.mjs`. Command
cron jobs are refused (no allowlist).

The Nightly repo check is the one product job that writes: design →
implement → upgrade → document. The implement stage verifies one live
claim with the `repo_read` / `stage_patch` tools; the upgrade stage is
the governed push (allowlisted `sudo /opt/teamz-runner/push-mem20.py`,
gated on the Reviewer — see `docs/PUSH_PATH.md`); the document stage
records the push (commit hash, remote main) or why nothing was
pushed. Most nights there is nothing to fix and the push stage
reports `NOTHING-TO-PUSH`.

## The Build Room (`conv-build-room`)

The channel where the whole team works: all 34 seed agents (4
original: Scout, Atlas, Pixel, Sage; 30 new) are members, so Jesse
can see them communicate. The Orchestrator's standing orders are
posted there as a seed message, and the runner records its agents'
replies as channel messages in the state (`state.channelMessages`),
exposed via `GET /runner-state` so the UI's "Runner automations"
panel shows them.

## The runner and the endpoint

- **Runner** (`scripts/runner.ts` + `scripts/runner-lib.ts`,
  built by `npm run build:runner` to `dist/runner.mjs`, on jnet1 as
  `teamz-runner.service`): ticks every 30s, reloads
  `/var/lib/teamz-runner/state.json` before each tick, saves after.
  One tick handles due triggers, due cron jobs, rate-limit rescues,
  then due product-job stages, sequentially. A failure in one item is
  recorded on that item and logged; it never aborts the rest.
- **Endpoint** (`scripts/agent-endpoint/agent.mjs`, on jnet1 as
  `teamz-agent.service`, port 8897): `POST /chat` (tool loop:
  calculator, wikipedia, weather, web_search, create_automation,
  add_provider, reassign_agent), `GET /health`, `GET /runner-state`
  (read-only), `POST /automations` (localhost-only, governed).
  Upstream is Pollinations anonymous (`openai-fast`) by default, with
  a 50s gap between calls; with `POLLINATIONS_API_KEY` it switches
  to the keyed endpoint with no spacing. There is deliberately no
  Ollama fallback: a failed stage retries instead of filing a bad
  reply as done.
- **Dispatch budget**: `dispatchPromptToAgent` times out at 60s per
  dispatch. On the anonymous tier each dispatch takes ~50s, so the
  26-job hourly batch takes ~22 minutes to drain sequentially — and
  the runner spaces dispatches 50s apart (between dispatches, outside
  any dispatch's 60s budget) so a second dispatch in the same tick
  does not burn its budget waiting for the rate window. The service
  skips ticks while one is still running. See the rate-limit
  assessment in `docs/PROVIDER_RESEARCHER.md`. **Hard limit found
  live Nov 26, 2026: the anonymous tier caps at 100 replies/day/IP
  (402 FREE_LIMIT) — the schedule needs ~127+ dispatches/day, so the
  Pollinations API key is a hard requirement, not a nice-to-have.**

## Governance

Gated stages (`release` / `advertise` / `sell`, or any stage flagged
`spendsMoney` / `publishesPublic` / `destructive`) never execute
without a live approval record (`src/lib/governance.ts`,
`canExecuteStage`). Routine gated stages (`requiresReview`) go to
the Reviewer; carve-outs always go to Jesse. See
`docs/REVIEWER_POLICY.md`.

## Tests

`npm test` — 331 tests (Nov 26, 2026), including the new suites:
`src/lib/reviewer.test.ts`, `src/lib/orchestrator.test.ts`,
`src/lib/runner-flows.test.ts` (Orchestrator mentions, Reviewer
approve/deny/carve-out/fallback, rate-limit rescue through the real
`processDue`), `src/lib/roster.test.ts` (roster/UI parity, Build Room
membership, automation inventory), `src/lib/keymaster.test.ts`
(inventory contains no credential values).
