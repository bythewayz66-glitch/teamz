/**
 * Fleet graph — who calls whom, and what leaves Teamz.
 *
 * Pure and DOM-free. Every number comes from a recorded source; nothing is
 * estimated. Each source carries its own coverage (the earliest event it can
 * prove it saw), and an edge is only called DEAD when its source reaches back
 * past the window and still saw nothing. An edge whose source cannot prove
 * that is UNKNOWN, never dead and never zero.
 */

import type { Agent, Message } from '../types';
import type { LocalAutonomy, RunnerSnapshot } from './agentHome';
import { parseMentions } from './mentions';
import type { UsageLedger } from './usageLedger';
import { AGENT_PROGRAMME } from '../data/programmes';

export const WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

export type SourceId = 'mentions' | 'handoffs' | 'usage';
export type EdgeRelation = 'mention' | 'handoff' | 'model' | 'push' | 'web';
export type EdgeState = 'active' | 'dead' | 'unknown';

export interface SourceCoverage {
  id: SourceId;
  label: string;
  /** Earliest event time this source holds, or null when it holds nothing. */
  from: number | null;
  /** True when `from` is at or before the start of the window. */
  coversWindow: boolean;
  /** Plain-words limit of the source. */
  note: string;
}

export interface GraphNode {
  id: string;
  kind: 'agent' | 'integration';
  label: string;
  programme: string | null;
  /** Observed calls in the window across every edge touching this node. */
  activity: number;
  /** 'zero' only when every relevant source covers the window and saw nothing. */
  health: 'active' | 'zero' | 'unknown';
  breakdown: { mentionsOut: number; mentionsIn: number; handoffsOut: number; handoffsIn: number; modelCalls: number; pushes: number };
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: 'agent' | 'integration';
  relation: EdgeRelation;
  /** Observed calls in the window; null when no source records this edge. */
  count: number | null;
  /** Observed calls anywhere in the source's coverage. */
  total: number | null;
  lastAt: number | null;
  state: EdgeState;
  /** The edge is also declared by configuration (job stages, provider, tools). */
  declared: boolean;
  source: SourceId | null;
}

export interface FleetGraph {
  now: number;
  windowStart: number;
  windowDays: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  sources: SourceCoverage[];
  busiest: GraphNode[];
  zeroCall: GraphNode[];
  unknownHealth: GraphNode[];
}

export const providerNodeId = (provider: string) => `int:model:${provider}`;
export const GITHUB_NODE_ID = 'int:github';
export const WEB_NODE_ID = 'int:web';

/** First UTC day (YYYY-MM-DD) whose activity can fall inside the window. */
function dayCountsInWindow(date: string, windowStart: number): boolean {
  const dayEnd = Date.parse(`${date}T00:00:00Z`) + DAY_MS;
  return Number.isFinite(dayEnd) && dayEnd > windowStart;
}

interface JobLike {
  stages: Array<{ stage: string; agentId: string }>;
  runs: Array<{ stage?: string; status?: string; startedAt?: number; kind?: string }>;
}

function jobsOf(runner: RunnerSnapshot | null, local: LocalAutonomy | null): JobLike[] {
  const out: JobLike[] = [];
  for (const j of runner?.jobs ?? []) out.push({ stages: j.stages, runs: j.runs });
  for (const j of local?.jobs ?? []) out.push({ stages: j.stages, runs: j.runs ?? [] });
  return out;
}

const PUSH_STAGE = 'upgrade';
const isPushRun = (r: { stage?: string; kind?: string }) =>
  r.stage === PUSH_STAGE && (r.kind === undefined || r.kind === 'command');

class EdgeBook {
  edges = new Map<string, GraphEdge>();
  upsert(
    from: string,
    to: string,
    relation: EdgeRelation,
    kind: 'agent' | 'integration',
    source: SourceId | null,
    declared: boolean,
  ): GraphEdge {
    const id = `${relation}:${from}>${to}`;
    let e = this.edges.get(id);
    if (!e) {
      e = { id, from, to, kind, relation, count: null, total: null, lastAt: null, state: 'unknown', declared, source };
      this.edges.set(id, e);
    } else if (declared) e.declared = true;
    return e;
  }
}

export interface GraphInput {
  agents: Agent[];
  messages: Record<string, Message[]>;
  runner: RunnerSnapshot | null;
  local: LocalAutonomy | null;
  ledger: UsageLedger;
  now: number;
  windowDays?: number;
}

export function buildFleetGraph(input: GraphInput): FleetGraph {
  const { agents, runner, local, ledger, now } = input;
  const windowDays = input.windowDays ?? WINDOW_DAYS;
  const windowStart = now - windowDays * DAY_MS;
  const agentIds = new Set(agents.map((a) => a.id));
  const book = new EdgeBook();
  const nodeStat = new Map<string, GraphNode['breakdown']>();
  const stat = (id: string) => {
    let s = nodeStat.get(id);
    if (!s) {
      s = { mentionsOut: 0, mentionsIn: 0, handoffsOut: 0, handoffsIn: 0, modelCalls: 0, pushes: 0 };
      nodeStat.set(id, s);
    }
    return s;
  };

  /* ------------------------------------------------------------ mentions */
  const seen = new Set<string>();
  const allMessages: Message[] = [];
  for (const list of Object.values(input.messages)) {
    for (const m of list) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      allMessages.push(m);
    }
  }
  for (const m of runner?.channelMessages ?? []) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    allMessages.push({
      id: m.id,
      conversationId: m.channelId,
      authorType: 'agent',
      authorId: m.agentId || undefined,
      text: m.text,
      createdAt: m.ts,
      status: 'sent',
    });
  }
  let mentionsFrom: number | null = null;
  for (const m of allMessages) {
    if (m.createdAt && (mentionsFrom === null || m.createdAt < mentionsFrom)) mentionsFrom = m.createdAt;
    if (m.authorType !== 'agent' || !m.authorId || !agentIds.has(m.authorId)) continue;
    for (const target of parseMentions(m.text, agents)) {
      if (target.id === m.authorId) continue;
      const e = book.upsert(m.authorId, target.id, 'mention', 'agent', 'mentions', false);
      e.total = (e.total ?? 0) + 1;
      e.lastAt = Math.max(e.lastAt ?? 0, m.createdAt);
      if (m.createdAt >= windowStart) e.count = (e.count ?? 0) + 1;
    }
  }

  /* ------------------------------------------------- handoffs and pushes */
  const jobs = jobsOf(runner, local);
  let runsFrom: number | null = null;
  for (const j of jobs) for (const r of j.runs) if (r.startedAt && (runsFrom === null || r.startedAt < runsFrom)) runsFrom = r.startedAt;
  for (const j of jobs) {
    for (let i = 0; i < j.stages.length; i++) {
      const here = j.stages[i];
      const next = j.stages[i + 1];
      const okRuns = j.runs.filter((r) => r.stage === here.stage && r.status === 'ok' && r.startedAt);
      if (next && next.agentId !== here.agentId && agentIds.has(here.agentId) && agentIds.has(next.agentId)) {
        const e = book.upsert(here.agentId, next.agentId, 'handoff', 'agent', 'handoffs', true);
        e.count = e.count ?? 0;
        e.total = e.total ?? 0;
        for (const r of okRuns) {
          e.total += 1;
          e.lastAt = Math.max(e.lastAt ?? 0, r.startedAt!);
          if (r.startedAt! >= windowStart) e.count += 1;
        }
      }
      if (here.stage === PUSH_STAGE && agentIds.has(here.agentId)) {
        const e = book.upsert(here.agentId, GITHUB_NODE_ID, 'push', 'integration', 'handoffs', true);
        e.count = e.count ?? 0;
        e.total = e.total ?? 0;
        for (const r of j.runs.filter((x) => isPushRun(x) && x.status === 'ok' && x.startedAt)) {
          e.total += 1;
          e.lastAt = Math.max(e.lastAt ?? 0, r.startedAt!);
          if (r.startedAt! >= windowStart) e.count += 1;
        }
      }
    }
  }

  /* --------------------------------------------------------------- usage */
  const providerOf = new Map<string, string>();
  for (const a of runner?.agents ?? []) if (a.provider) providerOf.set(a.id, a.provider);
  const ledgerDates = Object.keys(ledger.days).sort();
  const usageFrom = ledger.since ? Date.parse(`${ledger.since}T00:00:00Z`) : null;
  const usageStartMs = usageFrom !== null && Number.isFinite(usageFrom) ? usageFrom : null;
  const callsByAgent = new Map<string, { win: number; total: number; lastAt: number | null }>();
  for (const date of ledgerDates) {
    const inWin = dayCountsInWindow(date, windowStart);
    for (const [agentId, b] of Object.entries(ledger.days[date])) {
      if (!agentIds.has(agentId)) continue;
      const c = callsByAgent.get(agentId) ?? { win: 0, total: 0, lastAt: null };
      c.total += b.calls;
      if (inWin) c.win += b.calls;
      if (b.calls > 0) c.lastAt = Math.max(c.lastAt ?? 0, Date.parse(`${date}T00:00:00Z`) + DAY_MS - 1);
      callsByAgent.set(agentId, c);
    }
  }
  const usageCovers = usageStartMs !== null && usageStartMs <= windowStart;
  for (const a of agents) {
    const prov = providerOf.get(a.id);
    const calls = callsByAgent.get(a.id);
    if (!prov && !calls) continue;
    const e = book.upsert(a.id, providerNodeId(prov ?? 'unrecorded'), 'model', 'integration', 'usage', !!prov);
    e.count = calls?.win ?? 0;
    e.total = calls?.total ?? 0;
    e.lastAt = calls?.lastAt ?? null;
  }

  /* ----------------------------------------------- declared, uncounted web */
  // The runner endpoint enables its full built-in toolset (web_search,
  // fetch_url, wikipedia, weather) for every runner agent. No source records
  // per-agent calls to them, so these edges are declared and stay UNKNOWN.
  for (const a of runner?.agents ?? []) {
    if (agentIds.has(a.id)) book.upsert(a.id, WEB_NODE_ID, 'web', 'integration', null, true);
  }

  /* ------------------------------------------------------------ coverage */
  const sources: SourceCoverage[] = [
    {
      id: 'mentions',
      label: '@mentions in messages',
      from: mentionsFrom,
      coversWindow: mentionsFrom !== null && mentionsFrom <= windowStart,
      note: 'Workspace messages plus the runner’s last ~20 channel messages; older runner history is not reachable from the browser.',
    },
    {
      id: 'handoffs',
      label: 'Job stage runs (handoffs, pushes)',
      from: runsFrom,
      coversWindow: runsFrom !== null && runsFrom <= windowStart,
      note: 'Runs the runner exposes per job; how far back it keeps them is not recorded here.',
    },
    {
      id: 'usage',
      label: 'Model calls (usage ledger)',
      from: usageStartMs,
      coversWindow: usageCovers,
      note: 'Counted only on days this browser fetched /usage, so totals are lower bounds.',
    },
  ];
  const covers = (id: SourceId) => sources.find((s) => s.id === id)!.coversWindow;

  for (const e of book.edges.values()) {
    if (e.source === null) {
      e.state = 'unknown';
      continue;
    }
    if ((e.count ?? 0) > 0) e.state = 'active';
    else e.state = covers(e.source) ? 'dead' : 'unknown';
  }

  /* --------------------------------------------------------------- nodes */
  for (const e of book.edges.values()) {
    const n = e.count ?? 0;
    if (e.relation === 'mention') {
      stat(e.from).mentionsOut += n;
      stat(e.to).mentionsIn += n;
    } else if (e.relation === 'handoff') {
      stat(e.from).handoffsOut += n;
      stat(e.to).handoffsIn += n;
    } else if (e.relation === 'model') stat(e.from).modelCalls += n;
    else if (e.relation === 'push') stat(e.from).pushes += n;
  }

  const hasJobStage = new Set<string>();
  for (const j of jobs) for (const s of j.stages) hasJobStage.add(s.agentId);

  const agentNodes: GraphNode[] = agents.map((a) => {
    const b = stat(a.id);
    const activity = b.mentionsOut + b.mentionsIn + b.handoffsOut + b.handoffsIn + b.modelCalls + b.pushes;
    const provable = covers('usage') && covers('mentions') && (!hasJobStage.has(a.id) || covers('handoffs'));
    const health: GraphNode['health'] = activity > 0 ? 'active' : provable ? 'zero' : 'unknown';
    return {
      id: a.id,
      kind: 'agent',
      label: a.name,
      programme: AGENT_PROGRAMME[a.id] ?? null,
      activity,
      health,
      breakdown: b,
    };
  });

  const intNodes = new Map<string, GraphNode>();
  for (const e of book.edges.values()) {
    if (e.kind !== 'integration' || intNodes.has(e.to)) continue;
    const label = e.to === GITHUB_NODE_ID ? 'GitHub (governed push)' : e.to === WEB_NODE_ID ? 'Web tools' : `Model: ${e.to.slice('int:model:'.length)}`;
    let activity = 0;
    for (const x of book.edges.values()) if (x.to === e.to) activity += x.count ?? 0;
    intNodes.set(e.to, {
      id: e.to,
      kind: 'integration',
      label,
      programme: null,
      activity,
      health: e.to === WEB_NODE_ID ? 'unknown' : activity > 0 ? 'active' : 'unknown',
      breakdown: { mentionsOut: 0, mentionsIn: 0, handoffsOut: 0, handoffsIn: 0, modelCalls: 0, pushes: 0 },
    });
  }

  const ranked = [...agentNodes].sort((a, b) => b.activity - a.activity || a.label.localeCompare(b.label));
  const edges = [...book.edges.values()].sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.id.localeCompare(b.id));

  return {
    now,
    windowStart,
    windowDays,
    nodes: [...agentNodes, ...intNodes.values()],
    edges,
    sources,
    busiest: ranked.filter((n) => n.activity > 0).slice(0, 3),
    zeroCall: agentNodes.filter((n) => n.health === 'zero').sort((a, b) => a.label.localeCompare(b.label)),
    unknownHealth: agentNodes.filter((n) => n.health === 'unknown').sort((a, b) => a.label.localeCompare(b.label)),
  };
}
