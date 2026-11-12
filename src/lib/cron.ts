/**
 * ============================================================================
 *  Cron — a real 5-field parser and next-fire calculator.
 * ============================================================================
 *
 *  Triggers are only useful if the app can tell you *when* they will fire and
 *  whether a given minute is due. This module does both, with no dependency:
 *
 *    parseCron('0 7 * * 1-5')      -> CronSpec | null
 *    nextFire(spec, from)          -> Date | null
 *    isDue(spec, lastFired, now)   -> boolean
 *    describeCron(spec)            -> "Weekdays at 7:00 AM"
 *
 *  Supported syntax per field: `*`, `n`, `a-b`, `a-b/s`, `* /s`, and comma
 *  lists of any of those. Day-of-week accepts 0-7 (0 and 7 are Sunday) and the
 *  three-letter names. Month accepts 1-12 and names.
 *
 *  `isDue` is deliberately tolerant: it answers "has a scheduled minute passed
 *  since the last fire?", not "is it exactly this minute?". A browser tab that
 *  was asleep for two hours still fires the 7:00 job once when it wakes, which
 *  is what a user expects from a scheduler that lives in their browser.
 */

export interface CronSpec {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** The original expression, for display and round-tripping. */
  source: string;
}

const MONTH_NAMES = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Resolve a token to a number.
 *
 * `names` is 0-based for weekdays (Sunday is 0) but months are 1-based, so the
 * caller passes `nameOffset` to shift the index. Getting this wrong made
 * `jan` resolve to 0, which is out of range and rejected the whole expression.
 */
function resolveValue(token: string, names?: string[], nameOffset = 0): number | null {
  const t = token.trim().toLowerCase();
  if (names) {
    const idx = names.indexOf(t);
    if (idx >= 0) return idx + nameOffset;
  }
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names?: string[],
  nameOffset = 0,
): number[] | null {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const chunk = part.trim().toLowerCase();
    if (!chunk) return null;

    const [rangePart, stepPart] = chunk.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let lo: number;
    let hi: number;

    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      const av = resolveValue(a, names, nameOffset);
      const bv = resolveValue(b, names, nameOffset);
      if (av === null || bv === null) return null;
      lo = av;
      hi = bv;
      if (lo > hi) return null;
    } else {
      const v = resolveValue(rangePart, names, nameOffset);
      if (v === null) return null;
      lo = v;
      // `5/2` means "from 5 to max, every 2" — the standard reading.
      hi = stepPart === undefined ? v : max;
    }

    if (lo < min || hi > max) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

/** Parse a 5-field cron expression. Returns null when it is not valid. */
export function parseCron(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const daysOfMonth = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12, MONTH_NAMES, 1);
  const rawDow = parseField(fields[4], 0, 7, DAY_NAMES);
  if (!minutes || !hours || !daysOfMonth || !months || !rawDow) return null;

  // Normalise 7 → 0 so Sunday is one value.
  const daysOfWeek = [...new Set(rawDow.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);

  return { minutes, hours, daysOfMonth, months, daysOfWeek, source: expression.trim() };
}

/** True when the given date matches every field of the spec. */
export function matches(spec: CronSpec, date: Date): boolean {
  return (
    spec.minutes.includes(date.getMinutes()) &&
    spec.hours.includes(date.getHours()) &&
    spec.months.includes(date.getMonth() + 1) &&
    spec.daysOfMonth.includes(date.getDate()) &&
    spec.daysOfWeek.includes(date.getDay())
  );
}

/**
 * The next time the spec fires strictly after `from`.
 *
 * Walks minute by minute but skips whole days/months that cannot match, so a
 * yearly expression resolves in a handful of iterations rather than 500k.
 * Returns null when nothing matches within four years (e.g. `0 0 30 2 *`).
 */
export function nextFire(spec: CronSpec, from: Date = new Date()): Date | null {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = new Date(from.getTime());
  limit.setFullYear(limit.getFullYear() + 4);

  while (cursor <= limit) {
    if (!spec.months.includes(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.daysOfMonth.includes(cursor.getDate()) || !spec.daysOfWeek.includes(cursor.getDay())) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hours.includes(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minutes.includes(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(cursor.getTime());
  }
  return null;
}

/**
 * Has a scheduled minute passed since `lastFired`?
 *
 * `lastFired` undefined means "never fired" — we then only fire if the most
 * recent scheduled minute is within the last hour, so a brand-new trigger does
 * not immediately backfill a week of missed runs.
 */
export function isDue(spec: CronSpec, lastFired: number | undefined, now: number = Date.now()): boolean {
  const nowDate = new Date(now);
  const windowStart = lastFired ?? now - 60 * 60 * 1000;

  // Walk back from the current minute to the window start, at most 24h.
  const cursor = new Date(nowDate.getTime());
  cursor.setSeconds(0, 0);
  const floor = Math.max(windowStart, now - 24 * 60 * 60 * 1000);

  for (let i = 0; i < 24 * 60; i++) {
    if (cursor.getTime() <= floor) return false;
    if (matches(spec, cursor)) return true;
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return false;
}

const pad = (n: number) => String(n).padStart(2, '0');

function timeLabel(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${h12}:${pad(minute)} ${suffix}`;
}

function listLabel(values: number[], names?: string[]): string {
  if (values.length === 1) return names ? names[values[0]] : String(values[0]);
  return values.map((v) => (names ? names[v] : String(v))).join(', ');
}

/**
 * A human sentence for the spec, in the style the product uses:
 *   "Every day at 7:00 AM"
 *   "Weekdays at 8:00 AM"
 *   "Every Monday at 9:00 AM"
 *   "Every 15 minutes"
 */
export function describeCron(spec: CronSpec): string {
  const everyMinute = spec.minutes.length === 60;
  const singleMinute = spec.minutes.length === 1;
  const singleHour = spec.hours.length === 1;

  if (everyMinute && spec.hours.length === 24) {
    return spec.daysOfWeek.length === 7 && spec.daysOfMonth.length === 31
      ? 'Every minute'
      : 'Every minute on selected days';
  }

  // Regular interval within the hour, e.g. every 15 minutes.
  if (!singleMinute && spec.hours.length === 24) {
    const step = spec.minutes.length > 1 ? spec.minutes[1] - spec.minutes[0] : 0;
    const regular = spec.minutes.every((m, i) => i === 0 || m - spec.minutes[i - 1] === step);
    if (regular && step > 0) return `Every ${step} minutes`;
    return `At minutes ${listLabel(spec.minutes)} of every hour`;
  }

  const time = singleHour && singleMinute ? timeLabel(spec.hours[0], spec.minutes[0]) : null;

  // Day-of-week phrasing.
  const dow = spec.daysOfWeek;
  const isWeekdays = dow.length === 5 && [1, 2, 3, 4, 5].every((d) => dow.includes(d));
  const isWeekend = dow.length === 2 && dow.includes(0) && dow.includes(6);
  const isEveryDay = dow.length === 7;

  let dayPart: string;
  if (isEveryDay && spec.daysOfMonth.length === 31) dayPart = 'Every day';
  else if (isWeekdays) dayPart = 'Weekdays';
  else if (isWeekend) dayPart = 'Weekends';
  else if (dow.length === 1) dayPart = `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow[0]]}`;
  else if (dow.length < 7) dayPart = `Every ${listLabel(dow, DAY_NAMES)}`;
  else if (spec.daysOfMonth.length === 1) dayPart = `Monthly on the ${spec.daysOfMonth[0]}${ordinal(spec.daysOfMonth[0])}`;
  else dayPart = `On days ${listLabel(spec.daysOfMonth)}`;

  if (time) return `${dayPart} at ${time}`;
  return `${dayPart} at ${listLabel(spec.hours)}:${listLabel(spec.minutes)}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/** Presets offered in the trigger editor. */
export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every weekday at 8:00 AM', cron: '0 8 * * 1-5' },
  { label: 'Every day at 7:00 AM', cron: '0 7 * * *' },
  { label: 'Every Monday at 9:00 AM', cron: '0 9 * * 1' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'First of the month at 6:00 AM', cron: '0 6 1 * *' },
];
