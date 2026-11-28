/**
 * Usage ledger — cost-to-date from the endpoint's daily token totals.
 *
 * The teamz-agent endpoint's `GET /usage` only ever holds *today* (it starts a
 * fresh file each UTC day), so "cost to date" cannot be read from the server.
 * This ledger keeps each day's per-agent totals as the UI observes them and
 * sums across days. Two honest limits follow from that, and the UI says both:
 * history begins the first time Teamz saw a day, and dollars are only shown
 * when a rate has been set — Teamz ships no price list, so it will not guess.
 */

export interface UsageBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** What `GET /usage` returns for one UTC day. */
export interface UsageDay {
  date: string;
  byAgent: Record<string, UsageBucket>;
}

export interface UsageLedger {
  /** date (UTC) -> agent id -> that day's totals. */
  days: Record<string, Record<string, UsageBucket>>;
  /** Earliest date this ledger has seen, for "since …" wording. */
  since: string | null;
}

export interface CostRate {
  /** Dollars per million prompt tokens. */
  inputPerMillion: number;
  /** Dollars per million completion tokens. */
  outputPerMillion: number;
}

export const EMPTY_LEDGER: UsageLedger = { days: {}, since: null };

const EMPTY_BUCKET: UsageBucket = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

export function normalizeBucket(raw: unknown): UsageBucket {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    calls: num(r.calls),
    promptTokens: num(r.promptTokens),
    completionTokens: num(r.completionTokens),
    totalTokens: num(r.totalTokens),
  };
}

export function normalizeUsageDay(raw: unknown): UsageDay | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
  const byAgent: Record<string, UsageBucket> = {};
  if (r.byAgent && typeof r.byAgent === 'object') {
    for (const [id, b] of Object.entries(r.byAgent as Record<string, unknown>)) byAgent[id] = normalizeBucket(b);
  }
  return { date: r.date, byAgent };
}

const maxBucket = (a: UsageBucket, b: UsageBucket): UsageBucket => ({
  calls: Math.max(a.calls, b.calls),
  promptTokens: Math.max(a.promptTokens, b.promptTokens),
  completionTokens: Math.max(a.completionTokens, b.completionTokens),
  totalTokens: Math.max(a.totalTokens, b.totalTokens),
});

/**
 * Fold one observed day into the ledger. A day's totals only grow, so the
 * larger of what we had and what we just saw wins — a stale or partial
 * response can never shrink a day. Returns the same ledger when unchanged.
 */
export function recordUsageDay(ledger: UsageLedger, day: UsageDay): UsageLedger {
  const prev = ledger.days[day.date] ?? {};
  const merged: Record<string, UsageBucket> = { ...prev };
  let changed = !ledger.days[day.date];
  for (const [id, b] of Object.entries(day.byAgent)) {
    const m = prev[id] ? maxBucket(prev[id], b) : b;
    if (!prev[id] || JSON.stringify(m) !== JSON.stringify(prev[id])) changed = true;
    merged[id] = m;
  }
  if (!changed) return ledger;
  const since = ledger.since && ledger.since <= day.date ? ledger.since : day.date;
  return { days: { ...ledger.days, [day.date]: merged }, since };
}

export function sumBuckets(list: UsageBucket[]): UsageBucket {
  return list.reduce(
    (acc, b) => ({
      calls: acc.calls + b.calls,
      promptTokens: acc.promptTokens + b.promptTokens,
      completionTokens: acc.completionTokens + b.completionTokens,
      totalTokens: acc.totalTokens + b.totalTokens,
    }),
    EMPTY_BUCKET,
  );
}

export function agentUsage(ledger: UsageLedger, agentId: string): UsageBucket {
  return sumBuckets(Object.values(ledger.days).map((d) => d[agentId] ?? EMPTY_BUCKET));
}

export function usageDollars(b: UsageBucket, rate: CostRate | null): number | null {
  if (!rate) return null;
  return (b.promptTokens / 1e6) * rate.inputPerMillion + (b.completionTokens / 1e6) * rate.outputPerMillion;
}

export function parseLedger(raw: string | null): UsageLedger {
  if (!raw) return EMPTY_LEDGER;
  try {
    const p = JSON.parse(raw) as Partial<UsageLedger>;
    const days: UsageLedger['days'] = {};
    for (const [date, agents] of Object.entries(p.days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !agents || typeof agents !== 'object') continue;
      days[date] = {};
      for (const [id, b] of Object.entries(agents)) days[date][id] = normalizeBucket(b);
    }
    return { days, since: typeof p.since === 'string' ? p.since : null };
  } catch {
    return EMPTY_LEDGER;
  }
}

export function parseRate(raw: string | null): CostRate | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<CostRate>;
    if (typeof p.inputPerMillion === 'number' && typeof p.outputPerMillion === 'number' && p.inputPerMillion >= 0 && p.outputPerMillion >= 0) {
      return { inputPerMillion: p.inputPerMillion, outputPerMillion: p.outputPerMillion };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

export function formatDollars(d: number): string {
  if (d > 0 && d < 0.01) return '<$0.01';
  return `$${d.toFixed(2)}`;
}
