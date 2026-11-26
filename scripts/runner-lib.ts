/**
 * Runner library — the headless half of the autonomy system.
 *
 * This is what `scripts/runner.ts` (the jnet1 service) drives, and it is
 * built on exactly the same DOM-free core as the in-tab runner:
 * `src/lib/scheduler.ts` (cron + triggers + tick), `src/lib/jobs.ts`
 * (product lifecycle), and `src/lib/governance.ts` (approval gates). The
 * two runners differ only in transport: the tab sends through the chat UI,
 * this one POSTs to agent endpoints and runs allowlisted commands itself.
 *
 * State lives in one JSON file (`RunnerState` below). The service reloads
 * it from disk before every tick and writes it back after, so the file is
 * the shared surface: a future status page — or Jesse editing the file —
 * can add approvals and jobs, and the next tick picks them up. The browser
 * tab keeps its own copy in localStorage; the two are not yet synced, and
 * the server file is the authority for the 24/7 runner.
 *
 * Security rules, enforced here and not just documented:
 *  - Commands run only from a job's explicit allowlist (`isCommandAllowed`,
 *    exact argv match) and only via `spawn` with `shell: false` — there is
 *    no shell for an LLM reply to inject into, and a command that is not
 *    allowlisted is never spawned.
 *  - Commands never come from an LLM reply: a stage's command is fixed in
 *    the job definition when the job is created. An agent's reply can only
 *    become a stage's recorded output, never a command to run.
 *  - Gated stages (release / advertise / sell / spend / publish) never
 *    execute without a live approval record for that job + stage, checked
 *    by `canExecuteStage` inside `startStage` — the same gate as the tab.
 *  - This module never touches mem20 code. mem20 is the target repo the
 *    runner works on (a `workdir` + git commands), not a dependency.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  completeStageRun,
  currentStage,
  deserializeJob,
  isCommandAllowed,
  isJobDue,
  parkForApproval,
  startStage,
  type ProductJob,
} from '../src/lib/jobs';
import {
  findPendingApproval,
  decideApprovalByReviewer,
  isCarveOut,
  requestApproval,
  type ApprovalRequest,
} from '../src/lib/governance';
import { handleFor, parseMentions } from '../src/lib/mentions';
import type { Agent } from '../src/types';
import {
  createCronJob,
  recordCronRun,
  Schedule,
  tick as schedulerTick,
  type CronJob,
  type IntervalTrigger,
} from '../src/lib/scheduler';

/* ---------------------------------------------------------------------------
 * State file
 * ------------------------------------------------------------------------- */

/** One agent the runner can call: an HTTP endpoint, nothing more. */
export interface RunnerAgent {
  id: string;
  name: string;
  /** Agent HTTP endpoint, e.g. http://127.0.0.1:8001/chat. */
  endpointUrl: string;
  model?: string;
  /**
   * Keyless provider id from the provider registry (e.g. 'pollinations').
   * Absent means the endpoint's default provider. Set only by the
   * Provider Researcher write path, and only to validated keyless
   * providers — see docs/PROVIDER_RESEARCHER.md.
   */
  provider?: string;
  systemPrompt?: string;
}

/**
 * One message delivered to a channel by the runner — the Build Room's
 * record of what the headless agents actually said. Cron replies,
 * Orchestrator assignments, mention dispatches and resends are recorded
 * here so they are visible in the UI via /runner-state, not just in logs.
 */
export interface ChannelMessage {
  id: string;
  channelId: string;
  agentId: string;
  agentName: string;
  /** 'cron' | 'orchestrator' | 'mention' | 'researcher' | 'resend' */
  kind: string;
  text: string;
  ts: number;
}

/**
 * A rate-limit event the agent endpoint recorded when an upstream call
 * was refused (402/429). The retained `prompt` is the original request
 * that failed, so the runner can resend it instead of losing it.
 */
export interface RateLimitEvent {
  id: string;
  ts: number;
  agentId: string;
  agentName: string;
  channelId: string;
  /** The original user prompt that hit the rate limit, retained verbatim. */
  prompt: string;
  provider: string;
  error: string;
}

/** The record of one rate-limit rescue: what woke, what moved, what resent. */
export interface RateLimitRescue {
  eventId: string;
  ts: number;
  agentId: string;
  fromProvider: string;
  /** Provider the agent is on after the rescue (may be unchanged). */
  toProvider: string;
  /** The original request was resent on the (new) provider. */
  resent: boolean;
  /** The resend returned a real reply. */
  resendCompleted: boolean;
  researcherReply: string;
  attempts: number;
}

/**
 * The runner's whole world, in one JSON file. `jobs` are product-loop
 * jobs, `cronJobs` are scheduled prompt jobs, `triggers` are interval
 * prompts, `approvals` are Jesse's decisions. Agents are the address book
 * the runner POSTs to.
 */
export interface RunnerState {
  version: 1;
  agents: RunnerAgent[];
  jobs: ProductJob[];
  triggers: IntervalTrigger[];
  approvals: ApprovalRequest[];
  cronJobs: CronJob[];
  /** Build Room record of runner-delivered agent replies (newest kept). */
  channelMessages: ChannelMessage[];
  /** Rate-limit rescues, append-only (one record per event id). */
  rateLimitRescues: RateLimitRescue[];
}

export function emptyRunnerState(): RunnerState {
  return { version: 1, agents: [], jobs: [], triggers: [], approvals: [], cronJobs: [], channelMessages: [], rateLimitRescues: [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export interface LoadResult {
  state: RunnerState;
  warnings: string[];
}

/**
 * Load and validate a state file. Invalid entries are dropped with a
 * warning, never silently repaired; a missing file is an empty state, and
 * a malformed file is an error the caller must see.
 */
export function loadRunnerState(path: string): LoadResult {
  const warnings: string[] = [];
  if (!existsSync(path)) return { state: emptyRunnerState(), warnings };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`cannot parse runner state ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) throw new Error(`runner state ${path} is not a JSON object`);
  const state = emptyRunnerState();
  for (const a of Array.isArray(parsed.agents) ? parsed.agents : []) {
    if (isRecord(a) && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.endpointUrl === 'string') {
      state.agents.push({
        id: a.id,
        name: a.name,
        endpointUrl: a.endpointUrl,
        model: typeof a.model === 'string' ? a.model : undefined,
        provider: typeof a.provider === 'string' ? a.provider : undefined,
        systemPrompt: typeof a.systemPrompt === 'string' ? a.systemPrompt : undefined,
      });
    } else {
      warnings.push('dropped an agent entry without id, name, and endpointUrl');
    }
  }
  for (const rawJob of Array.isArray(parsed.jobs) ? parsed.jobs : []) {
    try {
      state.jobs.push(deserializeJob(rawJob));
    } catch (err) {
      warnings.push(`dropped an unreadable job: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const t of Array.isArray(parsed.triggers) ? parsed.triggers : []) {
    if (
      isRecord(t) && typeof t.id === 'string' && typeof t.channelId === 'string' &&
      typeof t.agentId === 'string' && typeof t.prompt === 'string' && typeof t.everyMs === 'number'
    ) {
      state.triggers.push(t as unknown as IntervalTrigger);
    } else {
      warnings.push('dropped a trigger entry with missing fields');
    }
  }
  for (const j of Array.isArray(parsed.cronJobs) ? parsed.cronJobs : []) {
    if (!isRecord(j) || typeof j.schedule !== 'string') {
      warnings.push('dropped a cron job entry without a schedule');
      continue;
    }
    try {
      new Schedule(j.schedule);
    } catch {
      warnings.push(`dropped a cron job with an invalid schedule: ${JSON.stringify(j.schedule)}`);
      continue;
    }
    state.cronJobs.push(j as unknown as CronJob);
  }
  for (const a of Array.isArray(parsed.approvals) ? parsed.approvals : []) {
    if (
      isRecord(a) && typeof a.id === 'string' && typeof a.jobId === 'string' &&
      typeof a.stage === 'string' &&
      (a.status === 'pending' || a.status === 'approved' || a.status === 'denied')
    ) {
      state.approvals.push(a as unknown as ApprovalRequest);
    } else {
      warnings.push('dropped an approval entry with missing fields');
    }
  }
  for (const m of Array.isArray(parsed.channelMessages) ? parsed.channelMessages : []) {
    if (
      isRecord(m) && typeof m.id === 'string' && typeof m.channelId === 'string' &&
      typeof m.agentId === 'string' && typeof m.text === 'string' && typeof m.ts === 'number'
    ) {
      state.channelMessages.push(m as unknown as ChannelMessage);
    } else {
      warnings.push('dropped a channel message entry with missing fields');
    }
  }
  for (const r of Array.isArray(parsed.rateLimitRescues) ? parsed.rateLimitRescues : []) {
    if (
      isRecord(r) && typeof r.eventId === 'string' && typeof r.agentId === 'string' &&
      typeof r.ts === 'number'
    ) {
      state.rateLimitRescues.push(r as unknown as RateLimitRescue);
    } else {
      warnings.push('dropped a rate-limit rescue entry with missing fields');
    }
  }
  return { state, warnings };
}

/** Write state atomically (temp file + rename) so a crash mid-write never corrupts it. */
export function saveRunnerState(path: string, state: RunnerState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/* ---------------------------------------------------------------------------
 * Prompt dispatch — the agent wire format, as documented in src/api/agents.ts
 * ------------------------------------------------------------------------- */

/**
 * The request body an agent endpoint expects: the agent's identity, the
 * message history (here: just this prompt, directed at this agent), and
 * the channel it belongs to. Same shape the browser sends.
 */
export function buildAgentRequest(agent: RunnerAgent, prompt: string, channelId: string): unknown {
  return {
    agent: {
      id: agent.id,
      name: agent.name,
      model: agent.model ?? '',
      provider: agent.provider ?? '',
      systemPrompt: agent.systemPrompt ?? '',
    },
    messages: [{ role: 'user', content: prompt }],
    channel: { id: channelId, name: channelId, members: [] },
    directed: true,
  };
}

/** Pull the reply text out of an agent's response, same shapes as `parseReply`. */
export function parseAgentReply(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') {
    throw new Error('agent returned an empty or non-JSON response');
  }
  const p = payload as Record<string, unknown>;
  for (const key of ['reply', 'text', 'message', 'content', 'output']) {
    if (typeof p[key] === 'string') return p[key] as string;
  }
  const choice = (p.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;
  const delta = (p.delta as { content?: unknown } | undefined)?.content;
  if (typeof delta === 'string') return delta;
  if (Array.isArray(p.content)) {
    const textBlock = (p.content as Array<{ text?: unknown }>).find((b) => typeof b?.text === 'string');
    if (textBlock) return textBlock.text as string;
  }
  throw new Error('agent replied, but the response did not contain readable text');
}

export interface DispatchOptions {
  /** Per-request timeout in milliseconds (default 60s). */
  timeoutMs?: number;
}

/**
 * Send one prompt to one agent over HTTP and return its reply text.
 * Throws on network failure, timeout, non-2xx, or an unreadable reply —
 * the caller records the failure on the run, it never becomes a success.
 */
export async function dispatchPromptToAgent(
  agent: RunnerAgent,
  prompt: string,
  channelId: string,
  options: DispatchOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(agent.endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildAgentRequest(agent, prompt, channelId)),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${agent.name} replied ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 240)}` : ''}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return parseAgentReply(await res.json());
    }
    const text = (await res.text()).trim();
    if (!text) throw new Error(`${agent.name} returned an empty reply`);
    return text;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`${agent.name} did not respond within ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------------
 * Channel messages, Orchestrator mentions, Reviewer replies, automations
 * ------------------------------------------------------------------------- */

/** Append a runner-delivered reply to the channel record (newest 200 kept). */
export function recordChannelMessage(
  state: RunnerState,
  message: Omit<ChannelMessage, 'id' | 'ts'> & { ts?: number },
): ChannelMessage {
  const full: ChannelMessage = {
    id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ts: message.ts ?? Date.now(),
    ...message,
    text: message.text.slice(0, 4000),
  };
  state.channelMessages = [...state.channelMessages, full].slice(-200);
  return full;
}

/** Max @-mention dispatches the Orchestrator may fan out in one run. */
export const MAX_ORCHESTRATOR_MENTIONS = 8;

/**
 * Who an Orchestrator reply @-mentions, resolved to runner agents.
 * Same parser as the UI (`src/lib/mentions.ts`: longest name wins, order
 * of first appearance), PLUS the id form (`@agent-qa-tester`): the
 * Orchestrator sees agents by id in the runner context and writes the
 * id as often as the display name, so both must resolve. Self-mentions
 * are dropped, unknown names never resolve, and the list is capped —
 * one level, no chaining.
 */
export function resolveMentionedAgents(
  reply: string,
  agents: RunnerAgent[],
  excludeId?: string,
): RunnerAgent[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits: Array<{ agent: RunnerAgent; pos: number }> = [];
  // Id form: @agent-qa-tester.
  for (const m of reply.matchAll(/@([A-Za-z][A-Za-z0-9_-]*)/g)) {
    const agent = byId.get(m[1]);
    if (agent && agent.id !== excludeId) hits.push({ agent, pos: m.index ?? 0 });
  }
  // Name / handle form, via the UI parser.
  const parsed = parseMentions(reply, agents as unknown as Agent[]);
  for (const hit of parsed) {
    const agent = byId.get(hit.id);
    if (!agent || agent.id === excludeId) continue;
    const re = new RegExp(`@(?:${escapeRe(agent.name)}|${escapeRe(handleFor(agent.name))})`, 'i');
    const mm = re.exec(reply);
    hits.push({ agent, pos: mm?.index ?? 0 });
  }
  hits.sort((a, b) => a.pos - b.pos);
  const seen = new Set<string>();
  const out: RunnerAgent[] = [];
  for (const hit of hits) {
    if (seen.has(hit.agent.id)) continue;
    seen.add(hit.agent.id);
    out.push(hit.agent);
    if (out.length >= MAX_ORCHESTRATOR_MENTIONS) break;
  }
  return out;
}

/** The Reviewer's verdict, from a one-line `APPROVE: <reason>` / `DENY: <reason>` reply. */
export function parseReviewerReply(
  reply: string,
): { decision: 'approve' | 'deny'; reason: string } | null {
  const approve = /^APPROVE[D]?:\s*(.+)$/im.exec(reply);
  if (approve) return { decision: 'approve', reason: approve[1].trim().slice(0, 500) };
  const deny = /^DEN(?:Y|IED):\s*(.+)$/im.exec(reply);
  if (deny) return { decision: 'deny', reason: deny[1].trim().slice(0, 500) };
  const denyBare = /^\s*DENY\b/im.exec(reply);
  if (denyBare) return { decision: 'deny', reason: reply.trim().slice(0, 500) };
  return null;
}

/** A proposed automation, as the Orchestrator (or the endpoint) submits it. */
export interface AutomationProposal {
  name: string;
  schedule: string;
  agentId: string;
  channelId: string;
  target: string;
}

/** Words that mark a proposal as spending, publishing, or destructive. */
const CARVE_OUT_WORDS =
  /\b(spend|spending|pay|payment|purchase|buy|charge|publish|public|release|deploy|delete|destroy|remove|wipe|drop)\b/i;

/**
 * Validate a proposed automation the way POST /automations does (the
 * endpoint duplicates these rules in plain JS — keep them in sync).
 * Returns the refusal reason; `carveOut` means "route to Jesse", never
 * to the Reviewer and never auto-approved.
 */
export function validateAutomationProposal(
  input: AutomationProposal,
  agents: RunnerAgent[],
): { ok: true } | { ok: false; reason: string; carveOut: boolean } {
  const name = (input.name ?? '').trim();
  if (!name) return { ok: false, reason: 'an automation needs a name', carveOut: false };
  try {
    new Schedule(input.schedule ?? '');
  } catch {
    return { ok: false, reason: `invalid cron schedule: ${JSON.stringify(input.schedule)}`, carveOut: false };
  }
  if (!agents.some((a) => a.id === input.agentId)) {
    return { ok: false, reason: `unknown agent ${input.agentId}`, carveOut: false };
  }
  if (input.channelId !== 'conv-build-room') {
    return { ok: false, reason: 'automations run only in conv-build-room', carveOut: false };
  }
  const target = (input.target ?? '').trim();
  if (!target) return { ok: false, reason: 'an automation needs a target prompt', carveOut: false };
  if (target.length > 2000) {
    return { ok: false, reason: 'target prompt is too long (max 2000 chars)', carveOut: false };
  }
  if (CARVE_OUT_WORDS.test(`${name} ${target}`)) {
    return {
      ok: false,
      reason: 'refused: the proposal spends money, publishes publicly, releases, or deletes — that needs Jesse, not an automation',
      carveOut: true,
    };
  }
  return { ok: true };
}

/** Build the CronJob for a validated proposal (throws when invalid). */
export function createAutomationFromProposal(input: AutomationProposal, agents: RunnerAgent[]): CronJob {
  const check = validateAutomationProposal(input, agents);
  if (!check.ok) throw new Error(`invalid automation proposal: ${check.reason}`);
  return createCronJob({
    name: input.name.trim(),
    schedule: input.schedule.trim(),
    type: 'prompt',
    target: input.target.trim(),
    agentId: input.agentId,
    channelId: input.channelId,
  });
}

/* ---------------------------------------------------------------------------
 * Command execution — allowlist + argv + timeout, no shell, ever
 * ------------------------------------------------------------------------- */

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  /** Captured stdout + stderr, truncated. Empty when blocked. */
  output: string;
  timedOut: boolean;
  /** True when the command was refused without spawning anything. */
  blocked: boolean;
  blockedReason: string | null;
}

export interface ExecuteOptions {
  /** Kill the command after this long (default 120s, matching the Python source). */
  timeoutMs?: number;
  /** Cap on captured output in characters (default 8000). */
  maxOutputChars?: number;
}

/**
 * Execute one allowlisted command in a job's working directory.
 *
 * The guard runs twice: `isCommandAllowed` (exact argv match against the
 * job's allowlist) and `spawn` with `shell: false`, so argv is passed
 * literally to the executable — a `;`, `|`, or `$()` in an argument is
 * data, never a second command. A refused command returns a blocked
 * result; nothing is spawned, nothing is faked as a run.
 */
export function executeAllowedCommand(
  job: ProductJob,
  argv: string[],
  options: ExecuteOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxChars = options.maxOutputChars ?? 8000;
  if (!isCommandAllowed(job, argv)) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      output: '',
      timedOut: false,
      blocked: true,
      blockedReason: `command ${JSON.stringify(argv)} is not on job "${job.name}"'s allowlist`,
    });
  }
  return new Promise((resolve) => {
    const cap = (s: string) => (s.length > maxChars ? s.slice(0, maxChars) + `\n…[output truncated at ${maxChars} chars]` : s);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: job.workdir || process.cwd(),
        shell: false,
        timeout: timeoutMs,
        windowsHide: true,
      });
    } catch (err) {
      // spawn() throws synchronously for an invalid argv (e.g. empty command).
      finish({
        ok: false,
        exitCode: null,
        output: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        timedOut: false,
        blocked: false,
        blockedReason: null,
      });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        exitCode: null,
        output: cap(stdout + stderr),
        timedOut: true,
        blocked: false,
        blockedReason: null,
      });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8');
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        exitCode: null,
        output: cap(`${stdout}${stderr}`) || `spawn failed: ${err.message}`,
        timedOut: false,
        blocked: false,
        blockedReason: null,
      });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      finish({
        ok: code === 0,
        exitCode: code,
        output: cap(`${stdout}${stderr}`),
        timedOut: false,
        blocked: false,
        blockedReason: null,
      });
    });
  });
}

/* ---------------------------------------------------------------------------
 * processDue — one tick of the headless runner
 * ------------------------------------------------------------------------- */

export interface RunnerDeps {
  dispatchPrompt: (agent: RunnerAgent, prompt: string, channelId: string) => Promise<string>;
  executeCommand: (job: ProductJob, argv: string[]) => Promise<CommandResult>;
  log: (message: string) => void;
  /**
   * Unhandled rate-limit events the agent endpoint recorded (the runner
   * polls this on its own tick — never a tight loop). Empty when the
   * caller has none; the rescue runs on the tick that sees the event.
   */
  rateLimitEvents?: () => Promise<RateLimitEvent[]>;
  /** Mark events handled after a rescue attempt (success or exhausted). */
  acknowledgeRateLimitEvents?: (ids: string[]) => Promise<void>;
  /**
   * Re-read the agent address book from disk — the Provider
   * Researcher's tools may have reassigned an agent in state.json while
   * this tick was running, and a resend must use the NEW assignment.
   */
  reloadAgents?: () => Promise<RunnerAgent[]>;
  /**
   * Minimum milliseconds between the END of one dispatch and the START
   * of the next (default 0 — tests). The live runner passes 50_000:
   * the endpoint enforces a 50s gap between upstream calls inside
   * each dispatch's 60s budget, so a second dispatch in the same tick
   * would burn ~50s of its budget waiting and then fail with "did not
   * respond in the time left" (observed live Nov 26, 2026). Waiting
   * BETWEEN dispatches — outside any dispatch's budget — keeps every
   * dispatch's model call inside its 60s. The tick gets longer (the
   * hourly batch drains over ~22 min); the service skips ticks while
   * one is still running (see scripts/runner.ts).
   */
  minDispatchGapMs?: number;
}

export interface ProcessDueResult {
  state: RunnerState;
  /** Human-readable lines of what this tick did, for the log. */
  fired: string[];
}

/**
 * One tick: find due triggers, cron jobs, and product-job stages, and act
 * on them. This is the headless twin of the in-tab tick in
 * `store/useAutonomy.ts` — same `tick()` primitive, same governance gate,
 * same stage lifecycle — with two transport differences: prompt stages go
 * to agent endpoints over HTTP, and command stages actually execute (the
 * tab can only note that it cannot).
 *
 * A failure in one item is recorded on that item and logged; it never
 * aborts the rest of the tick.
 */
export async function processDue(
  input: RunnerState,
  now: Date,
  deps: RunnerDeps,
): Promise<ProcessDueResult> {
  const state: RunnerState = structuredClone(input);
  const nowMs = now.getTime();
  const fired: string[] = [];
  const agentById = new Map(state.agents.map((a) => [a.id, a]));

  // Gap-spaced dispatch: every prompt in this tick goes through here,
  // so the wait between dispatches happens OUTSIDE any dispatch's 60s
  // budget (see RunnerDeps.minDispatchGapMs).
  const minGapMs = deps.minDispatchGapMs ?? 0;
  let lastDispatchEndedAt = 0;
  const dispatch = async (agent: RunnerAgent, prompt: string, channelId: string): Promise<string> => {
    if (minGapMs > 0) {
      const wait = minGapMs - (Date.now() - lastDispatchEndedAt);
      if (wait > 0) {
        deps.log(`spacing: waiting ${Math.ceil(wait / 1000)}s before dispatch to ${agent.name}`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    try {
      return await deps.dispatchPrompt(agent, prompt, channelId);
    } finally {
      lastDispatchEndedAt = Date.now();
    }
  };

  const { dueJobs, dueTriggers } = schedulerTick(now, state.cronJobs, state.triggers);

  for (const trigger of dueTriggers) {
    const agent = agentById.get(trigger.agentId);
    state.triggers = state.triggers.map((t) =>
      t.id === trigger.id ? { ...t, lastRunAt: nowMs } : t,
    );
    if (!agent) {
      fired.push(`trigger ${trigger.id}: unknown agent ${trigger.agentId}, skipped`);
      continue;
    }
    try {
      const reply = await dispatch(agent, trigger.prompt, trigger.channelId);
      fired.push(`trigger → ${agent.name} in ${trigger.channelId}: ${reply.slice(0, 120)}`);
    } catch (err) {
      fired.push(`trigger → ${agent.name}: FAILED ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const cron of dueJobs) {
    state.cronJobs = state.cronJobs.map((j) =>
      j.id === cron.id ? { ...j, lastRunAt: nowMs } : j,
    );
    if (cron.type === 'command') {
      // Cron jobs carry no allowlist, so there is no safe way to run them.
      // Refuse honestly; a command belongs in a product-job stage.
      const updated = recordCronRun(
        { ...cron, lastRunAt: nowMs },
        { ts: nowMs, ok: false, detail: 'command cron jobs are refused: no per-job allowlist — use a product-job command stage' },
      );
      state.cronJobs = state.cronJobs.map((j) => (j.id === cron.id ? updated : j));
      fired.push(`cron ${cron.name}: command refused (no allowlist)`);
      continue;
    }
    const agent = cron.agentId ? agentById.get(cron.agentId) : undefined;
    if (!agent || !cron.channelId) {
      const updated = recordCronRun(
        { ...cron, lastRunAt: nowMs },
        { ts: nowMs, ok: false, detail: 'no agent/channel for this prompt job' },
      );
      state.cronJobs = state.cronJobs.map((j) => (j.id === cron.id ? updated : j));
      fired.push(`cron ${cron.name}: no agent/channel, skipped`);
      continue;
    }
    try {
      const reply = await dispatch(agent, cron.target, cron.channelId);
      const updated = recordCronRun(
        { ...cron, lastRunAt: nowMs },
        { ts: nowMs, ok: true, detail: reply.slice(0, 200) },
      );
      state.cronJobs = state.cronJobs.map((j) => (j.id === cron.id ? updated : j));
      recordChannelMessage(state, {
        channelId: cron.channelId,
        agentId: agent.id,
        agentName: agent.name,
        kind: cron.agentId === 'agent-orchestrator' ? 'orchestrator' : 'cron',
        text: reply,
      });
      fired.push(`cron ${cron.name} → ${agent.name}: ${reply.slice(0, 120)}`);
      // Orchestrator mention flow: the Orchestrator assigns work by
      // @mentioning agents in its reply. Dispatch each mentioned agent
      // once, one level only (max 8) — the same bounds as the UI's
      // mention flow (depth 4, max 8 replies) in runner form.
      if (cron.agentId === 'agent-orchestrator') {
        const mentioned = resolveMentionedAgents(reply, state.agents, agent.id);
        for (const target of mentioned) {
          const assignment =
            `Assignment from @Orchestrator in the Build Room (conv-build-room):\n\n${reply}\n\n` +
            `Do the part addressed to you (@${target.name}) and reply with the completed output. Keep it to one reply.`;
          try {
            const targetReply = await dispatch(target, assignment, cron.channelId);
            recordChannelMessage(state, {
              channelId: cron.channelId,
              agentId: target.id,
              agentName: target.name,
              kind: 'mention',
              text: targetReply,
            });
            fired.push(`orchestrator → @${target.name}: ${targetReply.slice(0, 120)}`);
          } catch (err) {
            fired.push(
              `orchestrator → @${target.name}: FAILED ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (mentioned.length === 0) {
          fired.push('orchestrator: no @mentions in reply — nothing assigned this run');
        }
      }
    } catch (err) {
      const updated = recordCronRun(
        { ...cron, lastRunAt: nowMs },
        { ts: nowMs, ok: false, detail: err instanceof Error ? err.message : String(err) },
      );
      state.cronJobs = state.cronJobs.map((j) => (j.id === cron.id ? updated : j));
      fired.push(`cron ${cron.name}: FAILED ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Rate-limit rescue (event-driven, on the runner's own tick — never a
  // tight loop). The endpoint records a 402/429 as an event with the
  // failed request retained; the tick that sees it wakes the Provider
  // Researcher, lets it provision/reassign via its tools, then resends
  // the original request on the (possibly new) provider so the failed
  // request is not lost. An event with a completed rescue, or 3 failed
  // attempts, is not retried — the failure stays on the record.
  if (deps.rateLimitEvents) {
    let events: RateLimitEvent[] = [];
    try {
      events = await deps.rateLimitEvents();
    } catch (err) {
      fired.push(`rate-limit check FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const event of events) {
      const prior = state.rateLimitRescues.find((r) => r.eventId === event.id);
      if (prior && (prior.resendCompleted || prior.attempts >= 3)) continue;
      const researcher = agentById.get('agent-provider-researcher');
      const failedAgent = agentById.get(event.agentId);
      let researcherReply = 'no Provider Researcher agent configured';
      if (researcher) {
        const wakePrompt =
          `RATE-LIMIT RESCUE — wake up. Agent @${event.agentName} hit a rate limit on provider ` +
          `"${event.provider}" in channel ${event.channelId} (${event.error}). ` +
          `Use your tools: search for a new keyless provider, validate it with a live test call, ` +
          `provision it with add_provider, and reassign @${event.agentName} to it with reassign_agent ` +
          `(record the change with the reason "rate limit"). If no new provider validates, say so ` +
          `plainly — do not invent one. The runner will resend the agent's original request after you reply. ` +
          `Then return to standby.`;
        try {
          researcherReply = await dispatch(researcher, wakePrompt, event.channelId);
          recordChannelMessage(state, {
            channelId: event.channelId,
            agentId: researcher.id,
            agentName: researcher.name,
            kind: 'researcher',
            text: researcherReply,
          });
        } catch (err) {
          researcherReply = `Researcher dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      // The Researcher's tools may have reassigned the agent in
      // state.json on disk; re-read so the resend uses the new provider.
      let resendAgent = failedAgent;
      if (deps.reloadAgents) {
        try {
          const fresh = await deps.reloadAgents();
          const updated = fresh.find((a) => a.id === event.agentId);
          if (updated) {
            resendAgent = updated;
            state.agents = state.agents.map((a) => (a.id === updated.id ? updated : a));
            agentById.set(updated.id, updated);
          }
        } catch (err) {
          fired.push(`rate-limit rescue: could not reload agents — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      let resent = false;
      let resendCompleted = false;
      if (resendAgent) {
        try {
          const resendReply = await dispatch(resendAgent, event.prompt, event.channelId);
          resent = true;
          resendCompleted = true;
          recordChannelMessage(state, {
            channelId: event.channelId,
            agentId: resendAgent.id,
            agentName: resendAgent.name,
            kind: 'resend',
            text: resendReply,
          });
          fired.push(`rate-limit rescue: resent @${resendAgent.name}'s request on ${resendAgent.provider ?? 'default provider'} — completed`);
        } catch (err) {
          resent = true;
          fired.push(`rate-limit rescue: resend FAILED — ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        fired.push(`rate-limit rescue: unknown agent ${event.agentId}, cannot resend`);
      }
      const rescue: RateLimitRescue = {
        eventId: event.id,
        ts: nowMs,
        agentId: event.agentId,
        fromProvider: event.provider,
        toProvider: resendAgent?.provider ?? event.provider,
        resent,
        resendCompleted,
        researcherReply: researcherReply.slice(0, 500),
        attempts: (prior?.attempts ?? 0) + 1,
      };
      state.rateLimitRescues = [
        ...state.rateLimitRescues.filter((r) => r.eventId !== event.id),
        rescue,
      ];
      if (deps.acknowledgeRateLimitEvents && (resendCompleted || rescue.attempts >= 3)) {
        try {
          await deps.acknowledgeRateLimitEvents([event.id]);
        } catch (err) {
          fired.push(`rate-limit rescue: acknowledge FAILED — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  for (const job of state.jobs) {
    if (!isJobDue(job, now)) continue;
    if (job.runs.some((r) => r.status === 'dispatched')) continue;
    const plan = currentStage(job);
    if (!plan) continue;
    let started = startStage(job, state.approvals, nowMs);
    if (!started.ok) {
      const blockedReason = started.reason;
      if (!started.needsApproval) {
        fired.push(`job ${job.name}: stage not started — ${blockedReason}`);
        continue;
      }
      if (findPendingApproval(state.approvals, job.id, plan.stage)) {
        state.jobs = state.jobs.map((j) => (j.id === job.id ? parkForApproval(j, nowMs) : j));
        fired.push(`job ${job.name} / ${plan.stage}: still awaiting approval`);
        continue;
      }
      // Carve-out FIRST: release / advertise / sell, or any stage that
      // spends money, publishes publicly, or destroys something ALWAYS
      // goes to Jesse. The Reviewer is never even asked.
      const requestJesse = (note: string) => {
        const req = requestApproval(
          job.id,
          job.name,
          plan.stage,
          `Stage "${plan.stage}" of "${job.name}" needs Jesse's approval: ${blockedReason}. ${note}`,
          nowMs,
        );
        state.approvals = [...state.approvals, req];
        state.jobs = state.jobs.map((j) => (j.id === job.id ? parkForApproval(j, nowMs) : j));
        fired.push(`job ${job.name} / ${plan.stage}: approval requested from Jesse (${req.id})`);
      };
      if (isCarveOut(plan.stage, plan.flags)) {
        requestJesse('Carve-out — the Reviewer may never approve this.');
        continue;
      }
      // Routine gated stage: ask the Reviewer. Approved in writing, with
      // the decision recorded as decidedBy 'reviewer'; denied parks the
      // job. If the Reviewer is unreachable or its reply is unreadable,
      // fall back to a Jesse approval request — never silently approve.
      const reviewer = agentById.get('agent-reviewer');
      if (!reviewer) {
        requestJesse('No Reviewer agent configured — routed to Jesse.');
        continue;
      }
      try {
        const reviewerPrompt =
          `REVIEW REQUEST — decide this routine operational stage.\n` +
          `Job: "${job.name}" (id ${job.id})\nStage: ${plan.stage}\n` +
          `Stage prompt: ${plan.prompt}\nExpected output: ${plan.expectedOutput}\n` +
          `Reply with exactly one line: "APPROVE: <reason>" or "DENY: <reason>". ` +
          `You must NEVER approve spending money, public releases, or destructive or deletion ` +
          `actions — if this request touches any of those, reply "DENY: carve-out — needs Jesse".`;
        const reply = await dispatch(reviewer, reviewerPrompt, job.channelId);
        const verdict = parseReviewerReply(reply);
        if (!verdict) {
          throw new Error(`unreadable Reviewer reply: ${reply.slice(0, 200)}`);
        }
        const req = requestApproval(
          job.id,
          job.name,
          plan.stage,
          `Stage "${plan.stage}" of "${job.name}" needs a decision: ${blockedReason}`,
          nowMs,
        );
        if (verdict.decision === 'deny') {
          state.approvals = [
            ...state.approvals,
            decideApprovalByReviewer(req, 'denied', verdict.reason, nowMs),
          ];
          state.jobs = state.jobs.map((j) => (j.id === job.id ? parkForApproval(j, nowMs) : j));
          fired.push(`job ${job.name} / ${plan.stage}: DENIED by Reviewer — ${verdict.reason}`);
          continue;
        }
        state.approvals = [
          ...state.approvals,
          decideApprovalByReviewer(req, 'approved', verdict.reason, nowMs),
        ];
        fired.push(`job ${job.name} / ${plan.stage}: APPROVED by Reviewer — ${verdict.reason}`);
        const retry = startStage(job, state.approvals, nowMs);
        if (!retry.ok) {
          state.jobs = state.jobs.map((j) => (j.id === job.id ? parkForApproval(j, nowMs) : j));
          fired.push(`job ${job.name} / ${plan.stage}: still blocked after Reviewer approval — ${retry.reason}`);
          continue;
        }
        started = retry;
      } catch (err) {
        requestJesse(
          `Reviewer unavailable or unreadable (${err instanceof Error ? err.message : String(err)}) — falling back to Jesse.`,
        );
        continue;
      }
    }
    // Record the dispatched run first, so a crash mid-stage cannot lose it.
    state.jobs = state.jobs.map((j) => (j.id === job.id ? started.job : j));
    if (started.run.kind === 'command' && plan.command) {
      const result = await deps.executeCommand(job, plan.command.argv);
      if (result.blocked) {
        const { job: nextJob, approvals: nextApprovals } = completeStageRun(
          started.job,
          started.run.id,
          result.blockedReason ?? 'command blocked',
          false,
          state.approvals,
          Date.now(),
        );
        state.jobs = state.jobs.map((j) => (j.id === job.id ? nextJob : j));
        state.approvals = nextApprovals;
        fired.push(`job ${job.name} / ${plan.stage}: command BLOCKED — ${result.blockedReason}`);
        continue;
      }
      const output = result.timedOut
        ? `${result.output}\n[command timed out]`
        : result.output || `(exit ${result.exitCode}, no output)`;
      const { job: nextJob, approvals: nextApprovals } = completeStageRun(
        started.job,
        started.run.id,
        output,
        result.ok,
        state.approvals,
        Date.now(),
      );
      state.jobs = state.jobs.map((j) => (j.id === job.id ? nextJob : j));
      state.approvals = nextApprovals;
      fired.push(
        `job ${job.name} / ${plan.stage}: command ${result.ok ? 'ok' : 'failed'} (exit ${result.exitCode})`,
      );
      continue;
    }
    const agent = agentById.get(started.run.agentId);
    if (!agent) {
      const { job: nextJob } = completeStageRun(
        started.job,
        started.run.id,
        `unknown agent ${started.run.agentId}`,
        false,
        state.approvals,
        Date.now(),
      );
      state.jobs = state.jobs.map((j) => (j.id === job.id ? nextJob : j));
      fired.push(`job ${job.name} / ${plan.stage}: unknown agent ${started.run.agentId}, run failed`);
      continue;
    }
    try {
      const reply = await dispatch(agent, started.run.prompt, job.channelId);
      const { job: nextJob, approvals: nextApprovals } = completeStageRun(
        started.job,
        started.run.id,
        reply,
        true,
        state.approvals,
        Date.now(),
      );
      state.jobs = state.jobs.map((j) => (j.id === job.id ? nextJob : j));
      state.approvals = nextApprovals;
      fired.push(`job ${job.name} / ${plan.stage} → ${agent.name}: ${reply.slice(0, 120)}`);
    } catch (err) {
      const { job: nextJob } = completeStageRun(
        started.job,
        started.run.id,
        err instanceof Error ? err.message : String(err),
        false,
        state.approvals,
        Date.now(),
      );
      state.jobs = state.jobs.map((j) => (j.id === job.id ? nextJob : j));
      fired.push(`job ${job.name} / ${plan.stage}: FAILED ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const line of fired) deps.log(line);
  return { state, fired };
}
