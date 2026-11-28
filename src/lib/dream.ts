/**
 * Dream — scheduled self-review that reports (roadmap Phase 2).
 *
 * An enrolled agent periodically re-reads its own recent sessions and says,
 * in a strict JSON report, what it noticed and what (if anything) it would
 * change. A Dream never edits the agent: changes are *proposals* pinned on
 * the agent's home for the Reviewer or Jesse to act on.
 *
 * Everything here is pure (no DOM, no timers, no network): the planner, the
 * reply parser, the slot ledger and the state reducers are shared by the
 * browser hook (`store/useDream.ts`) and the tests. The model call is injected.
 *
 * Honesty rules, enforced here and covered by tests:
 *  - A reply that is not a valid report is a FAILED run, never a success.
 *    Refusal-shaped text and provider error text ("out of credits", rate
 *    limits) never become a report.
 *  - Every planned slot ends up ran / skipped (with a reason) / failed
 *    (with the error). A slot with no record that is past its grace window is
 *    `missed` — the one unexplained state, which the gate requires to be zero.
 *  - No model call is made (and so nothing is spent) when there is nothing new
 *    to review or when the provider is mock mode; the slot is `skipped` and says so.
 */

import type { Agent, Message, WorkspaceState } from '../types';
import { cronIntervalMinutes, Schedule } from './scheduler';
import { lastActivity, sessionsForAgent } from './sessions';
import type { RunnerChannelMessage } from '../api/runnerState';

export const DREAM_CRON = '0 */6 * * *';
/** Never dream more often than hourly: a typo must not become a spending loop. */
export const MIN_DREAM_INTERVAL_MINUTES = 60;
export const DREAM_CADENCES: Array<{ label: string; cron: string }> = [
  { label: 'Every 3 hours', cron: '0 */3 * * *' },
  { label: 'Every 6 hours', cron: DREAM_CRON },
  { label: 'Every 12 hours', cron: '0 */12 * * *' },
  { label: 'Daily', cron: '0 6 * * *' },
];

/**
 * Only these agents may be enrolled. Fleet-wide rollout is a later decision,
 * made after their Dreams prove stable; widening it is a one-line change here.
 */
export const DREAM_ENROLLABLE = ['agent-orchestrator', 'agent-reviewer', 'agent-website-currency-agent'] as const;
export const isDreamEnrollable = (agentId: string): boolean => (DREAM_ENROLLABLE as readonly string[]).includes(agentId);

/** The runner-side cron job id for an agent's Dream (see build-runner-state.mjs --dream). */
export const runnerDreamJobId = (agentId: string): string => `cron-dream-${agentId.replace(/^agent-/, '')}`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** First Dream looks back this far; later ones look back to the last successful Dream. */
export const FIRST_LOOKBACK_MS = DAY;
/** Trailing window the run record is shown over (the gate's "7-day run record"). */
export const RECORD_WINDOW_MS = 7 * DAY;
/** A tab slot with no record this long after it was due is `missed`. */
export const TAB_GRACE_MS = 10 * 60_000;
/** The runner dispatches one job per ~15 minutes, so its grace is wider. */
export const RUNNER_GRACE_MS = 45 * 60_000;

const MAX_PROMPT_CHARS = 8_000;
const MAX_RECORDS = 400;
const MAX_REPORTS = 120;
const MAX_NOTICES = 60;

/* --------------------------------------------------------------- types */

export type DreamOutcome = 'ran' | 'skipped' | 'failed';
/** `missed` = a planned slot with no record and no reason; `pending` = not yet due/attempted. */
export type SlotOutcome = DreamOutcome | 'missed' | 'pending';
export type DreamSource = 'tab' | 'runner';
export type ProposalTarget = 'instructions' | 'skills' | 'tools' | 'schedule' | 'other';

export interface DreamProposal {
  target: ProposalTarget;
  change: string;
  why: string;
}

export interface DreamReport {
  id: string;
  agentId: string;
  /** When the Dream finished. */
  at: number;
  /** The planned slot it answers. */
  slot: number;
  source: DreamSource;
  changed: boolean;
  summary: string;
  findings: string[];
  proposals: DreamProposal[];
  reviewed: { sessions: number; messages: number; sinceAt: number };
}

export interface DreamRecord {
  agentId: string;
  /** Planned slot (epoch ms, minute-aligned). */
  slot: number;
  outcome: DreamOutcome;
  at: number;
  source: DreamSource;
  /** Always set for skipped and failed. */
  reason?: string;
  reportId?: string;
}

export interface DreamAgentConfig {
  enabled: boolean;
  cron: string;
  /** Slots at or before this are not planned. Set when Dream is switched on. */
  enabledAt: number;
}

export interface DreamNotice {
  id: string;
  agentId: string;
  reportId: string;
  at: number;
  read: boolean;
}

export interface DreamState {
  version: 1;
  config: Record<string, DreamAgentConfig>;
  records: DreamRecord[];
  reports: DreamReport[];
  notices: DreamNotice[];
}

export const EMPTY_DREAM: DreamState = { version: 1, config: {}, records: [], reports: [], notices: [] };

/* ----------------------------------------------------------- persistence */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** Defensive load: anything malformed is dropped, never trusted. */
export function parseDreamState(raw: unknown): DreamState {
  if (!isRecord(raw) || raw.version !== 1) return EMPTY_DREAM;
  const config: Record<string, DreamAgentConfig> = {};
  if (isRecord(raw.config)) {
    for (const [id, c] of Object.entries(raw.config)) {
      if (!isRecord(c) || !isStr(c.cron) || !isNum(c.enabledAt) || typeof c.enabled !== 'boolean') continue;
      if (validateCadence(c.cron) || !isDreamEnrollable(id)) continue;
      config[id] = { enabled: c.enabled, cron: c.cron, enabledAt: c.enabledAt };
    }
  }
  const records = (Array.isArray(raw.records) ? raw.records : []).filter(
    (r): r is DreamRecord =>
      isRecord(r) && isStr(r.agentId) && isNum(r.slot) && isNum(r.at) &&
      (r.outcome === 'ran' || r.outcome === 'skipped' || r.outcome === 'failed') &&
      (r.source === 'tab' || r.source === 'runner'),
  );
  const reports = (Array.isArray(raw.reports) ? raw.reports : []).filter(
    (r): r is DreamReport =>
      isRecord(r) && isStr(r.id) && isStr(r.agentId) && isNum(r.at) && isNum(r.slot) &&
      typeof r.changed === 'boolean' && isStr(r.summary) && Array.isArray(r.findings) && Array.isArray(r.proposals) &&
      isRecord(r.reviewed),
  );
  const notices = (Array.isArray(raw.notices) ? raw.notices : []).filter(
    (n): n is DreamNotice => isRecord(n) && isStr(n.id) && isStr(n.agentId) && isStr(n.reportId) && isNum(n.at) && typeof n.read === 'boolean',
  );
  return { version: 1, config, records, reports, notices };
}

/* --------------------------------------------------------------- cadence */

/** Returns an error message, or null when the cadence is acceptable. */
export function validateCadence(cron: string): string | null {
  let s: Schedule;
  try {
    s = new Schedule(cron);
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid schedule';
  }
  const every = cronIntervalMinutes(s.expr);
  if (every === null) return 'could not work out how often this schedule fires';
  if (every < MIN_DREAM_INTERVAL_MINUTES) return `Dream may run at most hourly; this fires every ${every} minutes`;
  return null;
}

export function describeCadence(cron: string): string {
  return DREAM_CADENCES.find((c) => c.cron === cron)?.label ?? `on schedule ${cron}`;
}

/** Planned slots in (fromExclusive, toInclusive], oldest first, capped. */
export function slotsBetween(cron: string, fromExclusive: number, toInclusive: number, cap = 400): number[] {
  const out: number[] = [];
  if (toInclusive <= fromExclusive) return out;
  const s = new Schedule(cron);
  let cursor = new Date(fromExclusive);
  while (out.length < cap) {
    const next = s.next(cursor);
    if (next.getTime() > toInclusive) break;
    out.push(next.getTime());
    cursor = next;
  }
  return out;
}

export function nextSlot(cron: string, now: number): number | null {
  try {
    return new Schedule(cron).next(new Date(now)).getTime();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- review input */

export interface ReviewInput {
  sinceAt: number;
  sessions: Array<{ name: string; kind: string; lines: Array<{ who: string; at: number; text: string }> }>;
  sessionCount: number;
  messageCount: number;
  truncated: boolean;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/**
 * The agent's own sessions that saw activity after `sinceAt`, newest first,
 * with each session's newer messages oldest-first. Bounded so a Dream never
 * sends an unbounded prompt; `truncated` says when something was left out.
 */
export function buildReviewInput(
  state: Pick<WorkspaceState, 'conversations' | 'messages' | 'agents'>,
  agent: Pick<Agent, 'id' | 'name'>,
  sinceAt: number,
): ReviewInput {
  const names = new Map(state.agents.map((a) => [a.id, a.name]));
  const sessions: ReviewInput['sessions'] = [];
  let messageCount = 0;
  let sessionCount = 0;
  let budget = MAX_PROMPT_CHARS;
  let truncated = false;
  for (const c of sessionsForAgent(state, agent.id, { includeArchived: false, nonEmptyOnly: true })) {
    const msgs = (state.messages[c.id] ?? []).filter((m: Message) => m.status === 'sent' && m.text && m.createdAt > sinceAt);
    if (msgs.length === 0 || lastActivity(c, state.messages[c.id]) <= sinceAt) continue;
    sessionCount += 1;
    messageCount += msgs.length;
    const lines: ReviewInput['sessions'][number]['lines'] = [];
    for (const m of msgs.slice(-30)) {
      const who = m.authorType === 'user' ? 'Jesse' : m.authorId === agent.id ? `${agent.name} (you)` : names.get(m.authorId ?? '') ?? 'an agent';
      const text = clip(m.text.replace(/\s+/g, ' ').trim(), 500);
      if (budget - text.length < 0) {
        truncated = true;
        break;
      }
      budget -= text.length + who.length + 8;
      lines.push({ who, at: m.createdAt, text });
    }
    if (msgs.length > lines.length) truncated = true;
    if (lines.length > 0) sessions.push({ name: c.name, kind: c.session.kind, lines });
    if (budget <= 0) {
      truncated = true;
      break;
    }
  }
  return { sinceAt, sessions, sessionCount, messageCount, truncated };
}

export function composeDreamPrompt(agent: Pick<Agent, 'name'>, input: ReviewInput, now: number): string {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  const body = input.sessions
    .map((s) => `## ${s.name} (${s.kind})\n${s.lines.map((l) => `[${iso(l.at)}] ${l.who}: ${l.text}`).join('\n')}`)
    .join('\n\n');
  return [
    `This is your scheduled Dream, ${agent.name}: a self-review of your own recent work. It is ${iso(now)}.`,
    `Below is what happened in your sessions since ${iso(input.sinceAt)}${input.truncated ? ' (long, so some of it was left out)' : ''}.`,
    'Re-read it and decide whether anything about how you work should change: a mistake you repeated, an instruction that misled you, a skill or tool you lacked, a schedule that did not fit.',
    'Rules: use only what is in the transcript below; never invent events. You do NOT change yourself: a change is a proposal that Jesse or the Reviewer will decide on. If nothing needs changing, say so plainly. That is a good outcome.',
    'Reply with ONLY one JSON object, no other text, in exactly this shape:',
    '{"changed": boolean, "summary": "one or two plain sentences", "findings": ["short observation", ...], "proposals": [{"target": "instructions"|"skills"|"tools"|"schedule"|"other", "change": "what to change", "why": "the evidence from the transcript"}]}',
    '"changed" is true only if you have at least one proposal; if it is false, "proposals" must be an empty list.',
    '',
    '--- YOUR RECENT SESSIONS ---',
    body,
  ].join('\n');
}

/* -------------------------------------------------------------- parsing */

export type ParsedDream =
  | { ok: true; changed: boolean; summary: string; findings: string[]; proposals: DreamProposal[] }
  | { ok: false; reason: string };

const REFUSAL_OR_PROVIDER_ERROR =
  /\b(out of credits|insufficient (credits|funds|quota)|quota (exceeded|exhausted)|rate.?limit|too many requests|payment required|invalid api key|unauthori[sz]ed|forbidden|i (can(?:no|’|')t|am unable|’m unable|'m unable|won(?:’|')t)|i(?:’|')m sorry|i am sorry|as an ai)\b/i;
const SUMMARY_REFUSAL = /^\s*(i(?:’|')m sorry|i am sorry|i (can(?:no|’|')t|am unable|(?:’|')m unable)|as an ai|unable to)/i;
const TARGETS: readonly ProposalTarget[] = ['instructions', 'skills', 'tools', 'schedule', 'other'];

function candidateJson(text: string): unknown | undefined {
  const t = text.trim();
  const attempts: string[] = [t];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced) attempts.push(fenced[1].trim());
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a !== -1 && b > a) attempts.push(t.slice(a, b + 1));
  for (const s of attempts) {
    try {
      return JSON.parse(s);
    } catch {
      /* try the next shape */
    }
  }
  return undefined;
}

/** Parse a model reply into a report body. Anything that is not a valid report is `ok:false`. */
export function parseDreamReply(reply: string): ParsedDream {
  const text = (reply ?? '').trim();
  if (!text) return { ok: false, reason: 'the model returned an empty reply' };
  const json = candidateJson(text);
  if (!isRecord(json)) {
    return REFUSAL_OR_PROVIDER_ERROR.test(text)
      ? { ok: false, reason: `reply looks like a refusal or provider error, not a report: “${clip(text, 140)}”` }
      : { ok: false, reason: `reply is not a Dream report (no JSON object): “${clip(text, 140)}”` };
  }
  if (typeof json.changed !== 'boolean') return { ok: false, reason: 'report is missing a true/false "changed"' };
  if (!isStr(json.summary) || !json.summary.trim()) return { ok: false, reason: 'report is missing a "summary"' };
  const summary = clip(json.summary.trim(), 600);
  if (SUMMARY_REFUSAL.test(summary)) return { ok: false, reason: `summary is a refusal, not a review: “${clip(summary, 140)}”` };
  const findingsRaw = json.findings === undefined ? [] : json.findings;
  if (!Array.isArray(findingsRaw) || findingsRaw.some((f) => !isStr(f))) return { ok: false, reason: '"findings" must be a list of strings' };
  const findings = (findingsRaw as string[]).map((f) => clip(f.trim(), 300)).filter(Boolean).slice(0, 8);
  const proposalsRaw = json.proposals === undefined ? [] : json.proposals;
  if (!Array.isArray(proposalsRaw)) return { ok: false, reason: '"proposals" must be a list' };
  const proposals: DreamProposal[] = [];
  for (const p of proposalsRaw) {
    if (!isRecord(p) || !isStr(p.change) || !p.change.trim() || !isStr(p.why) || !p.why.trim()) {
      return { ok: false, reason: 'each proposal needs a "change" and a "why"' };
    }
    const target = TARGETS.includes(p.target as ProposalTarget) ? (p.target as ProposalTarget) : 'other';
    proposals.push({ target, change: clip(p.change.trim(), 400), why: clip(p.why.trim(), 400) });
  }
  if (proposals.length > 5) return { ok: false, reason: 'more than 5 proposals; a Dream proposes a few changes, not a rewrite' };
  if (json.changed && proposals.length === 0) return { ok: false, reason: 'report says "changed" but proposes nothing' };
  if (!json.changed && proposals.length > 0) return { ok: false, reason: 'report says nothing changed but lists proposals' };
  return { ok: true, changed: json.changed, summary, findings, proposals };
}

/** Same refusal/error test, for runner run details that are excerpts of a reply. */
export const looksLikeRefusalOrError = (text: string): boolean => REFUSAL_OR_PROVIDER_ERROR.test(text);

/* --------------------------------------------------------------- reducers */

const recordKey = (agentId: string, slot: number) => `${agentId}:${slot}`;

function upsertRecord(records: DreamRecord[], rec: DreamRecord): DreamRecord[] {
  const key = recordKey(rec.agentId, rec.slot);
  const rest = records.filter((r) => recordKey(r.agentId, r.slot) !== key);
  return [...rest, rec].sort((a, b) => a.slot - b.slot).slice(-MAX_RECORDS);
}

export function enableDream(state: DreamState, agentId: string, now: number, cron: string = DREAM_CRON): DreamState {
  if (!isDreamEnrollable(agentId)) throw new Error('Dream is not open to this agent yet: only the starter agents are enrolled.');
  const bad = validateCadence(cron);
  if (bad) throw new Error(bad);
  const prev = state.config[agentId];
  if (prev?.enabled && prev.cron === cron) return state;
  return { ...state, config: { ...state.config, [agentId]: { enabled: true, cron, enabledAt: prev?.enabled ? prev.enabledAt : now } } };
}

export function disableDream(state: DreamState, agentId: string): DreamState {
  const prev = state.config[agentId];
  if (!prev?.enabled) return state;
  return { ...state, config: { ...state.config, [agentId]: { ...prev, enabled: false } } };
}

export function setDreamCadence(state: DreamState, agentId: string, cron: string, now: number): DreamState {
  const prev = state.config[agentId];
  if (!prev?.enabled) throw new Error('Switch Dream on before changing its cadence.');
  const bad = validateCadence(cron);
  if (bad) throw new Error(bad);
  if (prev.cron === cron) return state;
  // Slots of the old cadence are settled; the new one is planned from now.
  return { ...state, config: { ...state.config, [agentId]: { enabled: true, cron, enabledAt: now } } };
}

export function markNoticesRead(state: DreamState, agentId?: string): DreamState {
  if (!state.notices.some((n) => !n.read && (!agentId || n.agentId === agentId))) return state;
  return { ...state, notices: state.notices.map((n) => (!n.read && (!agentId || n.agentId === agentId) ? { ...n, read: true } : n)) };
}

/** The `at` of the last Dream that ran (tab or runner), or null. */
export function lastRanAt(state: DreamState, agentId: string): number | null {
  let best: number | null = null;
  for (const r of state.records) if (r.agentId === agentId && r.outcome === 'ran' && (best === null || r.at > best)) best = r.at;
  return best;
}

export function reviewSince(state: DreamState, agentId: string, now: number): number {
  return lastRanAt(state, agentId) ?? now - FIRST_LOOKBACK_MS;
}

export interface PlanContext {
  /** True when the model transport can really answer (not mock mode). */
  providerLive: boolean;
  /** How much new material the agent has to review since a time. */
  activity: (agentId: string, sinceAt: number) => { sessions: number; messages: number };
}

export interface DreamDue {
  agentId: string;
  slot: number;
  sinceAt: number;
}

const clock = (t: number) => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Reconcile every enabled agent's planned slots up to `now`.
 *
 * Unrecorded slots before the latest one were missed because Teamz was not
 * open (this is a browser app); each is recorded `skipped` with that reason
 * and the latest is the one Dream to run (catch-up fires once, like
 * `isCronJobDue`). The latest slot itself is skipped, with a reason, when
 * there is nothing new to review or the provider is mock mode.
 * Returns the new state and the Dreams to execute now.
 */
export function planDreams(state: DreamState, now: number, ctx: PlanContext, inFlight: ReadonlySet<string> = new Set()): { state: DreamState; due: DreamDue[] } {
  let records = state.records;
  const due: DreamDue[] = [];
  for (const [agentId, cfg] of Object.entries(state.config)) {
    if (!cfg.enabled || !isDreamEnrollable(agentId)) continue;
    const slots = slotsBetween(cfg.cron, cfg.enabledAt, now).filter((s) => !records.some((r) => r.agentId === agentId && r.slot === s));
    if (slots.length === 0) continue;
    const latest = slots[slots.length - 1];
    if (inFlight.has(recordKey(agentId, latest))) continue;
    for (const s of slots.slice(0, -1)) {
      records = upsertRecord(records, {
        agentId, slot: s, outcome: 'skipped', at: now, source: 'tab',
        reason: `Teamz was not open at ${clock(s)}; the slot was folded into the ${clock(latest)} Dream.`,
      });
    }
    const sinceAt = reviewSince({ ...state, records }, agentId, now);
    if (!ctx.providerLive) {
      records = upsertRecord(records, {
        agentId, slot: latest, outcome: 'skipped', at: now, source: 'tab',
        reason: 'The provider is set to mock mode, so there is no real model to review with. No call was made.',
      });
      continue;
    }
    const act = ctx.activity(agentId, sinceAt);
    if (act.messages === 0) {
      records = upsertRecord(records, {
        agentId, slot: latest, outcome: 'skipped', at: now, source: 'tab',
        reason: `No new messages in this agent’s sessions since ${clock(sinceAt)}, so there was nothing to review. No model call was made.`,
      });
      continue;
    }
    due.push({ agentId, slot: latest, sinceAt });
  }
  return { state: records === state.records ? state : { ...state, records }, due };
}

export interface DreamExecution {
  state: DreamState;
  record: DreamRecord;
  report: DreamReport | null;
}

/**
 * Run one due Dream through the injected `send` (the model call) and fold the
 * result into state. A thrown error or an invalid reply is a failed run.
 */
export async function executeDream(opts: {
  state: DreamState;
  due: DreamDue;
  agent: Pick<Agent, 'id' | 'name'>;
  review: ReviewInput;
  send: (prompt: string) => Promise<string>;
  now: () => number;
}): Promise<DreamExecution> {
  const { due, agent, review } = opts;
  const startedNow = opts.now();
  let outcome: ParsedDream;
  try {
    outcome = parseDreamReply(await opts.send(composeDreamPrompt(agent, review, startedNow)));
  } catch (err) {
    outcome = { ok: false, reason: `the model call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const at = opts.now();
  if (!outcome.ok) {
    const record: DreamRecord = { agentId: agent.id, slot: due.slot, outcome: 'failed', at, source: 'tab', reason: outcome.reason };
    return { state: { ...opts.state, records: upsertRecord(opts.state.records, record) }, record, report: null };
  }
  const report: DreamReport = {
    id: `dr-${agent.id}-${due.slot}`,
    agentId: agent.id,
    at,
    slot: due.slot,
    source: 'tab',
    changed: outcome.changed,
    summary: outcome.summary,
    findings: outcome.findings,
    proposals: outcome.proposals,
    reviewed: { sessions: review.sessionCount, messages: review.messageCount, sinceAt: review.sinceAt },
  };
  const record: DreamRecord = { agentId: agent.id, slot: due.slot, outcome: 'ran', at, source: 'tab', reportId: report.id };
  const notices = report.changed
    ? [...opts.state.notices, { id: `dn-${report.id}`, agentId: agent.id, reportId: report.id, at, read: false }].slice(-MAX_NOTICES)
    : opts.state.notices;
  return {
    state: {
      ...opts.state,
      records: upsertRecord(opts.state.records, record),
      reports: [...opts.state.reports.filter((r) => r.id !== report.id), report].sort((a, b) => a.at - b.at).slice(-MAX_REPORTS),
      notices,
    },
    record,
    report,
  };
}

/**
 * Pin the runner's own Dream replies. The runner posts each Dream cron reply
 * to the Build Room as a channel message; one that parses as a valid report
 * (same strict parser) becomes a pinned report. Anything else is left alone:
 * the runner's run record, not this function, decides whether that run failed.
 * Only the runner's last ~20 channel messages are visible, so a report is
 * kept the first time it is seen.
 */
export function ingestRunnerReports(state: DreamState, messages: RunnerChannelMessage[]): DreamState {
  let reports = state.reports;
  let notices = state.notices;
  for (const m of messages) {
    if ((m.kind !== 'cron' && m.kind !== 'orchestrator') || !isDreamEnrollable(m.agentId)) continue;
    const id = `dr-${m.agentId}-runner-${m.ts}`;
    if (reports.some((r) => r.id === id)) continue;
    const parsed = parseDreamReply(m.text);
    if (!parsed.ok) continue;
    const report: DreamReport = {
      id, agentId: m.agentId, at: m.ts, slot: m.ts, source: 'runner',
      changed: parsed.changed, summary: parsed.summary, findings: parsed.findings, proposals: parsed.proposals,
      reviewed: { sessions: 0, messages: 0, sinceAt: 0 },
    };
    reports = [...reports, report];
    if (report.changed) notices = [...notices, { id: `dn-${id}`, agentId: m.agentId, reportId: id, at: m.ts, read: false }].slice(-MAX_NOTICES);
  }
  if (reports === state.reports) return state;
  return { ...state, reports: reports.sort((a, b) => a.at - b.at).slice(-MAX_REPORTS), notices };
}

/* ---------------------------------------------------------- run record */

export interface SlotEntry {
  slot: number;
  source: DreamSource;
  outcome: SlotOutcome;
  reason?: string;
  reportId?: string;
}

export interface DreamCounts {
  planned: number;
  ran: number;
  skipped: number;
  failed: number;
  missed: number;
  pending: number;
}

export interface RunnerDreamRun {
  ts: number;
  ok: boolean;
  detail?: string;
}

/**
 * The runner's own run list for an agent's Dream cron, as slot entries.
 * Runner slots are inferred from the gaps between its runs (timezone-free):
 * a gap of k periods means k-1 slots produced no run of their own, and the
 * runner records no reason for that, so they are `missed` (unexplained).
 * A run whose reply excerpt looks like a refusal or provider error is
 * `failed` even though the runner marked it ok.
 */
export function runnerSlotEntries(runs: RunnerDreamRun[], cron: string, now: number, windowStart: number): SlotEntry[] {
  const period = (cronIntervalMinutes(cron) ?? 360) * 60_000;
  const sorted = [...runs].sort((a, b) => a.ts - b.ts);
  const out: SlotEntry[] = [];
  sorted.forEach((r, i) => {
    if (i > 0) {
      const gap = r.ts - sorted[i - 1].ts;
      const k = Math.round(gap / period);
      for (let j = 1; j < k; j++) {
        const slot = sorted[i - 1].ts + j * period;
        if (slot >= windowStart) out.push({ slot, source: 'runner', outcome: 'missed', reason: 'The runner fired late and recorded no reason for this slot.' });
      }
    }
    if (r.ts < windowStart) return;
    const bad = !r.ok || (r.detail ? looksLikeRefusalOrError(r.detail) : false);
    out.push(
      bad
        ? { slot: r.ts, source: 'runner', outcome: 'failed', reason: r.ok ? `The reply looks like a refusal or provider error: “${clip(r.detail ?? '', 140)}”` : r.detail || 'The runner recorded a failed run.' }
        : { slot: r.ts, source: 'runner', outcome: 'ran', reason: undefined },
    );
  });
  const last = sorted[sorted.length - 1];
  if (last) {
    const overdueBy = now - (last.ts + period);
    if (overdueBy > RUNNER_GRACE_MS) {
      for (let s = last.ts + period; s <= now - RUNNER_GRACE_MS; s += period) {
        if (s >= windowStart) out.push({ slot: s, source: 'runner', outcome: 'missed', reason: 'No run has been recorded for this slot.' });
      }
    }
  }
  return out;
}

function countsOf(entries: SlotEntry[]): DreamCounts {
  const c: DreamCounts = { planned: 0, ran: 0, skipped: 0, failed: 0, missed: 0, pending: 0 };
  for (const e of entries) {
    if (e.outcome === 'pending') c.pending += 1;
    else {
      c.planned += 1;
      c[e.outcome] += 1;
    }
  }
  return c;
}

export interface DreamRecordSummary {
  counts: DreamCounts;
  /** Newest first. */
  entries: SlotEntry[];
  windowStart: number;
}

/** Planned / ran / skipped / failed over a trailing window, for one agent (browser slots + runner runs). */
export function summarizeDream(
  state: DreamState,
  agentId: string,
  now: number,
  runnerRuns: RunnerDreamRun[] = [],
  windowMs: number = RECORD_WINDOW_MS,
): DreamRecordSummary {
  const windowStart = now - windowMs;
  const entries: SlotEntry[] = [];
  const cfg = state.config[agentId];
  if (cfg) {
    const from = Math.max(windowStart, cfg.enabledAt);
    for (const slot of slotsBetween(cfg.cron, from, now)) {
      const rec = state.records.find((r) => r.agentId === agentId && r.slot === slot);
      if (rec) entries.push({ slot, source: rec.source, outcome: rec.outcome, reason: rec.reason, reportId: rec.reportId });
      else if (!cfg.enabled) continue;
      else if (now - slot <= TAB_GRACE_MS) entries.push({ slot, source: 'tab', outcome: 'pending' });
      else entries.push({ slot, source: 'tab', outcome: 'missed', reason: 'No record was written for this slot.' });
    }
  }
  // Records outside the current cadence's slot grid (e.g. after a cadence change) still count.
  for (const r of state.records) {
    if (r.agentId === agentId && r.at >= windowStart && !entries.some((e) => e.slot === r.slot && e.source === r.source)) {
      entries.push({ slot: r.slot, source: r.source, outcome: r.outcome, reason: r.reason, reportId: r.reportId });
    }
  }
  if (runnerRuns.length > 0) entries.push(...runnerSlotEntries(runnerRuns, cfg?.cron ?? DREAM_CRON, now, windowStart));
  entries.sort((a, b) => b.slot - a.slot);
  return { counts: countsOf(entries), entries, windowStart };
}

export const describeCounts = (c: DreamCounts): string =>
  `${c.planned} planned · ${c.ran} ran · ${c.skipped} skipped · ${c.failed} failed${c.missed ? ` · ${c.missed} missed, unexplained` : ''}${c.pending ? ` · ${c.pending} due now` : ''}`;
