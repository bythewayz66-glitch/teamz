/**
 * Metering, budgets and fleet health (Phase 5).
 *
 * Pure and DOM-free. Every figure comes from a recorded source and says what
 * it is a lower bound of: the browser's usage ledger only holds days this
 * browser fetched `/usage`, the runner exposes only what its state summary
 * carries, and Teamz ships no price list. Where a source is missing the answer
 * is "unknown" with the reason, never zero and never a guess.
 */

import type { Agent } from '../types';
import type { LocalAutonomy, RunnerSnapshot } from './agentHome';
import { cronIntervalMinutes, hasScheduledSlotSince, Schedule } from './scheduler';
import {
  agentUsage,
  usageDollars,
  type CostRate,
  type UsageBucket,
  type UsageLedger,
} from './usageLedger';
import { programmeOf } from './sections';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------- thresholds */

/** Every threshold the health and warning logic uses, so a spot-check can recompute it by hand. */
export const METERING = {
  /** Activity window for "sleeping" and for the graph (days). */
  windowDays: 14,
  /** An agent with scheduled work is starved when nothing ran for this many times its cadence… */
  starvedCadenceFactor: 2,
  /** …plus this grace, so a slow tick is not starvation. */
  starvedGraceMs: HOUR_MS,
  /** A run left `dispatched` this long is orphaned: the dispatch deadline is 330s, the stall watchdog 330s+60s. */
  parkedDispatchedMs: 30 * 60_000,
  /** An approval-parked job is flagged "stale" past this age in its detail line. */
  staleApprovalMs: 12 * HOUR_MS,
  /** Credit warning: days of balance left at the current burn rate. */
  creditLowDays: 3,
  creditCriticalDays: 1,
  /** Burn rate is the mean of up to this many most-recent observed days. */
  burnDays: 7,
  /** Roadmap success measure: no provider above this share of a week's calls without a recorded reason. */
  providerShareLimit: 0.6,
  /** A budget is "near" at this fraction of its approved limit. */
  budgetNearFraction: 0.8,
} as const;

/** Mirrors scripts/runner.ts and scripts/runner-lib.ts; a test fails if they drift. */
export const RUNNER_PACING = {
  minDispatchGapMs: 900_000,
  dispatchTimeoutMs: 330_000,
  baseSlots: 1,
  maxSlots: 2,
  heavyBacklogJobs: 2,
} as const;

/* ------------------------------------------------------------ attribution */

export const UNATTRIBUTED = 'unattributed';

export interface AgentRoute {
  provider: string;
  model: string;
}

/**
 * Which provider/model an agent is *configured* for. The ledger records tokens
 * per agent only, so provider and model figures are this attribution; a rescue
 * that routed a call to another provider is invisible here and the UI says so.
 */
export function agentRoutes(agents: Agent[], runner: RunnerSnapshot | null): Map<string, AgentRoute> {
  const byRunner = new Map((runner?.agents ?? []).map((a) => [a.id, a]));
  const out = new Map<string, AgentRoute>();
  for (const a of agents) {
    const r = byRunner.get(a.id);
    out.set(a.id, { provider: r?.provider?.trim() || UNATTRIBUTED, model: r?.model?.trim() || a.model?.trim() || 'unknown model' });
  }
  return out;
}

/* ------------------------------------------------------------ usage report */

export interface UsageRow {
  key: string;
  label: string;
  bucket: UsageBucket;
  dollars: number | null;
  /** Share of the window's calls, 0..1; null when the fleet made no observed calls. */
  callShare: number | null;
  tokenShare: number | null;
}

export interface UsageDayRow {
  date: string;
  /** False when this browser never fetched `/usage` for the day, so the row is "not observed", not zero. */
  observed: boolean;
  bucket: UsageBucket;
  dollars: number | null;
}

export interface UsageReport {
  now: number;
  windowDays: number;
  /** First ledger day; null when the ledger is empty. */
  since: string | null;
  observedDays: number;
  total: UsageBucket;
  totalDollars: number | null;
  byAgent: UsageRow[];
  byModel: UsageRow[];
  byProvider: UsageRow[];
  byDay: UsageDayRow[];
  /** Highest-share provider/agent, for the concentration finding. */
  topProvider: UsageRow | null;
  topAgent: UsageRow | null;
  providerConcentrated: boolean;
}

const ZERO: UsageBucket = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function add(a: UsageBucket, b: UsageBucket): UsageBucket {
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export const utcDay = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/** The last `n` UTC days ending at `now`, oldest first. */
export function lastDays(now: number, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(utcDay(now - i * DAY_MS));
  return out;
}

export function buildUsageReport(input: {
  agents: Agent[];
  runner: RunnerSnapshot | null;
  ledger: UsageLedger;
  rate: CostRate | null;
  now: number;
  windowDays?: number;
}): UsageReport {
  const { agents, runner, ledger, rate, now } = input;
  const windowDays = input.windowDays ?? METERING.windowDays;
  const days = lastDays(now, windowDays);
  const routes = agentRoutes(agents, runner);
  const nameOf = new Map(agents.map((a) => [a.id, a.name]));

  const agentTotals = new Map<string, UsageBucket>();
  const modelTotals = new Map<string, UsageBucket>();
  const providerTotals = new Map<string, UsageBucket>();
  const byDay: UsageDayRow[] = [];
  let total = ZERO;
  let observedDays = 0;

  for (const date of days) {
    const day = ledger.days[date];
    let dayTotal = ZERO;
    if (day) {
      observedDays += 1;
      for (const [id, b] of Object.entries(day)) {
        dayTotal = add(dayTotal, b);
        agentTotals.set(id, add(agentTotals.get(id) ?? ZERO, b));
        const r = routes.get(id) ?? { provider: UNATTRIBUTED, model: 'unknown model' };
        modelTotals.set(r.model, add(modelTotals.get(r.model) ?? ZERO, b));
        providerTotals.set(r.provider, add(providerTotals.get(r.provider) ?? ZERO, b));
      }
    }
    total = add(total, dayTotal);
    byDay.push({ date, observed: Boolean(day), bucket: dayTotal, dollars: usageDollars(dayTotal, rate) });
  }

  const rows = (m: Map<string, UsageBucket>, label: (k: string) => string): UsageRow[] =>
    [...m.entries()]
      .map(([key, bucket]) => ({
        key,
        label: label(key),
        bucket,
        dollars: usageDollars(bucket, rate),
        callShare: total.calls > 0 ? bucket.calls / total.calls : null,
        tokenShare: total.totalTokens > 0 ? bucket.totalTokens / total.totalTokens : null,
      }))
      .sort((a, b) => b.bucket.totalTokens - a.bucket.totalTokens || b.bucket.calls - a.bucket.calls || a.label.localeCompare(b.label));

  const byAgent = rows(agentTotals, (id) => nameOf.get(id) ?? id);
  const byModel = rows(modelTotals, (k) => k);
  const byProvider = rows(providerTotals, (k) => k);
  const top = (list: UsageRow[]) => list.slice().sort((a, b) => (b.callShare ?? 0) - (a.callShare ?? 0))[0] ?? null;
  const topProvider = top(byProvider);

  return {
    now,
    windowDays,
    since: ledger.since,
    observedDays,
    total,
    totalDollars: usageDollars(total, rate),
    byAgent,
    byModel,
    byProvider,
    byDay,
    topProvider,
    topAgent: top(byAgent),
    providerConcentrated: Boolean(topProvider && (topProvider.callShare ?? 0) > METERING.providerShareLimit && topProvider.key !== UNATTRIBUTED),
  };
}

/* --------------------------------------------------------------- credits */

export type CreditUnit = 'tokens' | 'calls' | 'dollars';

/** A balance the user typed in. Teamz cannot read provider balances; this is labelled user-entered everywhere. */
export interface ProviderCredit {
  provider: string;
  unit: CreditUnit;
  balance: number;
  /** Epoch ms the balance was true. */
  enteredAt: number;
}

export type CreditStatus = 'ok' | 'low' | 'critical' | 'exhausted' | 'unknown';

export interface CreditHealth {
  provider: string;
  status: CreditStatus;
  unit: CreditUnit;
  enteredBalance: number;
  /** Balance left after subtracting observed use since it was entered. Conservative: the whole entry day is subtracted. */
  remaining: number | null;
  burnPerDay: number | null;
  daysLeft: number | null;
  exhaustsAt: number | null;
  /** Why the status is what it is, in plain words. */
  reason: string;
  basis: 'user-entered';
}

function unitValue(b: UsageBucket, unit: CreditUnit, rate: CostRate | null): number | null {
  if (unit === 'tokens') return b.totalTokens;
  if (unit === 'calls') return b.calls;
  return usageDollars(b, rate);
}

/** Per-day usage of one provider (by configured attribution) for the given days. */
function providerDayBuckets(
  provider: string,
  days: string[],
  agents: Agent[],
  runner: RunnerSnapshot | null,
  ledger: UsageLedger,
): Array<{ date: string; observed: boolean; bucket: UsageBucket }> {
  const routes = agentRoutes(agents, runner);
  return days.map((date) => {
    const day = ledger.days[date];
    let bucket = ZERO;
    if (day) for (const [id, b] of Object.entries(day)) if ((routes.get(id)?.provider ?? UNATTRIBUTED) === provider) bucket = add(bucket, b);
    return { date, observed: Boolean(day), bucket };
  });
}

export function evaluateCredits(input: {
  credits: ProviderCredit[];
  agents: Agent[];
  runner: RunnerSnapshot | null;
  ledger: UsageLedger;
  rate: CostRate | null;
  now: number;
}): CreditHealth[] {
  const { credits, agents, runner, ledger, rate, now } = input;
  return credits.map((c): CreditHealth => {
    const base = { provider: c.provider, unit: c.unit, enteredBalance: c.balance, basis: 'user-entered' as const };
    if (c.balance <= 0) {
      return { ...base, status: 'exhausted', remaining: 0, burnPerDay: null, daysLeft: 0, exhaustsAt: c.enteredAt, reason: 'The balance you entered is zero.' };
    }
    if (c.unit === 'dollars' && !rate) {
      return { ...base, status: 'unknown', remaining: null, burnPerDay: null, daysLeft: null, exhaustsAt: null, reason: 'A dollar balance needs a cost rate; set one under Workspace & API, or enter the balance in tokens or calls.' };
    }
    const since = utcDay(c.enteredAt);
    const sinceDays: string[] = [];
    for (let t = Date.parse(`${since}T00:00:00Z`); t <= now; t += DAY_MS) sinceDays.push(utcDay(t));
    let used = 0;
    for (const d of providerDayBuckets(c.provider, sinceDays, agents, runner, ledger)) used += unitValue(d.bucket, c.unit, rate) ?? 0;
    const remaining = Math.max(0, c.balance - used);

    const recent = providerDayBuckets(c.provider, lastDays(now, METERING.burnDays), agents, runner, ledger).filter((d) => d.observed);
    if (recent.length === 0) {
      return { ...base, status: 'unknown', remaining, burnPerDay: null, daysLeft: null, exhaustsAt: null, reason: 'No usage day has been observed yet, so there is no burn rate to project from.' };
    }
    const burn = recent.reduce((s, d) => s + (unitValue(d.bucket, c.unit, rate) ?? 0), 0) / recent.length;
    if (remaining <= 0) {
      return { ...base, status: 'exhausted', remaining: 0, burnPerDay: burn, daysLeft: 0, exhaustsAt: now, reason: 'Observed use since you entered the balance has used it up.' };
    }
    if (burn <= 0) {
      return { ...base, status: 'ok', remaining, burnPerDay: 0, daysLeft: null, exhaustsAt: null, reason: `No use observed on this provider in the last ${recent.length} observed day${recent.length === 1 ? '' : 's'}.` };
    }
    const daysLeft = remaining / burn;
    const status: CreditStatus = daysLeft <= METERING.creditCriticalDays ? 'critical' : daysLeft <= METERING.creditLowDays ? 'low' : 'ok';
    const reason =
      status === 'ok'
        ? `At ${recent.length}-day mean burn, about ${daysLeft.toFixed(1)} days of balance left.`
        : `At ${recent.length}-day mean burn, about ${daysLeft.toFixed(1)} day${daysLeft === 1 ? '' : 's'} left, inside the ${status === 'critical' ? METERING.creditCriticalDays : METERING.creditLowDays}-day warning line.`;
    return { ...base, status, remaining, burnPerDay: burn, daysLeft, exhaustsAt: now + daysLeft * DAY_MS, reason };
  });
}

/* --------------------------------------------------------------- budgets */

export type BudgetScope = { kind: 'fleet' } | { kind: 'agent'; agentId: string };
export type BudgetPeriod = 'day' | 'week';
export type BudgetUnit = 'tokens' | 'calls' | 'dollars';

/** A limit. It binds nothing until the Reviewer's decision is recorded as `approved`. */
export interface BudgetProposal {
  id: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  unit: BudgetUnit;
  limit: number;
  proposedAt: number;
  note: string;
  status: 'proposed' | 'approved' | 'rejected';
  decision?: { by: string; at: number; note: string };
}

export function proposeBudget(input: Omit<BudgetProposal, 'id' | 'proposedAt' | 'status' | 'decision'>, now: number): BudgetProposal {
  if (!Number.isFinite(input.limit) || input.limit <= 0) throw new Error('A budget limit must be a positive number.');
  const who = input.scope.kind === 'fleet' ? 'fleet' : input.scope.agentId;
  return { ...input, id: `budget-${who}-${input.period}-${input.unit}-${now}`, proposedAt: now, status: 'proposed' };
}

export function decideBudget(b: BudgetProposal, decision: 'approved' | 'rejected', by: string, note: string, now: number): BudgetProposal {
  if (b.status !== 'proposed') throw new Error('Only a proposed budget can be decided.');
  if (!by.trim()) throw new Error('Say who is recording the Reviewer’s decision.');
  if (!note.trim()) throw new Error('A decision needs a reason.');
  return { ...b, status: decision, decision: { by: by.trim(), at: now, note: note.trim() } };
}

export type BudgetState = 'no-approved-limit' | 'ok' | 'near' | 'over' | 'unknown';

export interface BudgetRow {
  budget: BudgetProposal;
  label: string;
  used: number | null;
  fraction: number | null;
  state: BudgetState;
  /** For a proposal: how it would read against current use, so the Reviewer can see the effect. */
  wouldBe: BudgetState | null;
  note: string;
}

function periodDays(period: BudgetPeriod, now: number): string[] {
  return period === 'day' ? [utcDay(now)] : lastDays(now, 7);
}

function budgetUsed(b: BudgetProposal, ledger: UsageLedger, rate: CostRate | null, now: number): number | null {
  let bucket = ZERO;
  for (const date of periodDays(b.period, now)) {
    const day = ledger.days[date];
    if (!day) continue;
    for (const [id, x] of Object.entries(day)) if (b.scope.kind === 'fleet' || b.scope.agentId === id) bucket = add(bucket, x);
  }
  return unitValue(bucket, b.unit, rate);
}

function stateFor(used: number | null, limit: number): { state: BudgetState; fraction: number | null } {
  if (used === null) return { state: 'unknown', fraction: null };
  const fraction = used / limit;
  return { state: fraction >= 1 ? 'over' : fraction >= METERING.budgetNearFraction ? 'near' : 'ok', fraction };
}

export function evaluateBudgets(input: { budgets: BudgetProposal[]; agents: Agent[]; ledger: UsageLedger; rate: CostRate | null; now: number }): BudgetRow[] {
  const { budgets, agents, ledger, rate, now } = input;
  const names = new Map(agents.map((a) => [a.id, a.name]));
  return budgets.map((budget): BudgetRow => {
    const label = budget.scope.kind === 'fleet' ? 'Whole fleet' : names.get(budget.scope.agentId) ?? budget.scope.agentId;
    const used = budgetUsed(budget, ledger, rate, now);
    const { state: raw, fraction } = stateFor(used, budget.limit);
    const unknownNote = used === null ? 'A dollar budget needs a cost rate.' : '';
    const partial = 'Counts only the days this browser observed.';
    if (budget.status === 'approved') {
      return { budget, label, used, fraction, state: raw, wouldBe: null, note: unknownNote || partial };
    }
    return {
      budget,
      label,
      used,
      fraction,
      state: 'no-approved-limit',
      wouldBe: budget.status === 'proposed' ? raw : null,
      note: budget.status === 'proposed' ? 'Proposed only: nothing is enforced until the Reviewer approves it.' : 'Rejected by the Reviewer.',
    };
  });
}

/* ------------------------------------------------------------ fleet health */

export type HealthState = 'active' | 'sleeping' | 'starved' | 'parked' | 'never-run';

export interface AgentHealth {
  agentId: string;
  name: string;
  programme: string;
  state: HealthState;
  /** One plain sentence that can be checked against the agent's run record. */
  reason: string;
  lastActivityAt: number | null;
  scheduledCount: number;
  /** True when the evidence window is shorter than the 14-day rule, so "sleeping" means "none seen so far". */
  partial: boolean;
  lastRunFailed: boolean;
}

export interface FleetHealth {
  now: number;
  agents: AgentHealth[];
  counts: Record<HealthState, number>;
  /** Earliest timestamp any source proves; null when nothing is recorded. */
  evidenceFrom: number | null;
}

interface Sched {
  /** Expected seconds-scale cadence in ms; null for manual or unparseable schedules. */
  cadenceMs: number | null;
}

interface Run {
  at: number;
  ok: boolean | null;
}

const isIntervalLike = (v: unknown): v is { id: string; agentId: string; everyMs: number; lastRunAt: number | null; enabled?: boolean } => {
  const t = v as { id?: unknown; agentId?: unknown; everyMs?: unknown } | null;
  return Boolean(t) && typeof t!.id === 'string' && typeof t!.agentId === 'string' && typeof t!.everyMs === 'number';
};

function scheduleCadence(s: { kind: string; expr?: string; everyMs?: number }, now: number): number | null {
  if (s.kind === 'interval' && typeof s.everyMs === 'number' && s.everyMs > 0) return s.everyMs;
  if (s.kind === 'cron' && s.expr) {
    const m = cronIntervalMinutes(s.expr, new Date(now));
    return m === null ? null : m * 60_000;
  }
  return null;
}

export function buildFleetHealth(input: {
  agents: Agent[];
  runner: RunnerSnapshot | null;
  local: LocalAutonomy | null;
  ledger: UsageLedger;
  now: number;
}): FleetHealth {
  const { agents, runner, local, ledger, now } = input;
  const windowStart = now - METERING.windowDays * DAY_MS;

  const sched = new Map<string, Sched[]>();
  const runs = new Map<string, Run[]>();
  const parked = new Map<string, string>();
  const push = <T,>(m: Map<string, T[]>, id: string, v: T) => {
    const l = m.get(id);
    if (l) l.push(v);
    else m.set(id, [v]);
  };
  let evidenceFrom: number | null = ledger.since ? Date.parse(`${ledger.since}T00:00:00Z`) : null;
  const note = (ts: number) => {
    if (evidenceFrom === null || ts < evidenceFrom) evidenceFrom = ts;
  };

  const crons = [...(runner?.cronJobs ?? []), ...(local?.cronJobs ?? [])];
  for (const j of crons) {
    if (!j.agentId) continue;
    if (j.enabled) push(sched, j.agentId, { cadenceMs: scheduleCadence({ kind: 'cron', expr: j.schedule }, now) });
    for (const r of j.runs) {
      push(runs, j.agentId, { at: r.ts, ok: r.ok });
      note(r.ts);
    }
    if (j.lastRunAt !== null && j.runs.length === 0) {
      push(runs, j.agentId, { at: j.lastRunAt, ok: null });
      note(j.lastRunAt);
    }
  }
  const intervals = [...(runner?.triggers ?? []).filter(isIntervalLike), ...(local?.triggers ?? [])];
  for (const t of intervals) {
    if (t.enabled !== false) push(sched, t.agentId, { cadenceMs: t.everyMs > 0 ? t.everyMs : null });
    if (t.lastRunAt !== null) {
      push(runs, t.agentId, { at: t.lastRunAt, ok: null });
      note(t.lastRunAt);
    }
  }

  const jobList: Array<{
    name: string;
    enabled: boolean;
    status: string;
    schedule: { kind: string; expr?: string; everyMs?: number };
    stages: Array<{ stage: string; agentId: string }>;
    runs: Array<{ stage?: string; agentId?: string; status?: string; startedAt?: number }>;
  }> = [
    ...(runner?.jobs ?? []).map((j) => ({ name: j.name, enabled: j.enabled, status: j.status, schedule: j.schedule, stages: j.stages, runs: j.runs })),
    ...(local?.jobs ?? []).map((j) => ({ name: j.name, enabled: j.enabled, status: j.status, schedule: j.schedule as { kind: string; expr?: string; everyMs?: number }, stages: j.stages, runs: j.runs })),
  ];
  for (const j of jobList) {
    const owners = new Set(j.stages.map((s) => s.agentId));
    for (const id of owners) {
      if (j.enabled && (j.status === 'active' || j.status === 'awaiting_approval')) {
        push(sched, id, { cadenceMs: scheduleCadence(j.schedule, now) });
      }
      if (j.status === 'awaiting_approval' && j.enabled) {
        parked.set(id, `“${j.name}” is waiting for an approval.`);
      }
    }
    for (const r of j.runs) {
      if (typeof r.startedAt !== 'number') continue;
      const stage = j.stages.find((s) => s.stage === r.stage);
      const id = r.agentId ?? stage?.agentId;
      if (!id) continue;
      push(runs, id, { at: r.startedAt, ok: r.status === 'ok' ? true : r.status === 'failed' || r.status === 'blocked' ? false : null });
      note(r.startedAt);
      if (r.status === 'dispatched' && now - r.startedAt > METERING.parkedDispatchedMs) {
        parked.set(id, `“${j.name}” has had a dispatch open for ${formatSpan(now - r.startedAt)} (deadline is 330s).`);
      }
    }
  }
  const msgAt = new Map<string, number>();
  for (const m of runner?.channelMessages ?? []) {
    msgAt.set(m.agentId, Math.max(msgAt.get(m.agentId) ?? 0, m.ts));
    note(m.ts);
  }

  const partial = evidenceFrom === null || evidenceFrom > windowStart;
  const out: AgentHealth[] = agents.map((a) => {
    const mine = runs.get(a.id) ?? [];
    const sc = sched.get(a.id) ?? [];
    const usage = agentUsage(ledger, a.id);
    let lastLedgerDay: string | null = null;
    for (const [date, d] of Object.entries(ledger.days)) if ((d[a.id]?.calls ?? 0) > 0 && (!lastLedgerDay || date > lastLedgerDay)) lastLedgerDay = date;
    const lastRun = mine.reduce((m, r) => Math.max(m, r.at), 0) || null;
    const lastMsg = msgAt.get(a.id) ?? null;
    const ledgerAt = lastLedgerDay ? Date.parse(`${lastLedgerDay}T23:59:59Z`) : null;
    const lastActivityAt = Math.max(lastRun ?? 0, lastMsg ?? 0, ledgerAt ?? 0) || null;
    const lastRunFailed = [...mine].sort((x, y) => y.at - x.at)[0]?.ok === false;
    const ever = mine.length > 0 || usage.calls > 0 || lastMsg !== null;
    const base = { agentId: a.id, name: a.name, programme: programmeOf(a.id), lastActivityAt, scheduledCount: sc.length, partial, lastRunFailed };

    const p = parked.get(a.id);
    if (p) return { ...base, state: 'parked', reason: p };
    if (sc.length > 0 && !ever) {
      return { ...base, state: 'never-run', reason: `${sc.length} scheduled item${sc.length === 1 ? '' : 's'} but no run, model call or message recorded${partial ? ' in the history seen' : ''}.` };
    }
    if (sc.length > 0) {
      const cadences = sc.map((s) => s.cadenceMs).filter((c): c is number => c !== null);
      if (cadences.length > 0 && lastActivityAt !== null) {
        const cadence = Math.min(...cadences);
        const limit = cadence * METERING.starvedCadenceFactor + METERING.starvedGraceMs;
        if (now - lastActivityAt > limit) {
          return { ...base, state: 'starved', reason: `Scheduled every ${formatSpan(cadence)} but nothing recorded for ${formatSpan(now - lastActivityAt)} (limit ${formatSpan(limit)}).` };
        }
      }
      return { ...base, state: 'active', reason: lastActivityAt ? `Scheduled, last activity ${formatSpan(now - lastActivityAt)} ago.` : 'Scheduled; its cadence is manual so no lateness applies.' };
    }
    if (lastActivityAt !== null && lastActivityAt >= windowStart) {
      return { ...base, state: 'active', reason: `Nothing scheduled, but active ${formatSpan(now - lastActivityAt)} ago.` };
    }
    return {
      ...base,
      state: 'sleeping',
      reason: lastActivityAt
        ? `Nothing scheduled and nothing for ${formatSpan(now - lastActivityAt)} (rule: ${METERING.windowDays} days).`
        : `Nothing scheduled and no activity seen${partial ? ' in the history observed so far' : ` in ${METERING.windowDays} days`}.`,
    };
  });

  const counts: Record<HealthState, number> = { active: 0, sleeping: 0, starved: 0, parked: 0, 'never-run': 0 };
  for (const h of out) counts[h.state] += 1;
  return { now, agents: out, counts, evidenceFrom };
}

export function formatSpan(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 90) return `${m} min`;
  const h = ms / HOUR_MS;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${(ms / DAY_MS).toFixed(1)} days`;
}

/* ----------------------------------------------------------------- pacing */

export interface QueueDrain {
  /** Dispatches waiting: remaining stages of due product jobs, plus due cron jobs. */
  queued: number;
  dueJobs: number;
  dueCrons: number;
  neverRunJobs: number;
  totalJobs: number;
  slots: number;
  gapMs: number;
  /** Time to clear the queue if every dispatch is instant, and if each takes the full 330s budget. */
  drainMinMs: number;
  drainMaxMs: number;
}

function jobIsDue(
  j: { enabled: boolean; status: string; currentStageIndex: number; stages: unknown[]; schedule: { kind: string; expr?: string; everyMs?: number }; lastRunAt: number | null },
  now: number,
): boolean {
  if (!j.enabled || j.status !== 'active' || j.currentStageIndex >= j.stages.length) return false;
  const s = j.schedule;
  if (s.kind === 'manual') return false;
  if (s.kind === 'interval') return j.lastRunAt === null || (typeof s.everyMs === 'number' && now - j.lastRunAt >= s.everyMs);
  if (s.kind === 'cron' && s.expr) {
    try {
      if (j.lastRunAt === null) return new Schedule(s.expr).matches(new Date(now));
      return hasScheduledSlotSince(s.expr, j.lastRunAt, now);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * How long the due work takes to drain at a given spacing. This is arithmetic
 * on the runner's own published settings (one dispatch per slot per gap, a
 * second slot while two or more product jobs are due): a range, because the
 * runner does not tell the browser how long its dispatches really take.
 */
export function queueDrain(input: { runner: RunnerSnapshot | null; local?: LocalAutonomy | null; now: number; gapMs?: number }): QueueDrain {
  const { runner, now } = input;
  const gapMs = input.gapMs ?? RUNNER_PACING.minDispatchGapMs;
  const jobs = [...(runner?.jobs ?? []), ...(input.local?.jobs ?? [])] as Array<{
    enabled: boolean;
    status: string;
    currentStageIndex: number;
    stages: unknown[];
    schedule: { kind: string; expr?: string; everyMs?: number };
    lastRunAt: number | null;
    runs: unknown[];
  }>;
  let queued = 0;
  let dueJobs = 0;
  let neverRun = 0;
  for (const j of jobs) {
    if (j.enabled && j.runs.length === 0 && j.lastRunAt === null) neverRun += 1;
    if (jobIsDue(j, now)) {
      dueJobs += 1;
      queued += Math.max(1, j.stages.length - j.currentStageIndex);
    }
  }
  let dueCrons = 0;
  for (const c of [...(runner?.cronJobs ?? []), ...(input.local?.cronJobs ?? [])]) {
    if (!c.enabled) continue;
    const due = c.lastRunAt === null ? false : hasScheduledSlotSince(c.schedule, c.lastRunAt, now);
    if (due) dueCrons += 1;
  }
  queued += dueCrons;
  const slots = dueJobs >= RUNNER_PACING.heavyBacklogJobs ? RUNNER_PACING.maxSlots : RUNNER_PACING.baseSlots;
  const rounds = Math.ceil(queued / slots);
  return {
    queued,
    dueJobs,
    dueCrons,
    neverRunJobs: neverRun,
    totalJobs: jobs.length,
    slots,
    gapMs,
    drainMinMs: rounds * gapMs,
    drainMaxMs: rounds * (gapMs + RUNNER_PACING.dispatchTimeoutMs),
  };
}

/** A proposed spacing. Recording it changes nothing live; the Reviewer decides and the runner is redeployed by hand. */
export interface PacingProposal {
  id: string;
  gapMs: number;
  proposedAt: number;
  note: string;
  status: 'proposed' | 'approved' | 'rejected';
  decision?: { by: string; at: number; note: string };
}

export function proposePacing(gapMs: number, note: string, now: number): PacingProposal {
  if (!Number.isFinite(gapMs) || gapMs < 10_000 || gapMs > 6 * HOUR_MS) throw new Error('Spacing must be between 10 seconds and 6 hours.');
  return { id: `pacing-${now}`, gapMs: Math.round(gapMs), proposedAt: now, note: note.trim(), status: 'proposed' };
}

export function decidePacing(p: PacingProposal, decision: 'approved' | 'rejected', by: string, note: string, now: number): PacingProposal {
  if (p.status !== 'proposed') throw new Error('Only a proposed spacing can be decided.');
  if (!by.trim()) throw new Error('Say who is recording the Reviewer’s decision.');
  if (!note.trim()) throw new Error('A decision needs a reason.');
  return { ...p, status: decision, decision: { by: by.trim(), at: now, note: note.trim() } };
}

/* ------------------------------------------------------------ persistence */

export const METERING_KEY = 'teamz:metering:v1';

export interface MeteringState {
  credits: ProviderCredit[];
  budgets: BudgetProposal[];
  pacing: PacingProposal[];
}

export const emptyMetering = (): MeteringState => ({ credits: [], budgets: [], pacing: [] });

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseMetering(raw: string | null): MeteringState {
  if (!raw) return emptyMetering();
  try {
    const p = JSON.parse(raw) as Partial<MeteringState>;
    const credits = (Array.isArray(p.credits) ? p.credits : []).filter(
      (c): c is ProviderCredit => !!c && isStr(c.provider) && ['tokens', 'calls', 'dollars'].includes(c.unit) && isNum(c.balance) && isNum(c.enteredAt),
    );
    const decided = (d: unknown) => d === undefined || (!!d && isStr((d as { by?: unknown }).by) && isNum((d as { at?: unknown }).at));
    const budgets = (Array.isArray(p.budgets) ? p.budgets : []).filter(
      (b): b is BudgetProposal =>
        !!b && isStr(b.id) && !!b.scope && (b.scope.kind === 'fleet' || (b.scope.kind === 'agent' && isStr(b.scope.agentId))) &&
        ['day', 'week'].includes(b.period) && ['tokens', 'calls', 'dollars'].includes(b.unit) && isNum(b.limit) && b.limit > 0 &&
        ['proposed', 'approved', 'rejected'].includes(b.status) && decided(b.decision) && (b.status === 'proposed' || !!b.decision),
    );
    const pacing = (Array.isArray(p.pacing) ? p.pacing : []).filter(
      (x): x is PacingProposal => !!x && isStr(x.id) && isNum(x.gapMs) && ['proposed', 'approved', 'rejected'].includes(x.status) && decided(x.decision) && (x.status === 'proposed' || !!x.decision),
    );
    return { credits, budgets, pacing };
  } catch {
    return emptyMetering();
  }
}
