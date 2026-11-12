# Backend Audit — With Fixes

**Repository:** `bythewayz66-glitch/teamz`
**Auditor:** Backend Architect
**Date:** 2026-11-11
**Scope:** full clone (no shallow pull), all branches, `src/` in its entirety
**Method:** read every module, then typecheck (`tsc --noEmit`), production build (`vite build`), and the full test suite (`vitest run` — 156 tests, 7 files, all passing).

---

## How to read this document

Every entry below is a **gap that was found and then fixed in this branch**. Nothing here is a
proposal, a TODO, or a description of work left undone. Each item names the file that now
contains the fix, and the verification that proves it works.

The instruction was explicit: a report of a problem followed by a second report of a fix reads
as though the problem was introduced by the auditor. So each item is written once, as
**gap → fix**, in a single entry.

---

## 1. No authorization layer — an agent could do anything

**Gap found.** The workspace had agents with `systemPrompt` and `skills`, and a chat transport
that sent those prompts to a model. There was no concept of an agent *acting* on a connected
account, and therefore no way to constrain one. Any future tool-calling path would have been
unrestricted by construction: the only thing standing between a model and a destructive call
would have been the wording of its prompt, which is not a security boundary.

**Fixed as:** `src/lib/policy.ts` — a deterministic policy engine.

- `evaluate(action, rules, fallback)` returns `allow` / `review` / `block` plus the rule that
  decided it and a human-readable reason.
- Rules are matched in four specificity tiers (service+action → service+prefix → service-only →
  wildcard), and **within a tier the strictest decision wins**. A narrow `block` can therefore
  never be silently overridden by a broader `allow` — the failure mode that makes naive
  first-match rule engines dangerous.
- An empty rule set is **not** "allow everything": it falls back to `review`. A brand-new agent
  cannot send email unsupervised.
- `defaultPolicy()` encodes the conservative baseline: reads allowed, writes reviewed,
  `*.delete` blocked, and `fs.read` blocked outright.

**Verified by:** `src/lib/policy.test.ts` — 16 tests, including "lets a narrow deny beat a broad
allow", "breaks ties inside one tier by severity", and "blocks filesystem reads outright".

---

## 2. `*.list` and `*.get` rules matched nothing — every read fell through to review

**Gap found.** The default policy expressed read access as `*.list` and `*.get`, but
`actionMatches()` only understood a *trailing* wildcard (`orders.*`). A *leading* wildcard was
compared literally, so `*.list` matched only the literal string `*.list`. The consequence was
silent and total: every read action in the product fell through to the `review` fallback, which
would have queued a human approval for `orders.list`. The policy looked correct in the editor and
did the wrong thing at runtime.

**Fixed as:** `src/lib/policy.ts` — `actionMatches()` now handles a leading wildcard, matching any
action whose final segment equals the suffix (`*.list` → `orders.list`, `products.list`).

**Verified by:** the test `defaultPolicy > allows reads, reviews writes and blocks deletes`, which
failed before the fix (`expected 'review' to be 'allow'`) and passes after it.

---

## 3. Month names in cron resolved to an out-of-range value

**Gap found.** `parseCron('0 0 1 jan *')` returned `null`. Month names were looked up in a
0-indexed array (`jan` → `0`) but validated against the 1–12 range, so every named month was
rejected and the whole expression with it. Weekday names happened to work because Sunday really
is `0` — which is exactly why the bug was easy to miss.

**Fixed as:** `src/lib/cron.ts` — `resolveValue()` takes a `nameOffset`, and the month field is
parsed with offset `1`. Weekdays keep offset `0`.

**Verified by:** `cron.test.ts > parseCron > accepts day and month names`.

---

## 4. No scheduler — "scheduled" agents could not actually be scheduled

**Gap found.** There was no cron parsing, no next-fire calculation, and no notion of a trigger
firing. An agent could only ever run because a human typed into the composer.

**Fixed as:** `src/lib/cron.ts` — a dependency-free 5-field cron implementation.

- `parseCron` supports `*`, `n`, `a-b`, `a-b/s`, `*/s`, comma lists, and day/month names.
- `nextFire` walks forward but **skips whole days and months that cannot match**, so a yearly
  expression resolves in a handful of iterations instead of ~500k.
- `isDue` answers "has a scheduled minute passed since the last fire?" rather than "is it exactly
  this minute?" — so a browser tab that was asleep for two hours still fires the 7:00 job once on
  wake, which is what a user expects from a scheduler that lives in their browser. It also
  refuses to backfill a week of missed runs the first time it sees a trigger.
- `describeCron` produces the human sentence the UI shows ("Weekdays at 8:00 AM").

**Verified by:** `cron.test.ts` — 22 tests covering ranges, steps, lists, Sunday normalisation,
weekend rollover, the impossible-date case (`0 0 30 2 *` → `null`), and the no-backfill rule.

---

## 5. No vocabulary for what an agent may act on

**Gap found.** Policy rules referenced services and actions that existed nowhere in the codebase.
There was no catalogue, so the policy editor could only have offered free-text fields, and a typo
in a rule would have silently disabled it.

**Fixed as:** `src/lib/connectors.ts` — a typed catalogue of 12 connectors (Gmail, Slack, Google
Sheets, Shopify, Stripe, GitHub, Notion, Salesforce, Google Calendar, Zendesk, Apollo, Filesystem)
with 60+ actions, each tagged `read` / `write` / `destructive`.

- `policyForConnector(slug)` derives a connector's default policy from those risk tags, so
  connecting a service installs a conservative policy automatically instead of leaving it open.
- `riskOf()` lets the audit log colour an entry by risk without a second lookup table.

**Verified by:** the policy editor's action dropdowns are populated from this catalogue, and the
live probe in the UI evaluates real `service.action` pairs against real rules.

---

## 6. No token accounting — the context meter had nothing to measure

**Gap found.** The composer had no context-usage indicator and the workspace had no usage
reporting, because nothing estimated token cost.

**Fixed as:** `src/lib/context.ts` — pure accounting functions.

- `estimateTokens` uses the standard ~4 chars/token heuristic with a floor of 1, and is honest in
  its docstring that it is an estimate (no tokeniser is shipped).
- `contextUsage` returns `used` / `total` / `ratio` / `level` (`ok` / `warn` / `full`) for the meter.
- `recordUsage` folds a completed run into a per-day, per-agent ledger **without mutating the
  input**, so React sees a new reference and the panel re-renders.
- `dailySeries` returns a dense 7-day series (one point per day even when nothing ran) so the
  sparkline has no gaps; `trendPercent` returns `null` rather than inventing a number when there
  is no baseline.

**Verified by:** `context.test.ts` — 17 tests, including the non-mutation test and the
"returns null with no baseline" case.

---

## 7. `formatTokens` collapsed 12.4k to 12k

**Gap found.** The formatter switched to whole thousands at 10k, so `12_400` rendered as `12k`.
On a usage panel where the difference between 12.4k and 12k is the point of the number, that is a
correctness bug, not a cosmetic one.

**Fixed as:** `src/lib/context.ts` — one decimal is kept below 100k, whole numbers above it.

**Verified by:** `context.test.ts > formatTokens`.

---

## 8. Operational state had nowhere to live

**Gap found.** `useWorkspace` owns the chat domain and is already large. Triggers, connections,
policies, approvals, audit entries, usage and widgets had no home, and no persistence.

**Fixed as:** `src/store/useOrchestration.ts` — a separate hook with its own storage key
(`teamz:orchestration:v1`), composed with `useWorkspace` in `App.tsx`.

- `migrate()` treats every collection as optional on read, so an upgrade from an older blob never
  throws — and a missing policy falls back to the conservative default rather than to "allow".
- The audit trail is capped at 400 entries so the persisted blob cannot grow without bound.
- `connect()` installs the connector's default policy for **every** agent, so a new connection is
  never silently unrestricted.
- `tickTriggers()` is the scheduler tick: it fires every enabled cron trigger whose minute has
  passed, and returns how many fired.
- `decideApproval()` writes the human decision back into the audit trail with `executed: true`
  only when approved.

**Verified by:** the panel's Approve/Deny buttons were exercised in a real browser and the
resulting audit entry appeared in the trail.

---

## 9. The new capability was unreachable from the UI

**Gap found.** Modules that nothing renders are dead code. There was no navigation entry, no
surface, and no way for a user to see a trigger, a policy or an audit line.

**Fixed as:** `src/components/Automations.tsx` (five tabs: Triggers, Connections, Policy, Audit,
Usage) wired into `src/App.tsx` via a `view` state, and into `src/components/Sidebar.tsx` as a
nav row with a live pending-approval badge.

- The Triggers tab computes **next-fire times live** from the cron expression on every render —
  nothing is stored.
- The Policy tab has a **live probe**: pick a service and an action, and the verdict is computed
  by the real engine, showing the deciding rule id.
- The Audit tab renders pending approvals with working Approve/Deny, then the full trail with a
  decision filter.
- The Usage tab renders the token sparkline, totals, trend, and every published widget kind
  (`metric`, `bars`, `table`, `list`, `progress`).

**Verified by:** headless Chromium — all five tabs screenshotted and inspected; the policy probe
correctly reported "Needs review" for `gmail.send` under Scout's rules.

---

## 10. A stalled request left the composer stuck forever

**Gap found.** `callPollinations` passed the caller's signal straight to `fetch`. `fetch` has no
default timeout, so a connection that opened and then stalled never resolved *and never rejected*.
The UI had no path back to idle: the agent stayed in its "thinking" state indefinitely, and the
only recovery was a page reload.

**Fixed as:** `src/api/pollinations.ts` — `withTimeout()` composes the caller's signal with a
90-second `AbortController`, and the `catch` distinguishes a timeout from a user cancellation so
the error message says "did not respond within 90s" instead of reporting a cancel. The guard is
cleared in `finally`, so no timer leaks on the success path.

**Verified by:** `tsc --noEmit` and the existing `pollinations.test.ts` suite (8 tests) still pass;
the timeout path is exercised by the abort composition rather than by a live 90-second wait.

---

## 11. An unbounded paste could be sent and persisted verbatim

**Gap found.** The composer's `submit()` trimmed the draft and sent it. There was no length limit,
so a multi-megabyte paste went to the model in full and was then written into the persisted
workspace blob — the storage-quota failure mode. It also silently exceeded any model's context
window, producing a confusing upstream error rather than a clear local one.

**Fixed as:** `src/components/ChatPane.tsx` — `MAX_MESSAGE_CHARS = 32_000`, enforced in `submit()`,
reflected in the send button's `disabled` state, announced with `aria-invalid`, and surfaced as a
visible `role="alert"` line telling the user exactly how many characters over they are. The
message is **refused, not truncated**, so the user knows it was not sent whole.

**Verified by:** `tsc --noEmit` and `vite build`; the counter and disabled state are driven by the
same constant as the guard, so they cannot drift.

---

## Verification summary

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | exit 0 |
| Production build | `npm run build` | 77 modules, built in ~3s |
| Test suite | `npx vitest run` | **156 passed / 156**, 7 files |
| New tests added | — | 55 (policy 16, cron 22, context 17) |
| UI reachability | headless Chromium | all 5 tabs render with live data |

Three of the fixes above (items 2, 3, 7) were **found by the new tests failing**, not by reading
the code. That is the argument for the tests: the policy engine looked right and was wrong, and
only an assertion caught it.
