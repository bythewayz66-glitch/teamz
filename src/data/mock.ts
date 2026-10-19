import type { Agent, Conversation, Message, WorkspaceState } from '../types';

/** Fixed ids so seed data is stable across reloads (before localStorage takes over). */
const AGENT_SCOUT = 'agent-scout';
const AGENT_ATLAS = 'agent-atlas';
const AGENT_PIXEL = 'agent-pixel';
const AGENT_SAGE = 'agent-sage';

export const seedAgents: Agent[] = [
  {
    id: AGENT_SCOUT,
    name: 'Scout',
    emoji: '🔭',
    accent: '#7c9cff',
    status: 'online',
    endpointUrl: 'http://localhost:8001/chat',
    model: 'gpt-4o-mini',
    systemPrompt:
      'You are Scout, a research agent. You find primary sources, summarise them tightly, and always cite where a fact came from.',
    skills: [
      { key: 'research', label: 'Research', level: 5 },
      { key: 'sourcing', label: 'Source finding', level: 5 },
      { key: 'synthesis', label: 'Synthesis', level: 4 },
    ],
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 12,
  },
  {
    id: AGENT_ATLAS,
    name: 'Atlas',
    emoji: '🛠️',
    accent: '#5fd4a4',
    status: 'online',
    endpointUrl: 'http://localhost:8002/chat',
    model: 'qwen2.5-coder:32b',
    systemPrompt:
      'You are Atlas, a senior software engineer. You write small, readable diffs and explain trade-offs before recommending one.',
    skills: [
      { key: 'typescript', label: 'TypeScript', level: 5 },
      { key: 'api-design', label: 'API design', level: 4 },
      { key: 'system-design', label: 'System design', level: 4 },
    ],
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 11,
  },
  {
    id: AGENT_PIXEL,
    name: 'Pixel',
    emoji: '🎨',
    accent: '#f0a4c8',
    status: 'busy',
    endpointUrl: 'http://localhost:8003/chat',
    model: 'claude-sonnet-4',
    systemPrompt:
      'You are Pixel, a product designer. You care about spacing, contrast and states: hover, focus, empty, error.',
    skills: [
      { key: 'ux', label: 'UX flows', level: 5 },
      { key: 'ui', label: 'UI design', level: 4 },
      { key: 'design-systems', label: 'Design systems', level: 4 },
    ],
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 9,
  },
  {
    id: AGENT_SAGE,
    name: 'Sage',
    emoji: '📝',
    accent: '#f5c56b',
    status: 'offline',
    endpointUrl: 'http://localhost:8004/chat',
    model: 'llama3.1:70b',
    systemPrompt:
      'You are Sage, an editor. You cut filler, prefer concrete verbs, and keep the reader’s attention on one idea per paragraph.',
    skills: [
      { key: 'editing', label: 'Editing', level: 5 },
      { key: 'style', label: 'Style & voice', level: 4 },
      { key: 'structure', label: 'Structure', level: 4 },
    ],
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 6,
  },
];

const CHANNEL_ID = 'conv-build-room';

export const seedConversations: Conversation[] = [
  {
    id: CHANNEL_ID,
    kind: 'channel',
    name: 'Build Room',
    agentIds: [AGENT_ATLAS, AGENT_PIXEL, AGENT_SCOUT],
    topic: 'Shipping the teamz front-end',
    createdAt: Date.now() - 1000 * 60 * 60 * 5,
  },
  {
    id: 'conv-scout',
    kind: 'direct',
    name: 'Scout',
    agentIds: [AGENT_SCOUT],
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 3,
  },
  {
    id: 'conv-atlas',
    kind: 'direct',
    name: 'Atlas',
    agentIds: [AGENT_ATLAS],
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
  },
  {
    id: 'conv-pixel',
    kind: 'direct',
    name: 'Pixel',
    agentIds: [AGENT_PIXEL],
    createdAt: Date.now() - 1000 * 60 * 60 * 20,
  },
];

const mins = (n: number) => Date.now() - n * 60 * 1000;

const msg = (
  conversationId: string,
  authorType: 'user' | 'agent',
  text: string,
  createdAt: number,
  authorId?: string,
): Message => ({
  id: `seed-${conversationId}-${createdAt}-${Math.random().toString(36).slice(2, 7)}`,
  conversationId,
  authorType,
  authorId,
  text,
  createdAt,
  status: 'sent',
});

export const seedMessages: Record<string, Message[]> = {
  [CHANNEL_ID]: [
    msg(CHANNEL_ID, 'user', 'Kickoff: we need a front-end that feels like Teamily but talks to our own agents.', mins(180)),
    msg(
      CHANNEL_ID,
      'agent',
      'Here’s how I’d cut it. One shell: a 300px sidebar for the roster, a chat pane for the active thread, and a settings drawer that slides over the pane instead of replacing it — you never lose your scroll position.\n\nEvery agent is just `{ name, emoji, endpointUrl, model, systemPrompt }`. Channels are an array of agent ids. That’s the whole data model.',
      mins(176),
      AGENT_ATLAS,
    ),
    msg(
      CHANNEL_ID,
      'agent',
      'Two UI notes from me:\n\n• Keep agent colours as a 1px ring plus the name, never a full bubble fill — five saturated bubbles read as a rainbow, not a conversation.\n• The composer should show *who* will answer before you hit enter. In a channel that’s ambiguous unless you surface it.',
      mins(174),
      AGENT_PIXEL,
    ),
    msg(CHANNEL_ID, 'user', 'Agreed on both. What about the API layer?', mins(150)),
    msg(
      CHANNEL_ID,
      'agent',
      'One file, `src/api/agents.ts`, and one function that matters: `sendToAgent()`. Mock mode returns canned persona replies after a delay; live mode POSTs `{ agent, messages, channel }` to `agent.endpointUrl` and accepts a few response shapes (`reply`, `text`, or OpenAI-style `choices[0].message.content`). Swap the mode with a single env var.',
      mins(147),
      AGENT_ATLAS,
    ),
    msg(
      CHANNEL_ID,
      'agent',
      'I can draft the README if you want it in prose rather than bullet soup — the “how to connect a real agent” section is where people give up.',
      mins(140),
      AGENT_SCOUT,
    ),
  ],
  'conv-scout': [
    msg('conv-scout', 'user', 'What should I read before wiring up multi-agent routing?', mins(60 * 26)),
    msg(
      'conv-scout',
      'agent',
      'Three things, in this order:\n\n1. Anthropic’s “Building effective agents” — it separates workflows from agents, which is the exact distinction you need before adding a router.\n2. The ReAct paper for the reason/act loop shape.\n3. Your own server logs. Honestly the highest-signal source for routing bugs is the request trace, not a paper.\n\nWant me to pull the first one into a one-page summary?',
      mins(60 * 25 + 40),
      AGENT_SCOUT,
    ),
  ],
  'conv-atlas': [
    msg('conv-atlas', 'user', 'Give me a typesafe event handler for streaming agent tokens.', mins(60 * 20)),
    msg(
      'conv-atlas',
      'agent',
      'Two options, and I’d pick the first:\n\n```ts\nasync function* streamAgent(url: string, body: unknown, signal: AbortSignal) {\n  const res = await fetch(url, {\n    method: "POST",\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify(body),\n    signal,\n  });\n  if (!res.body) throw new Error(`No stream: ${res.status}`);\n\n  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();\n  let buf = "";\n  while (true) {\n    const { value, done } = await reader.read();\n    if (done) break;\n    buf += value;\n    const parts = buf.split("\\n\\n");\n    buf = parts.pop() ?? "";\n    for (const part of parts) {\n      const line = part.replace(/^data:\\s*/, "").trim();\n      if (!line || line === "[DONE]") continue;\n      yield JSON.parse(line) as { delta?: string };\n    }\n  }\n}\n```\n\nAlernative is `EventSource`, but it can’t do POST bodies — so it only works if your server accepts the prompt in the query string, which it shouldn’t.',
      mins(60 * 19 + 30),
      AGENT_ATLAS,
    ),
  ],
  'conv-pixel': [
    msg('conv-pixel', 'user', 'How dark should the dark theme be?', mins(60 * 8)),
    msg(
      'conv-pixel',
      'agent',
      'Not black. Pure `#000` makes bubbles float in a void and every border looks like a hairline crack.\n\nStart at `#0b0d12` for the canvas, lift panels to `#12151c`, and put bubbles at `#1a1f29`. Text at `#e8ecf4` primary and `#8a93a6` secondary — the second one matters more than people think, because timestamps and member lists live there.',
      mins(60 * 7 + 55),
      AGENT_PIXEL,
    ),
  ],
};

export const seedState: WorkspaceState = {
  agents: seedAgents,
  conversations: seedConversations,
  messages: seedMessages,
  // A fresh workspace is unfiltered — the filter map only gains entries once
  // the user actually narrows a channel.
  filters: {},
  activeConversationId: CHANNEL_ID,
};

/** Emoji palette offered when creating an agent. */
export const EMOJI_PALETTE = [
  '🔭', '🛠️', '🎨', '📝', '🧠', '⚡', '🛰️', '🧪', '📊', '🦉',
  '🐙', '🌱', '🔮', '🧭', '🎯', '💬', '🧩', '🚀', '🕵️', '📚',
];

export const ACCENT_PALETTE = [
  '#7c9cff', '#5fd4a4', '#f0a4c8', '#f5c56b', '#a78bfa',
  '#4fd1c5', '#fb923c', '#f87171', '#60a5fa', '#c084fc',
];
