import { describe, expect, it } from 'vitest';
import type { Agent } from '../types';
import {
  activeQuery,
  applyMention,
  handleFor,
  parseMentions,
  rankMentions,
} from './mentions';

/**
 * Minimal Agent factory. The mention code only ever reads `id`, `name` and
 * (for ranking) `skills`, so building the full domain object here would be
 * noise — but we keep the real type so a change to `Agent` breaks these tests
 * at compile time rather than silently at runtime.
 */
function agent(id: string, name: string, skills: Agent['skills'] = []): Agent {
  return {
    id,
    name,
    emoji: '🤖',
    accent: '#7c9cff',
    status: 'online',
    endpointUrl: 'http://localhost:8001/chat',
    model: 'gpt-4o',
    systemPrompt: '',
    skills,
    createdAt: 0,
  };
}

describe('handleFor', () => {
  it('kebab-cases a display name', () => {
    expect(handleFor('Frontend Engineer')).toBe('frontend-engineer');
    expect(handleFor('Senior Frontend Engineer (React)')).toBe(
      'senior-frontend-engineer-react',
    );
  });

  it('strips punctuation and collapses runs of separators', () => {
    expect(handleFor("Children's Author")).toBe('childrens-author');
    expect(handleFor('  Data   &  Analytics  ')).toBe('data-analytics');
  });
});

describe('parseMentions — multiple mentions', () => {
  const agents = [
    agent('a1', 'Scout'),
    agent('a2', 'Atlas'),
    agent('a3', 'Pixel'),
  ];

  it('returns every agent addressed in one message', () => {
    const hits = parseMentions('@Scout and @Atlas — can you both look at this?', agents);
    expect(hits.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('returns all three when all three are named', () => {
    const hits = parseMentions('@Scout @Atlas @Pixel standup in 5', agents);
    expect(hits.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('preserves the order the mentions appear in the text, not the roster order', () => {
    const hits = parseMentions('@Pixel first, then @Scout', agents);
    expect(hits.map((a) => a.id)).toEqual(['a3', 'a1']);
  });

  it('does not return the same agent twice when mentioned twice', () => {
    const hits = parseMentions('@Scout ping @Scout again', agents);
    expect(hits.map((a) => a.id)).toEqual(['a1']);
  });

  it('returns an empty array when nobody is mentioned', () => {
    expect(parseMentions('just a normal message', agents)).toEqual([]);
  });

  it('returns an empty array when there are no agents to match', () => {
    expect(parseMentions('@Scout hello', [])).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const hits = parseMentions('@scout @ATLAS', agents);
    expect(hits.map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('parseMentions — longest name wins', () => {
  // "Frontend" is a strict prefix of "Frontend Engineer", so a naive
  // substring match would fire both. Only the more specific one should win.
  const agents = [agent('short', 'Frontend'), agent('long', 'Frontend Engineer')];

  it('prefers the longer, more specific name when both could match', () => {
    const hits = parseMentions('@Frontend Engineer can you review this?', agents);
    expect(hits.map((a) => a.id)).toEqual(['long']);
  });

  it('still matches the short name when the long one is not present', () => {
    const hits = parseMentions('@Frontend can you review this?', agents);
    expect(hits.map((a) => a.id)).toEqual(['short']);
  });

  it('handles a three-deep prefix chain', () => {
    const chain = [
      agent('l1', 'Engineer'),
      agent('l2', 'Frontend Engineer'),
      agent('l3', 'Senior Frontend Engineer'),
    ];
    const hits = parseMentions('@Senior Frontend Engineer please advise', chain);
    expect(hits.map((a) => a.id)).toEqual(['l3']);
  });

  it('does not let a shorter name swallow a longer one mid-sentence', () => {
    const hits = parseMentions('ask @Frontend Engineer about it', agents);
    expect(hits.map((a) => a.id)).toEqual(['long']);
  });
});

describe('parseMentions — things that are not mentions', () => {
  const agents = [agent('a1', 'Scout'), agent('a2', 'Frontend Engineer')];

  it('ignores an email address', () => {
    expect(parseMentions('ping me at someone@example.com', agents)).toEqual([]);
  });

  it('ignores an email whose local part matches an agent name', () => {
    expect(parseMentions('mail scout@example.com', agents)).toEqual([]);
  });

  it('ignores an @ that follows a word character', () => {
    expect(parseMentions('user@Scout', agents)).toEqual([]);
  });

  it('ignores a bare @ with nothing after it', () => {
    expect(parseMentions('hey @', agents)).toEqual([]);
  });

  it('ignores a name that is only a partial word match', () => {
    // "Scoutmaster" must not match the agent "Scout".
    expect(parseMentions('@Scoutmaster is a different word', agents)).toEqual([]);
  });

  it('still matches when the mention is followed by punctuation', () => {
    const hits = parseMentions('@Scout, take a look.', agents);
    expect(hits.map((a) => a.id)).toEqual(['a1']);
  });
});

describe('parseMentions — kebab-case handles', () => {
  const agents = [agent('a1', 'Frontend Engineer'), agent('a2', 'SEO Specialist')];

  it('matches the kebab handle of a multi-word name', () => {
    const hits = parseMentions('@frontend-engineer take a look', agents);
    expect(hits.map((a) => a.id)).toEqual(['a1']);
  });

  it('matches a handle case-insensitively', () => {
    const hits = parseMentions('@SEO-Specialist what do you think?', agents);
    expect(hits.map((a) => a.id)).toEqual(['a2']);
  });

  it('matches a mix of display name and handle in one message', () => {
    const hits = parseMentions('@Frontend Engineer and @seo-specialist', agents);
    expect(hits.map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('activeQuery', () => {
  it('finds the token being typed at the caret', () => {
    expect(activeQuery('hi @fr', 6)).toEqual({ query: 'fr', start: 3, end: 6 });
  });

  it('returns an empty query for a bare @', () => {
    expect(activeQuery('hi @', 4)).toEqual({ query: '', start: 3, end: 4 });
  });

  it('returns null when the caret is not inside a mention', () => {
    expect(activeQuery('hi there', 8)).toBeNull();
  });

  it('returns null for an email address', () => {
    expect(activeQuery('mail a@b.com', 12)).toBeNull();
  });

  it('returns null once the token is clearly prose', () => {
    expect(activeQuery(`@${'x'.repeat(41)}`, 42)).toBeNull();
  });

  it('only considers text before the caret', () => {
    // The caret sits before the "@", so there is no active token.
    expect(activeQuery('hi @Scout', 3)).toBeNull();
  });
});

describe('applyMention', () => {
  it('replaces the in-progress token and reports the new caret', () => {
    const result = applyMention('hi @fr', { start: 3, end: 6 }, 'Frontend Engineer');
    expect(result.text).toBe('hi @Frontend Engineer ');
    expect(result.caret).toBe(result.text.length);
  });

  it('keeps the text that followed the token', () => {
    const result = applyMention('hi @fr please look', { start: 3, end: 6 }, 'Scout');
    expect(result.text).toBe('hi @Scout  please look');
    // Caret lands immediately after the inserted mention, before the space.
    expect(result.caret).toBe('hi @Scout '.length);
  });

  it('places the caret right after the committed mention', () => {
    const { text, caret } = applyMention('@a', { start: 0, end: 2 }, 'Atlas');
    expect(text).toBe('@Atlas ');
    expect(caret).toBe(7);
    expect(text.slice(0, caret)).toBe('@Atlas ');
  });

  it('round-trips: a committed mention is then parseable', () => {
    const agents = [agent('a1', 'Frontend Engineer')];
    const { text } = applyMention('hi @fr', { start: 3, end: 6 }, 'Frontend Engineer');
    expect(parseMentions(text, agents).map((a) => a.id)).toEqual(['a1']);
  });
});

describe('rankMentions', () => {
  const agents = [
    agent('a1', 'Frontend Engineer'),
    agent('a2', 'Backend Engineer'),
    agent('a3', 'Scout', [{ key: 'x', label: 'Frontend', level: 3 }]),
  ];

  it('ranks an exact handle match first', () => {
    const ranked = rankMentions('frontend-engineer', agents);
    expect(ranked[0].id).toBe('a1');
  });

  it('ranks prefix matches above substring matches', () => {
    const ranked = rankMentions('back', agents);
    expect(ranked[0].id).toBe('a2');
  });

  it('falls back to skill labels', () => {
    const ranked = rankMentions('frontend', agents);
    expect(ranked.map((a) => a.id)).toContain('a3');
  });

  it('returns the first N agents for an empty query', () => {
    expect(rankMentions('', agents, 2).map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('returns nothing when no agent matches', () => {
    expect(rankMentions('zzzz', agents)).toEqual([]);
  });
});
