/**
 * ============================================================================
 *  @mention parsing
 * ============================================================================
 *
 *  One implementation, used by both sides of the feature:
 *
 *    • the composer decides *what to offer* in the autocomplete
 *      (`activeQuery` + `rankMentions`)
 *    • the store decides *who a sent message goes to* (`parseMentions`)
 *
 *  Matching rules, in order:
 *    1. `@Name` — longest agent name wins, so "@Frontend Engineer" never
 *       matches a hypothetical agent called "@Frontend".
 *    2. `@handle` — the kebab-cased name ("@frontend-engineer"), for names
 *       with spaces that are painful to type.
 *
 *  Names are matched case-insensitively but the message keeps its original
 *  text: we never rewrite what the user typed.
 */

import type { Agent } from '../types';

/** Characters that may follow a mention without breaking it. */
const BOUNDARY = /[\s.,!?;:)\]}"'\\/]/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Kebab-case form of an agent name, used as a typeable handle. */
export function handleFor(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Return the agents a message is addressed to, in order of first appearance.
 * An empty array means "nobody was mentioned" — the caller decides whether
 * that means broadcast (channel) or the single member (DM).
 */
export function parseMentions(text: string, agents: Agent[]): Agent[] {
  if (!text.includes('@') || agents.length === 0) return [];

  // Longest name first so "@Senior Frontend Engineer" beats "@Senior".
  const candidates = agents
    .map((agent) => ({ agent, name: agent.name.trim(), handle: handleFor(agent.name) }))
    .filter((c) => c.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);

  const hit = new Map<string, Agent>();

  for (const { agent, name, handle } of candidates) {
    // `@` + the full display name, matched literally but case-insensitively.
    const nameRe = new RegExp(`(^|[^\\w@/])@${escapeRe(name)}(?=$|${BOUNDARY.source})`, 'i');
    if (nameRe.test(text)) {
      hit.set(agent.id, agent);
      continue;
    }
    // `@` + the kebab handle, also matched as a token.
    if (handle) {
      const handleRe = new RegExp(`(^|[^\\w@/])@${escapeRe(handle)}(?=$|${BOUNDARY.source})`, 'i');
      if (handleRe.test(text)) hit.set(agent.id, agent);
    }
  }

  if (hit.size === 0) return [];

  // Preserve the order the mentions appear in the text.
  return [...hit.values()].sort((a, b) => {
    const ia = firstIndex(text, a);
    const ib = firstIndex(text, b);
    return ia - ib;
  });
}

function firstIndex(text: string, agent: Agent): number {
  const lower = text.toLowerCase();
  const byName = lower.indexOf(`@${agent.name.trim().toLowerCase()}`);
  const byHandle = lower.indexOf(`@${handleFor(agent.name)}`);
  if (byName === -1) return byHandle;
  if (byHandle === -1) return byName;
  return Math.min(byName, byHandle);
}

/**
 * The token currently being typed at the caret, if it looks like a mention.
 * Returns null when the caret is not inside an `@…` sequence.
 *
 *   "hi @fr|"        -> { query: 'fr', start: 3, end: 6 }
 *   "hi @|"          -> { query: '',   start: 3, end: 4 }
 *   "mail a@b.com|"  -> null   (not a mention: `@` follows a word char)
 */
export function activeQuery(
  text: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;

  // The `@` must start the text or follow a space/bracket.
  if (at > 0 && /[\w@/]/.test(text[at - 1])) return null;

  const query = upto.slice(at + 1);
  // A newline or a run of spaces ends the token.
  if (/[\n]/.test(query) || /\s{2,}/.test(query)) return null;
  // Beyond a reasonable name length it is prose, not a mention.
  if (query.length > 40) return null;

  return { query, start: at, end: caret };
}

/**
 * Filter + rank agents for the autocomplete.
 * Prefix matches on the name or handle outrank substring matches, and an
 * exact handle match always wins.
 */
export function rankMentions(query: string, agents: Agent[], limit = 8): Agent[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents.slice(0, limit);

  const scored: { agent: Agent; score: number }[] = [];

  for (const agent of agents) {
    const name = agent.name.toLowerCase();
    const handle = handleFor(agent.name);
    let score = 0;

    if (handle === q || name === q) score = 100;
    else if (name.startsWith(q) || handle.startsWith(q)) score = 60;
    else if (name.split(/\s+/).some((word) => word.startsWith(q))) score = 45;
    else if (name.includes(q) || handle.includes(q)) score = 25;
    else if (agent.skills?.some((s) => s.label.toLowerCase().includes(q))) score = 10;

    if (score > 0) scored.push({ agent, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name))
    .slice(0, limit)
    .map((s) => s.agent);
}

/** Replace the in-progress `@query` with a committed `@Name ` mention. */
export function applyMention(
  text: string,
  token: { start: number; end: number },
  agentName: string,
): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  const inserted = `@${agentName} `;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

/** Agents named in `text`, used to render mention chips in a bubble. */
export function mentionedAgents(text: string, agents: Agent[]): Agent[] {
  return parseMentions(text, agents);
}
