import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '../types';
import type { LocalAutonomy, RunnerSnapshot } from './agentHome';
import { BASE_DISPATCH_SLOTS, DISPATCH_TIMEOUT_MS, HEAVY_BACKLOG_JOBS, MAX_DISPATCH_SLOTS } from '../../scripts/runner-lib';
import {
  METERING,
  RUNNER_PACING,
  UNATTRIBUTED,
  buildFleetHealth,
  buildUsageReport,
  decideBudget,
  decidePacing,
  emptyMetering,
  evaluateBudgets,
  evaluateCredits,
  parseMetering,
  proposeBudget,
  proposePacing,
  queueDrain,
  type BudgetProposal,
  type ProviderCredit,
} from './metering';
import { EMPTY_LEDGER, recordUsageDay, type CostRate, type UsageLedger } from './usageLedger';

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const fleet: Array<{ id: string; name: string }> = JSON.parse(readFileSync(join(process.cwd(), 'agents-104-list.json'), 'utf-8'));
const mk = (id: string, name = id): Agent => ({ id, name, emoji: 'A', accent: '#fff', status: 'online', endpointUrl: '', model: 'agent-model', systemPrompt: '', skills: [], createdAt: 0 });
const bucket = (calls: number, tokens = calls * 1000) => ({ calls, promptTokens: Math.floor(tokens * 0.8), completionTokens: Math.ceil(tokens * 0.2), totalTokens: tokens });
const snap = (over: Partial<RunnerSnapshot> = {}): RunnerSnapshot => ({ jobs: [], triggers: [], cronJobs: [], agents: [], channelMessages: [], fetchedAt: NOW, ...over });
const ledgerWith = (days: Record<string, Record<string, number>>): UsageLedger => {
  let l = EMPTY_LEDGER;
  for (const d of Object.keys(days).sort()) {
    l = recordUsageDay(l, { date: d, byAgent: Object.fromEntries(Object.entries(days[d]).map(([k, v]) => [k, bucket(v)])) });
  }
  return l;
};
const RATE: CostRate = { inputPerMillion: 1, outputPerMillion: 4 };

const A = mk('a', 'Alpha');
const B = mk('b', 'Bravo');
const routes = snap({
  agents: [
    { id: 'a', name: 'Alpha', provider: 'deepinfra', model: 'big' },
    { id: 'b', name: 'Bravo', provider: 'linkup', model: 'small' },
  ],
});

describe('pacing constants', () => {
  it('match the runner so the drain arithmetic cannot drift', () => {
    expect(RUNNER_PACING.baseSlots).toBe(BASE_DISPATCH_SLOTS);
    expect(RUNNER_PACING.maxSlots).toBe(MAX_DISPATCH_SLOTS);
    expect(RUNNER_PACING.heavyBacklogJobs).toBe(HEAVY_BACKLOG_JOBS);
    expect(RUNNER_PACING.dispatchTimeoutMs).toBe(DISPATCH_TIMEOUT_MS);
    expect(readFileSync(join(process.cwd(), 'scripts/runner.ts'), 'utf-8')).toContain(`minDispatchGapMs: ${RUNNER_PACING.minDispatchGapMs.toLocaleString('en-US').replace(/,/g, '_')}`);
  });
});

describe('usage report', () => {
  it('breaks down by agent, model, provider and day, and reproduces provider concentration and the top agent share', () => {
    const l = ledgerWith({ [dateOf(NOW)]: { a: 90, b: 10 }, [dateOf(NOW - DAY)]: { a: 90, b: 10 } });
    const r = buildUsageReport({ agents: [A, B], runner: routes, ledger: l, rate: null, now: NOW });
    expect(r.total.calls).toBe(200);
    expect(r.byProvider.map((x) => [x.key, x.callShare])).toEqual([['deepinfra', 0.9], ['linkup', 0.1]]);
    expect(r.byModel.map((x) => x.key)).toEqual(['big', 'small']);
    expect(r.topProvider?.key).toBe('deepinfra');
    expect(r.topAgent?.label).toBe('Alpha');
    expect(r.topAgent?.callShare).toBe(0.9);
    expect(r.providerConcentrated).toBe(true);
    expect(r.observedDays).toBe(2);
    expect(r.byDay).toHaveLength(14);
  });

  it('shows days the browser never observed as not observed, not as zero', () => {
    const r = buildUsageReport({ agents: [A], runner: routes, ledger: ledgerWith({ [dateOf(NOW)]: { a: 5 } }), rate: null, now: NOW });
    expect(r.byDay.filter((d) => !d.observed)).toHaveLength(13);
    expect(r.byDay[13].observed).toBe(true);
  });

  it('never invents dollars: null without a rate, a real figure with one', () => {
    const l = ledgerWith({ [dateOf(NOW)]: { a: 10 } });
    expect(buildUsageReport({ agents: [A], runner: routes, ledger: l, rate: null, now: NOW }).totalDollars).toBeNull();
    const d = buildUsageReport({ agents: [A], runner: routes, ledger: l, rate: RATE, now: NOW }).totalDollars!;
    expect(d).toBeCloseTo((8000 / 1e6) * 1 + (2000 / 1e6) * 4, 6);
  });

  it('attributes agents the runner does not list to "unattributed" and never calls that a concentration', () => {
    const r = buildUsageReport({ agents: [A], runner: null, ledger: ledgerWith({ [dateOf(NOW)]: { a: 50 } }), rate: null, now: NOW });
    expect(r.byProvider[0].key).toBe(UNATTRIBUTED);
    expect(r.providerConcentrated).toBe(false);
  });

  it('window boundary: a day just outside 14 days is excluded', () => {
    const l = ledgerWith({ [dateOf(NOW - 14 * DAY)]: { a: 7 }, [dateOf(NOW - 13 * DAY)]: { a: 3 } });
    const r = buildUsageReport({ agents: [A], runner: routes, ledger: l, rate: null, now: NOW });
    expect(r.total.calls).toBe(3);
  });

  it('handles an empty ledger without dividing by zero', () => {
    const r = buildUsageReport({ agents: [A], runner: routes, ledger: EMPTY_LEDGER, rate: null, now: NOW });
    expect(r.total.calls).toBe(0);
    expect(r.topProvider).toBeNull();
    expect(r.providerConcentrated).toBe(false);
  });

  it('runs on the real 106-agent fleet', () => {
    const agents = fleet.map((f) => mk(f.id, f.name));
    const day: Record<string, number> = {};
    agents.forEach((a, i) => (day[a.id] = i === 0 ? 900 : 1));
    const r = buildUsageReport({ agents, runner: null, ledger: ledgerWith({ [dateOf(NOW)]: day }), rate: null, now: NOW });
    expect(agents.length).toBeGreaterThanOrEqual(105);
    expect(r.byAgent[0].callShare).toBeGreaterThan(0.8);
  });
});

describe('credit warnings fire before exhaustion', () => {
  const credit = (balance: number, unit: ProviderCredit['unit'] = 'tokens', enteredAt = NOW - 2 * DAY): ProviderCredit => ({ provider: 'deepinfra', unit, balance, enteredAt });
  // 3 observed days of 100k tokens/day on deepinfra (Alpha)
  const l = ledgerWith({ [dateOf(NOW - 2 * DAY)]: { a: 100 }, [dateOf(NOW - DAY)]: { a: 100 }, [dateOf(NOW)]: { a: 100 } });
  const run = (c: ProviderCredit, ledger = l, rate: CostRate | null = null) => evaluateCredits({ credits: [c], agents: [A, B], runner: routes, ledger, rate, now: NOW })[0];

  it('warns while balance remains, not after the provider fails', () => {
    // balance 400k, used 300k since entry day => 100k left, burn 100k/day => 1.0 day => critical
    const h = run(credit(400_000));
    expect(h.remaining).toBe(100_000);
    expect(h.status).toBe('critical');
    expect(h.daysLeft).toBeCloseTo(1, 5);
    expect(h.remaining).toBeGreaterThan(0);
    expect(h.exhaustsAt).toBeGreaterThan(NOW);
    expect(h.basis).toBe('user-entered');
  });

  it('is low inside 3 days, ok beyond', () => {
    expect(run(credit(550_000)).status).toBe('low');
    expect(run(credit(900_000)).status).toBe('ok');
  });

  it('is exhausted once observed use has consumed the balance, and when the entered balance is zero', () => {
    expect(run(credit(250_000)).status).toBe('exhausted');
    expect(run(credit(0)).status).toBe('exhausted');
  });

  it('is unknown, with a reason, when there is no usage observed or a dollar balance has no rate', () => {
    const none = run(credit(1_000_000), EMPTY_LEDGER);
    expect(none.status).toBe('unknown');
    expect(none.reason).toMatch(/No usage day/);
    const dollars = run(credit(5, 'dollars'));
    expect(dollars.status).toBe('unknown');
    expect(dollars.reason).toMatch(/cost rate/);
    expect(run(credit(5, 'dollars'), l, RATE).status).not.toBe('unknown');
  });

  it('is ok with no burn rather than dividing by zero', () => {
    const quiet = ledgerWith({ [dateOf(NOW)]: { b: 100 } });
    const h = run(credit(1000), quiet);
    expect(h.status).toBe('ok');
    expect(h.burnPerDay).toBe(0);
    expect(h.daysLeft).toBeNull();
  });

  it('only counts use by the provider the balance is for', () => {
    const h = evaluateCredits({ credits: [{ provider: 'linkup', unit: 'calls', balance: 1000, enteredAt: NOW - DAY }], agents: [A, B], runner: routes, ledger: l, rate: null, now: NOW })[0];
    expect(h.remaining).toBe(1000);
  });
});

describe('budgets: proposals bind nothing until the Reviewer approves', () => {
  const l = ledgerWith({ [dateOf(NOW)]: { a: 100, b: 20 } });
  const evalOne = (b: BudgetProposal, rate: CostRate | null = null) => evaluateBudgets({ budgets: [b], agents: [A, B], ledger: l, rate, now: NOW })[0];

  it('shows a proposal as having no approved limit, with what it would read as', () => {
    const b = proposeBudget({ scope: { kind: 'agent', agentId: 'a' }, period: 'day', unit: 'tokens', limit: 90_000, note: 'cap Alpha' }, NOW);
    const r = evalOne(b);
    expect(r.state).toBe('no-approved-limit');
    expect(r.wouldBe).toBe('over');
    expect(r.note).toMatch(/nothing is enforced/);
  });

  it('enforces only after a recorded Reviewer decision, with who and why', () => {
    const b = proposeBudget({ scope: { kind: 'agent', agentId: 'a' }, period: 'day', unit: 'tokens', limit: 110_000, note: '' }, NOW);
    expect(() => decideBudget(b, 'approved', '', 'ok', NOW)).toThrow(/who/);
    expect(() => decideBudget(b, 'approved', 'Reviewer', '  ', NOW)).toThrow(/reason/);
    const approved = decideBudget(b, 'approved', 'Reviewer', 'fits the plan', NOW);
    expect(approved.decision?.by).toBe('Reviewer');
    expect(evalOne(approved).state).toBe('near');
    expect(() => decideBudget(approved, 'rejected', 'Reviewer', 'again', NOW)).toThrow(/proposed/);
  });

  it('a rejected budget never enforces', () => {
    const b = decideBudget(proposeBudget({ scope: { kind: 'fleet' }, period: 'day', unit: 'tokens', limit: 1, note: '' }, NOW), 'rejected', 'Reviewer', 'no', NOW);
    const r = evalOne(b);
    expect(r.state).toBe('no-approved-limit');
    expect(r.wouldBe).toBeNull();
  });

  it('fleet scope sums every agent; week scope spans 7 UTC days', () => {
    const wk = ledgerWith({ [dateOf(NOW - 6 * DAY)]: { a: 10 }, [dateOf(NOW - 7 * DAY)]: { a: 999 } });
    const b = decideBudget(proposeBudget({ scope: { kind: 'fleet' }, period: 'week', unit: 'calls', limit: 20, note: '' }, NOW), 'approved', 'R', 'ok', NOW);
    const r = evaluateBudgets({ budgets: [b], agents: [A], ledger: wk, rate: null, now: NOW })[0];
    expect(r.used).toBe(10);
    expect(r.state).toBe('ok');
  });

  it('a dollar budget without a rate is unknown, not zero', () => {
    const b = decideBudget(proposeBudget({ scope: { kind: 'fleet' }, period: 'day', unit: 'dollars', limit: 5, note: '' }, NOW), 'approved', 'R', 'ok', NOW);
    const r = evalOne(b);
    expect(r.state).toBe('unknown');
    expect(r.used).toBeNull();
  });

  it('rejects non-positive limits', () => {
    expect(() => proposeBudget({ scope: { kind: 'fleet' }, period: 'day', unit: 'tokens', limit: 0, note: '' }, NOW)).toThrow();
  });
});

describe('fleet health thresholds', () => {
  const cron = (id: string, agentId: string, schedule: string, runs: number[], lastRunAt: number | null = runs.length ? Math.max(...runs) : null) => ({
    id, name: id, schedule, type: 'prompt' as const, target: 'x', enabled: true, agentId, lastRunAt, runs: runs.map((ts) => ({ ts, ok: true })),
  });
  const health = (agents: Agent[], runner: RunnerSnapshot | null, ledger = EMPTY_LEDGER, local: LocalAutonomy | null = null) => buildFleetHealth({ agents, runner, local, ledger, now: NOW });
  const stateOf = (h: ReturnType<typeof health>, id: string) => h.agents.find((a) => a.agentId === id)!;

  it('never-run: scheduled work and no run, call or message ever recorded', () => {
    const h = health([A], snap({ cronJobs: [cron('c', 'a', '0 */6 * * *', [])] }));
    expect(stateOf(h, 'a').state).toBe('never-run');
  });

  it('a recorded model call is enough to count as having run', () => {
    const h = health([A], snap({ cronJobs: [cron('c', 'a', '0 */6 * * *', [])] }), ledgerWith({ [dateOf(NOW)]: { a: 3 } }));
    expect(stateOf(h, 'a').state).toBe('active');
  });

  it('starved: late by more than 2x cadence plus 1h; on-time at the boundary is not starved', () => {
    const limit = 6 * HOUR * 2 + HOUR;
    const edge = health([A], snap({ cronJobs: [cron('c', 'a', '0 */6 * * *', [NOW - limit])] }));
    expect(stateOf(edge, 'a').state).toBe('active');
    const late = health([A], snap({ cronJobs: [cron('c', 'a', '0 */6 * * *', [NOW - limit - 60_000])] }));
    expect(stateOf(late, 'a').state).toBe('starved');
    expect(stateOf(late, 'a').reason).toMatch(/limit 13 h/);
  });

  it('parked: a job awaiting approval, or a dispatch left open past the threshold', () => {
    const job = (over: Record<string, unknown>) => ({
      id: 'j', name: 'Job', schedule: { kind: 'interval', everyMs: HOUR }, enabled: true, status: 'active', currentStageIndex: 0,
      stages: [{ stage: 'design', agentId: 'a' }], runs: [], lastRunAt: null, ...over,
    });
    const waiting = health([A], snap({ jobs: [job({ status: 'awaiting_approval' })] }));
    expect(stateOf(waiting, 'a').state).toBe('parked');
    const stuck = health([A], snap({ jobs: [job({ runs: [{ id: 'r', stage: 'design', status: 'dispatched', startedAt: NOW - METERING.parkedDispatchedMs - 1 }] })] }));
    expect(stateOf(stuck, 'a').state).toBe('parked');
    const fresh = health([A], snap({ jobs: [job({ runs: [{ id: 'r', stage: 'design', status: 'dispatched', startedAt: NOW - 60_000 }] })] }));
    expect(stateOf(fresh, 'a').state).toBe('active');
  });

  it('sleeping: nothing scheduled and no activity in 14 days; flagged partial when the evidence is shorter', () => {
    const shallow = health([A], snap());
    expect(stateOf(shallow, 'a').state).toBe('sleeping');
    expect(stateOf(shallow, 'a').partial).toBe(true);
    const deep = health([A, B], snap({ channelMessages: [{ id: 'm', channelId: 'c', agentId: 'b', agentName: 'B', kind: 'x', text: '', ts: NOW - 40 * DAY }] }));
    expect(stateOf(deep, 'a').partial).toBe(false);
    expect(stateOf(deep, 'a').state).toBe('sleeping');
    expect(stateOf(deep, 'b').state).toBe('sleeping');
  });

  it('recent unscheduled activity is active, and older than the window is sleeping', () => {
    const l = ledgerWith({ [dateOf(NOW - 20 * DAY)]: { a: 4 }, [dateOf(NOW - DAY)]: { b: 4 } });
    const h = health([A, B], snap(), l);
    expect(stateOf(h, 'a').state).toBe('sleeping');
    expect(stateOf(h, 'b').state).toBe('active');
  });

  it('flags a last failed run without changing the state', () => {
    const c = { ...cron('c', 'a', '0 * * * *', []), lastRunAt: NOW - HOUR, runs: [{ ts: NOW - HOUR, ok: false }] };
    const h = health([A], snap({ cronJobs: [c] }));
    expect(stateOf(h, 'a').lastRunFailed).toBe(true);
    expect(stateOf(h, 'a').state).toBe('active');
  });

  it('classifies every agent of the real 106-agent fleet exactly once', () => {
    const agents = fleet.map((f) => mk(f.id, f.name));
    const crons = agents.slice(0, 40).map((a, i) => cron(`c${i}`, a.id, '0 * * * *', i % 2 ? [NOW - HOUR] : []));
    const h = health(agents, snap({ cronJobs: crons }));
    expect(h.agents).toHaveLength(agents.length);
    expect(Object.values(h.counts).reduce((s, n) => s + n, 0)).toBe(agents.length);
    expect(h.counts['never-run']).toBe(20);
    expect(h.counts.active).toBe(20);
    expect(h.counts.sleeping).toBe(agents.length - 40);
  });
});

describe('queue drain at the current spacing', () => {
  const job = (id: string, over: Record<string, unknown> = {}) => ({
    id, name: id, schedule: { kind: 'interval', everyMs: HOUR }, enabled: true, status: 'active', currentStageIndex: 0,
    stages: [{ stage: 'design', agentId: 'a' }, { stage: 'review', agentId: 'b' }], runs: [], lastRunAt: null, ...over,
  });

  it('counts remaining stages of due jobs and opens a second slot for a backlog', () => {
    const q = queueDrain({ runner: snap({ jobs: [job('1'), job('2'), job('3', { lastRunAt: NOW })] }), now: NOW });
    expect(q.dueJobs).toBe(2);
    expect(q.queued).toBe(4);
    expect(q.slots).toBe(2);
    expect(q.drainMinMs).toBe(2 * 900_000);
    expect(q.drainMaxMs).toBe(2 * (900_000 + 330_000));
    expect(q.neverRunJobs).toBe(2);
    expect(q.totalJobs).toBe(3);
  });

  it('a longer spacing lengthens the drain; the same queue is shown for both', () => {
    const r = snap({ jobs: [job('1')] });
    const now900 = queueDrain({ runner: r, now: NOW });
    const now1800 = queueDrain({ runner: r, now: NOW, gapMs: 1_800_000 });
    expect(now900.slots).toBe(1);
    expect(now1800.drainMinMs).toBe(2 * now900.drainMinMs);
  });

  it('is zero with nothing due, and paused or disabled jobs are never due', () => {
    expect(queueDrain({ runner: null, now: NOW }).drainMinMs).toBe(0);
    expect(queueDrain({ runner: snap({ jobs: [job('p', { status: 'paused' }), job('d', { enabled: false })] }), now: NOW }).queued).toBe(0);
  });

  it('counts a cron whose slot passed since its last run', () => {
    const c = { id: 'c', name: 'c', schedule: '0 * * * *', type: 'prompt' as const, target: '', enabled: true, agentId: 'a', lastRunAt: NOW - 3 * HOUR, runs: [] };
    expect(queueDrain({ runner: snap({ cronJobs: [c] }), now: NOW }).dueCrons).toBe(1);
  });
});

describe('pacing proposals', () => {
  it('only record a proposal and need a recorded Reviewer decision', () => {
    const p = proposePacing(1_800_000, 'ease provider load', NOW);
    expect(p.status).toBe('proposed');
    expect(() => proposePacing(1000, '', NOW)).toThrow();
    expect(() => decidePacing(p, 'approved', '', 'x', NOW)).toThrow(/who/);
    expect(decidePacing(p, 'rejected', 'Reviewer', 'trade-off too steep', NOW).status).toBe('rejected');
  });
});

describe('persistence', () => {
  it('round-trips and drops malformed or self-approved entries', () => {
    const b = proposeBudget({ scope: { kind: 'fleet' }, period: 'day', unit: 'tokens', limit: 5, note: '' }, NOW);
    const selfApproved = { ...b, id: 'x', status: 'approved' };
    const raw = JSON.stringify({
      credits: [{ provider: 'p', unit: 'tokens', balance: 5, enteredAt: NOW }, { provider: 'q' }],
      budgets: [b, selfApproved, { nope: 1 }],
      pacing: [proposePacing(900_000, '', NOW), { id: 'y', gapMs: 1, status: 'approved' }],
    });
    const s = parseMetering(raw);
    expect(s.credits).toHaveLength(1);
    expect(s.budgets.map((x) => x.id)).toEqual([b.id]);
    expect(s.pacing).toHaveLength(1);
    expect(parseMetering('not json')).toEqual(emptyMetering());
    expect(parseMetering(null)).toEqual(emptyMetering());
  });
});
