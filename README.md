# teamz

A chat front-end for running **your own** AI agents on your own server.

One workspace, two kinds of conversation: a **1:1 chat** with a single agent, and a
**channel** where several agents answer the same message in turn. Agents are just a
name, an emoji, an accent colour, an endpoint URL, a model string and a system prompt —
nothing is hard-coded to a vendor.

Agents give **real LLM replies via [Pollinations.ai](https://pollinations.ai)** out of the
box — no sign-up, no server. You can also point agents at your own servers, or switch to
offline mock replies, from **Workspace & API** settings.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # typecheck + production bundle into dist/
npm run typecheck  # tsc --noEmit only
```

Requires Node 18+ (developed on Node 20).

## What's in the box

| Area | Detail |
| --- | --- |
| Sidebar | 300px roster: channels on top, direct chats below, live search, last-message preview and relative timestamps |
| Chat pane | Day dividers, grouped messages, custom markdown renderer (fenced code, bold, italic, inline code, lists, quotes) |
| Channels | Multi-agent rooms — every member replies, sequentially, so answers interleave readably |
| Agent settings | Slide-over drawer: name, emoji, accent, model, endpoint URL, system prompt, status, and a **Test** button that pings the endpoint |
| Persistence | Everything is mirrored to `localStorage` (`teamz:workspace:v1`); "Reset workspace" restores the seed data |
| AI replies | Pollinations.ai by default (streaming); own endpoints or labelled offline mock replies are one click away |

## Real replies via Pollinations (default)

Replies stream straight from the browser to Pollinations' OpenAI-compatible Chat
Completions API (code: [`src/api/pollinations.ts`](src/api/pollinations.ts)).

| | No API key (default) | With an API key |
| --- | --- | --- |
| Endpoint | `https://text.pollinations.ai/openai` | `https://gen.pollinations.ai/v1/chat/completions` |
| Model | `openai-fast` (GPT-OSS 20B) | default `openai` (GPT-5.4 Nano); any id from [`/v1/models`](https://gen.pollinations.ai/v1/models) |
| Limits | Anonymous tier, rate-limited per IP. **Rejects `localhost` origins** (Turnstile) — works on the deployed Pages site | Billed to the key's Pollen balance |

* Each agent's system prompt, template role and top skills become the system message,
  plus the channel name/topic, other members, and whether it was `@mentioned`.
* The last 24 messages go along as context. The agent's own messages are `assistant`; the user
  and other agents are `user` messages prefixed `[Name]:` in channels. In a channel, agents answer
  one after another and each sees the replies before it.
* `@mentions` work as before: only mentioned agents answer; otherwise every member answers.
* Errors (rate limits, bad key, paid-only model) show up as a red message in the chat. Nothing
  silently falls back to mock.

**Settings** (Workspace & API → AI provider, or click the provider pill under the composer):
provider (Pollinations / Own endpoints / Mock), optional API key, model, referrer, streaming
on/off, and a **Test** button. They're saved in this browser's `localStorage`
(`teamz:llm-settings:v1`) only — never in the build or the repo. Note that a key stored in a
browser can be read by anything running on that page, so use a budget-limited key.

`VITE_API_MODE` now only picks the default for a fresh browser: unset → Pollinations,
`live` → own endpoints, `mock` → mock.

## Connecting your own server

All network code lives in [`src/api/agents.ts`](src/api/agents.ts). Two functions matter:

```ts
sendToAgent(agent, history, agentsById, options) // -> Promise<string>
pingAgent(agent)                                 // -> { ok, latencyMs, message }
```

### 1. Switch the provider

Open **Workspace & API** and choose **Own endpoints** (or build with `VITE_API_MODE=live`
to make that the default).

### 2. Know the request contract

`buildRequest()` (marked `MARKER 1`) produces this body and POSTs it as JSON to
`agent.endpointUrl`:

```jsonc
{
  "agent":    { "id": "...", "name": "Atlas", "model": "qwen2.5-coder:32b", "systemPrompt": "..." },
  "messages": [ { "role": "user", "content": "...", "authorName": "..." } ],   // oldest -> newest
  "channel":  { "id": "...", "name": "Build Room", "members": [ { "id": "...", "name": "Pixel" } ] }
}
```

### 3. Know the response shape

`parseReply()` (marked `MARKER 2`) already accepts the common shapes:

```jsonc
{ "reply": "..." }                                  // or "text", "message", "content", "output"
{ "choices": [ { "message": { "content": "..." } } ] }  // OpenAI-compatible
{ "delta": { "content": "..." } }                   // single stream chunk
{ "content": [ { "type": "text", "text": "..." } ] }    // Anthropic-compatible
```

Plain-text bodies work too. Anything else: add one branch to `parseReply()` — the rest
of the app doesn't need to know.

### 4. Minimal server to test against

```js
// node server.mjs  ->  http://localhost:8001/chat
import { createServer } from 'node:http';

createServer((req, res) => {
  if (req.method === 'GET') return res.end('ok');          // satisfies the Test button
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { agent, messages } = JSON.parse(body || '{}');
    const last = messages.at(-1)?.content ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      reply: `${agent.name} here. You said: "${last}".`,
    }));
  });
}).listen(8001, () => console.log('agent on :8001'));
```

Put `http://localhost:8001/chat` in an agent's settings, hit **Test**, then send a message.

### CORS

The browser calls your endpoint directly, so your server must allow the origin the app
is served from (`http://localhost:5173` in dev). Either send
`Access-Control-Allow-Origin: *` for local work, or put a small proxy in front of it.

## Autonomy: jobs, scheduler & governance

Teamz can run itself while Jesse only makes master decisions. A **job** is a
chain of stages that walks the product lifecycle — design → build → implement
→ upgrade → release → document → advertise → sell — where each stage is one
scheduled agent run whose reply becomes that stage's recorded output. The
first product the loop operates is the mem20 repo, which Jesse has handed
over to Teamz to run start to finish.

Two runners share one core (`src/lib/scheduler.ts`, `src/lib/jobs.ts`,
`src/lib/governance.ts` — all DOM-free, no mem20 dependency):

| Runner | Where it runs | What it does |
| --- | --- | --- |
| In-tab runner | This browser tab (`Jobs & Scheduler` button, top right) | Dev/preview mode. Checks every 30s, fires due work through the chat's own send path. **Only while the tab is open.** |
| Server runner | jnet1, as a systemd service (`scripts/runner.ts`) | The real 24/7 runner. Same schedules, same gates; prompt stages go to agent endpoints over HTTP, command stages execute in a repo working directory. |

### The hard rule

The runner **never** spends money, publishes something public, or releases
anything without Jesse's approval. `release`, `advertise`, and `sell` — and
any stage flagged as spending money, publishing publicly, or destroying
something — cannot execute without an approval record for that job + stage.
The gate is enforced in code (`canExecuteStage` inside `startStage`), not
just in the UI: a gated stage with no live approval is blocked, an approval
request is filed, and the job parks in `awaiting_approval` until Jesse
approves or denies it in the approvals queue. Routine stages (design,
build, implement, upgrade, drafting docs) proceed autonomously. Routine
stages that still need a decision (`requiresReview`) go to the **Reviewer**
agent instead of Jesse — carve-outs (spending, public releases,
destructive actions) always go to Jesse, never the Reviewer. See
[`docs/REVIEWER_POLICY.md`](docs/REVIEWER_POLICY.md).

### The roster and the automations

The runner drives **31 agents** (`runner-agents.json`, the single source
of truth — the same prompts live in the UI seed, `src/data/mock.ts`): the
26 Teamily agents, plus Reviewer, Orchestrator, Provider Researcher,
Keymaster, and Atlas. All 34 seed agents (including the 4 originals) are
members of the **Build Room** (`conv-build-room`), where the Orchestrator
assigns work by @mention and the runner records the agents' replies.

**29 scheduled automations** run in the Build Room (built by
`scripts/build-runner-state.mjs`, never hand-edited into the state file):
one hourly prompt job per Teamily agent (`0 * * * *`, each a concrete
task finishable in one dispatch), the Orchestrator every 15 minutes
(`*/15 * * * *`), the Provider Researcher every 6 hours
(`0 */6 * * *`), and the Keymaster's daily credential audit
(`0 8 * * *`) — plus the Nightly repo check product job
(`0 7 * * *`, Atlas). The Orchestrator's standing orders — *Teamz owns
mem20 and operates without a human in the loop, autonomously 24 hours a
day, driving mem20 to success and completion* — are in its system prompt
and posted in the Build Room. Full detail:
[`docs/TEAMZ_AUTONOMY.md`](docs/TEAMZ_AUTONOMY.md),
[`docs/ORCHESTRATOR.md`](docs/ORCHESTRATOR.md),
[`docs/PROVIDER_RESEARCHER.md`](docs/PROVIDER_RESEARCHER.md),
[`docs/KEYMASTER.md`](docs/KEYMASTER.md).

### Jobs

- A job names a channel, a manager agent, and one agent per stage. The
  manager distributes stages to their owner agents (the mem20crewz Crew
  pattern: a manager agent delegates, each stage's output feeds the next
  stage's context, every run records its provenance — which run produced
  which output, when, in which channel, under which approval).
- Templates (real data, instantiated with your agents — **Jobs &
  Scheduler → New job from a template**): **Ship a release** (the full
  eight-stage loop), **Publish docs** (design → document, gated on publish),
  **Nightly repo check** (design → implement → upgrade → document;
  the implement stage verifies one live claim with the repo tools and
  stages a small correction; the upgrade stage is the governed push —
  allowlisted `sudo /opt/teamz-runner/push-mem20.py`, gated on the
  Reviewer — see `docs/PUSH_PATH.md`).
- **Command stages** do real work on a checked-out repo. A command runs
  only when its exact argv is on the job's explicit allowlist, only via
  `spawn` with no shell (metacharacters are data, never a second command),
  with a timeout, and with captured output recorded as the stage's output.
  Commands never come from an LLM reply. The in-tab runner never executes
  commands — it leaves them for the server runner.
- Schedules: cron jobs (`0 7 * * 1-5` — same 5-field parser as mem20agentz),
  interval triggers (every N minutes), and per-job schedules (manual /
  interval / cron). State persists in `localStorage` (`teamz:autonomy:v1`).

### Deploy the 24/7 runner on jnet1

The runner lives on Jesse's server **jnet1** (in his Tailscale tailnet;
behind NAT, no public IP — the runner needs no public ingress, it calls
out to agent endpoints). Everything the runner serves (logs, health, any
future status page) is tailnet-only: no public IP, no open ports, no
firewall change. If public ingress is ever needed, that is a Tailscale
serve/funnel decision and needs Jesse's say-so first. Do not install it
until Jesse approves the install — the package and the steps are ready here.

```bash
npm run build:runner   # bundles scripts/runner.ts → dist/runner.mjs
# copy the repo (or at least dist/, scripts/, deploy/) to jnet1, then:
sudo ./deploy/install.sh
# edit /var/lib/teamz-runner/state.json — real agent endpoints, real job
# workdirs (the mem20 checkout on jnet1 is /opt/mem20), and the jobs to run
sudo systemctl start teamz-runner
journalctl -u teamz-runner -f   # or tail /var/log/teamz-runner/runner.log
```

- The service runs as a `teamz` system user, restarts automatically, and
  survives reboots (`deploy/teamz-runner.service`).
- The state file (`/var/lib/teamz-runner/state.json`, seeded from
  `scripts/runner-state.example.json`) is the runner's whole world: agents,
  jobs, triggers, cron jobs, approvals. The service reloads it before every
  tick and saves it after, so approvals added to the file take effect on
  the next tick. A reinstall never overwrites an existing state file.
- The runner needs agent endpoints it can reach — either agent servers on
  jnet1 or reachable over the tailnet. It cannot use the browser's
  Pollinations default; point agents at real endpoints in the state file.
- The runner listens on no ports: it only makes outbound HTTP calls to
  agent endpoints and reads/writes its state file and log. There is
  nothing to expose publicly and nothing to firewall — tailnet-only by
  construction, not by configuration.
- The runner works with whatever mem20 checkout is present (on jnet1 it is
  `/opt/mem20`) and **never syncs it**: it has no pull/fetch/update step,
  and it must never push to the mem20 repo from jnet1. Syncing that
  checkout to current main is **blocked pending Jesse's plain-words
  go-ahead** (the copy there is behind main and has uncommitted local
  modifications) — flag it as pending, do not work around it. Point job
  workdirs at the checkout as it stands.
- **Open items (Jesse's call):** how the runner authenticates to GitHub
  for mem20 work (a token or `gh` login on jnet1 — not set up here, and no
  credentials are stored anywhere in this repo), and how Jesse sees and
  approves pending approvals when he is not in the tab (a small status
  page over the state file, or a notification route — proposed, not built).

## Project layout

```
src/
  main.tsx                 entry point
  App.tsx                  shell: sidebar + chat pane + dialogs
  types.ts                 Agent / Conversation / Message domain types
  store/useWorkspace.ts    the single state hook (state, persistence, fan-out)
  api/agents.ts            the only file that talks to your agents
  components/
    Sidebar.tsx            roster, search, conversation rows
    ChatPane.tsx           header, message stream, composer
    AgentSettings.tsx      slide-over editor + endpoint test
    NewAgentDialog.tsx     create an agent
    ChannelDialog.tsx      create a channel / pick members
    WorkspaceInfo.tsx      how-it-works panel
    RichText.tsx           dependency-free markdown renderer
    Avatar.tsx             avatars, status dots, overlapping stacks
    Icons.tsx              inline SVG icon set (no icon dependency)
    Modal.tsx              shared modal primitive
  lib/format.ts            time + label formatting helpers
  lib/scheduler.ts         cron parser, interval triggers, tick() (DOM-free)
  lib/jobs.ts              product-loop jobs, stage lifecycle, templates
  lib/governance.ts        approval gates (release/advertise/sell/spend/publish)
  store/useAutonomy.ts     autonomy state + in-tab runner tick (30s)
  components/JobsPanel.tsx jobs, schedules, triggers, approvals queue
  data/mock.ts             seed agents, channels and messages
  styles.css               the whole theme
scripts/
  runner.ts                24/7 headless runner (jnet1 service entry)
  runner-lib.ts            state file, agent dispatch, command executor, tick
  runner-state.example.json
deploy/
  teamz-runner.service     systemd unit (auto-restart, survives reboots)
  install.sh               install on jnet1 (root, after Jesse's approval)
```

Dependencies: React 18 and Vite 5. That's it — no UI kit, no icon package, no markdown
library.

## Design notes

- **One spacing scale** (4 / 8 / 12 / 16 / 24 / 32) and one radius scale, so nothing
  hand-picks an in-between value.
- **Agent colour is a 1px ring plus the name**, never a filled bubble — five saturated
  bubbles read as a rainbow rather than a conversation.
- **The composer names who will answer** before you press enter, because in a channel
  that is otherwise ambiguous.
- **Empty states are designed first**: a channel with no members, a search with no hits.
- Dark palette starts at `#0b0d12`, not `#000` — pure black makes borders read as cracks.

## License

MIT
