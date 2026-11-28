/**
 * Global search — agents, sessions (by name and by what was said inside them)
 * and settings, behind one query box. Pure and synchronous: it scans the
 * in-memory workspace, which is all the data there is.
 *
 * Matching: every whitespace-separated word of the query must appear
 * (case-insensitive) somewhere in the candidate. An exact phrase hit scores
 * higher than the words merely co-occurring, and a hit in a name scores higher
 * than a hit in a message body. That is deliberate — "find the session where
 * we said X" is a phrase query, so the phrase must win.
 */

import type { Agent, Conversation, Message, WorkspaceState } from '../types';
import { oneLine, timeAgo } from './agentHome';
import { isSession, lastActivity } from './sessions';

export type SettingTarget = 'workspace' | 'jobs' | 'new-agent' | 'new-channel' | 'cost-rate';

export type SearchAction =
  | { type: 'open-agent'; agentId: string }
  | { type: 'open-session'; conversationId: string; messageId?: string }
  | { type: 'open-setting'; target: SettingTarget };

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

export interface SearchResult {
  id: string;
  group: 'agent' | 'session' | 'setting';
  title: string;
  subtitle: string;
  snippet?: Snippet;
  score: number;
  /** Epoch ms, for ordering ties and for showing "3d ago". */
  at?: number;
  action: SearchAction;
}

interface SettingEntry {
  target: SettingTarget;
  title: string;
  subtitle: string;
  keywords: string;
}

const SETTINGS: SettingEntry[] = [
  {
    target: 'workspace',
    title: 'Workspace & API',
    subtitle: 'AI provider, model, API key, reset workspace',
    keywords: 'provider api key model endpoint pollinations deepinfra reset settings preferences',
  },
  {
    target: 'cost-rate',
    title: 'Token cost rate',
    subtitle: 'Dollars per million tokens, used for cost-to-date',
    keywords: 'cost price pricing spend budget dollars usd tokens rate billing',
  },
  {
    target: 'jobs',
    title: 'Jobs & Scheduler',
    subtitle: 'Automations, cron, triggers, approvals',
    keywords: 'cron schedule automations triggers approvals runner jobs',
  },
  {
    target: 'new-agent',
    title: 'New agent',
    subtitle: 'Create an agent from a template or from scratch',
    keywords: 'create add agent template',
  },
  {
    target: 'new-channel',
    title: 'New channel',
    subtitle: 'A room where several agents answer together',
    keywords: 'create add channel room team',
  },
];

const tokenize = (q: string): string[] =>
  q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

const allIn = (haystackLower: string, tokens: string[]): boolean =>
  tokens.every((t) => haystackLower.includes(t));

/** A short excerpt around the first hit, split so the UI can bold the match. */
export function makeSnippet(text: string, query: string, radius = 64): Snippet | undefined {
  const flat = oneLine(text);
  if (!flat) return undefined;
  const lower = flat.toLowerCase();
  const phrase = query.trim().toLowerCase().replace(/\s+/g, ' ');
  let idx = phrase ? lower.indexOf(phrase) : -1;
  let len = phrase.length;
  if (idx < 0) {
    for (const t of tokenize(query)) {
      const i = lower.indexOf(t);
      if (i >= 0) {
        idx = i;
        len = t.length;
        break;
      }
    }
  }
  if (idx < 0) return undefined;
  const start = Math.max(0, idx - radius);
  const end = Math.min(flat.length, idx + len + radius);
  return {
    before: (start > 0 ? '…' : '') + flat.slice(start, idx),
    match: flat.slice(idx, idx + len),
    after: flat.slice(idx + len, end) + (end < flat.length ? '…' : ''),
  };
}

function agentHaystack(a: Agent): string {
  return [
    a.name,
    a.id,
    a.model,
    a.origin?.role ?? '',
    a.role ?? '',
    a.skills.map((s) => s.label).join(' '),
    (a.capabilities ?? []).join(' '),
  ]
    .join(' ')
    .toLowerCase();
}

function scoreAgent(a: Agent, q: string, tokens: string[]): number {
  const name = a.name.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 90;
  if (name.includes(q)) return 80;
  if (allIn(name, tokens)) return 70;
  if (allIn(agentHaystack(a), tokens)) return 40;
  return 0;
}

export interface SearchOptions {
  limitPerGroup?: number;
  now?: number;
}

/**
 * Search the workspace. An empty query returns what you probably want next:
 * the most recent sessions and the settings entries.
 */
export function searchWorkspace(
  state: Pick<WorkspaceState, 'agents' | 'conversations' | 'messages'>,
  query: string,
  opts: SearchOptions = {},
): SearchResult[] {
  const limit = opts.limitPerGroup ?? 8;
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const tokens = tokenize(query);
  const agentsById = new Map(state.agents.map((a) => [a.id, a]));
  const results: SearchResult[] = [];

  const sessionTitle = (c: Conversation): string => {
    const owner = c.session?.agentId ? agentsById.get(c.session.agentId) : undefined;
    return owner ? `${owner.name} · ${c.name}` : c.name;
  };
  const sessionSubtitle = (c: Conversation): string => {
    const kind =
      c.session?.kind === 'room' ? 'Shared room' : c.session?.kind === 'work' ? 'Work session' : 'Chat session';
    return kind;
  };

  if (tokens.length === 0) {
    // Gamut's palette opens on "Recent agents" then "Recent sessions".
    const nowMs = opts.now ?? Date.now();
    const lastActive = new Map<string, number>();
    for (const c of state.conversations) {
      const owner = c.session?.agentId;
      const msgs = state.messages[c.id];
      if (!owner || c.session?.status === 'archived' || !msgs || msgs.length === 0) continue;
      lastActive.set(owner, Math.max(lastActive.get(owner) ?? 0, lastActivity(c, msgs)));
    }
    const recentAgents = [...lastActive.entries()]
      .filter(([id]) => agentsById.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [id, at] of recentAgents) {
      const a = agentsById.get(id)!;
      results.push({
        id: `agent:${id}`,
        group: 'agent',
        title: a.name,
        subtitle: `Last active ${timeAgo(at, nowMs)}`,
        score: 1,
        at,
        action: { type: 'open-agent', agentId: id },
      });
    }
    const recent = state.conversations
      .filter(isSession)
      .filter((c) => c.session.status !== 'archived' && (state.messages[c.id]?.length ?? 0) > 0)
      .map((c) => ({ c, at: lastActivity(c, state.messages[c.id]) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 5);
    for (const { c, at } of recent) {
      results.push({
        id: `session:${c.id}`,
        group: 'session',
        title: sessionTitle(c),
        subtitle: sessionSubtitle(c),
        score: 1,
        at,
        action: { type: 'open-session', conversationId: c.id },
      });
    }
    for (const s of SETTINGS) {
      results.push({
        id: `setting:${s.target}`,
        group: 'setting',
        title: s.title,
        subtitle: s.subtitle,
        score: 1,
        action: { type: 'open-setting', target: s.target },
      });
    }
    return results;
  }

  const agentHits: SearchResult[] = [];
  for (const a of state.agents) {
    const score = scoreAgent(a, q, tokens);
    if (score === 0) continue;
    agentHits.push({
      id: `agent:${a.id}`,
      group: 'agent',
      title: a.name,
      subtitle: a.origin?.role ?? a.role ?? a.model,
      score,
      action: { type: 'open-agent', agentId: a.id },
    });
  }
  agentHits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  const sessionHits: SearchResult[] = [];
  for (const c of state.conversations) {
    if (!isSession(c) || c.session.status === 'archived') continue;
    const owner = c.session.agentId ? agentsById.get(c.session.agentId) : undefined;
    const title = sessionTitle(c);
    const titleLower = `${title} ${owner?.model ?? ''}`.toLowerCase();
    const msgs: Message[] = state.messages[c.id] ?? [];
    const at = lastActivity(c, msgs);

    let best: { score: number; msg?: Message } | null = null;
    if (titleLower.includes(q)) best = { score: 85 };
    else if (allIn(titleLower, tokens)) best = { score: 65 };

    // Prefer the newest message that contains the whole phrase, then the
    // newest that contains every word.
    let phraseMsg: Message | undefined;
    let wordsMsg: Message | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.status === 'pending' || !m.text) continue;
      const t = m.text.toLowerCase();
      if (!phraseMsg && t.includes(q)) {
        phraseMsg = m;
        break;
      }
      if (!wordsMsg && allIn(t, tokens)) wordsMsg = m;
    }
    if (phraseMsg && (!best || best.score < 60)) best = { score: 60, msg: phraseMsg };
    else if (wordsMsg && !best) best = { score: 35, msg: wordsMsg };
    else if (best && !best.msg && (phraseMsg || wordsMsg)) best.msg = phraseMsg ?? wordsMsg;
    if (!best) continue;

    sessionHits.push({
      id: `session:${c.id}`,
      group: 'session',
      title,
      subtitle: sessionSubtitle(c),
      snippet: best.msg ? makeSnippet(best.msg.text, query) : undefined,
      score: best.score,
      at: best.msg?.createdAt ?? at,
      action: { type: 'open-session', conversationId: c.id, messageId: best.msg?.id },
    });
  }
  sessionHits.sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0));

  const settingHits: SearchResult[] = [];
  for (const s of SETTINGS) {
    const hay = `${s.title} ${s.subtitle} ${s.keywords}`.toLowerCase();
    if (!allIn(hay, tokens)) continue;
    settingHits.push({
      id: `setting:${s.target}`,
      group: 'setting',
      title: s.title,
      subtitle: s.subtitle,
      score: s.title.toLowerCase().includes(q) ? 75 : 30,
      action: { type: 'open-setting', target: s.target },
    });
  }
  settingHits.sort((a, b) => b.score - a.score);

  results.push(...agentHits.slice(0, limit), ...sessionHits.slice(0, limit), ...settingHits.slice(0, limit));
  return results;
}
