import { describe, expect, it } from 'vitest';
import { EMPTY_LEDGER, agentUsage, formatDollars, formatTokens, parseLedger, parseRate, recordUsageDay, usageDollars } from './usageLedger';

const b = (total: number, calls = 1) => ({ calls, promptTokens: total, completionTokens: 0, totalTokens: total });

describe('usage ledger', () => {
  it('sums an agent across days and remembers the first day seen', () => {
    let l = recordUsageDay(EMPTY_LEDGER, { date: '2026-11-27', byAgent: { a: b(100) } });
    l = recordUsageDay(l, { date: '2026-11-28', byAgent: { a: b(50, 2), z: b(9) } });
    expect(agentUsage(l, 'a')).toMatchObject({ totalTokens: 150, calls: 3 });
    expect(l.since).toBe('2026-11-27');
  });

  it('a day only grows: a stale response never shrinks it', () => {
    const l = recordUsageDay(EMPTY_LEDGER, { date: '2026-11-28', byAgent: { a: b(500) } });
    expect(recordUsageDay(l, { date: '2026-11-28', byAgent: { a: b(100) } })).toBe(l);
    expect(agentUsage(recordUsageDay(l, { date: '2026-11-28', byAgent: { a: b(900) } }), 'a').totalTokens).toBe(900);
  });

  it('prices only when a rate exists', () => {
    expect(usageDollars(b(1_000_000), null)).toBeNull();
    expect(usageDollars({ calls: 1, promptTokens: 1e6, completionTokens: 1e6, totalTokens: 2e6 }, { inputPerMillion: 0.2, outputPerMillion: 0.6 })).toBeCloseTo(0.8, 6);
  });

  it('parses storage defensively', () => {
    expect(parseLedger('{not json')).toEqual(EMPTY_LEDGER);
    expect(parseLedger(JSON.stringify({ days: { 'bad-date': { a: b(1) }, '2026-11-28': { a: b(5) } } })).days).toEqual({ '2026-11-28': { a: { calls: 1, promptTokens: 5, completionTokens: 0, totalTokens: 5 } } });
    expect(parseRate('{"inputPerMillion":-1,"outputPerMillion":1}')).toBeNull();
    expect(parseRate('{"inputPerMillion":0.1,"outputPerMillion":0.4}')).toEqual({ inputPerMillion: 0.1, outputPerMillion: 0.4 });
  });

  it('formats', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(12_400)).toBe('12k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
    expect(formatDollars(0.004)).toBe('<$0.01');
    expect(formatDollars(3.456)).toBe('$3.46');
  });
});
