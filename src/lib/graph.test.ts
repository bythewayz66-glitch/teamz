import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, Message } from '../types';
import { buildFleetGraph, GITHUB_NODE_ID, WEB_NODE_ID, providerNodeId } from './graph';
import type { RunnerSnapshot } from './agentHome';
import { EMPTY_LEDGER, recordUsageDay, type UsageLedger } from './usageLedger';

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const DAY = 86_400_000;
const bucket = (calls: number) => ({ calls, promptTokens: 0, completionTokens: 0, totalTokens: 0 });

const fleet: Array<{ id: string; name: string }> = JSON.parse(readFileSync(join(process.cwd(), 'agents-104-list.json'), 'utf-8'));
const mk = (id: string, name: string): Agent => ({ id, name, emoji: 'A', accent: '#fff', status: 'online', endpointUrl: '', model: 'm', systemPrompt: '', skills: [], createdAt: 0 });
const A = mk('a', 'Alpha');
const B = mk('b', 'Bravo');
const C = mk('c', 'Charlie');

const msg = (id: string, authorId: string, text: string, createdAt: number): Message => ({
  id, conversationId: 'room', authorType: 'agent', authorId, text, createdAt, status: 'sent',
});
const snap = (over: Partial<RunnerSnapshot> = {}): RunnerSnapshot => ({ jobs: [], triggers: [], cronJobs: [], agents: [], channelMessages: [], fetchedAt: NOW, ...over });
const ledgerWith = (days: Record<string, Record<string, number>>): UsageLedger => {
  let l = EMPTY_LEDGER;
  for (const d of Object.keys(days).sort()) {
    l = recordUsageDay(l, { date: d, byAgent: Object.fromEntries(Object.entries(days[d]).map(([k, v]) => [k, bucket(v)])) });
  }
  return l;
};
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('mention edges', () => {
  it('counts agent @mentions inside the window and ignores self-mentions', () => {
    const g = buildFleetGraph({
      agents: [A, B], runner: null, local: null, ledger: EMPTY_LEDGER, now: NOW,
      messages: { room: [msg('1', 'a', '@Bravo please look', NOW - DAY), msg('2', 'a', '@Alpha note to self', NOW - DAY), msg('3', 'a', '@Bravo again', NOW - 2 * DAY)] },
    });
    const e = g.edges.find((x) => x.id === 'mention:a>b')!;
    expect(e.count).toBe(2);
    expect(g.edges.some((x) => x.id === 'mention:a>a')).toBe(false);
  });

  it('window boundary: an event exactly at the window start counts, one ms earlier does not', () => {
    const start = NOW - 14 * DAY;
    const g = buildFleetGraph({
      agents: [A, B], runner: null, local: null, ledger: EMPTY_LEDGER, now: NOW,
      messages: { room: [msg('old', 'b', 'x', start - 20 * DAY), msg('1', 'a', '@Bravo', start), msg('2', 'a', '@Bravo', start - 1)] },
    });
    const e = g.edges.find((x) => x.id === 'mention:a>b')!;
    expect(e.count).toBe(1);
    expect(e.total).toBe(2);
  });

  it('is dead only when the source reaches back past the window; a shallow source proves nothing', () => {
    const covered = buildFleetGraph({
      agents: [A, B], runner: null, local: null, ledger: EMPTY_LEDGER, now: NOW,
      messages: { room: [msg('0', 'b', 'hello', NOW - 30 * DAY), msg('1', 'a', '@Bravo', NOW - 20 * DAY)] },
    });
    expect(covered.edges.find((x) => x.id === 'mention:a>b')!.state).toBe('dead');
    const onlyRecent = buildFleetGraph({
      agents: [A, B], runner: null, local: null, ledger: EMPTY_LEDGER, now: NOW,
      messages: { room: [msg('2', 'b', 'hi', NOW - 3 * DAY)] },
    });
    expect(onlyRecent.sources.find((s) => s.id === 'mentions')!.coversWindow).toBe(false);
    expect(onlyRecent.edges).toHaveLength(0);
  });

  it('merges runner channel messages without double counting an id the workspace already has', () => {
    const g = buildFleetGraph({
      agents: [A, B], local: null, ledger: EMPTY_LEDGER, now: NOW,
      messages: { room: [msg('same', 'a', '@Bravo', NOW - DAY)] },
      runner: snap({ channelMessages: [{ id: 'same', channelId: 'room', agentId: 'a', agentName: 'Alpha', kind: 'reply', text: '@Bravo', ts: NOW - DAY }, { id: 'r2', channelId: 'room', agentId: 'a', agentName: 'Alpha', kind: 'reply', text: '@Bravo', ts: NOW - 2 * DAY }] }),
    });
    expect(g.edges.find((x) => x.id === 'mention:a>b')!.count).toBe(2);
  });
});

describe('job edges', () => {
  const job = (runs: Array<{ stage: string; status: string; startedAt: number }>) => ({
    id: 'j', name: 'J', schedule: { kind: 'interval' }, enabled: true, status: 'active', currentStageIndex: 0,
    stages: [{ stage: 'design', agentId: 'a' }, { stage: 'implement', agentId: 'b' }, { stage: 'upgrade', agentId: 'c' }],
    runs, lastRunAt: null,
  });

  it('turns stage order into handoff edges and the upgrade stage into a GitHub push edge', () => {
    const g = buildFleetGraph({
      agents: [A, B, C], messages: {}, local: null, ledger: EMPTY_LEDGER, now: NOW,
      runner: snap({ jobs: [job([{ stage: 'design', status: 'ok', startedAt: NOW - 20 * DAY }, { stage: 'design', status: 'ok', startedAt: NOW - DAY }, { stage: 'implement', status: 'failed', startedAt: NOW - DAY }, { stage: 'upgrade', status: 'ok', startedAt: NOW - 2 * DAY }])] }),
    });
    const h = g.edges.find((x) => x.id === 'handoff:a>b')!;
    expect(h.count).toBe(1);
    expect(h.total).toBe(2);
    expect(g.edges.find((x) => x.id === 'handoff:b>c')!.count).toBe(0);
    expect(g.edges.find((x) => x.id === 'handoff:b>c')!.state).toBe('dead');
    const p = g.edges.find((x) => x.id === `push:c>${GITHUB_NODE_ID}`)!;
    expect(p.count).toBe(1);
    expect(p.state).toBe('active');
  });

  it('a failed run is not a handoff', () => {
    const g = buildFleetGraph({
      agents: [A, B, C], messages: {}, local: null, ledger: EMPTY_LEDGER, now: NOW,
      runner: snap({ jobs: [job([{ stage: 'design', status: 'failed', startedAt: NOW - DAY }])] }),
    });
    expect(g.edges.find((x) => x.id === 'handoff:a>b')!.count).toBe(0);
  });

  it('with no runs at all the edges are declared but unknown, not dead', () => {
    const g = buildFleetGraph({ agents: [A, B, C], messages: {}, local: null, ledger: EMPTY_LEDGER, now: NOW, runner: snap({ jobs: [job([])] }) });
    expect(g.edges.find((x) => x.id === 'handoff:a>b')!.state).toBe('unknown');
  });
});

describe('model edges and the usage ledger', () => {
  const runner = snap({ agents: [{ id: 'a', name: 'Alpha', provider: 'deepinfra' }, { id: 'b', name: 'Bravo', provider: 'deepinfra' }] });

  it('counts calls inside the window by UTC day and keeps the rest as total', () => {
    const start = NOW - 14 * DAY;
    const g = buildFleetGraph({
      agents: [A, B], messages: {}, local: null, runner, now: NOW,
      ledger: ledgerWith({ [dateOf(start - 5 * DAY)]: { a: 100 }, [dateOf(start - DAY)]: { a: 7 }, [dateOf(start)]: { a: 3 }, [dateOf(NOW)]: { a: 2 } }),
    });
    const e = g.edges.find((x) => x.id === `model:a>${providerNodeId('deepinfra')}`)!;
    expect(e.total).toBe(112);
    expect(e.count).toBe(5);
  });

  it('is dead with a ledger that reaches back, unknown with a young one', () => {
    const old = ledgerWith({ [dateOf(NOW - 30 * DAY)]: { b: 1 } });
    const young = ledgerWith({ [dateOf(NOW - 2 * DAY)]: { b: 1 } });
    const dead = buildFleetGraph({ agents: [A, B], messages: {}, local: null, runner, now: NOW, ledger: old });
    const unk = buildFleetGraph({ agents: [A, B], messages: {}, local: null, runner, now: NOW, ledger: young });
    expect(dead.edges.find((x) => x.id === `model:a>${providerNodeId('deepinfra')}`)!.state).toBe('dead');
    expect(unk.edges.find((x) => x.id === `model:a>${providerNodeId('deepinfra')}`)!.state).toBe('unknown');
  });

  it('web edges are declared for runner agents and never given a count', () => {
    const g = buildFleetGraph({ agents: [A, B], messages: {}, local: null, runner, now: NOW, ledger: EMPTY_LEDGER });
    const w = g.edges.find((x) => x.id === `web:a>${WEB_NODE_ID}`)!;
    expect(w.count).toBeNull();
    expect(w.state).toBe('unknown');
  });
});

describe('agent health: busiest, zero-call, unknown', () => {
  const runner = snap({ agents: [{ id: 'a', name: 'Alpha', provider: 'p' }, { id: 'b', name: 'Bravo', provider: 'p' }, { id: 'c', name: 'Charlie', provider: 'p' }] });
  const deep = (calls: Record<string, number>) => ledgerWith({ [dateOf(NOW - 30 * DAY)]: { a: 1 }, [dateOf(NOW - DAY)]: calls });
  const history = { room: [msg('0', 'a', 'old', NOW - 40 * DAY)] };

  it('names the three busiest and flags the zero-call agent when every source reaches back', () => {
    const g = buildFleetGraph({ agents: [A, B, C], messages: history, local: null, runner, now: NOW, ledger: deep({ a: 9, b: 5 }) });
    expect(g.busiest.map((n) => n.id)).toEqual(['a', 'b']);
    const c = g.nodes.find((n) => n.id === 'c')!;
    expect(c.health).toBe('zero');
    expect(g.zeroCall.map((n) => n.id)).toEqual(['c']);
  });

  it('does not call an agent zero-call when the sources cannot prove it', () => {
    const g = buildFleetGraph({ agents: [A, B, C], messages: {}, local: null, runner, now: NOW, ledger: EMPTY_LEDGER });
    expect(g.zeroCall).toHaveLength(0);
    expect(g.unknownHealth).toHaveLength(3);
  });

  it('an agent with no data anywhere is simply unknown, never throws', () => {
    const g = buildFleetGraph({ agents: [A], messages: {}, local: null, runner: null, now: NOW, ledger: EMPTY_LEDGER });
    expect(g.nodes[0].health).toBe('unknown');
    expect(g.edges).toHaveLength(0);
  });
});

describe('the real 106-agent fleet', () => {
  const agents = fleet.map((f) => mk(f.id, f.name));
  const runner = snap({
    agents: fleet.map((f) => ({ id: f.id, name: f.name, provider: 'deepinfra' })),
    jobs: fleet.slice(0, 40).map((f, i) => ({
      id: `job-${i}`, name: `Job ${i}`, schedule: { kind: 'interval' }, enabled: true, status: 'active', currentStageIndex: 0,
      stages: [{ stage: 'implement', agentId: f.id }, { stage: 'upgrade', agentId: fleet[(i + 1) % 106].id }],
      runs: [{ stage: 'implement', status: 'ok', startedAt: NOW - (i % 20) * DAY }], lastRunAt: null,
    })),
  });
  const ledger = ledgerWith({ [dateOf(NOW - 20 * DAY)]: { 'agent-orchestrator': 50 }, [dateOf(NOW - DAY)]: { 'agent-orchestrator': 400, 'agent-reviewer': 90, 'agent-atlas': 40 } });

  it('builds quickly and ranks the Orchestrator, Reviewer and Atlas as the busiest three', () => {
    const t = performance.now();
    const g = buildFleetGraph({ agents, messages: {}, local: null, runner, ledger, now: NOW });
    expect(performance.now() - t).toBeLessThan(500);
    expect(g.nodes.filter((n) => n.kind === 'agent')).toHaveLength(106);
    expect(g.busiest.map((n) => n.id).slice(0, 3)).toEqual(['agent-orchestrator', 'agent-reviewer', 'agent-atlas']);
  });
});
