# Teamz diary

A running record of what changed in this repo and why. Newest first.
Dates are in Jesse's time (MST).

## 2026-11-26 — The 24/7 team: 26 Teamily agents, Orchestrator, Reviewer, Provider Researcher, Keymaster

Jesse's ask (Nov 26, ~00:55–01:10 MST): add ALL 26 Teamily agents to
Teamz, 100% working with an hourly automation each that actually runs
and completes; add a Reviewer that approves most human choices without
Jesse (spending, public releases, destructive actions still need
Jesse); add an Orchestrator that runs every 15 minutes, assigns work
by @mention in the Build Room, and can add new automations; add a
Provider Researcher that finds and adds keyless LLM providers,
balances agents across them, and rescues rate-limited requests;
build tests; write docs; tell the Orchestrator that Teamz owns mem20
and runs it autonomously 24/7; add a Keymaster credential custodian;
then push to GitHub and deploy to jnet1.

Teamz and Teamily are strictly separate — the agents were added with
their skills, tools, and prompts; there is no Teamily connection.

### Roster (31 runner agents, 34 in the Build Room)

- `runner-agents.json` is the single source of truth: 26 Teamily
  agents + Reviewer + Orchestrator + Provider Researcher + Keymaster
  + Atlas = 31 records, all at `http://127.0.0.1:8897/chat`,
  model `openai-fast`. Every system prompt is identical in the UI
  seed (`src/data/mock.ts`) — enforced by test.
- The Build Room (`conv-build-room`) holds all 34 seed agents (4
  originals: Scout, Atlas, Pixel, Sage; 30 new). The Orchestrator's
  standing orders are posted there as a seed message.
- Keymaster (30th new agent): credential custodian — inventory only,
  never a credential value, anywhere.

### Automations (29 cron jobs + the Nightly repo check)

- 26 hourly prompt jobs (`0 * * * *`), one per Teamily agent, each a
  concrete task finishable in one dispatch, read-only against
  `/opt/mem20`. Hourly work is CronJobs, not ProductJobs — a
  ProductJob is done forever once its last stage completes.
- Orchestrator triage every 15 minutes (`*/15 * * * *`).
- Provider Researcher sweep every 6 hours (`0 */6 * * *`).
- Keymaster credential audit daily at 08:00 (`0 8 * * *`).
- Nightly repo check product job unchanged (`0 7 * * *`, Atlas).
- Built by `scripts/build-runner-state.mjs` from the roster; the
  Nightly job, approvals, and triggers are preserved from the live
  state. State lives at `/var/lib/teamz-runner/state.json` on jnet1.

### Orchestrator (mission directive + mention flow + job creation)

- Standing orders, in the system prompt and posted in the Build Room:
  "Teamz owns mem20 and operates without a human in the loop,
  autonomously 24 hours a day, driving mem20 to success and
  completion." Spending, public releases, and destructive actions
  still need Jesse.
- After the Orchestrator's cron dispatch returns, the runner parses
  @mentions (same parser as the UI), dispatches each mentioned agent
  once (max 8, one level, no chaining), and records the replies as
  channel messages in the state so the UI can show them.
- Governed automation creation: `create_automation` tool →
  `POST /automations` (localhost-only) on the teamz-agent service.
  Validates (prompt type, bounded target, known agent, Build Room
  only, valid cron) and appends to state.json atomically. Refuses
  anything that spends, publishes, releases, or deletes — those go
  to Jesse. Docs: `docs/ORCHESTRATOR.md`.

### Reviewer (approval flow)

- Carve-outs first: `release` / `advertise` / `sell`, spending,
  publishing publicly, or destructive work ALWAYS goes to Jesse —
  the Reviewer is never asked.
- Routine gated stages (`requiresReview`) go to the Reviewer, which
  replies `APPROVE: <reason>` or `DENY: <reason>`. Approved → the
  approval is recorded (`decidedBy: 'reviewer'`) and the stage runs
  in the same tick; denied → the job parks. Unreachable or unreadable
  → falls back to a Jesse approval request. Never silently approves.
  Write permission means an approved stage's actions may execute.
  Docs: `docs/REVIEWER_POLICY.md`.

### Provider system (registry, routing, rescue)

- Registry `/var/lib/teamz-agent/providers.json`: keyless providers
  only, validated with a live test call before adding. Pollinations
  anonymous (`openai-fast`) is the only provider validated live
  (Nov 26, 2026: test prompt returned exactly `PING`).
- Failed candidates, recorded honestly: Hack Club AI (404), DuckDuckGo
  AI (418 bot challenge), DeepInfra / Together / OpenRouter / Hugging
  Face (all need an API key), BlackBox AI (returns HTML). Consequence:
  live load balancing across two providers is not possible yet — the
  mechanism is built and tested, the Researcher's sweep keeps hunting,
  and the recommendation is a Pollinations API key (Jesse creates it
  at enter.pollinations.ai).
- Per-agent routing: the endpoint routes each agent's calls by its
  assigned provider (from the runner state); per-provider spacing, so
  one provider's limit never throttles another. `web_search` tool
  (keyless DuckDuckGo Lite, real results) is what the Researcher uses
  to find providers. `reassign_agent` changes only LLM fields in the
  runner state and records every change; `scripts/sync-agent-llm.mjs`
  applies the same change to the UI seed (model only) — with the
  honest caveat that the UI persists to localStorage after first
  load, so a seed change only reaches fresh loads.
- Rate-limit rescue: the endpoint records a 402/429 as an event with
  the failed request retained; the runner's tick wakes the Provider
  Researcher, lets it provision/reassign, then resends the original
  request (retained verbatim, never invented) and records the rescue.
  Docs: `docs/PROVIDER_RESEARCHER.md`.

### Rate-limit assessment

Anonymous tier: ~1 reply/45s per IP, 50s gap enforced, ~50s per
dispatch. The 26-job hourly batch takes ~22 minutes to drain
sequentially, plus Orchestrator/Researcher/Keymaster runs. It fits
inside the hour, barely — with zero retries. One retry pushes the
batch past the hour. Recommendation: the Pollinations API key (see
above). Nothing is silently dropped: a failed dispatch is recorded
as failed and retried on the next due tick.

### Keymaster (credentials — presence only)

- Inventory `docs/credential-inventory.json`, first audit Nov 26,
  2026 (file existence / env presence / CLI login status only — no
  contents read, no values printed): GitHub token present (gh logged
  in on jnet1), Cloudflare token present (token files on jnet1, scope
  unverified, root-held), Agensi OAuth present (Muse connector).
  Missing: Stripe secret + publishable keys (`/opt/mem20/secrets/.env`
  does not exist — the known shop-deploy blocker), Pollinations API
  key, Teamily server key; IONOS credentials missing on jnet1 (held
  by Jesse).
- Secrets store `/var/lib/teamz-secrets` on jnet1: created, `0700`,
  owned by `teamz:teamz`, empty — no values placed, none invented.
  Docs: `docs/KEYMASTER.md`.

### Tests (331 total, all green)

- 281 existing tests still pass. 50 new: `src/lib/reviewer.test.ts`
  (carve-outs, review marker, decision records),
  `src/lib/orchestrator.test.ts` (mention resolution/caps, automation
  validation), `src/lib/runner-flows.test.ts` (Orchestrator mentions,
  Reviewer approve/deny/carve-out/fallback, rate-limit rescue through
  the real `processDue`), `src/lib/roster.test.ts` (roster/UI parity,
  Build Room membership, automation inventory via the real builder),
  `src/lib/keymaster.test.ts` (inventory contains no credential
  values). `npx tsc --noEmit` clean.

### Fixes found by the live tests (same day)

- **Id-form mentions.** The Orchestrator's first live run replied
  `@agent-qa-tester …` (the agent id), which the mention parser did
  not resolve — only the display name (`@QA Tester`) and handle
  (`@qa-tester`) resolved. `resolveMentionedAgents` now accepts the
  id form too, with a test for it.
- **Second-dispatch timeout.** A mention dispatch fired right after
  the Orchestrator's own dispatch burned ~50s of its 60s budget
  waiting for the endpoint's rate window, then failed with
  "Pollinations did not respond in the time left". The runner now
  waits 50s *between* dispatches (`minDispatchGapMs`), outside any
  dispatch's budget, and the service skips ticks while one is still
  running (tick guard). The hourly batch drains over ~22 minutes
  instead of failing halfway.
- **Build order.** `npm run build` (vite) wipes `dist/`, so
  `dist/runner.mjs` must be built *after* the UI build
  (`build:runner` last), or it is deleted.
- **Daily free limit (402 FREE_LIMIT).** At ~08:46 UTC the anonymous
  tier hit its 100 replies/day/IP cap and every dispatch failed
  until the 00:00 UTC reset. The schedule needs ~127+ dispatches a
  day, so the Pollinations API key is a hard requirement, not a
  recommendation. The same day also exposed that the rate-limit
  events file was root-owned (the service could not write it) and
  that the endpoint logged "recorded" even when the append failed —
  both fixed (ownership + a real success return from
  `recordRateLimitEvent`).
- **Tool-arg format.** The Provider Researcher first called
  `reassign_agent` with a bare agent id instead of a JSON object, so
  the tool failed. The tool error messages now show an example JSON
  object. The QA Tester pin was applied through the `reassign_agent`
  tool function directly because the model retry was blocked by the
  402 — the write path is the same code, but the model's own
  invocation of it was not demonstrated live.
- **`web_search` parser.** DDG Lite anchors put `href` before
  `class` and use single quotes; the first parser matched neither
  and returned nothing. Fixed (order-independent match), plus an
  HTML-endpoint fallback. DDG still serves 202 challenge pages
  intermittently from this server IP — the tool says so plainly
  instead of inventing results.
- **Truncated JSON replies.** The model once emitted a truncated
  `{"action":"final",…` blob with no closing brace, and the raw blob
  was shown to the user. `parseAction` now salvages the "final" text
  out of a truncated or malformed blob.

### Deploy (jnet1, Nov 26, 2026)

Final deployed state (verified live, all three services active):
- Runner: `/opt/teamz-runner/runner.mjs` md5 `b02d97b1535eb262485613654a3acaa5`
  (50s inter-dispatch spacing + tick guard).
- Endpoint: `/opt/teamz-agent/agent.mjs` md5
  `be1a59b5633ee571066af668b3e8ad30` (tool loop + `/runner-state` +
  `web_search` + `create_automation` + `add_provider` +
  `reassign_agent` + `/automations` + rate-limit recording).
- UI: `/opt/teamz-ui/dist`, bundle `index-DnvsEBDZ.js` (Keymaster +
  mission directive in the served JS).
- State: `/var/lib/teamz-runner/state.json` — 31 agents, 29 cron jobs,
  Nightly repo check, 0 approvals. Runner restarted after the
  controlled tests.
- **Known live condition at deploy time: Pollinations anonymous tier
  is at its 100/day/IP cap (402 FREE_LIMIT, resets 00:00 UTC). All
  dispatches fail until the reset or until Jesse adds the API key.**
  The runner is running and will retry on the next due tick; failures
  are recorded, not silent.

### Commit (pushed Nov 26, 2026)

`974145c` — "Teamz autonomy: 31 agents, hourly automations, Reviewer,
Orchestrator, Provider Researcher, Keymaster" (`1440b10..974145c`,
`main`, 28 files, +5926/−29). `deploy/__pycache__/` intentionally
not committed.

- Pushed to `bythewayz66-glitch/teamz` (main) — Jesse explicitly
  authorized this push; no workflow files touched.
- Runner rebuilt (`npm run build:runner`) and redeployed
  (`/opt/teamz-runner/runner.mjs`); agent endpoint redeployed
  (`/opt/teamz-agent/agent.mjs`, merged onto the deployed copy —
  tool loop + `/runner-state` both verified live after deploy); UI
  rebuilt and redeployed (`/opt/teamz-ui/dist`).
- State rebuilt from the live state (Nightly job preserved): 31
  agents, 29 cron jobs. Providers registry, reassignments file, and
  credential inventory on jnet1; secrets store created.
- Live verification: `/chat` with the tool loop answers; `/runner-state`
  serves 31 agents / 29 cron jobs; a real hourly dispatch completed
  and was recorded; an Orchestrator run @mentioned an agent and the
  mention dispatch fired; a routine gated stage was approved by the
  Reviewer and proceeded while a release stage still filed a Jesse
  approval; a simulated rate-limit event woke the Researcher, the
  original request was resent and completed, and the rescue was
  recorded. (Simulation is labelled as such in the verification notes.)

### Still needs Jesse

- Pollinations API key (enter.pollinations.ai) — removes the
  anonymous-tier rate limit; the hourly math says the schedule only
  just fits without it.
- Stripe secret + publishable keys in `/opt/mem20/secrets/.env` —
  blocks the live shop deploy (4 priced tier SKUs).
- Teamily server key — only if a Teamily link is ever built (none is).
