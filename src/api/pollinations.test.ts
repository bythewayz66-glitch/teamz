import { describe, expect, it } from 'vitest';
import type { Agent, Message } from '../types';
import {
  DEFAULT_ANON_MODEL,
  DEFAULT_KEYED_MODEL,
  POLLINATIONS_ANON_URL,
  POLLINATIONS_KEYED_URL,
  buildPollinationsRequest,
  createSseParser,
} from './pollinations';
import { DEFAULT_SETTINGS, normaliseSettings, type LlmSettings } from './settings';

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name,
  emoji: '🤖',
  accent: '#fff',
  status: 'online',
  endpointUrl: '',
  model: 'gpt-4o-mini',
  systemPrompt: `You are ${name}.`,
  skills: [],
  createdAt: 0,
  ...extra,
});

const atlas = agent('a', 'Atlas', {
  skills: [
    { key: 'ts', label: 'TypeScript', level: 5 },
    { key: 'api', label: 'API design', level: 3 },
  ],
});
const pixel = agent('p', 'Pixel');
const byId = new Map([atlas, pixel].map((a) => [a.id, a]));

let n = 0;
const msg = (authorType: 'user' | 'agent', text: string, authorId?: string, status: Message['status'] = 'sent'): Message => ({
  id: `m${n++}`,
  conversationId: 'c',
  authorType,
  authorId,
  text,
  createdAt: n,
  status,
});

const settings = (p: Partial<LlmSettings> = {}): LlmSettings => ({ ...DEFAULT_SETTINGS, provider: 'pollinations', ...p });

describe('buildPollinationsRequest', () => {
  const history = [
    msg('user', 'How should we build it?'),
    msg('agent', 'Use a module boundary.', 'a'),
    msg('agent', 'Mind the spacing.', 'p'),
    msg('agent', '', 'p', 'pending'),
    msg('agent', 'boom', 'p', 'error'),
    msg('user', '@Atlas what about streaming?'),
  ];
  const ctx = {
    conversationKind: 'channel' as const,
    conversationName: 'Build Room',
    topic: 'Shipping',
    otherAgents: [{ id: 'p', name: 'Pixel' }],
    directed: true,
  };

  it('uses the anonymous endpoint and free model without a key', () => {
    const req = buildPollinationsRequest(atlas, history, byId, ctx, settings());
    expect(req.url).toBe(POLLINATIONS_ANON_URL);
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.body.model).toBe(DEFAULT_ANON_MODEL);
    expect(req.body.stream).toBe(true);
    expect(req.body.referrer).toBe('teamz');
  });

  it('switches to the keyed endpoint with a bearer token', () => {
    const req = buildPollinationsRequest(atlas, history, byId, ctx, settings({ apiKey: ' sk_test ' }));
    expect(req.url).toBe(POLLINATIONS_KEYED_URL);
    expect(req.headers.Authorization).toBe('Bearer sk_test');
    expect(req.body.model).toBe(DEFAULT_KEYED_MODEL);
    expect(req.body.referrer).toBeUndefined();
  });

  it('respects an explicit model', () => {
    const req = buildPollinationsRequest(atlas, history, byId, ctx, settings({ model: 'deepseek' }));
    expect(req.body.model).toBe('deepseek');
  });

  it('builds a persona system prompt and maps roles from the agent’s view', () => {
    const { messages } = buildPollinationsRequest(atlas, history, byId, ctx, settings()).body;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('You are Atlas.');
    expect(messages[0].content).toContain('TypeScript');
    expect(messages[0].content).toContain('Build Room');
    expect(messages[0].content).toContain('Pixel');
    expect(messages[0].content).toContain('@mention');
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: '[User]: How should we build it?' },
      { role: 'assistant', content: 'Use a module boundary.' },
      { role: 'user', content: '[Pixel]: Mind the spacing.' },
      { role: 'user', content: '[User]: @Atlas what about streaming?' },
    ]);
  });

  it('leaves user text unprefixed in a direct chat', () => {
    const { messages } = buildPollinationsRequest(
      atlas,
      [msg('user', 'hi')],
      byId,
      { conversationKind: 'direct', conversationName: 'Atlas' },
      settings(),
    ).body;
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(messages[0].content).toContain('one-to-one');
  });
});

describe('createSseParser', () => {
  it('yields content deltas across chunk boundaries and ignores reasoning', () => {
    const p = createSseParser();
    const a = p.push('data: {"choices":[{"delta":{"reasoning":"hmm"}}]}\n\ndata: {"choices":[{"delta":{"content":"Hel');
    const b = p.push('lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n');
    expect(a).toEqual([]);
    expect(b).toEqual(['Hello', ' world']);
    expect(p.done).toBe(true);
  });

  it('throws on an error event', () => {
    const p = createSseParser();
    expect(() => p.push('data: {"error":{"message":"nope"}}\n')).toThrow('nope');
  });
});

describe('normaliseSettings', () => {
  it('fills defaults and rejects junk', () => {
    expect(normaliseSettings({ provider: 'weird', stream: 'x' })).toEqual({ ...DEFAULT_SETTINGS });
    expect(normaliseSettings(null).provider).toBe('pollinations');
  });
});
