import { describe, expect, it } from 'vitest';
import type { Agent, Message, WorkspaceState } from '../types';
import { newChatSession } from './sessions';
import {
  DREAM_CRON,
  composeDreamPrompt,
  buildReviewInput,
  disableDream,
  enableDream,
  executeDream,
  ingestRunnerReports,
  isDreamEnrollable,
  parseDreamReply,
  parseDreamState,
  planDreams,
  runnerDreamJobId,
  runnerSlotEntries,
  setDreamCadence,
  slotsBetween,
  summarizeDream,
  validateCadence,
  EMPTY_DREAM,
  markNoticesRead,
  type DreamState,
  type PlanContext,
} from './dream';

const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 28, 12, 30, 0).getTime();
const ORCH = 'agent-orchestrator';

const agent = { id: ORCH, name: 'Orchestrator' } as Agent;
const msg = (id: string, text: string, at: number, who: 'user' | 'agent' = 'user'): Message => ({
  id, conversationId: 'c1', authorType: who, authorId: who === 'agent' ? ORCH : undefined, text, createdAt: at, status: 'sent',
});

function workspace(messages: Message[]): WorkspaceState {
  const conv = newChatSession(agent, 'c1', NOW - 48 * HOUR, 'Triage chat');
  return {
    agents: [agent],
    conversations: [conv],
    messages: { c1: messages },
    filters: {},
    activeConversationId: 'c1',
  };
}

const live: PlanContext = { providerLive: true, activity: () => ({ sessions: 1, messages: 3 }) };
const goodReply = JSON.stringify({
  changed: true,
  summary: 'I double-assigned the same brief twice.',
  findings: ['Assigned @atlas twice at 09:10 and 09:40'],
  proposals: [{ target: 'instructions', change: 'Check room_read before assigning', why: 'Two identical assignments in "Triage chat"' }],
});
const nothingReply = JSON.stringify({ changed: false, summary: 'Nothing to change; the last sessions were routine.', findings: [], proposals: [] });

describe('parseDreamReply — a reply is a report or it is a failure', () => {
  it('accepts a strict report, bare or fenced or wrapped in prose', () => {
    expect(parseDreamReply(goodReply)).toMatchObject({ ok: true, changed: true });
    expect(parseDreamReply('```json\n' + nothingReply + '\n```')).toMatchObject({ ok: true, changed: false });
    expect(parseDreamReply(`Here is my review:\n${nothingReply}\nThanks.`)).toMatchObject({ ok: true, changed: false });
  });

  it('rejects empty, prose-only and refusal-shaped replies', () => {
    expect(parseDreamReply('')).toMatchObject({ ok: false });
    expect(parseDreamReply('All good, nothing to report!')).toMatchObject({ ok: false, reason: expect.stringMatching(/not a Dream report/) });
    for (const refusal of [
      "I'm sorry, but I can't help with that.",
      'Insufficient credits. Please top up your account.',
      'HTTP 429: rate limit exceeded, too many requests',
      'As an AI language model I cannot review sessions.',
    ]) {
      expect(parseDreamReply(refusal)).toMatchObject({ ok: false, reason: expect.stringMatching(/refusal or provider error/) });
    }
  });

  it('rejects a valid-shaped object whose summary is a refusal', () => {
    const r = parseDreamReply(JSON.stringify({ changed: false, summary: "I'm sorry, I cannot do that.", findings: [], proposals: [] }));
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/refusal/) });
  });

  it('enforces the changed/proposals contract', () => {
    expect(parseDreamReply(JSON.stringify({ changed: true, summary: 's', findings: [], proposals: [] }))).toMatchObject({ ok: false });
    expect(
      parseDreamReply(JSON.stringify({ changed: false, summary: 's', findings: [], proposals: [{ target: 'tools', change: 'x', why: 'y' }] })),
    ).toMatchObject({ ok: false });
    expect(parseDreamReply(JSON.stringify({ summary: 's', findings: [], proposals: [] }))).toMatchObject({ ok: false });
    expect(parseDreamReply(JSON.stringify({ changed: false, findings: [], proposals: [] }))).toMatchObject({ ok: false });
    expect(parseDreamReply(JSON.stringify({ changed: false, summary: 's', findings: 'nope', proposals: [] }))).toMatchObject({ ok: false });
  });

  it('turns an unknown proposal target into "other" rather than dropping the proposal', () => {
    const r = parseDreamReply(JSON.stringify({ changed: true, summary: 's', findings: [], proposals: [{ target: 'weather', change: 'c', why: 'w' }] }));
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.proposals[0].target).toBe('other');
  });
});

describe('cadence', () => {
  it('accepts hourly or slower and rejects faster or invalid schedules', () => {
    expect(validateCadence(DREAM_CRON)).toBeNull();
    expect(validateCadence('0 * * * *')).toBeNull();
    expect(validateCadence('*/15 * * * *')).toMatch(/at most hourly/);
    expect(validateCadence('nope')).toMatch(/5 fields/);
  });

  it('enumerates the 6-hourly slots in a window', () => {
    const slots = slotsBetween(DREAM_CRON, NOW - 24 * HOUR, NOW);
    expect(slots).toHaveLength(4);
    expect(slots[3] - slots[2]).toBe(6 * HOUR);
    expect(slots.every((s) => new Date(s).getMinutes() === 0)).toBe(true);
  });
});

describe('enrolment', () => {
  it('only the three starter agents can be enrolled', () => {
    expect(['agent-orchestrator', 'agent-reviewer', 'agent-website-currency-agent'].every(isDreamEnrollable)).toBe(true);
    expect(isDreamEnrollable('agent-daily-planner')).toBe(false);
    expect(() => enableDream(EMPTY_DREAM, 'agent-daily-planner', NOW)).toThrow(/starter agents/);
  });

  it('enable is idempotent, disable keeps history, cadence change replans from now', () => {
    const on = enableDream(EMPTY_DREAM, ORCH, NOW);
    expect(enableDream(on, ORCH, NOW + HOUR)).toBe(on);
    expect(on.config[ORCH]).toMatchObject({ enabled: true, cron: DREAM_CRON, enabledAt: NOW });
    expect(setDreamCadence(on, ORCH, '0 */12 * * *', NOW + HOUR).config[ORCH].enabledAt).toBe(NOW + HOUR);
    expect(() => setDreamCadence(on, ORCH, '*/5 * * * *', NOW)).toThrow();
    expect(() => setDreamCadence(EMPTY_DREAM, ORCH, DREAM_CRON, NOW)).toThrow(/switch Dream on/i);
    expect(disableDream(on, ORCH).config[ORCH].enabled).toBe(false);
    expect(disableDream(EMPTY_DREAM, ORCH)).toBe(EMPTY_DREAM);
  });
});

describe('planDreams — every slot ends up with a record or a due Dream', () => {
  const enabledAt = NOW - 30 * HOUR;
  const base = (): DreamState => ({ ...EMPTY_DREAM, config: { [ORCH]: { enabled: true, cron: DREAM_CRON, enabledAt } } });

  it('runs the latest slot once and records the folded earlier slots as skipped with a reason', () => {
    const { state, due } = planDreams(base(), NOW, live);
    const slots = slotsBetween(DREAM_CRON, enabledAt, NOW);
    expect(slots.length).toBeGreaterThanOrEqual(5);
    expect(due).toEqual([{ agentId: ORCH, slot: slots[slots.length - 1], sinceAt: NOW - 24 * HOUR }]);
    const skipped = state.records.filter((r) => r.outcome === 'skipped');
    expect(skipped).toHaveLength(slots.length - 1);
    expect(skipped.every((r) => /not open/.test(r.reason ?? ''))).toBe(true);
  });

  it('skips with a reason, and makes no call, when there is nothing new to review', () => {
    const { state, due } = planDreams(base(), NOW, { providerLive: true, activity: () => ({ sessions: 0, messages: 0 }) });
    expect(due).toEqual([]);
    const last = state.records[state.records.length - 1];
    expect(last).toMatchObject({ outcome: 'skipped' });
    expect(last.reason).toMatch(/nothing to review/);
  });

  it('skips with a reason in mock mode: no fake Dream is ever produced', () => {
    const { state, due } = planDreams(base(), NOW, { providerLive: false, activity: () => ({ sessions: 1, messages: 9 }) });
    expect(due).toEqual([]);
    expect(state.records[state.records.length - 1].reason).toMatch(/mock mode/);
  });

  it('does not plan a disabled agent, a recorded slot, or an in-flight slot', () => {
    expect(planDreams(disableDream(base(), ORCH), NOW, live).due).toEqual([]);
    const once = planDreams(base(), NOW, live);
    const done = { ...once.state, records: [...once.state.records, { agentId: ORCH, slot: once.due[0].slot, outcome: 'ran' as const, at: NOW, source: 'tab' as const }] };
    expect(planDreams(done, NOW, live).due).toEqual([]);
    expect(planDreams(base(), NOW, live, new Set([`${ORCH}:${once.due[0].slot}`])).due).toEqual([]);
  });

  it('after a successful Dream, the next one reviews from that Dream onwards', () => {
    const slots = slotsBetween(DREAM_CRON, enabledAt, NOW);
    const withRan: DreamState = {
      ...base(),
      records: slots.slice(0, -1).map((s) => ({ agentId: ORCH, slot: s, outcome: 'ran' as const, at: s + 60_000, source: 'tab' as const })),
    };
    const { due } = planDreams(withRan, NOW, live);
    expect(due[0].sinceAt).toBe(slots[slots.length - 2] + 60_000);
  });
});

describe('executeDream — success, nothing to change, and failure paths', () => {
  const enabledAt = NOW - 7 * HOUR;
  const state0 = (): DreamState => ({ ...EMPTY_DREAM, config: { [ORCH]: { enabled: true, cron: DREAM_CRON, enabledAt } } });
  const run = async (reply: string | Error) => {
    const { state, due } = planDreams(state0(), NOW, live);
    const ws = workspace([msg('m1', 'Please triage the room', NOW - 3 * HOUR), msg('m2', 'Assigned Atlas.', NOW - 2 * HOUR, 'agent')]);
    const review = buildReviewInput(ws, agent, due[0].sinceAt);
    return executeDream({
      state, due: due[0], agent, review, now: () => NOW,
      send: async () => { if (reply instanceof Error) throw reply; return reply; },
    });
  };

  it('a changed Dream pins a report with proposals and raises a notice', async () => {
    const r = await run(goodReply);
    expect(r.record.outcome).toBe('ran');
    expect(r.report).toMatchObject({ changed: true, source: 'tab', reviewed: { sessions: 1, messages: 2 } });
    expect(r.state.reports).toHaveLength(1);
    expect(r.state.notices).toEqual([expect.objectContaining({ agentId: ORCH, read: false })]);
  });

  it('an honest "nothing to change" is a ran report with no notice', async () => {
    const r = await run(nothingReply);
    expect(r.record.outcome).toBe('ran');
    expect(r.report?.changed).toBe(false);
    expect(r.state.notices).toEqual([]);
  });

  it('refusal-as-success is a FAILED run with no report and no notice', async () => {
    for (const bad of ["I'm sorry, I can't do that.", 'Out of credits. Add credits to continue.', 'Done! Everything looks fine.', '']) {
      const r = await run(bad);
      expect(r.record.outcome).toBe('failed');
      expect(r.record.reason).toBeTruthy();
      expect(r.report).toBeNull();
      expect(r.state.reports).toEqual([]);
      expect(r.state.notices).toEqual([]);
    }
  });

  it('a thrown model error is a failed run carrying the error', async () => {
    const r = await run(new Error('HTTP 402 from the provider'));
    expect(r.record).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('HTTP 402') });
  });

  it('a retried slot replaces its record instead of duplicating it', async () => {
    const first = await run('nope');
    const again = await executeDream({
      state: first.state, due: { agentId: ORCH, slot: first.record.slot, sinceAt: NOW - 24 * HOUR }, agent,
      review: buildReviewInput(workspace([msg('m1', 'x', NOW - HOUR)]), agent, NOW - 24 * HOUR), now: () => NOW, send: async () => nothingReply,
    });
    expect(again.state.records.filter((x) => x.slot === first.record.slot)).toHaveLength(1);
    expect(again.record.outcome).toBe('ran');
  });
});

describe('summarizeDream — planned / ran / skipped / failed, with nothing unexplained', () => {
  it('a normal day: 4 planned slots, each accounted for', async () => {
    let s: DreamState = { ...EMPTY_DREAM, config: { [ORCH]: { enabled: true, cron: DREAM_CRON, enabledAt: NOW - 24 * HOUR } } };
    const slots = slotsBetween(DREAM_CRON, NOW - 24 * HOUR, NOW);
    s = { ...s, records: [
      { agentId: ORCH, slot: slots[0], outcome: 'ran', at: slots[0], source: 'tab', reportId: 'r' },
      { agentId: ORCH, slot: slots[1], outcome: 'skipped', at: slots[1], source: 'tab', reason: 'nothing to review' },
      { agentId: ORCH, slot: slots[2], outcome: 'failed', at: slots[2], source: 'tab', reason: 'HTTP 402' },
      { agentId: ORCH, slot: slots[3], outcome: 'ran', at: slots[3], source: 'tab', reportId: 'r2' },
    ] };
    const { counts } = summarizeDream(s, ORCH, NOW);
    expect(counts).toEqual({ planned: 4, ran: 2, skipped: 1, failed: 1, missed: 0, pending: 0 });
  });

  it('an old slot with no record is `missed` (unexplained); a fresh one is pending', () => {
    const s: DreamState = { ...EMPTY_DREAM, config: { [ORCH]: { enabled: true, cron: DREAM_CRON, enabledAt: NOW - 12 * HOUR } } };
    const { counts } = summarizeDream(s, ORCH, NOW);
    expect(counts.missed).toBeGreaterThan(0);
    const justAfterSlot = slotsBetween(DREAM_CRON, NOW - 12 * HOUR, NOW).pop()! + 2 * 60_000;
    expect(summarizeDream(s, ORCH, justAfterSlot).counts.pending).toBe(1);
  });

  it('switching Dream off does not turn the slots after it into misses', () => {
    const s: DreamState = disableDream({ ...EMPTY_DREAM, config: { [ORCH]: { enabled: true, cron: DREAM_CRON, enabledAt: NOW - 24 * HOUR } } }, ORCH);
    expect(summarizeDream(s, ORCH, NOW).counts).toEqual({ planned: 0, ran: 0, skipped: 0, failed: 0, missed: 0, pending: 0 });
  });

  it('plan → execute leaves zero missed slots', async () => {
    let s: DreamState = { ...EMPTY_DREAM, config: { [ORCH]: { enabled: true, cron: DREAM_CRON, enabledAt: NOW - 30 * HOUR } } };
    const planned = planDreams(s, NOW, live);
    s = planned.state;
    const ws = workspace([msg('m1', 'hello', NOW - 2 * HOUR)]);
    const done = await executeDream({ state: s, due: planned.due[0], agent, review: buildReviewInput(ws, agent, planned.due[0].sinceAt), now: () => NOW, send: async () => nothingReply });
    const { counts } = summarizeDream(done.state, ORCH, NOW);
    expect(counts.missed).toBe(0);
    expect(counts.pending).toBe(0);
    expect(counts.ran).toBe(1);
    expect(counts.planned).toBe(counts.ran + counts.skipped + counts.failed);
  });
});

describe('runner-side record', () => {
  const six = 6 * HOUR;
  it('classifies ran, failed and a runner-reported refusal', () => {
    const e = runnerSlotEntries(
      [{ ts: NOW - 2 * six, ok: true, detail: '{"changed":false}' }, { ts: NOW - six, ok: false, detail: 'dispatch timed out' }, { ts: NOW - 60_000, ok: true, detail: "I'm sorry, I can't review that." }],
      DREAM_CRON, NOW, NOW - 48 * HOUR,
    );
    expect(e.map((x) => x.outcome).sort()).toEqual(['failed', 'failed', 'ran']);
    expect(e.find((x) => x.outcome === 'failed' && /refusal/.test(x.reason ?? ''))).toBeTruthy();
  });

  it('a gap of several periods leaves the extra slots as unexplained misses', () => {
    const e = runnerSlotEntries([{ ts: NOW - 3 * six, ok: true }, { ts: NOW - 60_000, ok: true }], DREAM_CRON, NOW, NOW - 48 * HOUR);
    expect(e.filter((x) => x.outcome === 'missed')).toHaveLength(2);
  });

  it('a runner Dream overdue by more than its grace is a miss; just-due is not', () => {
    expect(runnerSlotEntries([{ ts: NOW - six - 2 * HOUR, ok: true }], DREAM_CRON, NOW, NOW - 48 * HOUR).some((x) => x.outcome === 'missed')).toBe(true);
    expect(runnerSlotEntries([{ ts: NOW - six - 10 * 60_000, ok: true }], DREAM_CRON, NOW, NOW - 48 * HOUR).some((x) => x.outcome === 'missed')).toBe(false);
  });

  it('is merged into the summary counts', () => {
    const s = summarizeDream(EMPTY_DREAM, ORCH, NOW, [{ ts: NOW - 60_000, ok: true }]);
    expect(s.counts).toMatchObject({ planned: 1, ran: 1 });
  });

  it('ingests only runner messages that parse as reports', () => {
    const state = ingestRunnerReports(EMPTY_DREAM, [
      { id: 'a', channelId: 'c', agentId: ORCH, agentName: 'Orchestrator', kind: 'orchestrator', text: goodReply, ts: NOW - 1000 },
      { id: 'b', channelId: 'c', agentId: ORCH, agentName: 'Orchestrator', kind: 'orchestrator', text: 'Triage: nothing unassigned.', ts: NOW - 500 },
      { id: 'c', channelId: 'c', agentId: 'agent-daily-planner', agentName: 'Planner', kind: 'cron', text: goodReply, ts: NOW },
    ]);
    expect(state.reports).toHaveLength(1);
    expect(state.reports[0]).toMatchObject({ source: 'runner', changed: true });
    expect(state.notices).toHaveLength(1);
    expect(ingestRunnerReports(state, [{ id: 'a', channelId: 'c', agentId: ORCH, agentName: 'O', kind: 'orchestrator', text: goodReply, ts: NOW - 1000 }])).toBe(state);
  });

  it('names the runner cron job after the agent', () => {
    expect(runnerDreamJobId('agent-website-currency-agent')).toBe('cron-dream-website-currency-agent');
  });
});

describe('review input and prompt', () => {
  it('includes only messages after the cut-off and names who said what', () => {
    const ws = workspace([msg('old', 'ancient history', NOW - 40 * HOUR), msg('m1', 'triage please', NOW - 3 * HOUR), msg('m2', 'Assigned Atlas', NOW - 2 * HOUR, 'agent')]);
    const input = buildReviewInput(ws, agent, NOW - 24 * HOUR);
    expect(input).toMatchObject({ sessionCount: 1, messageCount: 2, truncated: false });
    const prompt = composeDreamPrompt(agent, input, NOW);
    expect(prompt).toContain('Jesse: triage please');
    expect(prompt).toContain('Orchestrator (you): Assigned Atlas');
    expect(prompt).not.toContain('ancient history');
    expect(prompt).toContain('You do NOT change yourself');
  });

  it('finds nothing when no session moved since the cut-off, and bounds a huge transcript', () => {
    expect(buildReviewInput(workspace([msg('m', 'x', NOW - 40 * HOUR)]), agent, NOW - 24 * HOUR).messageCount).toBe(0);
    const many = Array.from({ length: 200 }, (_, i) => msg(`m${i}`, 'x'.repeat(480), NOW - HOUR + i));
    const input = buildReviewInput(workspace(many), agent, NOW - 24 * HOUR);
    expect(input.truncated).toBe(true);
    expect(composeDreamPrompt(agent, input, NOW).length).toBeLessThan(11_000);
  });
});

describe('persistence', () => {
  it('round-trips and drops malformed pieces instead of trusting them', () => {
    const s = enableDream(EMPTY_DREAM, ORCH, NOW);
    expect(parseDreamState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseDreamState(null)).toBe(EMPTY_DREAM);
    expect(parseDreamState({ version: 2 })).toBe(EMPTY_DREAM);
    const dirty = parseDreamState({ version: 1, config: { [ORCH]: { enabled: true, cron: '*/5 * * * *', enabledAt: 1 } }, records: [{ junk: true }], reports: [3], notices: ['x'] });
    expect(dirty).toEqual(EMPTY_DREAM);
    const tampered = { version: 1, config: { 'agent-daily-planner': { enabled: true, cron: DREAM_CRON, enabledAt: 1 } }, records: [], reports: [], notices: [] };
    expect(parseDreamState(tampered).config).toEqual({});
    const forced: DreamState = { ...EMPTY_DREAM, config: { 'agent-daily-planner': { enabled: true, cron: DREAM_CRON, enabledAt: NOW - 30 * HOUR } } };
    expect(planDreams(forced, NOW, live).due).toEqual([]);
  });

  it('marks notices read per agent or all', () => {
    const s: DreamState = { ...EMPTY_DREAM, notices: [{ id: 'a', agentId: ORCH, reportId: 'r', at: 1, read: false }, { id: 'b', agentId: 'agent-reviewer', reportId: 'r2', at: 2, read: false }] };
    expect(markNoticesRead(s, ORCH).notices.map((n) => n.read)).toEqual([true, false]);
    expect(markNoticesRead(s).notices.every((n) => n.read)).toBe(true);
    expect(markNoticesRead(EMPTY_DREAM)).toBe(EMPTY_DREAM);
  });
});
