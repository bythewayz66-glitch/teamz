/**
 * ============================================================================
 *  teamz API layer — the ONLY place that talks to your agents.
 * ============================================================================
 *
 *  Everything in the UI goes through the two functions at the bottom:
 *
 *    sendToAgent(agent, history, options)  -> Promise<string>
 *    pingAgent(agent)                      -> Promise<{ ok, latencyMs }>
 *
 *  Mode is chosen by VITE_API_MODE:
 *
 *    mock  (default) — no network at all. Returns persona-flavoured canned
 *                      replies after a short delay so the UI is fully usable
 *                      offline. This is what ships in the repo.
 *
 *    live            — POSTs to `agent.endpointUrl`, exactly as described in
 *                      README → "Connecting real agents".
 *
 *  To adapt this to your own server, you normally only need to edit
 *  `buildRequest()` and `parseReply()` (both clearly marked below). Nothing
 *  else in the app knows how your backend works.
 */

import type { Agent, Message } from '../types';

export type ApiMode = 'mock' | 'live';

export const API_MODE: ApiMode =
  (import.meta.env.VITE_API_MODE as ApiMode | undefined) ?? 'mock';

/** What a caller can send along with the message history. */
export interface SendOptions {
  /** Id of the conversation, so servers can keep per-channel memory. */
  conversationId: string;
  /** Name of the channel/direct chat (handy for logging server-side). */
  conversationName: string;
  /** Display names of the other agents in a channel — useful for routing. */
  otherAgents?: { id: string; name: string }[];
  /**
   * True when the user addressed this agent with an `@mention` rather than
   * broadcasting to the whole room. Servers can use it to skip the
   * "should I answer?" deliberation entirely.
   */
  directed?: boolean;
  /** Abort a slow request (e.g. user switched conversations). */
  signal?: AbortSignal;
}

/* ---------------------------------------------------------------------------
 * Wire format. This is the contract your server should implement — or you can
 * change it here and keep the UI untouched.
 * ------------------------------------------------------------------------- */

export interface AgentRequest {
  agent: {
    id: string;
    name: string;
    model: string;
    systemPrompt: string;
  };
  /** Oldest → newest, including the user's just-sent message. */
  messages: { role: 'user' | 'assistant'; content: string; authorName?: string }[];
  channel: {
    id: string;
    name: string;
    members: { id: string; name: string }[];
  };
  /** Present only on directed (@mention) messages. */
  directed?: boolean;
}

/* ---------------------------------------------------------------------------
 * MARKER 1 — build the request body sent to your server.
 * ------------------------------------------------------------------------- */
export function buildRequest(
  agent: Agent,
  history: Message[],
  agentsById: Map<string, Agent>,
  options: SendOptions,
): AgentRequest {
  return {
    agent: {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
    },
    messages: history.map((m) => ({
      role: m.authorType === 'user' ? 'user' : 'assistant',
      content: m.text,
      authorName:
        m.authorType === 'agent' && m.authorId
          ? agentsById.get(m.authorId)?.name
          : undefined,
    })),
    channel: {
      id: options.conversationId,
      name: options.conversationName,
      members: (options.otherAgents ?? []).map((a) => ({ id: a.id, name: a.name })),
    },
    ...(options.directed ? { directed: true } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * MARKER 2 — pull the reply text out of whatever your server returns.
 *
 * The three shapes below cover most implementations. Add yours at the top.
 * ------------------------------------------------------------------------- */
export function parseReply(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Agent returned an empty or non-JSON response');
  }
  const p = payload as Record<string, any>;

  // 1. { reply: "..." }  /  { text: "..." }  /  { message: "..." }
  for (const key of ['reply', 'text', 'message', 'content', 'output']) {
    if (typeof p[key] === 'string') return p[key];
  }
  // 2. OpenAI-compatible: { choices: [{ message: { content } }] }
  const choice = p.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;
  // 3. OpenAI streaming-ish single chunk: { delta: { content } }
  if (typeof p.delta?.content === 'string') return p.delta.content;
  // 4. Anthropic-compatible: { content: [{ type: "text", text }] }
  if (Array.isArray(p.content)) {
    const textBlock = p.content.find((b: any) => typeof b?.text === 'string');
    if (textBlock) return textBlock.text;
  }

  throw new Error('Could not find reply text in the agent response. Edit parseReply() in src/api/agents.ts.');
}

/* ---------------------------------------------------------------------------
 * Live transport
 * ------------------------------------------------------------------------- */
async function callLive(
  agent: Agent,
  request: AgentRequest,
  options: SendOptions,
): Promise<string> {
  const endpoint = agent.endpointUrl?.trim();
  if (!endpoint) {
    throw new Error(`${agent.name} has no endpoint URL. Open its settings and add one.`);
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: options.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${agent.name} replied ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 240)}` : ''}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return parseReply(await res.json());
  }
  // Fall back to plain text bodies.
  return (await res.text()).trim() || '…';
}

/* ---------------------------------------------------------------------------
 * Mock transport — deterministic-ish persona replies, no network.
 * ------------------------------------------------------------------------- */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MOCK_REPLIES: Record<string, string[]> = {
  Scout: [
    'Pulled three sources on that. The short version: the claim holds, but only for the narrower case — two of the three papers scope it to single-agent loops.\n\nWant the contradiction written up, or just the cite list?',
    'Best primary source I found is the project’s own design doc, not the blog posts summarising it. Blog posts disagree with each other; the doc doesn’t.',
    'Searched, filtered, and ranked by recency. Nothing on this after the 2025 rewrite — assume the older material is stale.',
  ],
  Atlas: [
    'Cleanest change here is a single module boundary: keep the transport in `api/`, keep components dumb, and let the store own the merge. Anything else and you end up threading callbacks through three layers.\n\n```ts\nexport async function sendToAgent(a: Agent, history: Message[]) {\n  const req = buildRequest(a, history);\n  const res = await fetch(a.endpointUrl, {\n    method: "POST",\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify(req),\n  });\n  return parseReply(await res.json());\n}\n```\n\nTrade-off: you lose streaming for now. Fine at this size.',
    'Two bugs are likely here and both are boring: an effect that re-runs on every render because a dependency is an array literal, and a message list keyed by index. Neither shows up until you have real latency.',
  ],
  Pixel: [
    'Spacing is the whole trick. Use one scale — 4 / 8 / 12 / 16 / 24 — and never hand-pick a value between steps. The app will instantly look like a product instead of a prototype.',
    'Your bubbles are too round and too tall. `18px` radius, `14px / 20px` padding for one-liners, and let multi-line bubbles drop to `10px` on the outer corner. It reads as chat instead of as cards.',
    'Add the empty state before the happy path. A channel with no members is the most common first-run screen and right now it’s just… blank.',
  ],
  Sage: [
    'Tightened it. Cut 30% of the words, kept every claim:\n\n> A Teamily-style workspace for agents you host yourself. Sidebar for the roster, one pane for the thread, settings inline. Runs with mock data on first launch; point it at your servers when you’re ready.',
    'One idea per paragraph and lead with the verb. “Configure the endpoint” beats “The endpoint can be configured”.',
  ],
  _default: [
    'Got it — working through that now. I’ll come back with the short version plus the one decision you need to make.',
    'Noted. Here’s my read: the hard part isn’t the happy path, it’s what happens when an agent times out mid-channel. Want me to handle that case first?',
    'Read, considered, and I disagree with one assumption — but it’s fixable. Say the word and I’ll spell it out.',
  ],
};

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

async function callMock(agent: Agent, options: SendOptions): Promise<string> {
  // Simulate realistic latency; offline agents take noticeably longer.
  await sleep(500 + Math.random() * 900 + (agent.status === 'offline' ? 900 : 0));
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const pool = MOCK_REPLIES[agent.name] ?? MOCK_REPLIES._default;
  let reply = pick(pool);

  // Agents created from a template answer in-character: they name the skills
  // they are applying, which are derived from the template, never random.
  const topSkills = (agent.skills ?? [])
    .slice()
    .sort((a, b) => b.level - a.level)
    .slice(0, 2)
    .map((s) => s.label);

  if (agent.origin && topSkills.length > 0) {
    reply = `Coming at this as ${agent.origin.role.toLowerCase()} \u2014 ${topSkills.join(
      ' and ',
    )}.\n\n${reply}`;
  }

  if (options.directed) {
    reply = `Thanks for the direct ask.\n\n${reply}`;
  }

  if (agent.status === 'offline') {
    return `\u26a0\ufe0f _${agent.name} looks offline in this mock run \u2014 a real endpoint would fail here._\n\n${reply}`;
  }
  return reply;
}

/* ---------------------------------------------------------------------------
 * Public API used by the UI
 * ------------------------------------------------------------------------- */

export async function sendToAgent(
  agent: Agent,
  history: Message[],
  agentsById: Map<string, Agent>,
  options: SendOptions,
): Promise<string> {
  if (API_MODE === 'live') {
    return callLive(agent, buildRequest(agent, history, agentsById, options), options);
  }
  return callMock(agent, options);
}

/** Lightweight reachability check used by the settings panel's "Test" button. */
export async function pingAgent(agent: Agent): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  const started = performance.now();
  if (API_MODE === 'mock') {
    await sleep(320);
    return {
      ok: agent.status !== 'offline',
      latencyMs: Math.round(performance.now() - started),
      message:
        agent.status === 'offline'
          ? 'Mock mode: this agent is marked offline.'
          : 'Mock mode — always reachable. Set VITE_API_MODE=live to test the real endpoint.',
    };
  }
  try {
    const res = await fetch(agent.endpointUrl, { method: 'GET' });
    return {
      ok: res.ok,
      latencyMs: Math.round(performance.now() - started),
      message: res.ok ? `Reachable (${res.status})` : `Responded ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      message: err instanceof Error ? err.message : 'Request failed',
    };
  }
}
