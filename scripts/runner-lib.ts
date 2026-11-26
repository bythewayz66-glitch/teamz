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
  requestApproval,
  type ApprovalRequest,
} from '../src/lib/governance';
import {
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
  systemPrompt?: string;
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
}

export function emptyRunnerState(): RunnerState {
  return { version: 1, agents: [], jobs: [], triggers: [], approvals: [], cronJobs: [] };
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
      const reply = await deps.dispatchPrompt(agent, trigger.prompt, trigger.channelId);
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
      const reply = await deps.dispatchPrompt(agent, cron.target, cron.channelId);
      const updated = recordCronRun(
        { ...cron, lastRunAt: nowMs },
        { ts: nowMs, ok: true, detail: reply.slice(0, 200) },
      );
      state.cronJobs = state.cronJobs.map((j) => (j.id === cron.id ? updated : j));
      fired.push(`cron ${cron.name} → ${agent.name}: ${reply.slice(0, 120)}`);
    } catch (err) {
      const updated = recordCronRun(
        { ...cron, lastRunAt: nowMs },
        { ts: nowMs, ok: false, detail: err instanceof Error ? err.message : String(err) },
      );
      state.cronJobs = state.cronJobs.map((j) => (j.id === cron.id ? updated : j));
      fired.push(`cron ${cron.name}: FAILED ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const job of state.jobs) {
    if (!isJobDue(job, now)) continue;
    if (job.runs.some((r) => r.status === 'dispatched')) continue;
    const plan = currentStage(job);
    if (!plan) continue;
    const started = startStage(job, state.approvals, nowMs);
    if (!started.ok) {
      if (started.needsApproval && !findPendingApproval(state.approvals, job.id, plan.stage)) {
        const req = requestApproval(
          job.id,
          job.name,
          plan.stage,
          `Stage "${plan.stage}" of "${job.name}" needs Jesse's approval: ${started.reason}`,
          nowMs,
        );
        state.approvals = [...state.approvals, req];
        state.jobs = state.jobs.map((j) => (j.id === job.id ? parkForApproval(j, nowMs) : j));
        fired.push(`job ${job.name} / ${plan.stage}: approval requested (${req.id})`);
      } else if (started.needsApproval) {
        state.jobs = state.jobs.map((j) => (j.id === job.id ? parkForApproval(j, nowMs) : j));
        fired.push(`job ${job.name} / ${plan.stage}: still awaiting approval`);
      } else {
        fired.push(`job ${job.name}: stage not started — ${started.reason}`);
      }
      continue;
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
      const reply = await deps.dispatchPrompt(agent, started.run.prompt, job.channelId);
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
