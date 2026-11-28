import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../types';
import { seedState } from '../data/mock';
import { migrateToSessions, newChatSession } from './sessions';
import { makeSnippet, searchWorkspace } from './search';

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const DAY = 86_400_000;

function workspace(): WorkspaceState {
  const s = migrateToSessions(structuredClone(seedState), NOW);
  const old = newChatSession({ id: 'agent-atlas' }, 'sess-old', NOW - 7 * DAY, 'Billing cutover');
  const other = newChatSession({ id: 'agent-scout' }, 'sess-other', NOW - 2 * DAY, 'Market scan');
  return {
    ...s,
    conversations: [old, other, ...s.conversations],
    messages: {
      ...s.messages,
      'sess-old': [
        { id: 'o1', conversationId: 'sess-old', authorType: 'user', text: 'Which flag gates the cutover?', createdAt: NOW - 7 * DAY, status: 'sent' },
        { id: 'o2', conversationId: 'sess-old', authorType: 'agent', authorId: 'agent-atlas', text: 'The flag is BILLING_DUAL_WRITE; flip it only after the zebra-stripe checksum matches.', createdAt: NOW - 7 * DAY + 1000, status: 'sent' },
      ],
      'sess-other': [
        { id: 'x1', conversationId: 'sess-other', authorType: 'agent', authorId: 'agent-scout', text: 'Three competitors, none with checksums.', createdAt: NOW - 2 * DAY, status: 'sent' },
      ],
    },
  };
}

describe('searchWorkspace', () => {
  it('finds a week-old session by a phrase inside it, with the phrase highlighted', () => {
    const r = searchWorkspace(workspace(), 'zebra-stripe checksum');
    const hit = r.find((x) => x.group === 'session');
    expect(hit?.action).toEqual({ type: 'open-session', conversationId: 'sess-old', messageId: 'o2' });
    expect(hit?.snippet?.match.toLowerCase()).toBe('zebra-stripe checksum');
    expect(hit?.title).toContain('Billing cutover');
  });

  it('matches words that are not adjacent, but ranks the exact phrase higher', () => {
    const s = workspace();
    const loose = searchWorkspace(s, 'checksum zebra').find((x) => x.id === 'session:sess-old');
    const exact = searchWorkspace(s, 'zebra-stripe').find((x) => x.id === 'session:sess-old');
    expect(loose).toBeDefined();
    expect(exact!.score).toBeGreaterThan(loose!.score);
  });

  it('finds an agent by name, prefix first', () => {
    const r = searchWorkspace(workspace(), 'atl');
    expect(r[0]).toMatchObject({ group: 'agent', title: 'Atlas', action: { type: 'open-agent', agentId: 'agent-atlas' } });
  });

  it('finds settings by what they do, not just their title', () => {
    const r = searchWorkspace(workspace(), 'api key');
    expect(r.some((x) => x.group === 'setting' && x.action.type === 'open-setting' && x.action.target === 'workspace')).toBe(true);
  });

  it('skips archived sessions and unfinished replies', () => {
    const s = workspace();
    s.conversations = s.conversations.map((c) => (c.id === 'sess-old' ? { ...c, session: { ...c.session!, status: 'archived' as const } } : c));
    expect(searchWorkspace(s, 'zebra-stripe').some((x) => x.id === 'session:sess-old')).toBe(false);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchWorkspace(workspace(), 'qqqzzzxxx')).toEqual([]);
  });

  it('with an empty query offers recent sessions and settings', () => {
    const r = searchWorkspace(workspace(), '');
    expect(r.some((x) => x.group === 'session')).toBe(true);
    expect(r.some((x) => x.group === 'setting')).toBe(true);
  });
});

describe('makeSnippet', () => {
  it('centres on the match and ellipsises long text', () => {
    const text = `${'a '.repeat(80)}needle${' b'.repeat(80)}`;
    const s = makeSnippet(text, 'needle')!;
    expect(s.match).toBe('needle');
    expect(s.before.startsWith('…')).toBe(true);
    expect(s.after.endsWith('…')).toBe(true);
  });
});
