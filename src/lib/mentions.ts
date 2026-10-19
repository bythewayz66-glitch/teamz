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

  const candidates = agents
    .map((agent) => ({ agent, name: agent.name.trim(), handle: handleFor(agent.name) }))
    .filter((c) => c.name.length > 0);

  /**
   * Every place an agent could be mentioned, as a half-open span in `text`.
   *
   * We collect *all* candidate spans first and only then decide which ones
   * count, because "longest name wins" is a property of the whole message, not
   * of one agent: `@Frontend Engineer` must resolve to the specific agent and
   * must NOT also fire the generic "Frontend" agent whose name is a prefix of
   * it. Testing each agent independently cannot express that — the shorter
   * agent matches perfectly well on its own terms.
   */
  interface Span {
    agent: Agent;
    start: number;
    end: number;
    length: number;
  }

  const spans: Span[] = [];

  for (const { agent, name, handle } of candidates) {
    // The display name and the kebab handle are both valid ways to address
    // the same agent, so both are collected.
    for (const token of [name, handle]) {
      if (!token) continue;

      const re = new RegExp(
        `(^|[^\\w@/])@${escapeRe(token)}(?=$|${BOUNDARY.source})`,
        'gi',
      );

      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        // `match[1]` is the boundary character (or empty at the start), which
        // is not part of the mention itself.
        const start = match.index + match[1].length;
        spans.push({ agent, start, end: start + 1 + token.length, length: token.length });

        // Zero-length matches cannot happen here, but guard the loop anyway.
        if (match.index === re.lastIndex) re.lastIndex += 1;
      }
    }
  }

  // Longest token first, so the most specific name claims its span before a
  // shorter name can. Ties break on position to keep the result deterministic.
  spans.sort((a, b) => b.length - a.length || a.start - b.start);

  const claimed: { start: number; end: number }[] = [];
  const firstSeen = new Map<string, number>();

  for (const span of spans) {
    // A span that overlaps one already claimed is part of a longer mention
    // that has been resolved — drop it.
    const overlaps = claimed.some((c) => span.start < c.end && span.end > c.start);
    if (overlaps) continue;

    claimed.push({ start: span.start, end: span.end });
    if (!firstSeen.has(span.agent.id)) firstSeen.set(span.agent.id, span.start);
  }

  if (firstSeen.size === 0) return [];

  // Preserve the order the mentions appear in the text.
  return [...firstSeen.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => agents.find((a) => a.id === id)!)
    .filter(Boolean);
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
