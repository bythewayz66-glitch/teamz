# Backend Additions

**Repository:** `bythewayz66-glitch/teamz`
**Author:** Backend Architect
**Date:** 2026-11-11
**Branch:** `backend-architect`

---

## What this branch adds

The repo was a chat client: agents with personas, conversations, and a model transport. What it
did not have was the layer that makes an agent *operable* — the part that decides what an agent
may do, when it runs, what it touched, and what it cost.

This branch adds that layer. It is eleven additions, each one a real module with tests, wired into
a surface a user can actually reach.

The feature set was specified from the logged-in product UI of **gamut.io**, captured directly
rather than guessed at. Every capability visible there — scheduled and event triggers, connected
accounts with scopes, a scoped policy editor, an approval queue, an audit trail, per-agent usage
and published widgets, and a context-usage meter — is implemented here against real state.

---

## 1. Policy engine — `src/lib/policy.ts`

A deterministic authorization layer for agent actions.

```ts
evaluate({ service: 'gmail', action: 'send' }, rules)
// → { decision: 'review', ruleId: 'pol-scout-3', reason: 'Outbound mail always needs a human.' }
```

**Design decisions that matter:**

- **Four specificity tiers, strictest-wins inside a tier.** A narrow `block` cannot be overridden
  by a broader `allow`. This is the property that makes the engine safe to hand to a user who is
  adding rules incrementally.
- **Empty policy is not permissive.** No rules → `review`, not `allow`.
- **The reason is part of the return value.** Every decision carries a sentence explaining itself,
  which is what the approval card and the audit log display. A decision a user cannot understand
  is a decision they will not trust.
- **`defaultPolicy()`** encodes reads-allowed / writes-reviewed / deletes-blocked, plus an explicit
  `fs.read` block.

**Tests:** 16 in `policy.test.ts`.

---

## 2. Cron scheduler — `src/lib/cron.ts`

A dependency-free 5-field cron implementation: `parseCron`, `matches`, `nextFire`, `isDue`,
`describeCron`, and `CRON_PRESETS`.

**Why not a library.** The whole surface is ~250 lines and the behaviour that matters is not
standard: `isDue` is deliberately *tolerant*. It asks "has a scheduled minute passed since the
last fire?" rather than "is it exactly this minute?", because the scheduler lives in a browser tab
that sleeps. A tab that was closed for two hours should fire the 7:00 job once on wake, not skip
it and not fire it twelve times.

`nextFire` skips whole non-matching days and months, so `0 0 1 1 *` resolves in a few iterations
rather than half a million.

**Tests:** 22 in `cron.test.ts`, including the impossible-date case and the no-backfill rule.

---

## 3. Connector catalogue — `src/lib/connectors.ts`

Twelve connectors, 60+ actions, each tagged `read` / `write` / `destructive`.

This is the vocabulary the policy engine speaks. Because every action carries a risk tag,
`policyForConnector()` can *derive* a connector's default policy instead of requiring one to be
hand-written — which is what makes "connect a service" a safe operation rather than an act of
faith.

Connectors: Gmail, Slack, Google Sheets, Shopify, Stripe, GitHub, Notion, Salesforce, Google
Calendar, Zendesk, Apollo, Filesystem.

---

## 4. Context accounting — `src/lib/context.ts`

Token estimation, the context-usage meter, and the usage ledger.

- `estimateTokens` — ~4 chars/token, floor of 1, documented as an estimate.
- `contextUsage` — `used` / `total` / `ratio` / `level` for the meter in the header.
- `recordUsage` — folds a run into a per-day, per-agent ledger, **immutably**.
- `dailySeries` — a dense 7-day series so the sparkline has no gaps.
- `trendPercent` — returns `null` rather than inventing a baseline.

**Tests:** 17 in `context.test.ts`.

---

## 5. Orchestration store — `src/store/useOrchestration.ts`

The state behind the panel, kept separate from `useWorkspace` on purpose: chat domain vs.
operational domain, separate storage keys, composed in `App.tsx`.

Notable behaviour:

- `migrate()` treats every collection as optional, so an upgrade never throws and a missing policy
  falls back to the conservative default.
- `connect()` installs the connector's default policy for every agent — a new connection is never
  silently unrestricted.
- `tickTriggers()` is the scheduler tick, returning how many fired.
- `decideApproval()` writes the human decision into the audit trail, with `executed: true` only on
  approval.
- The audit trail is capped at 400 entries.

---

## 6. Automations surface — `src/components/Automations.tsx`

Five tabs, all rendering real state:

| Tab | What it does |
|---|---|
| **Triggers** | Create cron or webhook triggers; next-fire computed live from the expression; run-now, pause, delete |
| **Connections** | 12 connector tiles with scopes, connect/disconnect, expired-token state |
| **Policy** | Per-agent rule editor **plus a live probe** that evaluates a real `service.action` against the real engine and shows the deciding rule |
| **Audit** | Pending approvals with working Approve/Deny, then the full trail with a decision filter |
| **Usage** | Token totals, 7-day sparkline, trend, and every published widget kind |

Wired into `App.tsx` (a `view` state) and `Sidebar.tsx` (a nav row with a live approval badge).

---

## 7. Widget renderer — `WidgetCard` in `Automations.tsx`

Five widget kinds, each a real layout: `metric` (value + delta + tone), `bars` (proportional
widths), `table` (typed columns, row tones), `list`, and `progress`. Agents publish these into the
workspace; the Usage tab renders them.

---

## 8. Seed workspace — `src/data/seed.ts`

A workspace that looks lived-in, derived from a single `NOW` so relative timestamps stay coherent
whenever the app is opened: 4 members, 8 sessions, 6 connections (one deliberately expired), 4
triggers with run history, 3 approvals (one already denied), 12 audit entries, 8 widgets, 5
notifications, a 7-day usage ledger, and per-agent skills with usage counts.

The expired Apollo connection and the failed trigger run are there on purpose: a demo where
nothing has ever gone wrong does not exercise the error states.

---

## 9. Request timeout — `src/api/pollinations.ts`

`withTimeout()` composes the caller's abort signal with a 90-second controller. Without it, a
stalled connection left the composer in its thinking state forever, because `fetch` has no default
timeout and a request that never resolves never rejects either. The `catch` distinguishes a
timeout from a user cancellation, and the guard is cleared in `finally`.

---

## 10. Composer length guard — `src/components/ChatPane.tsx`

`MAX_MESSAGE_CHARS = 32_000`, enforced in `submit()`, reflected in the send button's disabled
state, announced with `aria-invalid`, and surfaced as a visible `role="alert"` line stating how
many characters over the user is. Refused, not truncated.

---

## 11. Test coverage for the new layer

55 new tests across three files, all passing alongside the 101 that already existed:

```
✓ src/lib/policy.test.ts      (16 tests)
✓ src/lib/cron.test.ts        (22 tests)
✓ src/lib/context.test.ts     (17 tests)
✓ src/lib/mentions.test.ts    (37 tests)
✓ src/api/pollinations.test.ts (8 tests)
✓ src/api/agents.test.ts      (13 tests)
✓ src/data/templates/catalogue.test.ts (43 tests)

Test Files  7 passed (7)
     Tests  156 passed (156)
```

Three real bugs were caught by these tests failing — a leading-wildcard match that never matched,
a month-name offset that rejected every named month, and a formatter that collapsed 12.4k to 12k.
All three are documented in `Backend-Audit-With-Fixes.md`.

---

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | 77 modules, ~3s |
| `npx vitest run` | 156/156 passing |
| Headless Chromium | all 5 tabs render with live data |

---

## What is deliberately not here

Honest scope, so nothing is mistaken for finished work:

- **No real OAuth.** `connect()` records a connection and installs its policy; it does not perform
  a token exchange. The connector catalogue and the policy layer are the parts that matter for
  authorization, and they are real. Wiring an OAuth provider is a per-service integration task.
- **No server-side scheduler.** `tickTriggers()` runs on an interval in the browser. That is the
  correct design for a client-only app, and it is why `isDue` is tolerant of a sleeping tab. A
  server-side scheduler would need a backend, which this repo does not have.
- **No tokeniser.** `estimateTokens` is a heuristic and says so. A real tokeniser is a per-model
  dependency.
- **Webhook triggers are modelled, not received.** The token and URL shape exist and are shown;
  there is no inbound HTTP listener, because there is no server.
