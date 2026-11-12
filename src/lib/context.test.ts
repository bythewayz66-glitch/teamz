import { describe, expect, it } from 'vitest';
import {
  CONTEXT_WINDOW,
  contextUsage,
  dailySeries,
  dayKey,
  estimateTokens,
  formatTokens,
  recordUsage,
  totalsFor,
  trendPercent,
} from './context';
import type { Message, UsageEntry } from '../types';

const msg = (text: string): Message =>
  ({ id: 'm', text, authorType: 'user', status: 'sent' }) as Message;

describe('estimateTokens', () => {
  it('is zero for empty or whitespace', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   \n ')).toBe(0);
  });

  it('is at least one for any real text', () => {
    expect(estimateTokens('hi')).toBe(1);
  });

  it('scales with length', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('formatTokens', () => {
  it('formats small, thousands and millions', () => {
    expect(formatTokens(940)).toBe('940');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(1_240_000)).toBe('1.2M');
  });
});

describe('contextUsage', () => {
  it('reports ok for a short conversation', () => {
    const u = contextUsage([msg('hello')]);
    expect(u.level).toBe('ok');
    expect(u.total).toBe(CONTEXT_WINDOW);
    expect(u.ratio).toBeLessThan(0.6);
  });

  it('reports full when the window is exhausted', () => {
    const u = contextUsage([msg('a'.repeat(CONTEXT_WINDOW * 4))]);
    expect(u.level).toBe('full');
    expect(u.ratio).toBe(1);
  });

  it('clamps the ratio at 1', () => {
    const u = contextUsage([msg('a'.repeat(CONTEXT_WINDOW * 8))]);
    expect(u.ratio).toBe(1);
  });
});

describe('recordUsage', () => {
  it('creates a row for a new day', () => {
    const out = recordUsage([], 'a1', 100, 50, new Date(2026, 10, 11, 10).getTime());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ agentId: 'a1', promptTokens: 100, completionTokens: 50, runs: 1 });
  });

  it('accumulates into an existing row', () => {
    const t = new Date(2026, 10, 11, 10).getTime();
    const once = recordUsage([], 'a1', 100, 50, t);
    const twice = recordUsage(once, 'a1', 20, 10, t);
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ promptTokens: 120, completionTokens: 60, runs: 2 });
  });

  it('does not mutate the input', () => {
    const t = new Date(2026, 10, 11, 10).getTime();
    const base = recordUsage([], 'a1', 100, 50, t);
    const snapshot = JSON.stringify(base);
    recordUsage(base, 'a1', 1, 1, t);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('keeps agents in separate rows', () => {
    const t = new Date(2026, 10, 11, 10).getTime();
    const out = recordUsage(recordUsage([], 'a1', 10, 5, t), 'a2', 20, 10, t);
    expect(out).toHaveLength(2);
  });
});

describe('totalsFor', () => {
  const ledger: UsageEntry[] = [
    { day: '2026-11-11', agentId: 'a1', promptTokens: 100, completionTokens: 50, runs: 2 },
    { day: '2026-11-11', agentId: 'a2', promptTokens: 10, completionTokens: 5, runs: 1 },
  ];

  it('sums everything without a filter', () => {
    expect(totalsFor(ledger)).toMatchObject({ totalTokens: 165, runs: 3 });
  });

  it('filters by agent', () => {
    expect(totalsFor(ledger, 'a1')).toMatchObject({ totalTokens: 150, runs: 2 });
  });
});

describe('dailySeries', () => {
  it('returns one dense point per day, oldest first', () => {
    const now = new Date(2026, 10, 11, 12).getTime();
    const series = dailySeries([], 7, undefined, now);
    expect(series).toHaveLength(7);
    expect(series[6].day).toBe(dayKey(now));
  });

  it('fills in the right day', () => {
    const now = new Date(2026, 10, 11, 12).getTime();
    const ledger: UsageEntry[] = [
      { day: dayKey(now), agentId: 'a1', promptTokens: 100, completionTokens: 0, runs: 1 },
    ];
    expect(dailySeries(ledger, 7, undefined, now)[6].tokens).toBe(100);
  });
});

describe('trendPercent', () => {
  it('returns null with no baseline', () => {
    expect(trendPercent([], 7)).toBeNull();
  });

  it('computes a positive change', () => {
    const now = new Date(2026, 10, 11, 12).getTime();
    const ledger: UsageEntry[] = [
      { day: dayKey(now), agentId: 'a1', promptTokens: 200, completionTokens: 0, runs: 1 },
      { day: dayKey(now - 8 * 86400000), agentId: 'a1', promptTokens: 100, completionTokens: 0, runs: 1 },
    ];
    expect(trendPercent(ledger, 7, undefined, now)).toBe(100);
  });
});
