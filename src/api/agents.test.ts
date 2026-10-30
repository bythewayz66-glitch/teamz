import { describe, expect, it } from 'vitest';
import type { Agent, Message } from '../types';
import { buildRequest, parseReply, windowHistory, HISTORY_CHAR_BUDGET } from './agents';

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  emoji: '🤖',
  accent: '#fff',
  status: 'online',
  endpointUrl: 'http://localhost:9/chat',
  model: 'gpt-4o-mini',
  systemPrompt: `You are ${name}.`,
  skills: [],
  createdAt: 0,
});

const atlas = agent('a', 'Atlas');
const pixel = agent('p', 'Pixel');
const byId = new Map([atlas, pixel].map((a) => [a.id, a]));

let n = 0;
const msg = (authorType: 'user' | 'agent', text: string, authorId?: string): Message => ({
  id: `m${n++}`,
  conversationId: 'c',
  authorType,
  authorId,
  text,
  createdAt: n,
  status: 'sent',
});

describe('buildRequest', () => {
  it('maps user messages to user role and agent messages to assistant', () => {
    const history = [msg('user', 'hi'), msg('agent', 'hello', 'a')];
    const req = buildRequest(atlas, history, byId, {
      conversationId: 'c',
      conversationName: 'DM',
    });
    expect(req.messages).toEqual([
      { role: 'user', content: 'hi', authorName: undefined },
      { role: 'assistant', content: 'hello', authorName: 'Atlas' },
    ]);
    expect(req.agent.name).toBe('Atlas');
    expect(req.channel.id).toBe('c');
  });

  it('sets directed flag only when provided', () => {
    const req = buildRequest(atlas, [msg('user', 'x')], byId, {
      conversationId: 'c',
      conversationName: 'c',
      directed: true,
    });
    expect(req.directed).toBe(true);
    const req2 = buildRequest(atlas, [msg('user', 'x')], byId, {
      conversationId: 'c',
      conversationName: 'c',
    });
    expect(req2.directed).toBeUndefined();
  });

  it('windows history to the character budget', () => {
    const big = 'x'.repeat(HISTORY_CHAR_BUDGET + 100);
    const history = [msg('user', big), msg('user', 'recent')];
    const req = buildRequest(atlas, history, byId, { conversationId: 'c', conversationName: 'c' });
    // Only the most recent turn fits.
    expect(req.messages.length).toBe(1);
    expect(req.messages[0].content).toBe('recent');
  });
});

describe('parseReply', () => {
  it('reads reply/text/message/content/output keys', () => {
    for (const key of ['reply', 'text', 'message', 'content', 'output']) {
      expect(parseReply({ [key]: 'hi' })).toBe('hi');
    }
  });
  it('reads OpenAI choices', () => {
    expect(parseReply({ choices: [{ message: { content: 'yo' } }] })).toBe('yo');
  });
  it('reads delta.content', () => {
    expect(parseReply({ delta: { content: 'stream' } })).toBe('stream');
  });
  it('reads Anthropic content blocks', () => {
    expect(parseReply({ content: [{ type: 'text', text: 'block' }] })).toBe('block');
  });
  it('reads plain string', () => {
    expect(parseReply('plain')).toBe('plain');
  });
  it('throws on unknown payload', () => {
    expect(() => parseReply({ foo: 1 })).toThrow();
    expect(() => parseReply(null)).toThrow();
  });
});

describe('windowHistory', () => {
  it('returns empty for empty input', () => {
    expect(windowHistory([])).toEqual([]);
  });
  it('keeps all messages when under budget', () => {
    const h = [msg('user', 'a'), msg('user', 'b')];
    expect(windowHistory(h)).toHaveLength(2);
  });
  it('always keeps at least the last turn', () => {
    const h = [msg('user', 'x'.repeat(HISTORY_CHAR_BUDGET * 2))];
    expect(windowHistory(h)).toHaveLength(1);
  });
  it('does not mutate input', () => {
    const h = [msg('user', 'a')];
    const copy = [...h];
    windowHistory(h);
    expect(h).toEqual(copy);
  });
});
