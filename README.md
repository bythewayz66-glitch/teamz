# teamz

A Teamily-style chat front-end for running **your own** AI agents on your own server.

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
  data/mock.ts             seed agents, channels and messages
  styles.css               the whole theme
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
