# Sessions, agent home and search (Phase 1)

Teamz is a browser app; its workspace lives in `localStorage` (`teamz:workspace:v1`)
and the 24/7 runner on jnet1 is read-only to it. Sessions are built inside that
model: no new backend, nothing written to the runner.

## What a session is

A session is a conversation carrying `SessionMeta` (`src/types.ts`): owning agent,
status (`active` | `interrupted` | `archived`), and an explicit retention policy.
The name is the conversation's own `name`.

| Kind | What it is | Default retention |
|---|---|---|
| `chat` | A conversation with one agent. Each agent's existing DM is adopted as its first one; "New session" on an agent's home starts more. Named from the first message, renameable. | keep forever |
| `work` | What an agent did in the Build Room (its replies, plus the `@mention` messages that assigned it work), one rolling session per agent per ISO week. | 90 days, then pruned |
| `room` | The Build Room itself, untouched, now with metadata. The shared session Jesse watches. | keep forever |

Retention is `forever`, `days: N` or `messages: N`. Each agent has a default for its *new*
sessions (its home: "Session auto-delete", Gamut's per-agent setting); any session can then be
changed from the bar above it. It is enforced on load and hourly (`applyRetention`). **Starred
sessions are never pruned.** A `work` session that empties out is dropped (unless starred); a chat
or the room is never deleted by retention, only trimmed.

## Migrating the Build Room

`migrateToSessions` runs on every load: adopt DMs and the room as sessions,
recover interrupted replies, fold the room into per-agent work sessions, prune.
`foldRoomIntoSessions` copies (same message id) and never removes: the room keeps
every message. It is idempotent, re-run whenever a finished reply lands in the room
(including runner sync), and it will not resurrect messages older than the work
retention window. "Reset to demo data" still wipes everything, sessions included.

## Interrupted work and resume

A reply still `pending` when the tab closed used to stay "typing" forever. On load it
becomes an `interrupted` message (keeping any streamed text) and the session is flagged.
`planResume` keeps **every** earlier message as the context, removes only the dead
placeholders, and re-asks the agents that were mid-reply, through the same
`deliverTurn` path as a normal send. The Resume button is on the session bar and the
agent's home. (Cross-tab sync deliberately does not mark another tab's in-flight reply
as interrupted.)

## Agent home

`buildAgentHome` (`src/lib/agentHome.ts`) gathers status, model/provider, sessions,
triggers (runner cron jobs, interval triggers, product jobs, plus in-tab ones), skills,
tools, connections, recent runs and cost-to-date, and writes the opening two sentences.
Open it from the sidebar's house icon, the session bar, or search.

The runner snapshot (`/runner-state`) and `/usage` are polled every 60s by
`useOperations` and the last good copy is saved, so a home still opens, labelled with
its age, when the runner is unreachable.

### Honest limits

- **Skills.** Only ~31 of the 106 fleet agents carry a declared skill list. Others show
  their role line if the endpoint supplies one (`role` on each agent in `/runner-state`,
  see below), else an explicit empty state. Nothing is invented.
- **Cost.** `GET /usage` holds only *today*, so cost-to-date is a ledger the browser keeps
  from the first day it saw usage. Teamz has no price list; dollars appear only after a
  rate is entered in Workspace & API → Token cost rate. Tokens always show.
- **Schedules** are the runner's cron jobs as last fetched; "next run" is computed from the
  cron expression with the same `Schedule` class the runner uses.

### Follow-up for the endpoint (not in this PR)

To give the 75 runner-only agents a role line, add to `readRunnerState()` in
`scripts/agent-endpoint/agent.mjs`, inside the `agents` map:

```js
role: roleLine(a?.systemPrompt),
```

with `roleLine` returning the first sentence of the system prompt (capped at 200 chars).
The client already reads `role` when present. This needs a redeploy of the endpoint,
which is the Reviewer's call.

## Search

`Ctrl/Cmd+K` (or the Search button) opens the palette. It searches agents (name, role,
model, skills), sessions (name **and the text inside every message**), and settings.
Every word must match; an exact phrase ranks above scattered words; the matched phrase is
highlighted in the snippet. Selecting a session opens it; an agent opens its home.

## Gamut patterns: followed and deliberately skipped

Reference: the Gamut exploration notebook (27 Nov 2026) and the overhaul roadmap, section 4.

Followed:
- Palette opens on **Recent agents** (with last-active time) then **Recent sessions**.
- **Session auto-delete** as a per-agent default, with **starred sessions preserved**.
- On an agent's home, **sort and search that agent's sessions** (search reads message text).
- Each sidebar agent row has a **New session** action and an expandable list of its sessions.
- The run record in Gamut's plain format: "Last 7 days: 24 planned runs, 23 ran, 1 skipped, and 0 failed."
- The model is shown on the home without its vendor prefix (full id on hover).

Deliberately skipped, and why:
- **Reasoning "effort"** (Gamut: "Sonnet 5.5 · Medium"). Teamz has no effort setting; showing one would be a fake capability. The nearest real knob, the per-request tool-step budget, is shown as "up to N steps" when an agent has one.
- **Per-agent connections state** (Slack "Setup required", GitHub "Listening"). The data is not in the runner's read-only summary; it is Phase 4's Connections hub.
- **"Invoked by X" sessions** for agent-to-agent calls. Teamz's equivalent is the weekly *work* session built from the @mentions that assigned the work.
- **Notifications, Drives, Memories, Secrets, API logs, Pinned Items** on the home: later phases (Dream reports pin in Phase 2).
- **Session auto-delete applying retroactively.** Changing an agent's default affects sessions started afterwards; silently pruning existing history on a settings change is the wrong default.
- **Skipped-run accuracy before the first run.** The record counts a schedule only from its first recorded run in the window; Teamz keeps no creation time for a cron job, so "skipped" before that would blame a job for time it did not exist. A schedule with nothing on record is listed separately. Phase 0's runner record is the authoritative version of this.

Voice: the two opening sentences are written by the UI about the agent, so for the Reviewer they are
third person. Nothing in Teamz speaks as the Reviewer except the Reviewer.
