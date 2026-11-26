/**
 * Scheduler — cron expressions, interval triggers, and the tick primitive.
 *
 * Ported from the mem20agentz cron design (`mem20agentz/cron.py`): the same
 * 5-field cron parser (star, star-slash-n, a-b lists, a-b ranges), the same `Schedule`
 * matches/next shape with a minute-scan lookahead, the same Job record with
 * run history, and the same idea that `tick()` is the testable primitive.
 * The OREO interval-trigger shape (`{channelId, agentId, prompt, everyMs}`
 * plus `lastRunAt`, due when the interval has elapsed) is ported alongside
 * it, since that is the simple case a job schedule usually starts as.
 *
 * This module is deliberately DOM-free: no `window`, no `localStorage`, no
 * network, no timers. A future Node runner can import it directly and drive
 * it with its own clock and its own store; the in-tab runner in
 * `store/useAutonomy.ts` is one caller of `tick()`, not the owner of it.
 *
 * Two deliberate divergences from the Python source, both documented here:
 *  - Day-of-week follows standard cron (0 = Sunday, 6 = Saturday, matching
 *    JavaScript's `Date.getDay()`). The Python code compared against
 *    `tm_wday`, where 0 is Monday, so its `0` meant Monday.
 *  - `next()` scans up to 366 days ahead instead of 24 hours, so monthly
 *    and yearly schedules (e.g. `0 0 1 * *`) can resolve a next run at all.
 *    The minute-by-minute scan itself is unchanged.
 */

/** Thrown when a cron expression or a field in it cannot be parsed. */
export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

/**
 * Parse one cron field into its sorted set of allowed values.
 *
 * Supported forms, exactly as in the Python source: `*`, `*\/n`, `a,b`,
 * `a-b`, and combinations such as `1,15-20/2`. Values outside `[lo, hi]`
 * and steps below 1 are errors.
 */
export function parseCronField(field: string, lo: number, hi: number): number[] {
  const values = new Set<number>();
  for (const rawToken of field.split(',')) {
    const token = rawToken.trim();
    if (!token) continue;
    let step = 1;
    let base = token;
    const slash = token.indexOf('/');
    if (slash !== -1) {
      base = token.slice(0, slash);
      const stepText = token.slice(slash + 1);
      step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) {
        throw new CronParseError(`step must be an integer >= 1 in field ${JSON.stringify(field)}`);
      }
    }
    let loV: number;
    let hiV: number;
    if (base === '*') {
      loV = lo;
      hiV = hi;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-', 2);
      loV = Number(a);
      hiV = Number(b);
      if (!Number.isInteger(loV) || !Number.isInteger(hiV)) {
        throw new CronParseError(`bad range ${JSON.stringify(base)} in field ${JSON.stringify(field)}`);
      }
    } else {
      loV = hiV = Number(base);
      if (!Number.isInteger(loV)) {
        throw new CronParseError(`bad value ${JSON.stringify(base)} in field ${JSON.stringify(field)}`);
      }
    }
    if (loV < lo || hiV > hi || loV > hiV) {
      throw new CronParseError(`value out of range ${lo}-${hi} in field ${JSON.stringify(field)}`);
    }
    for (let v = loV; v <= hiV; v += step) values.add(v);
  }
  if (values.size === 0) {
    throw new CronParseError(`empty field ${JSON.stringify(field)}`);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * A parsed 5-field cron schedule: minute, hour, day-of-month, month,
 * day-of-week (0 = Sunday).
 */
export class Schedule {
  readonly expr: string;
  readonly minutes: number[];
  readonly hours: number[];
  readonly dom: number[];
  readonly months: number[];
  readonly dow: number[];

  constructor(expr: string) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new CronParseError(
        `schedule must have 5 fields (minute hour dom month dow): ${JSON.stringify(expr)}`,
      );
    }
    try {
      this.minutes = parseCronField(parts[0], 0, 59);
      this.hours = parseCronField(parts[1], 0, 23);
      this.dom = parseCronField(parts[2], 1, 31);
      this.months = parseCronField(parts[3], 1, 12);
      this.dow = parseCronField(parts[4], 0, 6);
    } catch (err) {
      if (err instanceof CronParseError) {
        throw new CronParseError(`bad schedule ${JSON.stringify(expr)}: ${err.message}`);
      }
      throw err;
    }
    this.expr = expr.trim().replace(/\s+/g, ' ');
  }

  /** Does this schedule fire at the given instant? Seconds are ignored. */
  matches(date: Date): boolean {
    if (
      !this.minutes.includes(date.getMinutes()) ||
      !this.hours.includes(date.getHours()) ||
      !this.months.includes(date.getMonth() + 1)
    ) {
      return false;
    }
    // Day-of-month / day-of-week: if both are restricted, either matching
    // fires the job (standard cron behaviour, same as the Python source).
    const domAny = this.dom.length === 31;
    const dowAny = this.dow.length === 7;
    if (domAny && dowAny) return true;
    if (domAny) return this.dow.includes(date.getDay());
    if (dowAny) return this.dom.includes(date.getDate());
    return this.dom.includes(date.getDate()) || this.dow.includes(date.getDay());
  }

  /**
   * Next scheduled time strictly after `after` (default now), found by the
   * same minute-by-minute scan as the Python source. Throws CronParseError
   * when nothing matches within the 366-day lookahead (e.g. February 30).
   */
  next(after: Date = new Date()): Date {
    const cursor = new Date(after.getTime() + 60_000);
    cursor.setSeconds(0, 0);
    for (let i = 0; i < 366 * 24 * 60; i++) {
      if (this.matches(cursor)) return cursor;
      cursor.setTime(cursor.getTime() + 60_000);
    }
    throw new CronParseError(`no match within 366-day lookahead for ${JSON.stringify(this.expr)}`);
  }
}

/** One recorded run of a scheduled job: when it fired and how it ended. */
export interface CronRunRecord {
  /** Epoch milliseconds the run started. */
  ts: number;
  ok: boolean;
  /** Short human-readable outcome (reply excerpt, dispatch note, error). */
  detail?: string;
}

/**
 * A scheduled job, mirroring the Python `Job`: a name, a cron expression, a
 * type, a target, an optional profile, an enabled flag, and run history.
 *
 * Prompt jobs need a destination, so they also carry the agent and channel
 * that receive the prompt. Command jobs run a shell command — a browser tab
 * cannot do that, so the in-tab runner records them as blocked and the
 * server runner (see `scripts/runner.ts`) is the one that executes them.
 */
export interface CronJob {
  id: string;
  name: string;
  /** Cron expression, e.g. `0 7 * * 1-5`. Validated by `createCronJob`. */
  schedule: string;
  type: 'prompt' | 'command';
  /** Prompt text for `prompt` jobs, shell command for `command` jobs. */
  target: string;
  profile?: string;
  enabled: boolean;
  /** Agent + channel a prompt job is delivered to. */
  agentId?: string;
  channelId?: string;
  /** Epoch milliseconds of the last minute this job fired in (dedupe key). */
  lastRunAt: number | null;
  runs: CronRunRecord[];
}

export interface CreateCronJobInput {
  name: string;
  schedule: string;
  type?: 'prompt' | 'command';
  target: string;
  profile?: string;
  enabled?: boolean;
  agentId?: string;
  channelId?: string;
}

/** Build a CronJob, validating the schedule eagerly so bad input fails here. */
export function createCronJob(input: CreateCronJobInput): CronJob {
  // Throws CronParseError on a bad expression — a job with an unparseable
  // schedule must never reach the store.
  new Schedule(input.schedule);
  const name = input.name.trim();
  if (!name) throw new CronParseError('cron job needs a name');
  if (!input.target.trim()) throw new CronParseError('cron job needs a target');
  if (input.type === 'prompt' && (!input.agentId || !input.channelId)) {
    throw new CronParseError('a prompt job needs an agentId and a channelId');
  }
  return {
    id: `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    schedule: input.schedule.trim().replace(/\s+/g, ' '),
    type: input.type ?? 'prompt',
    target: input.target,
    profile: input.profile,
    enabled: input.enabled ?? true,
    agentId: input.agentId,
    channelId: input.channelId,
    lastRunAt: null,
    runs: [],
  };
}

/** Next run of a cron job strictly after `after` (default now). */
export function nextRun(job: CronJob, after: Date = new Date()): Date {
  return new Schedule(job.schedule).next(after);
}

/**
 * The minute a timestamp falls in, as epoch milliseconds. Two runs in the
 * same minute are the same firing: a tick that runs every 30s must not fire
 * a `0 7 * * *` job twice.
 */
export function minuteKey(ts: number): number {
  return Math.floor(ts / 60_000) * 60_000;
}

/**
 * Is this cron job due at `now`? Enabled, schedule matches this minute, and
 * it has not already fired in this minute.
 */
export function isCronJobDue(job: CronJob, now: Date): boolean {
  if (!job.enabled) return false;
  if (!new Schedule(job.schedule).matches(now)) return false;
  if (job.lastRunAt !== null && minuteKey(job.lastRunAt) === minuteKey(now.getTime())) {
    return false;
  }
  return true;
}

/** Append a run record, keeping history bounded (newest 50 kept). */
export function recordCronRun(job: CronJob, record: CronRunRecord): CronJob {
  return { ...job, runs: [...job.runs, record].slice(-50) };
}

/* ---------------------------------------------------------------------------
 * Interval triggers — the simple case.
 *
 * Ported from the OREO trigger shape: `{channelId, agentId, prompt, everyMs}`
 * plus `lastRunAt`. `lastRunAt == null` means "never run" and is due
 * immediately; the check is `== null`, not falsy, so a trigger that last ran
 * at epoch 0 is a real timestamp and does not fire on every tick.
 * ------------------------------------------------------------------------- */

export interface IntervalTrigger {
  id: string;
  channelId: string;
  agentId: string;
  prompt: string;
  /** Interval between firings, in milliseconds. */
  everyMs: number;
  lastRunAt: number | null;
  enabled: boolean;
}

export interface CreateTriggerInput {
  channelId: string;
  agentId: string;
  prompt: string;
  everyMs: number;
}

export function createTrigger(input: CreateTriggerInput): IntervalTrigger {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('a trigger needs a prompt');
  if (!input.channelId || !input.agentId) {
    throw new Error('a trigger needs a channelId and an agentId');
  }
  if (!Number.isFinite(input.everyMs) || input.everyMs < 1_000) {
    throw new Error('a trigger interval must be at least 1000ms');
  }
  return {
    id: `trg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    channelId: input.channelId,
    agentId: input.agentId,
    prompt,
    everyMs: Math.floor(input.everyMs),
    lastRunAt: null,
    enabled: true,
  };
}

/** Is this trigger due at `nowMs` (epoch milliseconds)? */
export function isTriggerDue(trigger: IntervalTrigger, nowMs: number): boolean {
  if (!trigger.enabled) return false;
  if (trigger.lastRunAt == null) return true;
  return nowMs - trigger.lastRunAt >= trigger.everyMs;
}

/** Every trigger due at `nowMs`, in list order. */
export function dueTriggers(triggers: IntervalTrigger[], nowMs: number): IntervalTrigger[] {
  return triggers.filter((t) => isTriggerDue(t, nowMs));
}

/* ---------------------------------------------------------------------------
 * tick() — the testable primitive.
 *
 * Pure: given a clock reading and the current jobs and triggers, it returns
 * what is due right now and nothing else. It never fires anything, never
 * mutates its inputs, and never touches the clock. Callers mark `lastRunAt`
 * and record runs after dispatching, so a crash between tick and dispatch
 * can only refire — never silently drop — a due job.
 * ------------------------------------------------------------------------- */

export interface TickResult {
  dueJobs: CronJob[];
  dueTriggers: IntervalTrigger[];
}

export function tick(now: Date, jobs: CronJob[], triggers: IntervalTrigger[]): TickResult {
  return {
    dueJobs: jobs.filter((j) => isCronJobDue(j, now)),
    dueTriggers: dueTriggers(triggers, now.getTime()),
  };
}
