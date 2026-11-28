import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, WorkspaceState } from '../types';
import { seedState } from '../data/mock';
import { mergeRunnerAgents } from '../store/useWorkspace';
import { BUILD_ROOM_ID, migrateToSessions } from './sessions';
import { createCronJob, type CronJob } from './scheduler';
import {
  buildAgentHome,
  deriveSkills,
  describeCron,
  describeInterval,
  timeAgo,
  timeUntil,
  type RunnerSnapshot,
} from './agentHome';
import { EMPTY_LEDGER, recordUsageDay } from './usageLedger';

const NOW = Date.UTC(2026, 10, 28, 12, 30, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const fleet: Array<{ id: string; name: string }> = JSON.parse(
  readFileSync(join(process.cwd(), 'agents-104-list.json'), 'utf-8'),
);

/** The live shape: seed agents + the full runner fleet merged in, an hourly job and room activity per agent. */
function liveFleet(): { state: WorkspaceState; runner: RunnerSnapshot } {
  const merged = mergeRunnerAgents(
    structuredClone(seedState),
    fleet.map((a) => ({ id: a.id, name: a.name, model: 'deepseek-ai/DeepSeek-V4-Flash-0731', provider: 'deepinfra', endpointUrl: 'http://127.0.0.1:8897/chat' })),
  );
  const room = [...(merged.messages[BUILD_ROOM_ID] ?? [])];
  const cronJobs: CronJob[] = [];
  fleet.forEach((a, i) => {
    room.push({
      id: `fleet-${i}`,
      conversationId: BUILD_ROOM_ID,
      authorType: 'agent',
      authorId: a.id,
      text: `Checked in: ${a.name} finished the hourly pass and found nothing blocking.`,
      createdAt: NOW - (1 + (i % 6)) * DAY,
      status: 'sent',
    });
    const job = createCronJob({ name: `Hourly: ${a.name}`, schedule: '0 * * * *', target: 'status', agentId: a.id, channelId: BUILD_ROOM_ID });
    cronJobs.push({ ...job, lastRunAt: NOW - 30 * 60_000, runs: [{ ts: NOW - 30 * 60_000, ok: true, detail: 'Hourly pass complete.' }] });
  });
  const state = migrateToSessions({ ...merged, messages: { ...merged.messages, [BUILD_ROOM_ID]: room } }, NOW);
  return { state, runner: { jobs: [], triggers: [], cronJobs, agents: [], channelMessages: [], fetchedAt: NOW } };
}

const home = (state: WorkspaceState, runner: RunnerSnapshot | null, agent: Agent) =>
  buildAgentHome({ agent, state, runner, local: null, ledger: EMPTY_LEDGER, rate: null, now: NOW });

describe('the Phase 1 gate: from any agent’s home, last session, next run and skills', () => {
  const { state, runner } = liveFleet();

  it('covers the whole 106-agent fleet', () => {
    expect(fleet).toHaveLength(106);
    for (const a of fleet) expect(state.agents.some((x) => x.id === a.id)).toBe(true);
  });

  it('every agent’s home has a last session and a next scheduled run', () => {
    for (const { id } of fleet) {
      const agent = state.agents.find((a) => a.id === id)!;
      const h = home(state, runner, agent);
      expect(h.lastSession, `${agent.name} lastSession`).not.toBeNull();
      expect(h.lastSession!.messageCount).toBeGreaterThan(0);
      expect(h.nextTrigger?.nextAt, `${agent.name} next run`).toBeGreaterThan(NOW);
    }
  });

  it('three arbitrary agents: last session, next run and skills are all reachable on the home model', () => {
    for (const id of [fleet[7].id, fleet[58].id, fleet[103].id]) {
      const agent = state.agents.find((a) => a.id === id)!;
      const h = home(state, runner, agent);
      expect(h.lastSession).not.toBeNull();
      expect(h.nextTrigger?.when).toBe('every hour');
      expect(h.skills).toBeInstanceOf(Array);
      expect(h.warmth.last.length).toBeGreaterThan(10);
      expect(h.warmth.next).toContain('Next, I’ll run');
    }
  });

  it('a runner-only agent shows its role as a skill once the endpoint supplies it, and an honest empty list before', () => {
    const only = fleet.find((a) => !seedState.agents.some((s) => s.id === a.id))!;
    const bare = state.agents.find((a) => a.id === only.id)!;
    expect(deriveSkills(bare)).toEqual([]);
    const withRole = mergeRunnerAgents(state, [{ id: only.id, name: only.name, endpointUrl: 'http://127.0.0.1:8897/chat', role: 'You are the Pricing Strategist for mem20.' }]);
    expect(deriveSkills(withRole.agents.find((a) => a.id === only.id)!)).toEqual([
      { label: 'You are the Pricing Strategist for mem20.', source: 'instructions' },
    ]);
  });
});

describe('warmth: plain words for last and next', () => {
  const { state, runner } = liveFleet();
  const atlas = state.agents.find((a) => a.id === 'agent-atlas')!;

  it('says what the agent did last and when it runs next', () => {
    const h = home(state, runner, atlas);
    expect(h.warmth.last).toMatch(/^I last ran “Hourly: Atlas” 30 minutes ago — Hourly pass complete\.$/);
    // The cron scheduler reads the host clock's local time, so assert the shape, not the hour.
    expect(h.warmth.next).toMatch(/^Next, I’ll run “Hourly: Atlas” in \d+ (?:minutes?|hours?) \(\d\d:\d\d\), every hour\.$/);
  });

  it('with no schedule and no activity, says so plainly', () => {
    const lone: Agent = { ...atlas, id: 'agent-lone', name: 'Lone' };
    const s: WorkspaceState = { ...state, agents: [...state.agents, lone] };
    const h = home(s, null, lone);
    expect(h.warmth.last).toBe('I haven’t done anything yet. Start a session with me and it will show up here.');
    expect(h.warmth.next).toBe('Nothing is scheduled for me. I act when someone asks, or when the Orchestrator assigns me work.');
  });

  it('reports a failed run as failed', () => {
    const failing: RunnerSnapshot = {
      ...runner,
      cronJobs: runner.cronJobs.map((j) => (j.agentId === 'agent-atlas' ? { ...j, runs: [{ ts: NOW - 5 * 60_000, ok: false, detail: 'upstream 429' }] } : j)),
    };
    expect(home(state, failing, atlas).warmth.last).toContain('failed 5 minutes ago — upstream 429');
  });

  it('a paused or approval-gated schedule is not presented as upcoming', () => {
    const paused: RunnerSnapshot = { ...runner, cronJobs: runner.cronJobs.map((j) => (j.agentId === 'agent-atlas' ? { ...j, enabled: false } : j)) };
    const h = home(state, paused, atlas);
    expect(h.nextTrigger?.nextAt).toBeNull();
    expect(h.warmth.next).toContain('paused');
  });
});

describe('home sections', () => {
  const { state, runner } = liveFleet();
  const atlas = state.agents.find((a) => a.id === 'agent-atlas')!;

  it('gathers status, model, sessions, triggers, skills, tools, connections, runs and cost', () => {
    const withTools: Agent = { ...atlas, enabledTools: ['calculator', 'not-a-tool'] };
    const ledger = recordUsageDay(EMPTY_LEDGER, {
      date: '2026-11-28',
      byAgent: { 'agent-atlas': { calls: 4, promptTokens: 2_000_000, completionTokens: 500_000, totalTokens: 2_500_000 } },
    });
    const h = buildAgentHome({
      agent: withTools,
      state,
      runner: { ...runner, agents: [{ id: 'agent-atlas', name: 'Atlas', provider: 'deepinfra' }] },
      local: null,
      ledger,
      rate: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
      now: NOW,
    });
    expect(h.status).toMatchObject({ tone: 'ok', label: 'Ready' });
    expect(h.model).toBe(atlas.model);
    expect(h.sessions.length).toBeGreaterThan(0);
    expect(h.triggers).toHaveLength(1);
    expect(h.skills.map((s) => s.label)).toContain('TypeScript');
    expect(h.tools.map((t) => t.id)).toEqual(['calculator', 'not-a-tool']);
    expect(h.connections).toEqual(expect.arrayContaining([{ label: 'Model provider', detail: 'deepinfra' }]));
    expect(h.recentRuns[0]).toMatchObject({ title: 'Hourly: Atlas', outcome: 'ok' });
    expect(h.cost.tokensLabel).toBe('2.5M tokens · 4 calls');
    expect(h.cost.dollars).toBeCloseTo(0.4, 5);
    expect(h.cost.dollarsLabel).toBe('$0.40');
  });

  it('shows tokens but no dollars until a rate is set', () => {
    const h = home(state, runner, atlas);
    expect(h.cost.dollars).toBeNull();
    expect(h.cost.dollarsLabel).toBeNull();
  });

  it('flags an interrupted session in the status', () => {
    const s: WorkspaceState = {
      ...state,
      conversations: state.conversations.map((c) => (c.session?.agentId === 'agent-atlas' && c.session.kind === 'chat' ? { ...c, session: { ...c.session, status: 'interrupted' as const } } : c)),
    };
    expect(home(s, runner, atlas).status.label).toBe('Interrupted');
  });
});

describe('plain-words helpers', () => {
  it('describes cron expressions', () => {
    expect(describeCron('0 * * * *')).toBe('every hour');
    expect(describeCron('*/15 * * * *')).toBe('every 15 minutes');
    expect(describeCron('0 */6 * * *')).toBe('every 6 hours');
    expect(describeCron('0 8 * * *')).toBe('every day at 08:00');
    expect(describeCron('30 7 * * 1-5')).toBe('07:30 on days 1-5 of the week');
    expect(describeCron('bad')).toBe('on schedule bad');
    expect(describeInterval(15 * 60_000)).toBe('every 15 minutes');
  });
  it('describes time', () => {
    expect(timeAgo(NOW - 20_000, NOW)).toBe('just now');
    expect(timeAgo(NOW - 3 * HOUR, NOW)).toBe('3 hours ago');
    expect(timeAgo(NOW - 1 * DAY, NOW)).toBe('yesterday');
    expect(timeUntil(NOW + 38 * 60_000, NOW)).toBe('in 38 minutes');
    expect(timeUntil(NOW + 2 * DAY, NOW)).toBe('in 2 days');
  });
});
