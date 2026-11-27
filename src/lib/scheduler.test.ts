import { describe, expect, it } from 'vitest';
import {
  CronParseError,
  Schedule,
  createCronJob,
  createTrigger,
  cronIntervalMinutes,
  dueTriggers,
  isCronJobDue,
  isTriggerDue,
  minuteKey,
  nextRun,
  parseCronField,
  recordCronRun,
  tick,
  type CronJob,
} from './scheduler';

/** Local-time Date constructor helper: months are 1-based here. */
function at(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe('parseCronField', () => {
  it('parses * to the full range', () => {
    expect(parseCronField('*', 0, 59)).toHaveLength(60);
    expect(parseCronField('*', 0, 6)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('parses */n steps', () => {
    expect(parseCronField('*/15', 0, 59)).toEqual([0, 15, 30, 45]);
    expect(parseCronField('*/2', 0, 6)).toEqual([0, 2, 4, 6]);
  });

  it('parses comma lists', () => {
    expect(parseCronField('1,15,30', 0, 59)).toEqual([1, 15, 30]);
  });

  it('parses ranges', () => {
    expect(parseCronField('9-17', 0, 23)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('parses stepped ranges and combined forms', () => {
    expect(parseCronField('1-10/3', 0, 59)).toEqual([1, 4, 7, 10]);
    expect(parseCronField('0,30-35/2', 0, 59)).toEqual([0, 30, 32, 34]);
  });

  it('dedupes and sorts overlapping values', () => {
    expect(parseCronField('5,1-5,3', 0, 59)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects out-of-range values', () => {
    expect(() => parseCronField('60', 0, 59)).toThrow(CronParseError);
    expect(() => parseCronField('0-24', 0, 23)).toThrow(CronParseError);
    expect(() => parseCronField('32', 1, 31)).toThrow(CronParseError);
  });

  it('rejects bad steps and empty fields', () => {
    expect(() => parseCronField('*/0', 0, 59)).toThrow(CronParseError);
    expect(() => parseCronField('*/x', 0, 59)).toThrow(CronParseError);
    expect(() => parseCronField('', 0, 59)).toThrow(CronParseError);
    expect(() => parseCronField(' , ', 0, 59)).toThrow(CronParseError);
    expect(() => parseCronField('abc', 0, 59)).toThrow(CronParseError);
    expect(() => parseCronField('5-2', 0, 59)).toThrow(CronParseError);
  });
});

describe('Schedule', () => {
  it('requires exactly 5 fields', () => {
    expect(() => new Schedule('0 7 * *')).toThrow(CronParseError);
    expect(() => new Schedule('0 7 * * * *')).toThrow(CronParseError);
    expect(() => new Schedule('')).toThrow(CronParseError);
    expect(() => new Schedule('61 * * * *')).toThrow(CronParseError);
  });

  it('matches a plain weekday-morning schedule', () => {
    const s = new Schedule('0 7 * * 1-5');
    expect(s.matches(at(2026, 11, 25, 7, 0))).toBe(true); // Wednesday
    expect(s.matches(at(2026, 11, 25, 7, 1))).toBe(false);
    expect(s.matches(at(2026, 11, 25, 8, 0))).toBe(false);
    expect(s.matches(at(2026, 11, 28, 7, 0))).toBe(false); // Saturday
    expect(s.matches(at(2026, 11, 29, 7, 0))).toBe(false); // Sunday
    expect(s.matches(at(2026, 11, 30, 7, 0))).toBe(true); // Monday
  });

  it('treats dow 0 as Sunday (standard cron)', () => {
    const s = new Schedule('0 9 * * 0');
    expect(s.matches(at(2026, 11, 29, 9, 0))).toBe(true); // Sunday
    expect(s.matches(at(2026, 11, 30, 9, 0))).toBe(false); // Monday
  });

  it('matches dom when dow is unrestricted, and vice versa', () => {
    const domOnly = new Schedule('0 12 15 * *');
    expect(domOnly.matches(at(2026, 11, 15, 12, 0))).toBe(true);
    expect(domOnly.matches(at(2026, 11, 16, 12, 0))).toBe(false);
    const dowOnly = new Schedule('0 12 * * 3');
    expect(dowOnly.matches(at(2026, 11, 25, 12, 0))).toBe(true); // Wednesday
    expect(dowOnly.matches(at(2026, 11, 26, 12, 0))).toBe(false); // Thursday
  });

  it('fires when either dom or dow matches when both are restricted', () => {
    const s = new Schedule('0 12 15 * 3');
    expect(s.matches(at(2026, 11, 15, 12, 0))).toBe(true); // 15th, Sunday
    expect(s.matches(at(2026, 11, 25, 12, 0))).toBe(true); // Wednesday, not 15th
    expect(s.matches(at(2026, 11, 16, 12, 0))).toBe(false); // neither
  });

  it('next() is strictly after the given time', () => {
    const s = new Schedule('0 7 * * *');
    expect(s.next(at(2026, 11, 25, 7, 0))).toEqual(at(2026, 11, 26, 7, 0));
    expect(s.next(at(2026, 11, 25, 6, 59))).toEqual(at(2026, 11, 25, 7, 0));
    expect(s.next(at(2026, 11, 25, 7, 1))).toEqual(at(2026, 11, 26, 7, 0));
  });

  it('next() resolves monthly schedules beyond 24h', () => {
    const s = new Schedule('30 8 1 * *');
    expect(s.next(at(2026, 11, 25, 9, 0))).toEqual(at(2026, 12, 1, 8, 30));
  });

  it('next() throws for an impossible date', () => {
    const s = new Schedule('0 0 30 2 *');
    expect(() => s.next(at(2026, 1, 1))).toThrow(CronParseError);
  });
});

function promptJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron-test',
    name: 'Morning brief',
    schedule: '0 7 * * 1-5',
    type: 'prompt',
    target: 'Write the morning brief.',
    enabled: true,
    agentId: 'agent-scout',
    channelId: 'conv-build-room',
    lastRunAt: null,
    runs: [],
    ...overrides,
  };
}

describe('cron jobs and tick()', () => {
  it('a matching enabled job is due', () => {
    expect(isCronJobDue(promptJob(), at(2026, 11, 25, 7, 0))).toBe(true);
    expect(isCronJobDue(promptJob(), at(2026, 11, 25, 7, 1))).toBe(false);
    expect(isCronJobDue(promptJob({ enabled: false }), at(2026, 11, 25, 7, 0))).toBe(false);
  });

  it('does not refire within the same minute (30s ticks)', () => {
    const firedAt = at(2026, 11, 25, 7, 0).getTime() + 15_000;
    const job = promptJob({ lastRunAt: at(2026, 11, 25, 7, 0).getTime() });
    expect(isCronJobDue(job, new Date(firedAt))).toBe(false);
    // Next day, same minute: due again.
    expect(isCronJobDue(job, at(2026, 11, 26, 7, 0))).toBe(true);
  });

  it('a missed slot stays due until it fires (catch-up — the starvation fix)', () => {
    // Hourly job that last ran at 17:00. The runner was busy grinding
    // through product jobs, so no tick started in the 18:00 minute.
    // At 18:05 the 18:00 slot is still due — it must not silently expire.
    const hourly = promptJob({ schedule: '0 * * * *', lastRunAt: at(2026, 11, 26, 17, 0).getTime() });
    expect(isCronJobDue(hourly, at(2026, 11, 26, 18, 5))).toBe(true);
    expect(isCronJobDue(hourly, at(2026, 11, 26, 18, 0))).toBe(true);
    // A 15-minute job that missed several slots is due once, not once
    // per missed slot.
    const quarter = promptJob({ schedule: '*/15 * * * *', lastRunAt: at(2026, 11, 26, 18, 45).getTime() });
    expect(isCronJobDue(quarter, at(2026, 11, 26, 19, 20))).toBe(true);
    // After the catch-up firing, it is quiet until the next slot.
    const caughtUp = promptJob({ schedule: '*/15 * * * *', lastRunAt: at(2026, 11, 26, 19, 20).getTime() });
    expect(isCronJobDue(caughtUp, at(2026, 11, 26, 19, 25))).toBe(false);
    expect(isCronJobDue(caughtUp, at(2026, 11, 26, 19, 30))).toBe(true);
    // A job that ran on schedule is not due early.
    const onTime = promptJob({ schedule: '0 * * * *', lastRunAt: at(2026, 11, 26, 17, 0).getTime() });
    expect(isCronJobDue(onTime, at(2026, 11, 26, 17, 30))).toBe(false);
  });

  it('a never-run job still waits for its first slot (no immediate fire)', () => {
    const hourly = promptJob({ schedule: '0 * * * *', lastRunAt: null });
    expect(isCronJobDue(hourly, at(2026, 11, 26, 17, 30))).toBe(false);
    expect(isCronJobDue(hourly, at(2026, 11, 26, 18, 0))).toBe(true);
    const daily = promptJob({ schedule: '0 7 * * *', lastRunAt: null });
    expect(isCronJobDue(daily, at(2026, 11, 26, 10, 0))).toBe(false);
    expect(isCronJobDue(daily, at(2026, 11, 27, 7, 0))).toBe(true);
  });

  it('minuteKey floors to the minute', () => {
    expect(minuteKey(60_000)).toBe(60_000);
    expect(minuteKey(60_000 + 59_999)).toBe(60_000);
  });

  it('tick() returns due jobs and triggers together, without mutating', () => {
    const job = promptJob();
    const trigger = createTrigger({
      channelId: 'conv-build-room',
      agentId: 'agent-scout',
      prompt: 'Ping',
      everyMs: 60_000,
    });
    const now = at(2026, 11, 25, 7, 0);
    const result = tick(now, [job], [trigger]);
    expect(result.dueJobs).toEqual([job]);
    expect(result.dueTriggers).toEqual([trigger]);
    expect(job.lastRunAt).toBeNull();
    // tick() is pure: it never marks anything as run. The caller records
    // lastRunAt after dispatching, and only then does the next tick go quiet.
    const marked = { ...trigger, lastRunAt: now.getTime() };
    const markedJob = { ...job, lastRunAt: now.getTime() };
    const soon = tick(new Date(now.getTime() + 30_000), [markedJob], [marked]);
    expect(soon.dueJobs).toEqual([]);
    expect(soon.dueTriggers).toEqual([]);
    // Exactly one interval later it is due again — that is the trigger working.
    const later = tick(new Date(now.getTime() + 60_000), [markedJob], [marked]);
    expect(later.dueJobs).toEqual([]);
    expect(later.dueTriggers).toEqual([marked]);
  });

  it('nextRun() resolves through the job record', () => {
    expect(nextRun(promptJob(), at(2026, 11, 25, 6, 0))).toEqual(at(2026, 11, 25, 7, 0));
  });

  it('recordCronRun appends and bounds history', () => {
    let job = promptJob();
    for (let i = 0; i < 60; i++) {
      job = recordCronRun(job, { ts: i, ok: true });
    }
    expect(job.runs).toHaveLength(50);
    expect(job.runs[0].ts).toBe(10);
  });

  it('createCronJob validates eagerly', () => {
    expect(() => createCronJob({ name: 'x', schedule: 'bad', target: 't' })).toThrow(
      CronParseError,
    );
    expect(() => createCronJob({ name: ' ', schedule: '* * * * *', target: 't' })).toThrow(
      CronParseError,
    );
    expect(() => createCronJob({ name: 'x', schedule: '* * * * *', target: ' ' })).toThrow(
      CronParseError,
    );
    expect(() =>
      createCronJob({ name: 'x', schedule: '* * * * *', target: 't', type: 'prompt' }),
    ).toThrow(CronParseError); // prompt job without agent/channel
    const ok = createCronJob({
      name: 'Brief',
      schedule: '0 7 * * 1-5',
      target: 'Brief me.',
      agentId: 'a',
      channelId: 'c',
    });
    expect(ok.type).toBe('prompt');
    expect(ok.enabled).toBe(true);
    expect(ok.runs).toEqual([]);
  });
});

describe('interval triggers', () => {
  it('a never-run trigger is due immediately', () => {
    const t = createTrigger({
      channelId: 'c',
      agentId: 'a',
      prompt: 'Go',
      everyMs: 3_600_000,
    });
    expect(t.lastRunAt).toBeNull();
    expect(isTriggerDue(t, Date.now())).toBe(true);
  });

  it('fires only after the interval has elapsed', () => {
    const base = 1_000_000_000;
    const t = { ...createTrigger({ channelId: 'c', agentId: 'a', prompt: 'Go', everyMs: 60_000 }), lastRunAt: base };
    expect(isTriggerDue(t, base + 59_999)).toBe(false);
    expect(isTriggerDue(t, base + 60_000)).toBe(true);
    expect(isTriggerDue({ ...t, enabled: false }, base + 600_000)).toBe(false);
  });

  it('epoch 0 is a real timestamp, not "never run"', () => {
    const t = { ...createTrigger({ channelId: 'c', agentId: 'a', prompt: 'Go', everyMs: 60_000 }), lastRunAt: 0 };
    // 30s after epoch 0: interval has not elapsed, so not due.
    expect(isTriggerDue(t, 30_000)).toBe(false);
    expect(dueTriggers([t], 30_000)).toEqual([]);
  });

  it('createTrigger rejects empty prompts, missing ids, tiny intervals', () => {
    expect(() => createTrigger({ channelId: 'c', agentId: 'a', prompt: ' ', everyMs: 1000 })).toThrow();
    expect(() => createTrigger({ channelId: '', agentId: 'a', prompt: 'x', everyMs: 1000 })).toThrow();
    expect(() => createTrigger({ channelId: 'c', agentId: 'a', prompt: 'x', everyMs: 999 })).toThrow();
  });
});

describe('cronIntervalMinutes', () => {
  it('measures the gap between firings: 15-min is 15, hourly is 60, daily is 1440', () => {
    const from = at(2026, 11, 26, 10, 0);
    expect(cronIntervalMinutes('*/15 * * * *', from)).toBe(15);
    expect(cronIntervalMinutes('0 * * * *', from)).toBe(60);
    expect(cronIntervalMinutes('0 7 * * *', from)).toBe(1440);
    expect(cronIntervalMinutes('0 9 * * 1', from)).toBe(10080);
  });

  it('returns null for a bad expression instead of throwing', () => {
    expect(cronIntervalMinutes('not a cron')).toBeNull();
  });
});
