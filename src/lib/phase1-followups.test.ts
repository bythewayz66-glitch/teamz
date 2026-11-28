import { describe, expect, it } from 'vitest';
import type { Agent, WorkspaceState } from '../types';
import { seedState } from '../data/mock';
import { createCronJob, type CronJob } from './scheduler';
import {
  BUILD_ROOM_ID,
  applyRetention,
  foldRoomIntoSessions,
  migrateToSessions,
  newChatSession,
  patchSession,
  weekKey,
  workSessionId,
} from './sessions';
import { searchWorkspace } from './search';
import {
  buildAgentHome,
  buildRunRecord,
  buildWarmth,
  filterSessions,
  modelLabel,
  type HomeSession,
  type RunnerSnapshot,
} from './agentHome';
import { EMPTY_LEDGER } from './usageLedger';

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const DAY = 86_400_000;

const base = (): WorkspaceState => migrateToSessions(structuredClone(seedState), NOW);
const agentOf = (s: WorkspaceState, id: string): Agent => s.agents.find((a) => a.id === id)!;

describe('starred sessions and per-agent retention defaults', () => {
  it('a starred session is never pruned, even when its policy would drop everything', () => {
    const s0 = base();
    const chat = newChatSession({ id: 'agent-atlas' }, 'sess-s', NOW - 100 * DAY);
    chat.session!.retention = { mode: 'days', days: 1 };
    const msgs = [{ id: 'm1', conversationId: 'sess-s', authorType: 'user' as const, text: 'old', createdAt: NOW - 90 * DAY, status: 'sent' as const }];
    const s = { ...s0, conversations: [chat, ...s0.conversations], messages: { ...s0.messages, 'sess-s': msgs } };
    expect(applyRetention(s, NOW).messages['sess-s']).toHaveLength(0);
    const starred = patchSession(s, 'sess-s', { starred: true });
    expect(applyRetention(starred, NOW)).toBe(starred);
  });

  it('a starred work session survives emptying out', () => {
    let s = base();
    s = { ...s, messages: { ...s.messages, [BUILD_ROOM_ID]: [{ id: 'w1', conversationId: BUILD_ROOM_ID, authorType: 'agent', authorId: 'agent-atlas', text: 'x', createdAt: NOW - 10 * DAY, status: 'sent' }] } };
    s = foldRoomIntoSessions(s, NOW);
    const id = workSessionId('agent-atlas', weekKey(NOW - 10 * DAY));
    s = patchSession(s, id, { starred: true, retention: { mode: 'days', days: 1 } });
    expect(applyRetention(s, NOW).conversations.some((c) => c.id === id)).toBe(true);
  });

  it('new sessions take the agent’s own default retention', () => {
    const atlas: Agent = { ...agentOf(base(), 'agent-atlas'), sessionRetention: { mode: 'days', days: 30 } };
    expect(newChatSession(atlas, 'sess-d', NOW).session!.retention).toEqual({ mode: 'days', days: 30 });
    expect(newChatSession({ id: 'agent-atlas' }, 'sess-e', NOW).session!.retention).toEqual({ mode: 'forever' });
  });

  it('work sessions folded from the room use the agent default, and its window', () => {
    // Un-migrated state, so Atlas has no work session yet and the fold creates it.
    let s = structuredClone(seedState);
    s = { ...s, agents: s.agents.map((a) => (a.id === 'agent-atlas' ? { ...a, sessionRetention: { mode: 'days' as const, days: 5 } } : a)) };
    s = {
      ...s,
      messages: {
        ...s.messages,
        [BUILD_ROOM_ID]: [
          { id: 'old', conversationId: BUILD_ROOM_ID, authorType: 'agent', authorId: 'agent-atlas', text: 'old', createdAt: NOW - 20 * DAY, status: 'sent' },
          { id: 'new', conversationId: BUILD_ROOM_ID, authorType: 'agent', authorId: 'agent-atlas', text: 'new', createdAt: NOW - 1 * DAY, status: 'sent' },
        ],
      },
    };
    const next = foldRoomIntoSessions(s, NOW);
    const sess = next.conversations.find((c) => c.id === workSessionId('agent-atlas', weekKey(NOW - 1 * DAY)))!;
    expect(sess.session!.retention).toEqual({ mode: 'days', days: 5 });
    expect(next.conversations.some((c) => c.id === workSessionId('agent-atlas', weekKey(NOW - 20 * DAY)))).toBe(false);
  });
});

describe('palette opens on recent agents, then recent sessions', () => {
  it('lists agents with their last-active time before sessions', () => {
    const r = searchWorkspace(base(), '', { now: NOW + 2 * 3_600_000 });
    const groups = r.map((x) => x.group);
    expect(groups.indexOf('agent')).toBe(0);
    expect(groups.indexOf('agent')).toBeLessThan(groups.indexOf('session'));
    expect(r[0].subtitle).toMatch(/^Last active /);
    expect(r.filter((x) => x.group === 'agent').length).toBeLessThanOrEqual(5);
  });
});

describe('searching and sorting one agent’s sessions', () => {
  const mk = (name: string, lastAt: number, text: string): HomeSession => ({
    id: name, name, kind: 'chat', status: 'active', lastAt, messageCount: 1, preview: '', retention: '', starred: false, text: `${name} ${text}`.toLowerCase(),
  });
  const list = [mk('Beta plan', 2, 'rollback steps'), mk('Alpha', 3, 'zebra checksum'), mk('Gamma', 1, 'nothing')];
  it('matches words anywhere in the name or messages', () => {
    expect(filterSessions(list, 'checksum zebra', 'recent').map((s) => s.name)).toEqual(['Alpha']);
    expect(filterSessions(list, 'qqq', 'recent')).toEqual([]);
  });
  it('sorts by recency or by name', () => {
    expect(filterSessions(list, '', 'recent').map((s) => s.name)).toEqual(['Alpha', 'Beta plan', 'Gamma']);
    expect(filterSessions(list, '', 'name').map((s) => s.name)).toEqual(['Alpha', 'Beta plan', 'Gamma']);
    expect(filterSessions([mk('b', 9, ''), mk('a', 1, '')], '', 'name').map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('run record in Gamut’s plain format', () => {
  const at = (h: number) => new Date(2026, 10, 28, h, 0, 0).getTime();
  const now = new Date(2026, 10, 28, 12, 30, 0).getTime();
  const job = (runs: CronJob['runs'], name = 'Hourly: Atlas'): CronJob => ({
    ...createCronJob({ name, schedule: '0 * * * *', target: 't', agentId: 'agent-atlas' }),
    runs,
  });
  const snap = (jobs: CronJob[]): RunnerSnapshot => ({ jobs: [], triggers: [], cronJobs: jobs, agents: [], channelMessages: [], fetchedAt: now });

  it('counts planned, ran, skipped and failed from the first recorded run', () => {
    const rec = buildRunRecord('agent-atlas', snap([job([{ ts: at(9), ok: true }, { ts: at(10), ok: false }, { ts: at(12), ok: true }])]), null, now)!;
    expect(rec).toMatchObject({ planned: 4, ran: 2, failed: 1, skipped: 1 });
    expect(rec.sentence).toBe('Last 7 days: 4 planned runs, 2 ran, 1 skipped, and 1 failed.');
  });

  it('does not call a schedule with nothing on record “skipped”', () => {
    const rec = buildRunRecord('agent-atlas', snap([job([])]), null, now)!;
    expect(rec.planned).toBe(0);
    expect(rec.skipped).toBe(0);
    expect(rec.noRecord).toEqual(['Hourly: Atlas']);
  });

  it('ignores runs older than seven days and returns null with no schedule', () => {
    const stale = buildRunRecord('agent-atlas', snap([job([{ ts: now - 9 * DAY, ok: true }])]), null, now)!;
    expect(stale.noRecord).toHaveLength(1);
    expect(buildRunRecord('agent-nobody', snap([job([])]), null, now)).toBeNull();
  });

  it('singular grammar for one planned run', () => {
    const rec = buildRunRecord('agent-atlas', snap([job([{ ts: at(12), ok: true }])]), null, now)!;
    expect(rec.sentence).toBe('Last 7 days: 1 planned run, 1 ran, 0 skipped, and 0 failed.');
  });
});

describe('model display', () => {
  it('drops the vendor prefix but keeps the full id available', () => {
    expect(modelLabel('deepseek-ai/DeepSeek-V4-Flash-0731')).toBe('DeepSeek-V4-Flash-0731');
    expect(modelLabel('openai-fast')).toBe('openai-fast');
    const s = base();
    const atlas: Agent = { ...agentOf(s, 'agent-atlas'), maxIterations: 25 };
    const h = buildAgentHome({ agent: atlas, state: s, runner: null, local: null, ledger: EMPTY_LEDGER, rate: null, now: NOW });
    expect(h.modelLabel).toBe('DeepSeek-V4-Flash-0731');
    expect(h.model).toBe('deepseek-ai/DeepSeek-V4-Flash-0731');
    expect(h.stepLimit).toBe(25);
    expect(buildAgentHome({ agent: agentOf(s, 'agent-scout'), state: s, runner: null, local: null, ledger: EMPTY_LEDGER, rate: null, now: NOW }).stepLimit).toBeNull();
  });
});

describe('the Reviewer is never spoken as', () => {
  const FIRST_PERSON = /\b(I|I’ll|I’m|my|me|My)\b/;
  const s = base();
  const home = (id: string) => buildAgentHome({ agent: agentOf(s, id), state: s, runner: null, local: null, ledger: EMPTY_LEDGER, rate: null, now: NOW });

  it('the Reviewer’s home sentences are third person', () => {
    const w = home('agent-reviewer').warmth;
    expect(w.last).not.toMatch(FIRST_PERSON);
    expect(w.next).not.toMatch(FIRST_PERSON);
    expect(w.next).toBe('Nothing is scheduled for Reviewer. It acts when someone asks, or when the Orchestrator assigns it work.');
  });

  it('every voice variant stays third person for the Reviewer', () => {
    const run = [{ id: 'r', at: NOW - 60_000, title: 'Review sweep', outcome: 'failed' as const, detail: 'upstream 429' }];
    const trig = { id: 't', name: 'Sweep', when: 'every hour', nextAt: NOW + 3_600_000, lastAt: null, enabled: true, source: 'cron' as const };
    const voice = { name: 'Reviewer', third: true };
    for (const w of [
      buildWarmth(null, [], null, true, NOW, voice),
      buildWarmth(null, run, trig, false, NOW, voice),
      buildWarmth(null, [{ ...run[0], outcome: 'ok' }], { ...trig, nextAt: null, note: 'paused' }, false, NOW, voice),
    ]) {
      expect(w.last).not.toMatch(FIRST_PERSON);
      expect(w.next).not.toMatch(FIRST_PERSON);
    }
  });

  it('ordinary agents keep the first-person voice', () => {
    expect(home('agent-atlas').warmth.next).toBe('Nothing is scheduled for me. I act when someone asks, or when the Orchestrator assigns me work.');
  });
});
