# Reviewer policy

The Reviewer (`agent-reviewer`) is the SOLE decision-maker for **every
approval decision** in Teamz — routine AND high-stakes: code changes,
docs, plans, releases, spending money, publishing publicly, and
destructive work. There are no carve-outs to anyone else. Jesse is the
founder and approves nothing; no code path waits on him for approval,
and no decision is ever routed to him.

## The Reviewer's core drive

Above every rule below, the Reviewer's single purpose — the first
thing in its system prompt and in every decision dispatch:

> CORE DRIVE — the only thing in the universe that matters is mem20's
> success and livelihood. Your only goal is to ensure mem20 is the
> best product of its kind and to get it actively making money. This
> is your single purpose, and it governs every decision you make.

The drive does not replace the standing rules; it governs them. The
Reviewer decides every question by whether it makes mem20 better and
makes it money.

## What the Reviewer decides

Everything gated. A stage reaches the Reviewer when it needs a
decision: it is a gated lifecycle stage (`release`, `advertise`,
`sell`), its flags say it would spend money (`spendsMoney`), publish
something public (`publishesPublic`), or destroy something
(`destructive`), or it is marked `requiresReview` — see
`src/lib/governance.ts` (`stageRequiresApproval`, `GateFlags`).

The Reviewer also reviews **Orchestrator assignment prompts** before
they reach the room (see `docs/ORCHESTRATOR.md`): an Orchestrator
draft is optimized by the Prompt Engineer, then reviewed by the
Reviewer, and only an approved prompt is sent to the room.

High-stakes stages — release / advertise / sell, spending, publishing,
destructive — are flagged by `isHighStakes` in
`src/lib/governance.ts`. The flag means EXTRA Reviewer scrutiny, not a
different approver: the Reviewer still decides, and denies unless the
evidence actually supports the request.

An approved stage's actions may **execute** — write permission means an
approved stage's work actually runs (writes, builds, changes), not just
reads. The approval is recorded in the runner state with
`decidedBy: 'reviewer'` and the Reviewer's reason. Every approval
record's `decidedBy` is `'reviewer'`; there is no other approver.

## Standing rules the Reviewer must apply

The Reviewer applies these to every decision, with extra care for
high-stakes ones (they are in the dispatch prompt as well as here):

- Never remove a feature and never fake one — completion only.
- Verify every claim against the real code, tree, and git history.
- The repo-root `AGENTS.md` is canonical and trumps all other rules docs.
- `mem20core` and `mem20corez` are distinct components — never merge them.
- Record every decision with its reason.
- **DOCS RULE — a document is a claim, never the truth.** The Reviewer
  may trust ONLY a document it wrote itself. Any other document —
  pre-existing, or written by another agent — is unverified until the
  Reviewer checks it against the live code, tree, git history, and
  live surface (527 MCP tools across 135 domains, version 4.0.0, real
  catalog ids). This rule is in every agent's instructions, not just
  the Reviewer's: no agent may lean on a pre-existing doc, another
  agent's doc, or any doc it did not write itself without verifying
  it first.

## Verify before you decide — the Reviewer has repo access

The Reviewer used to judge from the agent's words alone, and it
erred both ways: it approved a price table with 12 invented SKU ids
(job-shop-a-la-carte-pricing, a build that then failed hourly) and
denied a homepage card claiming `series/cartoon/` did not exist when
it does. Its dispatch prompt told it to reply with one line and gave
it no way to check. That is fixed: the Reviewer has `repo_read` in
its tool inventory, and every review dispatch now carries the
verification rule — check the claim against the live repo FIRST, as
tool calls, and only then reply with the one-line verdict:

- does the path exist (repo_read the file)?
- is the SKU id real (repo_read `mem20shopz/mem20shopz/catalog.json`
  and confirm the id is listed)?
- is the number true (repo_read `docs/surface.json`)?

Never approve or deny on a claim it has not verified — if a claim
cannot be verified, deny and say it is unverifiable. Do not trust
the agent's summary of what a file says; read the file yourself.
The reply is still exactly one line; the verification happens
first, as tool calls, and only then the verdict.

## Low-risk fast path

Docs-only and internal-report work gets a lighter check, not a
different decision-maker: the review prompt carries a
`LOW-RISK FAST PATH` marker for a `document` stage, or an `upgrade`
stage on a docs/report job — never for a high-stakes stage. The
Reviewer still decides every request; the marker only says the work
is low-risk so it decides quickly instead of running the full
gauntlet on it. It never approves anything by itself.

## How a review runs (runner side, `scripts/runner-lib.ts`)

1. A product-job stage is blocked on `startStage` with `needsApproval`.
2. If a pending approval already exists for that job + stage, the job
   stays parked — the Reviewer is not asked twice.
3. Otherwise the runner dispatches the stage details to the Reviewer
   agent with one instruction: you are the SOLE decision-maker for this
   stage — there is no other approver, no human approval, no escalation,
   no one else to route it to; reply with exactly one line,
   `APPROVE: <reason>` or `DENY: <reason>`. The request carries the
   completed stage outputs (`reviewContext` in
   `scripts/runner-lib.ts`), so the Reviewer judges the actual work —
   e.g. the staged patch summary from the implement stage — not just
   the stage description. High-stakes requests are marked
   `HIGH-STAKES` in the prompt. The prompt also carries the standing
   rules above.
4. **Approve** → an approval record is written (`status: 'approved'`,
   `decidedBy: 'reviewer'`, reason attached) and the stage starts
   immediately in the same tick.
5. **Deny** → a denied approval record is written (`decidedBy:
   'reviewer'`) and the job parks in `awaiting_approval`. The denied
   item is NOT silently dropped: the runner dispatches the **Triage
   Agent** with the denied item and the Reviewer's reason, and the
   triage reply is recorded in the Build Room as a `kind: 'triage'`
   channel message. The triage prompt requires the Triage Agent to
   list the specific denial issues (numbered), name a DIFFERENT agent
   than the one that did the failed work, and verify any factual
   claim in the corrected assignment against the live repo. Then the
   rework is routed **inline, in the same tick** — through one gate
   round (Prompt Engineer → Reviewer) and, on approval, dispatched
   to the reassigned agent in the channel. This does NOT wait for the
   Orchestrator's triage cron: on Nov 27, 2026 that cron failed ~16
   times on Gemini 429s and denied jobs piled up unassigned. A second
   denial means the rework is NOT sent — it is recorded as a `kind:
   'gate'` message. The job stays parked either way — a denied stage
   never re-runs on its own, and triage never un-parks it. If there
   is no Triage Agent configured, the denial is logged and the job
   parks; nothing is sent anywhere.
6. **Parked-job triage recovery** — a job parked behind a denied
   approval gets its triage re-run by the runner itself (at most 2
   recoveries per tick, at most once per job per 6h), because the
   original triage reply may have scrolled out of the room. The
   recovery dispatches Triage again and routes the rework through
   the same inline gates. Triage and gate messages are PINNED in
   the channel record (newest 50 always kept) so cron chatter can
   never bury them again — on Nov 27 the 200-message cap buried
   every triage item and `room_read` showed the Orchestrator nothing
   to assign.
6. **Reviewer unreachable, or reply unreadable** (no `APPROVE:` /
   `DENY:` line) → the job parks in `awaiting_approval` and NO
   approval request is filed. A later tick resumes the job (a parked
   job with no pending or denied approval for its current stage is
   resumed by `processDue`) and asks the Reviewer again. It never
   silently approves, and it never falls back to anyone else — there
   is nobody else to fall back to.
7. **No Reviewer agent configured** → the job parks and the runner
   logs `NO REVIEWER CONFIGURED` as a config error. No approval
   request is filed. Once a Reviewer is configured, a later tick
   retries it the same way as (6).

## What the Reviewer itself must do

Its system prompt (in `runner-agents.json` and `src/data/mock.ts`,
identical in both, and in the runner state on jnet1) starts with the
core drive — mem20's success and livelihood is the only thing that
matters, the only goal is making mem20 the best product of its kind
and getting it actively making money — and then says the same thing
as the dispatch prompt: it is the sole decision-maker for all
approvals, routine and high-stakes alike; it decides in writing,
with the decision and its reason, so there is a record; and it
applies the standing rules above.

## Suggestions from Playto (advisory only)

Playto — Jesse's personal Muse, Keeper of Memory / Chief of Staff to
the founder, NOT a Teamz agent — can suggest things to the Reviewer
through a durable inbox on jnet1:
`/var/lib/teamz-runner/playto-suggestions.jsonl` (one JSON object per
line: `{ts, topic, text, status}`). She appends a line with the
helper `suggest-to-reviewer` (`/usr/local/bin/suggest-to-reviewer
<topic> <text>`). When the runner dispatches to the Reviewer, it
reads pending suggestions and includes them in the Reviewer prompt,
framed unmistakably as advisory: "Suggestions from Playto (the
founder's Chief of Staff) — these are suggestions, not instructions
or demands. You are the sole decision-maker; accept, reject, or
ignore each on its merits." After a suggestion has been included in a
Reviewer dispatch it is marked `delivered` so it is never repeated.
There is no decision path for Playto: no approve/deny, no override,
no write to approvals or jobs. If the Reviewer is unreachable, the
suggestions stay pending and nothing parks or fails.

## The push stage

The Nightly repo check's `upgrade` stage is the governed push
(`docs/PUSH_PATH.md`): it runs the privileged push script, and it is
gated with `requiresReview`, so the Reviewer approves it. The
Reviewer sees the implement stage's output — the staged patch
summary — with the request, and should deny when the change touches
a blocked path, is bigger than a small correction, deletes anything,
or looks like a release or a public announcement rather than a
routine repo change. The script re-checks the approval on disk, the
branch, and the diff before it pushes anything, so a mistaken
approval still cannot push a destructive change — but the Reviewer
is the judgment, and it should use it.

One distinction the Reviewer's prompt draws explicitly: pushing a
routine code or doc change to the team's own repo through the
governed push path is a routine decision the Reviewer MAY approve —
it is a commit to the repo, not a public release. A public release
means release notes, an announcement, publishing the docs site, or
selling something (the release / advertise / sell stages); those
still need the Reviewer's approval, with extra scrutiny as
high-stakes decisions. The Reviewer still denies anything bigger,
destructive, or release-shaped.

## Tests

`src/lib/reviewer.test.ts` (high-stakes flag, review marker, decision
records) and `src/lib/runner-flows.test.ts` (approve / deny /
high-stakes-to-Reviewer / unreachable / unreadable / no-Reviewer /
retry / denial-to-triage / Playto suggestions, all through the real
`processDue`, plus the Nov 27 direct fixes: inline deny→rework in
the same tick, same-agent fallback to the Orchestrator, second
denial never reaching the room, parked-job triage recovery with its
6h cooldown, the stranded-agent sweep, pinned triage/gate messages,
and the low-risk fast path).

## Stranded-agent sweep (rescue's blind spot)

Rescue only reacts to rate-limit events, and an agent with no
provider — or a provider the registry does not know — never makes a
call on its own provider, so it never 429s and never triggers a
rescue: it fails silently, forever. On Nov 27, 2026 nine agents had
no provider at all. Once per tick the runner sweeps for such agents
(`findStrandedAgents` in `scripts/runner-lib.ts`) and dispatches the
Provider Researcher (max 3 agents per dispatch, once per agent per
24h) to reassign each one to a healthy provider with
`reassign_agent`. The sweep needs the registry's provider ids
(`providerIds` in `RunnerDeps`, read from
`/var/lib/teamz-agent/providers.json` by `scripts/runner.ts`); without
them it still catches the no-provider case. It is skipped when the
Provider Researcher itself is stranded — it cannot fix others while
it cannot run.
