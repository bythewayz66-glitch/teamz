# Provider Researcher — providers, load balancing, rate-limit rescue

The Provider Researcher (`agent-provider-researcher`) has one job:
find keyless, free LLM providers, verify them, and spread the agents
across them so no single provider's rate limit stops the team.

## The registry

`/var/lib/teamz-agent/providers.json` on jnet1:

```json
{
  "providers": [
    { "id": "pollinations", "name": "Pollinations (anonymous tier)",
      "baseUrl": "https://text.pollinations.ai/openai", "model": "openai-fast",
      "keyless": true, "validatedAt": "…", "lastValidated": "…", "notes": "…" }
  ],
  "validationLog": [{ "ts": "…", "candidate": "…", "ok": false, "reason": "…" }]
}
```

Rules, enforced in code (`scripts/agent-endpoint/agent.mjs`):

- **Only keyless providers. Never paid, never keyed.** A candidate that
  needs an API key, a card, or payment is refused.
- **Validate BEFORE adding.** `provisionProvider` makes a real test
  call (a PING prompt to the candidate's OpenAI-compatible chat
  endpoint) and requires a real, non-empty reply. A candidate that
  fails is recorded in `validationLog` and **not** added.
- The registry is the only place providers live. The endpoint routes
  each agent's calls by that agent's current provider assignment
  (`agent.provider`, from the runner state) — Pollinations is the
  default when unassigned, and the Pollinations path is untouched.
- Per-provider rate handling: upstream calls are serialised **per
  provider** with that provider's own gap (Pollinations anonymous:
  50s; other keyless providers: a 5s courtesy gap). One provider's
  limit never throttles another.

## Validation status (Nov 26, 2026 — all checked live from jnet1)

| Candidate | Result |
|---|---|
| Pollinations anonymous (`text.pollinations.ai/openai`, `openai-fast`) | **Validated** — test prompt returned exactly `PING`. The only provider in the registry. Note: the anonymous tier offers exactly one model (`openai-fast`). |
| Hack Club AI (`ai.hackclub.com/chat/completions`) | Failed — HTTP 404, endpoint gone. |
| DuckDuckGo AI (`duckduckgo.com/duckchat/v1/chat`) | Failed — HTTP 418, bot challenge from a server IP. |
| DeepInfra, Together, OpenRouter, Hugging Face router | Failed — all require an API key (401 / "missing API key"). |
| BlackBox AI (`blackbox.ai/api/chat`) | Failed — returns an HTML page, no API. |

Consequence, stated plainly: **live load balancing across two
providers is not possible yet** — there is only one validated keyless
provider. The mechanism (below) is built and tested; the Researcher's
scheduled sweep keeps hunting for a second one. The honest
recommendation is a Pollinations API key (Jesse creates it at
`enter.pollinations.ai`), which removes the anonymous-tier rate limit
entirely — see the rate-limit assessment at the end.

## Per-agent routing and reassignment

- The runner sends `agent.provider` with every dispatch
  (`scripts/runner-lib.ts`, `buildAgentRequest`; the field is
  whitelisted in `loadRunnerState` so it survives reloads).
- The endpoint resolves the provider from the registry and calls it
  (Pollinations via its existing client, others via a generic
  OpenAI-compatible client).
- The Researcher changes an agent's LLM assignment with the
  `reassign_agent` tool, which updates **only** the `provider` and
  `model` fields of that agent in `state.json` (atomic write) — never
  system prompts, skills, or anything else — and only to a validated
  keyless provider. Every change is recorded in
  `/var/lib/teamz-agent/reassignments.json`: which agent, from which
  LLM to which, when, and why (e.g. rate limit).
- The UI seed is source code, so the same change reaches it through
  `scripts/sync-agent-llm.mjs --reassignments <file>`, which writes
  only the agent's `model` (and `endpointUrl` when the provider's
  endpoint differs) in `src/data/mock.ts`, refuses any provider not in
  the validated registry, and then the UI is rebuilt and redeployed.
  Honest caveat: the UI persists to localStorage on Jesse's phone
  after first load, so a seed change only reaches fresh loads — the
  live assignment is what the endpoint uses and what `/runner-state`
  shows.

## The web_search tool

`web_search` (in the endpoint's tool loop) is keyless DuckDuckGo Lite
(`lite.duckduckgo.com`): it fetches the results page and returns the
real top-5 titles and links, or says plainly that nothing came back.
It never fakes results. This is what the Researcher uses to find
providers. (Verified live from jnet1 on Nov 26, 2026.)

## Scheduled sweep

`cron-provider-researcher-6h` (`0 */6 * * *`, `conv-build-room`): a
regular research/rebalancing run — find one new keyless provider,
validate it, provision it, reassign one agent, and report the provider
inventory and the assignment table.

## Rate-limit rescue (event-driven, not scheduled)

1. **Detect.** When an upstream call is refused (402/429), the endpoint
   appends an event to `/var/lib/teamz-agent/rate-limit-events.jsonl`
   with the failed request **retained** (agent, channel, prompt,
   provider, error). It answers 429 honestly; nothing is faked as a
   success.
2. **Wake.** The runner's own tick (every 30s — never a tight loop)
   reads unhandled events (`scripts/runner.ts`) and `processDue`
   dispatches the Provider Researcher with the failed-request context.
   The Researcher uses its tools to find, validate, provision, and
   reassign — and it can run even when the rate-limited provider is
   the one it would normally use, because the runner's dispatch goes
   through the endpoint's per-provider routing: a different provider,
   once provisioned, serves the Researcher, and until one exists the
   rescue still proceeds on the original provider after the rate
   window passes.
3. **Resend.** After the Researcher replies, the runner re-reads the
   agent address book from disk (the Researcher's tools may have
   reassigned the agent in `state.json`) and **resends the agent's
   original request** on the (possibly new) provider. The failed
   request is retained in the event and resent verbatim — never
   invented, never lost.
4. **Record.** The rescue is recorded in the runner state
   (`state.rateLimitRescues`: event id, agent, from/to provider,
   whether the resend happened and completed, the Researcher's reply,
   attempt count) and the event is acknowledged. An event with a
   completed rescue — or 3 failed attempts — is not retried; the
   failure stays on the record.
5. **Standby.** The Researcher returns to standby until the next
   trigger or its next scheduled sweep.

## Daily free limit — the anonymous tier cannot sustain this workload (found live Nov 26, 2026)

At ~08:46 UTC on Nov 26, 2026 the endpoint started returning
`Pollinations 402 FREE_LIMIT: "Free limit reached: 100 replies a day
per IP. It resets at 00:00 UTC, in 16 hours."` Every dispatch after
that failed until the reset. The day's minimum upstream load is
already over the cap: 26 hourly jobs + 96 Orchestrator runs (every 15
min) + Provider Researcher + Keymaster ≈ 127 dispatches a day, and
every tool-using dispatch costs 2+ upstream calls (propose, then
propose again after the tool result), so the real load is higher
still — plus retries. The anonymous tier **cannot sustain this
schedule**. The Pollinations API key is no longer a recommendation;
it is a hard requirement for the runner to work at all: Jesse creates
it at `enter.pollinations.ai` and sets `POLLINATIONS_API_KEY` on
`teamz-agent.service`, and the service switches to the keyed endpoint
with no per-IP daily cap and no 50s spacing. Until then, every
dispatch fails with 402, the failures are recorded (not silent), and
the runner retries on the next due tick — and the rate-limit rescue
loop cannot help, because the Researcher itself is blocked by the
same cap and no second keyless provider has validated.

Two bugs the 402 exposed, fixed the same day:
- The rate-limit events file was root-owned (created by a root shell
  append), so the teamz service could not write to it — and the
  endpoint logged "rate-limit event recorded" unconditionally even
  when the append failed, so a real 402 event was lost while the log
  claimed success. `recordRateLimitEvent` now returns whether the
  append actually succeeded and the handler only logs "recorded" on
  success. Files are owned by `teamz:teamz`.
- The endpoint retries a 402 with backoff (25s) inside the dispatch
  budget, which wastes the budget on a limit that resets in 16 hours.
  The retry stays — a transient 429 is worth one retry — but the
  rescue loop, not the retry, is the mechanism that matters.

## Rate-limit assessment (Nov 26, 2026)

The anonymous tier allows ~1 reply per 45s per IP, and the endpoint
enforces a 50s gap between upstream calls. Each dispatch takes ~50s,
so the hourly batch of 26 jobs takes ~22 minutes of sequential
dispatches to drain, plus the Orchestrator (4/hour) and the Researcher
and Keymaster runs. That **fits inside the hour, barely** — but only
just, and only while nothing retries: a single rate-limit retry pushes
the batch past the hour and the next hour's jobs queue behind it.
The Orchestrator's mention dispatches add more calls on top.

One failure the live tests caught (Nov 26, 2026): a second dispatch
in the same tick burned ~50s of its 60s budget waiting for the
endpoint's rate window, then failed with "Pollinations did not respond
in the time left". The fix is in the runner, not the timeout: the
runner now waits 50s **between** dispatches (`minDispatchGapMs` in
`scripts/runner-lib.ts`, wired to 50s in `scripts/runner.ts`), outside
any dispatch's 60s budget, so every dispatch's model call fits its
budget. The tick gets longer — the hourly batch drains over ~22
minutes — and the service skips ticks while one is still running
(tick guard in `scripts/runner.ts`), so a long tick can never fire
the same jobs twice. On the anonymous tier the schedule is sustainable
with this spacing, but with no headroom for bursts. **Recommendation:
Jesse creates a Pollinations API key at `enter.pollinations.ai`** and
sets it as `POLLINATIONS_API_KEY` on `teamz-agent.service` — the
service then switches to the keyed endpoint with no per-IP spacing
and the full tool loop fits in a dispatch. Until then, jobs are never
silently dropped: a failed dispatch is recorded as failed and retried
on the next due tick.

## Tests

`src/lib/runner-flows.test.ts` (rescue loop through the real
`processDue`: Researcher woken, original request resent, rescue
recorded, completed events not retried) and `src/lib/roster.test.ts`
(provider routing fields in the roster).
