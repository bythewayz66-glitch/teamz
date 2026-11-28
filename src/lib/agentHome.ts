/**
 * Agent home — everything one agent is, in one place, plus the two plain
 * sentences it opens with: what it did last and what it will do next.
 *
 * Pure: give it the workspace, the runner's last snapshot and the usage
 * ledger, and it returns a view model. Nothing here fetches or renders.
 */

import type { Agent, Conversation, Message, WorkspaceState } from '../types';
import { Schedule, type CronJob, type IntervalTrigger } from './scheduler';
import type { ProductJob } from './jobs';
import { getTool } from './tools';
import { describeRetention, lastActivity, sessionsForAgent } from './sessions';
import {
  agentUsage,
  formatDollars,
  formatTokens,
  usageDollars,
  type CostRate,
  type UsageBucket,
  type UsageLedger,
} from './usageLedger';
import type { RunnerAgentSummary, RunnerChannelMessage, RunnerJobSummary } from '../api/runnerState';

/* ---------------------------------------------------------------- words */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

export function timeAgo(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${plural(Math.floor(d / MIN), 'minute')} ago`;
  if (d < DAY) return `${plural(Math.floor(d / HOUR), 'hour')} ago`;
  const days = Math.floor(d / DAY);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function timeUntil(ts: number, now: number): string {
  const d = ts - now;
  if (d < MIN) return 'in under a minute';
  if (d < HOUR) return `in ${plural(Math.round(d / MIN), 'minute')}`;
  if (d < DAY) return `in ${plural(Math.round(d / HOUR), 'hour')}`;
  const days = Math.round(d / DAY);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

/** "every hour", "every day at 08:00" — a cron expression in plain words. */
export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return `on schedule ${expr}`;
  const [m, h, dom, mon, dow] = f;
  const everyDay = dom === '*' && mon === '*' && dow === '*';
  const pad = (v: string) => v.padStart(2, '0');
  if (everyDay && /^\d+$/.test(m)) {
    if (h === '*') return m === '0' ? 'every hour' : `every hour at :${pad(m)}`;
    if (/^\*\/\d+$/.test(h)) return `every ${plural(Number(h.slice(2)), 'hour')}`;
    if (/^\d+$/.test(h)) return `every day at ${pad(h)}:${pad(m)}`;
  }
  if (everyDay && h === '*' && /^\*\/\d+$/.test(m)) return `every ${plural(Number(m.slice(2)), 'minute')}`;
  if (dom === '*' && mon === '*' && dow !== '*' && /^\d+$/.test(m) && /^\d+$/.test(h)) {
    return `${pad(h)}:${pad(m)} on days ${dow} of the week`;
  }
  return `on schedule ${expr}`;
}

export function describeInterval(everyMs: number): string {
  if (everyMs % DAY === 0) return `every ${plural(everyMs / DAY, 'day')}`;
  if (everyMs % HOUR === 0) return `every ${plural(everyMs / HOUR, 'hour')}`;
  return `every ${plural(Math.max(1, Math.round(everyMs / MIN)), 'minute')}`;
}

/** Plain single-line text: markdown fences and emphasis markers removed so previews read cleanly. */
export const oneLine = (t: string) =>
  t
    .replace(/```[a-z]*/gi, '')
    .replace(/[`*]/g, '')
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
const excerpt = (t: string, n = 110) => {
  const l = oneLine(t);
  return l.length > n ? `${l.slice(0, n - 1).trimEnd()}…` : l;
};

/* ----------------------------------------------------------- view model */

export interface RunnerSnapshot {
  jobs: RunnerJobSummary[];
  triggers: unknown[];
  cronJobs: CronJob[];
  agents: RunnerAgentSummary[];
  channelMessages: RunnerChannelMessage[];
  fetchedAt: number;
}

export interface LocalAutonomy {
  jobs: ProductJob[];
  triggers: IntervalTrigger[];
  cronJobs: CronJob[];
}

export interface HomeSession {
  id: string;
  name: string;
  kind: 'chat' | 'work' | 'room';
  status: 'active' | 'interrupted' | 'archived';
  lastAt: number;
  messageCount: number;
  preview: string;
  /** Plain-words retention policy, e.g. "kept for 90 days, then pruned". */
  retention: string;
  starred: boolean;
  /** Lower-cased name plus message text, for searching within this agent's sessions. */
  text: string;
}

export type SessionSort = 'recent' | 'name';

/** Gamut's per-agent "Sort / Search sessions": every word must appear in the name or any message. */
export function filterSessions(sessions: HomeSession[], query: string, sort: SessionSort): HomeSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = words.length === 0 ? sessions : sessions.filter((s) => words.every((w) => s.text.includes(w)));
  return [...hit].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : b.lastAt - a.lastAt));
}

/** The model without its vendor prefix, e.g. "deepseek-ai/DeepSeek-V4-Flash-0731" -> "DeepSeek-V4-Flash-0731". */
export function modelLabel(model: string): string {
  const tail = model.split('/').pop() ?? model;
  return tail || model;
}

export interface HomeTrigger {
  id: string;
  name: string;
  /** Plain-words schedule, e.g. "every hour". */
  when: string;
  nextAt: number | null;
  lastAt: number | null;
  enabled: boolean;
  source: 'cron' | 'interval' | 'job';
  /** Set when it will not fire on its own, e.g. "waiting for approval". */
  note?: string;
}

export interface HomeSkill {
  label: string;
  level?: number;
  source: 'declared' | 'instructions';
}

export interface HomeRun {
  id: string;
  at: number;
  title: string;
  outcome: 'ok' | 'failed' | 'info';
  detail: string;
}

export interface HomeStatus {
  tone: 'ok' | 'busy' | 'warn' | 'off';
  label: string;
  detail: string;
}

export interface HomeCost {
  total: UsageBucket;
  tokensLabel: string;
  /** Null until a rate is set — Teamz ships no price list and will not guess. */
  dollars: number | null;
  dollarsLabel: string | null;
  since: string | null;
}

export interface AgentHomeModel {
  agent: Agent;
  status: HomeStatus;
  model: string;
  /** Model name without the vendor prefix; the full id is `model`. */
  modelLabel: string;
  /** Per-request tool-step budget when the agent has one (Teamz's analogue of Gamut's effort). */
  stepLimit: number | null;
  provider: string | null;
  sessions: HomeSession[];
  lastSession: HomeSession | null;
  triggers: HomeTrigger[];
  nextTrigger: HomeTrigger | null;
  skills: HomeSkill[];
  tools: Array<{ id: string; label: string; description: string }>;
  connections: Array<{ label: string; detail: string }>;
  recentRuns: HomeRun[];
  runRecord: RunRecord | null;
  cost: HomeCost;
  warmth: { last: string; next: string };
}

/**
 * Skills the agent declares; failing that, its capability lines; failing that,
 * the role sentence from its own instructions ("You are X, a Y who…"), marked
 * as taken from the instructions so nobody mistakes it for a declared skill.
 * An agent with none of these gets an empty list, not an invented one.
 */
export function deriveSkills(agent: Agent): HomeSkill[] {
  if (agent.skills.length > 0) {
    return [...agent.skills]
      .sort((a, b) => b.level - a.level)
      .map((s) => ({ label: s.label, level: s.level, source: 'declared' as const }));
  }
  if (agent.capabilities && agent.capabilities.length > 0) {
    return agent.capabilities.map((c) => ({ label: c, source: 'declared' as const }));
  }
  if (agent.role && agent.role.trim()) return [{ label: agent.role.trim(), source: 'instructions' }];
  const first = oneLine(agent.systemPrompt).match(/^You are [^,.]+?,\s*(?:an?|the)?\s*([^.]{6,140})/i);
  if (first) return [{ label: first[1].trim(), source: 'instructions' }];
  return [];
}

function jobSummaryAsTrigger(j: RunnerJobSummary, now: number): HomeTrigger | null {
  const s = j.schedule;
  let when = 'when started by hand';
  let nextAt: number | null = null;
  if (s.kind === 'cron' && s.expr) {
    when = describeCron(s.expr);
    try {
      nextAt = new Schedule(s.expr).next(new Date(now)).getTime();
    } catch {
      nextAt = null;
    }
  } else if (s.kind === 'interval' && s.everyMs) {
    when = describeInterval(s.everyMs);
    nextAt = (j.lastRunAt ?? now) + s.everyMs;
  }
  const waiting = j.status === 'awaiting_approval';
  const paused = j.status === 'paused' || !j.enabled;
  return {
    id: `job:${j.id}`,
    name: j.name,
    when,
    nextAt: waiting || paused || s.kind === 'manual' ? null : nextAt,
    lastAt: j.lastRunAt,
    enabled: j.enabled && j.status !== 'paused',
    source: 'job',
    note: waiting ? 'waiting for the Reviewer’s approval' : paused ? 'paused' : undefined,
  };
}

function cronAsTrigger(j: CronJob, now: number): HomeTrigger {
  let nextAt: number | null = null;
  try {
    nextAt = j.enabled ? new Schedule(j.schedule).next(new Date(now)).getTime() : null;
  } catch {
    nextAt = null;
  }
  return {
    id: `cron:${j.id}`,
    name: j.name,
    when: describeCron(j.schedule),
    nextAt,
    lastAt: j.lastRunAt,
    enabled: j.enabled,
    source: 'cron',
    note: j.enabled ? undefined : 'paused',
  };
}

function intervalAsTrigger(t: IntervalTrigger, now: number): HomeTrigger {
  return {
    id: `interval:${t.id}`,
    name: excerpt(t.prompt, 60),
    when: describeInterval(t.everyMs),
    nextAt: t.enabled ? Math.max(now, (t.lastRunAt ?? now) + t.everyMs) : null,
    lastAt: t.lastRunAt,
    enabled: t.enabled,
    source: 'interval',
    note: t.enabled ? undefined : 'paused',
  };
}

function isIntervalTrigger(v: unknown): v is IntervalTrigger {
  const t = v as Partial<IntervalTrigger> | null;
  return Boolean(t) && typeof t!.id === 'string' && typeof t!.agentId === 'string' && typeof t!.everyMs === 'number';
}

/** Everything that will wake this agent up by itself, runner and in-tab alike. */
export function agentTriggers(
  agentId: string,
  runner: RunnerSnapshot | null,
  local: LocalAutonomy | null,
  now: number,
): HomeTrigger[] {
  const out = new Map<string, HomeTrigger>();
  const crons = [...(runner?.cronJobs ?? []), ...(local?.cronJobs ?? [])];
  for (const j of crons) if (j.agentId === agentId) out.set(`cron:${j.id}`, cronAsTrigger(j, now));
  const intervals = [...(runner?.triggers ?? []).filter(isIntervalTrigger), ...(local?.triggers ?? [])];
  for (const t of intervals) if (t.agentId === agentId) out.set(`interval:${t.id}`, intervalAsTrigger(t, now));
  for (const j of runner?.jobs ?? []) {
    if (j.stages.some((s) => s.agentId === agentId)) {
      const t = jobSummaryAsTrigger(j, now);
      if (t) out.set(t.id, t);
    }
  }
  for (const j of local?.jobs ?? []) {
    if (j.stages.some((s) => s.agentId === agentId)) {
      const t = jobSummaryAsTrigger(
        {
          id: j.id,
          name: j.name,
          schedule: j.schedule,
          enabled: j.enabled,
          status: j.status,
          currentStageIndex: j.currentStageIndex,
          stages: j.stages,
          runs: [],
          lastRunAt: j.lastRunAt,
        },
        now,
      );
      if (t) out.set(t.id, t);
    }
  }
  return [...out.values()].sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
}

function agentRuns(
  agentId: string,
  runner: RunnerSnapshot | null,
  local: LocalAutonomy | null,
): HomeRun[] {
  const runs: HomeRun[] = [];
  const crons = [...(runner?.cronJobs ?? []), ...(local?.cronJobs ?? [])];
  for (const j of crons) {
    if (j.agentId !== agentId) continue;
    for (const r of j.runs) {
      runs.push({
        id: `cron:${j.id}:${r.ts}`,
        at: r.ts,
        title: j.name,
        outcome: r.ok ? 'ok' : 'failed',
        detail: r.detail ? excerpt(r.detail) : r.ok ? 'Completed.' : 'Failed.',
      });
    }
  }
  for (const j of runner?.jobs ?? []) {
    for (const r of j.runs) {
      const stage = j.stages.find((s) => s.stage === r.stage);
      if (!stage || stage.agentId !== agentId || typeof r.startedAt !== 'number') continue;
      runs.push({
        id: `job:${j.id}:${r.id ?? r.startedAt}`,
        at: r.startedAt,
        title: `${j.name} · ${r.stage}`,
        outcome: r.status === 'ok' ? 'ok' : r.status === 'failed' || r.status === 'blocked' ? 'failed' : 'info',
        detail: r.output ? excerpt(r.output) : r.status ?? '',
      });
    }
  }
  for (const j of local?.jobs ?? []) {
    for (const r of j.runs) {
      if (r.agentId !== agentId) continue;
      runs.push({
        id: `ljob:${j.id}:${r.id}`,
        at: r.startedAt,
        title: `${j.name} · ${r.stage}`,
        outcome: r.status === 'ok' ? 'ok' : r.status === 'failed' || r.status === 'blocked' ? 'failed' : 'info',
        detail: r.output ? excerpt(r.output) : r.status,
      });
    }
  }
  return runs.sort((a, b) => b.at - a.at);
}

export interface RunRecord {
  planned: number;
  ran: number;
  skipped: number;
  failed: number;
  /** Gamut's plain format: "Last 7 days: 24 planned runs, 23 ran, 1 skipped, and 0 failed." */
  sentence: string;
  /** Schedules with nothing on record in the window; their misses cannot be counted honestly. */
  noRecord: string[];
}

const RECORD_WINDOW_MS = 7 * DAY;

function countSlots(expr: string, fromMs: number, toMs: number, cap = 1000): number {
  try {
    const schedule = new Schedule(expr);
    let t = new Date(Math.floor(fromMs / MIN) * MIN - MIN);
    let n = 0;
    while (n < cap) {
      const next = schedule.next(t);
      if (next.getTime() > toMs) break;
      n += 1;
      t = next;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * Planned / ran / skipped / failed over the last 7 days across this agent's
 * cron schedules, in Gamut's plain format. A schedule is only counted from its
 * first recorded run in the window: Teamz keeps no creation time for a cron job
 * and the runner retains only its newest 50 runs per job, so counting earlier
 * slots as "skipped" would blame a job for time it did not exist (or whose
 * history has rolled off). A schedule with nothing on record is listed
 * separately instead of being called skipped. Planned slots are an estimate
 * from the cron expression; two runs in one slot count as one ran.
 */
export function buildRunRecord(
  agentId: string,
  runner: RunnerSnapshot | null,
  local: LocalAutonomy | null,
  now: number,
): RunRecord | null {
  const byId = new Map<string, CronJob>();
  for (const j of [...(runner?.cronJobs ?? []), ...(local?.cronJobs ?? [])]) {
    if (j.agentId === agentId) byId.set(j.id, j);
  }
  if (byId.size === 0) return null;
  let planned = 0;
  let ran = 0;
  let failed = 0;
  let skipped = 0;
  const noRecord: string[] = [];
  for (const j of byId.values()) {
    const inWindow = j.runs.filter((r) => r.ts >= now - RECORD_WINDOW_MS);
    if (inWindow.length === 0) {
      noRecord.push(j.name);
      continue;
    }
    const anchor = Math.min(...inWindow.map((r) => r.ts));
    const slots = Math.max(countSlots(j.schedule, anchor, now), inWindow.length);
    const okRuns = inWindow.filter((r) => r.ok).length;
    const failRuns = inWindow.length - okRuns;
    planned += slots;
    ran += okRuns;
    failed += failRuns;
    skipped += Math.max(0, slots - inWindow.length);
  }
  const sentence = `Last 7 days: ${plural(planned, 'planned run')}, ${ran} ran, ${skipped} skipped, and ${failed} failed.`;
  return { planned, ran, skipped, failed, sentence, noRecord };
}

function isReviewer(agent: Pick<Agent, 'id'>): boolean {
  return agent.id === 'agent-reviewer';
}

function statusOf(agent: Agent, interrupted: boolean): HomeStatus {
  if (interrupted) {
    return { tone: 'warn', label: 'Interrupted', detail: 'A reply was cut off mid-work. Open the session and resume it.' };
  }
  if (agent.lastPingOk === false) {
    return { tone: 'warn', label: 'Unreachable', detail: agent.lastPingMessage || 'The last connection check failed.' };
  }
  if (agent.status === 'busy') return { tone: 'busy', label: 'Working', detail: 'Marked busy right now.' };
  if (agent.status === 'offline') return { tone: 'off', label: 'Offline', detail: 'Marked offline; it will not answer until it is back.' };
  return { tone: 'ok', label: 'Ready', detail: 'Online and answering.' };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function lastAgentMessage(
  agentId: string,
  state: Pick<WorkspaceState, 'conversations' | 'messages'>,
): { msg: Message; conv: Conversation } | null {
  let best: { msg: Message; conv: Conversation } | null = null;
  for (const conv of state.conversations) {
    const list = state.messages[conv.id];
    if (!list) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.authorType === 'agent' && m.authorId === agentId && m.status === 'sent' && m.text) {
        if (!best || m.createdAt > best.msg.createdAt) best = { msg: m, conv };
        break;
      }
    }
  }
  return best;
}

/**
 * The two warm sentences a home opens with. They are written by the UI about
 * the agent, not by the agent, so for the Reviewer they are third person:
 * nothing in Teamz speaks as the Reviewer except the Reviewer.
 */
export function buildWarmth(
  lastMsg: { msg: Message; conv: Conversation } | null,
  runs: HomeRun[],
  next: HomeTrigger | null,
  interrupted: boolean,
  now: number,
  voice: { name: string; third: boolean } = { name: 'I', third: false },
): { last: string; next: string } {
  const t = voice.third;
  const who = voice.name;
  const lastRun = runs[0];
  let last: string;
  if (interrupted) {
    last = t
      ? `${who} was cut off in the middle of a reply. Open that session and resume it, and ${who} will pick up from everything already said.`
      : 'I was cut off in the middle of a reply. Open that session and resume it, and I will pick up from everything already said.';
  } else if (lastRun && (!lastMsg || lastRun.at > lastMsg.msg.createdAt)) {
    const tail = lastRun.detail ? ` — ${lastRun.detail}` : '.';
    last =
      lastRun.outcome === 'failed'
        ? `${t ? `${who}’s` : 'My'} last scheduled run, “${lastRun.title}”, failed ${timeAgo(lastRun.at, now)}${tail}`
        : `${t ? who : 'I'} last ran “${lastRun.title}” ${timeAgo(lastRun.at, now)}${tail}`;
  } else if (lastMsg) {
    const where = lastMsg.conv.session?.kind === 'room' || lastMsg.conv.kind === 'channel' ? `in ${lastMsg.conv.name}` : `in “${lastMsg.conv.name}”`;
    last = `${t ? who : 'I'} last replied ${where} ${timeAgo(lastMsg.msg.createdAt, now)}: “${excerpt(lastMsg.msg.text)}”`;
  } else {
    last = t
      ? `${who} hasn’t done anything yet. Start a session and it will show up here.`
      : `I haven’t done anything yet. Start a session with me and it will show up here.`;
  }

  let nextText: string;
  if (next && next.nextAt !== null) {
    const clock = new Date(next.nextAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    nextText = t
      ? `Next, ${who} will run “${next.name}” ${timeUntil(next.nextAt, now)} (${clock}), ${next.when}.`
      : `Next, I’ll run “${next.name}” ${timeUntil(next.nextAt, now)} (${clock}), ${next.when}.`;
  } else if (next) {
    nextText = `“${next.name}” is set up for ${t ? who : 'me'} but ${next.note ?? 'is not scheduled'}, so nothing is queued.`;
  } else {
    nextText = t
      ? `Nothing is scheduled for ${who}. It acts when someone asks, or when the Orchestrator assigns it work.`
      : `Nothing is scheduled for me. I act when someone asks, or when the Orchestrator assigns me work.`;
  }
  return { last, next: nextText };
}

export function buildAgentHome(input: {
  agent: Agent;
  state: Pick<WorkspaceState, 'conversations' | 'messages'>;
  runner: RunnerSnapshot | null;
  local: LocalAutonomy | null;
  ledger: UsageLedger;
  rate: CostRate | null;
  now: number;
}): AgentHomeModel {
  const { agent, state, runner, local, ledger, rate, now } = input;

  const sessions: HomeSession[] = sessionsForAgent(state, agent.id, { includeArchived: false, nonEmptyOnly: false }).map((c) => {
    const msgs = state.messages[c.id] ?? [];
    const last = [...msgs].reverse().find((m) => m.text && m.status !== 'pending');
    return {
      id: c.id,
      name: c.name,
      kind: c.session.kind,
      status: c.session.status,
      lastAt: lastActivity(c, msgs),
      messageCount: msgs.length,
      preview: last ? excerpt(last.text, 90) : 'No messages yet',
      retention: describeRetention(c.session.retention),
      starred: Boolean(c.session.starred),
      text: `${c.name} ${msgs.map((m) => m.text).join(' ')}`.toLowerCase().slice(0, 30_000),
    };
  });
  const lastSession = sessions.find((s) => s.messageCount > 0) ?? null;
  const interrupted = sessions.some((s) => s.status === 'interrupted');

  const triggers = agentTriggers(agent.id, runner, local, now);
  const nextTrigger = triggers.find((t) => t.enabled && t.nextAt !== null) ?? triggers[0] ?? null;

  const runs = agentRuns(agent.id, runner, local);
  const recentRuns = runs.slice(0, 8);

  const tools = (agent.enabledTools ?? []).map((id) => {
    const def = getTool(id);
    return { id, label: def?.label ?? id, description: def?.description ?? 'Enabled for this agent.' };
  });

  const runnerAgent = runner?.agents.find((a) => a.id === agent.id);
  const provider = runnerAgent?.provider ?? null;
  const channels = state.conversations.filter((c) => c.kind === 'channel' && c.agentIds.includes(agent.id));
  const host = hostOf(agent.endpointUrl);
  const connections: Array<{ label: string; detail: string }> = [];
  if (provider) connections.push({ label: 'Model provider', detail: provider });
  connections.push({ label: 'Endpoint', detail: host ?? (agent.endpointUrl || 'not set') });
  connections.push({
    label: 'Runner',
    detail: runnerAgent ? 'Registered with the 24/7 runner' : runner ? 'Not in the runner’s agent list' : 'Runner not reached yet',
  });
  if (channels.length > 0) {
    connections.push({
      label: channels.length === 1 ? 'Channel' : 'Channels',
      detail: channels.length > 3 ? `${channels.slice(0, 3).map((c) => c.name).join(', ')} +${channels.length - 3}` : channels.map((c) => c.name).join(', '),
    });
  }

  const total = agentUsage(ledger, agent.id);
  const dollars = usageDollars(total, rate);
  const cost: HomeCost = {
    total,
    tokensLabel: `${formatTokens(total.totalTokens)} tokens · ${total.calls} call${total.calls === 1 ? '' : 's'}`,
    dollars,
    dollarsLabel: dollars === null ? null : formatDollars(dollars),
    since: ledger.since,
  };

  const lastMsg = lastAgentMessage(agent.id, state);

  return {
    agent,
    status: statusOf(agent, interrupted),
    model: agent.model,
    modelLabel: modelLabel(agent.model),
    stepLimit: agent.maxIterations ?? null,
    provider,
    sessions,
    lastSession,
    triggers,
    nextTrigger,
    skills: deriveSkills(agent),
    tools,
    connections,
    recentRuns,
    runRecord: buildRunRecord(agent.id, runner, local, now),
    cost,
    warmth: buildWarmth(lastMsg, runs, nextTrigger, interrupted, now, {
      name: agent.name,
      third: isReviewer(agent),
    }),
  };
}
