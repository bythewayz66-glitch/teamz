import { describe, expect, it } from 'vitest';
import { describeCron, isDue, matches, nextFire, parseCron } from './cron';

/** Local-time date helper, so the tests do not depend on the machine's TZ. */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

describe('parseCron', () => {
  it('rejects the wrong number of fields', () => {
    expect(parseCron('0 7 * *')).toBeNull();
    expect(parseCron('0 7 * * * *')).toBeNull();
  });

  it('rejects out-of-range values', () => {
    expect(parseCron('60 * * * *')).toBeNull();
    expect(parseCron('* 24 * * *')).toBeNull();
    expect(parseCron('* * 0 * *')).toBeNull();
    expect(parseCron('* * * 13 *')).toBeNull();
  });

  it('parses a plain expression', () => {
    const spec = parseCron('0 7 * * *')!;
    expect(spec.minutes).toEqual([0]);
    expect(spec.hours).toEqual([7]);
    expect(spec.daysOfMonth).toHaveLength(31);
    expect(spec.months).toHaveLength(12);
    expect(spec.daysOfWeek).toHaveLength(7);
  });

  it('expands ranges and steps', () => {
    expect(parseCron('*/15 * * * *')!.minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 9 * * 1-5')!.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it('expands comma lists', () => {
    expect(parseCron('0 8,12,18 * * *')!.hours).toEqual([8, 12, 18]);
  });

  it('normalises Sunday 7 to 0', () => {
    expect(parseCron('0 0 * * 7')!.daysOfWeek).toEqual([0]);
  });

  it('accepts day and month names', () => {
    expect(parseCron('0 9 * * mon')!.daysOfWeek).toEqual([1]);
    expect(parseCron('0 0 1 jan *')!.months).toEqual([1]);
  });
});

describe('matches', () => {
  it('matches a weekday morning', () => {
    const spec = parseCron('0 8 * * 1-5')!;
    // 2026-11-11 is a Wednesday.
    expect(matches(spec, at(2026, 11, 11, 8, 0))).toBe(true);
    expect(matches(spec, at(2026, 11, 11, 8, 1))).toBe(false);
    expect(matches(spec, at(2026, 11, 15, 8, 0))).toBe(false); // Sunday
  });
});

describe('nextFire', () => {
  it('finds the next weekday morning', () => {
    const spec = parseCron('0 8 * * 1-5')!;
    const next = nextFire(spec, at(2026, 11, 11, 9, 0))!;
    expect(next.getDate()).toBe(12);
    expect(next.getHours()).toBe(8);
    expect(next.getMinutes()).toBe(0);
  });

  it('rolls over the weekend to Monday', () => {
    const spec = parseCron('0 8 * * 1-5')!;
    const next = nextFire(spec, at(2026, 11, 13, 9, 0))!; // Friday after 8
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getDate()).toBe(16);
  });

  it('is strictly after the given time', () => {
    const spec = parseCron('0 8 * * *')!;
    const next = nextFire(spec, at(2026, 11, 11, 8, 0))!;
    expect(next.getDate()).toBe(12);
  });

  it('handles every-15-minutes', () => {
    const spec = parseCron('*/15 * * * *')!;
    const next = nextFire(spec, at(2026, 11, 11, 10, 7))!;
    expect(next.getMinutes()).toBe(15);
  });

  it('returns null for an impossible date', () => {
    expect(nextFire(parseCron('0 0 30 2 *')!, at(2026, 1, 1))).toBeNull();
  });
});

describe('isDue', () => {
  it('fires when a scheduled minute passed since the last run', () => {
    const spec = parseCron('0 8 * * *')!;
    const now = at(2026, 11, 11, 8, 30).getTime();
    const lastFired = at(2026, 11, 10, 8, 0).getTime();
    expect(isDue(spec, lastFired, now)).toBe(true);
  });

  it('does not fire twice in the same window', () => {
    const spec = parseCron('0 8 * * *')!;
    const now = at(2026, 11, 11, 8, 30).getTime();
    const lastFired = at(2026, 11, 11, 8, 0).getTime();
    expect(isDue(spec, lastFired, now)).toBe(false);
  });

  it('does not backfill a week of missed runs on first sight', () => {
    const spec = parseCron('0 8 * * *')!;
    const now = at(2026, 11, 11, 15, 0).getTime();
    expect(isDue(spec, undefined, now)).toBe(false);
  });
});

describe('describeCron', () => {
  it('describes weekdays', () => {
    expect(describeCron(parseCron('0 8 * * 1-5')!)).toBe('Weekdays at 8:00 AM');
  });
  it('describes every day', () => {
    expect(describeCron(parseCron('0 7 * * *')!)).toBe('Every day at 7:00 AM');
  });
  it('describes a single weekday', () => {
    expect(describeCron(parseCron('0 9 * * 1')!)).toBe('Every Monday at 9:00 AM');
  });
  it('describes an interval', () => {
    expect(describeCron(parseCron('*/15 * * * *')!)).toBe('Every 15 minutes');
  });
  it('describes noon correctly', () => {
    expect(describeCron(parseCron('0 12 * * *')!)).toBe('Every day at 12:00 PM');
  });
  it('describes midnight correctly', () => {
    expect(describeCron(parseCron('0 0 * * *')!)).toBe('Every day at 12:00 AM');
  });
});
