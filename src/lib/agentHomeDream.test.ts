import { describe, expect, it } from 'vitest';
import type { Agent, WorkspaceState } from '../types';
import { createCronJob } from './scheduler';
import { buildAgentHome, type RunnerSnapshot } from './agentHome';
import { DREAM_CRON, EMPTY_DREAM, enableDream, runnerDreamJobId, type DreamReport, type DreamState } from './dream';
import { EMPTY_LEDGER } from './usageLedger';

const NOW = new Date(2026, 10, 28, 12, 30, 0).getTime();
const HOUR = 3_600_000;
const mk = (id: string, name: string): Agent => ({ id, name, emoji: '🙂', accent: '#888', status: 'online', endpointUrl: 'http://x', model: 'm', systemPrompt: '', skills: [] } as unknown as Agent);
const orch = mk('agent-orchestrator', 'Orchestrator');
const planner = mk('agent-daily-planner', 'Daily Planner');
const state: Pick<WorkspaceState, 'conversations' | 'messages'> = { conversations: [], messages: {} };
const home = (agent: Agent, dream?: DreamState, runner: RunnerSnapshot | null = null) =>
  buildAgentHome({ agent, state, runner, local: null, ledger: EMPTY_LEDGER, rate: null, now: NOW, dream });

const report = (id: string, at: number, changed: boolean): DreamReport => ({
  id, agentId: orch.id, at, slot: at, source: 'tab', changed, summary: changed ? 'Found a repeat mistake.' : 'Nothing to change.',
  findings: [], proposals: changed ? [{ target: 'instructions', change: 'c', why: 'w' }] : [], reviewed: { sessions: 1, messages: 2, sinceAt: at - HOUR },
});

describe('the Dream card on the agent home', () => {
  it('is closed to non-starter agents, with no trigger and no skill added', () => {
    const h = home(planner, enableDreamSafe());
    expect(h.dream).toMatchObject({ enrollable: false, enabled: false });
    expect(h.triggers.some((t) => t.source === 'dream')).toBe(false);
    expect(h.skills.some((s) => s.source === 'dream')).toBe(false);
  });

  it('an enrolled starter gets a Dream trigger with a next slot, and the Dream skill', () => {
    const h = home(orch, enableDream(EMPTY_DREAM, orch.id, NOW - 7 * HOUR));
    expect(h.dream).toMatchObject({ enrollable: true, enabled: true, cron: DREAM_CRON, cadenceLabel: 'Every 6 hours' });
    const t = h.triggers.find((x) => x.source === 'dream')!;
    expect(t).toMatchObject({ name: 'Dream', enabled: true });
    expect(t.nextAt).toBeGreaterThan(NOW);
    expect(h.skills.some((s) => s.source === 'dream')).toBe(true);
    expect(h.warmth.next).toContain('Dream');
  });

  it('pins the newest report, keeps the rest as history, and lists unread notices', () => {
    const s: DreamState = {
      ...enableDream(EMPTY_DREAM, orch.id, NOW - 30 * HOUR),
      reports: [report('r1', NOW - 20 * HOUR, false), report('r2', NOW - 2 * HOUR, true)],
      notices: [{ id: 'n', agentId: orch.id, reportId: 'r2', at: NOW - 2 * HOUR, read: false }],
    };
    const d = home(orch, s).dream;
    expect(d.pinned?.id).toBe('r2');
    expect(d.history.map((r) => r.id)).toEqual(['r1']);
    expect(d.unread).toHaveLength(1);
  });

  it('counts the runner’s Dream cron runs in the same planned / ran / skipped / failed format', () => {
    const job = createCronJob({ name: 'Dream: Orchestrator', schedule: DREAM_CRON, target: 'dream', agentId: orch.id, channelId: 'conv-build-room' });
    const runner: RunnerSnapshot = {
      jobs: [], triggers: [], agents: [], channelMessages: [], fetchedAt: NOW,
      cronJobs: [{ ...job, id: runnerDreamJobId(orch.id), runs: [{ ts: NOW - 12 * HOUR, ok: true }, { ts: NOW - 6 * HOUR, ok: false, detail: 'timed out' }, { ts: NOW - 5 * 60_000, ok: true }] }],
    };
    const h = home(orch, undefined, runner);
    expect(h.dream.runnerJob).toBe(true);
    expect(h.dream.counts).toMatchObject({ planned: 3, ran: 2, failed: 1, missed: 0 });
    expect(h.triggers.filter((t) => /dream/i.test(t.name))).toHaveLength(1);
    expect(h.triggers.some((t) => t.source === 'dream')).toBe(true);
  });

  it('with no Dream anywhere, the card model is inert', () => {
    const d = home(orch).dream;
    expect(d).toMatchObject({ enabled: false, runnerJob: false, pinned: null });
    expect(d.counts.planned).toBe(0);
  });
});

function enableDreamSafe(): DreamState {
  return { ...EMPTY_DREAM, config: { [planner.id]: { enabled: true, cron: DREAM_CRON, enabledAt: NOW - HOUR } } };
}
