/**
 * Jobs — the autonomous product loop, modelled on mem20crewz.
 *
 * A job is a chain of stage-tasks that walks the product lifecycle Jesse
 * named: design → build → implement → upgrade → release → document →
 * advertise → sell. Each stage is one scheduled agent run, modelled on a
 * mem20crewz `Task`: a name, a description, an expected output, an assigned
 * agent, upstream context, and a human-review flag. Each run records a
 * `StageRun` modelled on `TaskOutcome`: which run produced which output,
 * when, in which channel, and under which approval — the provenance trail.
 *
 * Distribution follows the mem20crewz Crew pattern, not a dispatcher that
 * pushes work: a job optionally names a `managerAgentId`, and the manager
 * agent distributes each stage to its owner agent (the stage's `agentId`).
 * Stages run in order and each stage's prompt is assembled with the
 * completed outputs of its upstream stages as context — the same sequential
 * context chaining a Crew does, where each task's output feeds the next
 * task's `context` list.
 *
 * Governance is enforced at `startStage`: a gated stage (release,
 * advertise, sell — or any stage flagged as spending money or publishing
 * publicly) cannot start without a live approval record for that job +
 * stage; see `lib/governance.ts`. A blocked start returns a result instead
 * of throwing, so the runner can file the approval request and park the job
 * in `awaiting_approval`.
 *
 * This module is pure and DOM-free: no `window`, no storage, no timers.
 * Persistence lives in `store/useAutonomy.ts`, which serialises jobs with
 * `serializeJob` / `deserializeJob` below.
 */

import {
  canExecuteStage,
  consumeApproval,
  findLiveApproval,
  stageRequiresApproval,
  type ApprovalRequest,
  type GateFlags,
} from './governance';
import { Schedule, minuteKey } from './scheduler';

/** The product lifecycle, in order. A job's stages are a subsequence of this. */
export const PRODUCT_STAGES = [
  'design',
  'build',
  'implement',
  'upgrade',
  'release',
  'document',
  'advertise',
  'sell',
] as const;

export type JobStage = (typeof PRODUCT_STAGES)[number];

/** Index of a stage in the lifecycle order, for ordering checks. */
export function stageIndex(stage: JobStage): number {
  return PRODUCT_STAGES.indexOf(stage);
}

export type JobStatus = 'active' | 'paused' | 'awaiting_approval' | 'done' | 'failed';

/**
 * When a job's stages fire. `manual` means the job only runs when Jesse
 * (or a Run now) starts it; `interval` and `cron` are evaluated by the
 * runner tick, using the same rules as `lib/scheduler.ts`.
 */
export type JobSchedule =
  | { kind: 'manual' }
  | { kind: 'interval'; everyMs: number }
  | { kind: 'cron'; expr: string };

/**
 * One lifecycle stage of a job — the mem20crewz Task shape, adapted:
 * `prompt` is the task description, `expectedOutput` is what "done" looks
 * like, `contextStages` names the upstream stages whose outputs feed this
 * stage's prompt, and `humanInput` is set for gated stages (Task's
 * human-review flag) so a gated stage can never be mistaken for routine.
 *
 * A stage does its work in one of two ways:
 *  - a prompt stage (the default): the runner sends `prompt` to the
 *    stage's agent and the reply becomes the stage's recorded output;
 *  - a command stage (`command` set): the runner executes the command in
 *    the job's working directory and the captured output becomes the
 *    stage's recorded output. Command stages exist so a job can do real
 *    work on a checked-out repo (git, tests, builds). They only ever run
 *    on the server runner — a browser tab cannot run shell commands — and
 *    only when the command is on the job's explicit `allowedCommands`
 *    allowlist (see `isCommandAllowed`). The command is argv, never a
 *    shell string, and never comes from an LLM reply.
 */
export interface StagePlan {
  stage: JobStage;
  agentId: string;
  prompt: string;
  expectedOutput: string;
  contextStages: JobStage[];
  humanInput: boolean;
  /** Set when this stage's work spends money or publishes publicly. */
  flags?: GateFlags;
  /** Command stage: exact argv to execute (no shell). Requires allowlisting. */
  command?: { argv: string[] };
}

export type StageRunStatus = 'dispatched' | 'ok' | 'failed' | 'blocked';

/**
 * One recorded stage run — the mem20crewz TaskOutcome shape: the task, the
 * agent, whether it worked, the output it produced, where that output lives
 * (channel + message), when it ran, and which approval authorised it when
 * the stage was gated. The output is the stage's recorded output; the
 * channel message is the primary record and this is the pointer to it.
 */
export interface StageRun {
  id: string;
  jobId: string;
  stage: JobStage;
  agentId: string;
  prompt: string;
  status: StageRunStatus;
  output: string | null;
  conversationId: string;
  /** Message id of the agent's reply in the channel, once it arrives. */
  messageId: string | null;
  startedAt: number;
  finishedAt: number | null;
  blockedReason: string | null;
  /** Approval that authorised this run, for gated stages. */
  approvalId: string | null;
  /** How this run did its work: an agent reply, or an allowlisted command. */
  kind: 'prompt' | 'command';
}

export interface ProductJob {
  id: string;
  name: string;
  description: string;
  channelId: string;
  /** Manager agent that distributes stages to their owner agents (Crew-style). */
  managerAgentId: string | null;
  stages: StagePlan[];
  /** Index into `stages` of the stage currently being worked. */
  currentStageIndex: number;
  status: JobStatus;
  schedule: JobSchedule;
  enabled: boolean;
  /** Epoch ms of the last tick this job's schedule fired on. */
  lastRunAt: number | null;
  runs: StageRun[];
  createdAt: number;
  updatedAt: number;
  /**
   * Working directory command stages run in — a checked-out repo on the
   * server runner. Prompt stages ignore it. Empty means "the runner's own
   * working directory".
   */
  workdir?: string;
  /**
   * Explicit allowlist of commands this job may execute, as exact argv
   * arrays (e.g. `[["git", "status", "--short"]]`). A command stage runs
   * only when its argv matches an entry exactly — see `isCommandAllowed`.
   * The in-tab runner never executes commands at all.
   */
  allowedCommands?: string[][];
}

/** Exact-match allowlist check: the argv must equal one entry, element for element. */
export function isCommandAllowed(job: ProductJob, argv: string[]): boolean {
  const list = job.allowedCommands ?? [];
  return list.some(
    (entry) => entry.length === argv.length && entry.every((part, i) => part === argv[i]),
  );
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface CreateJobInput {
  name: string;
  description?: string;
  channelId: string;
  managerAgentId?: string | null;
  stages: Array<{
    stage: JobStage;
    agentId: string;
    prompt: string;
    expectedOutput: string;
    contextStages?: JobStage[];
    flags?: GateFlags;
    command?: { argv: string[] };
  }>;
  schedule?: JobSchedule;
  enabled?: boolean;
  workdir?: string;
  allowedCommands?: string[][];
}

/**
 * Build a job. Validates: a name, a channel, at least one stage, stages in
 * lifecycle order with no repeats, every stage assigned to an agent with a
 * real prompt and expected output, and context stages that are earlier
 * stages of the same job. A cron schedule is validated by parsing it. A
 * command stage is validated against the job's allowlist: its argv must
 * match an allowlisted entry exactly, or the job is rejected — a job can
 * never be created with a command it is not allowed to run.
 */
export function createJob(input: CreateJobInput, nowMs: number = Date.now()): ProductJob {
  const name = input.name.trim();
  if (!name) throw new Error('a job needs a name');
  if (!input.channelId) throw new Error('a job needs a channelId');
  if (input.stages.length === 0) throw new Error('a job needs at least one stage');
  const allowlist = input.allowedCommands ?? [];
  for (const entry of allowlist) {
    if (!Array.isArray(entry) || entry.length === 0 || entry.some((p) => typeof p !== 'string' || !p)) {
      throw new Error(`allowlist entries must be non-empty argv arrays in job "${name}"`);
    }
  }
  const seen = new Set<JobStage>();
  let prevIndex = -1;
  for (const s of input.stages) {
    if (seen.has(s.stage)) throw new Error(`stage "${s.stage}" appears twice in job "${name}"`);
    seen.add(s.stage);
    const idx = stageIndex(s.stage);
    if (idx <= prevIndex) {
      throw new Error(`stages must follow lifecycle order in job "${name}": "${s.stage}" is out of order`);
    }
    prevIndex = idx;
    if (!s.agentId) throw new Error(`stage "${s.stage}" needs an agentId`);
    if (!s.prompt.trim()) throw new Error(`stage "${s.stage}" needs a prompt`);
    if (!s.expectedOutput.trim()) throw new Error(`stage "${s.stage}" needs an expectedOutput`);
    if (s.command) {
      if (!Array.isArray(s.command.argv) || s.command.argv.length === 0) {
        throw new Error(`stage "${s.stage}" has an empty command argv`);
      }
      const allowed = allowlist.some(
        (entry) =>
          entry.length === s.command!.argv.length &&
          entry.every((part, i) => part === s.command!.argv[i]),
      );
      if (!allowed) {
        throw new Error(
          `stage "${s.stage}" command ${JSON.stringify(s.command.argv)} is not on the job's allowlist`,
        );
      }
    }
    for (const ctx of s.contextStages ?? []) {
      if (!seen.has(ctx) && ctx !== s.stage) {
        // Context must be an earlier stage of this job (or the stage itself
        // is never valid context); anything else is a broken chain.
        throw new Error(`stage "${s.stage}" lists "${ctx}" as context, which is not an earlier stage`);
      }
      if (stageIndex(ctx) >= idx) {
        throw new Error(`stage "${s.stage}" cannot take context from "${ctx}" (not earlier)`);
      }
    }
  }
  const schedule = input.schedule ?? { kind: 'manual' };
  if (schedule.kind === 'cron') new Schedule(schedule.expr); // throws on bad expr
  if (schedule.kind === 'interval' && (!Number.isFinite(schedule.everyMs) || schedule.everyMs < 1_000)) {
    throw new Error('an interval schedule must be at least 1000ms');
  }
  const stages: StagePlan[] = input.stages.map((s) => ({
    stage: s.stage,
    agentId: s.agentId,
    prompt: s.prompt,
    expectedOutput: s.expectedOutput,
    contextStages: [...(s.contextStages ?? [])],
    humanInput: stageRequiresApproval(s.stage, s.flags),
    flags: s.flags,
    command: s.command ? { argv: [...s.command.argv] } : undefined,
  }));
  return {
    id: uid('job'),
    name,
    description: input.description ?? '',
    channelId: input.channelId,
    managerAgentId: input.managerAgentId ?? null,
    stages,
    currentStageIndex: 0,
    status: 'active',
    schedule,
    enabled: input.enabled ?? true,
    lastRunAt: null,
    runs: [],
    createdAt: nowMs,
    updatedAt: nowMs,
    workdir: input.workdir,
    allowedCommands: allowlist.length > 0 ? allowlist.map((a) => [...a]) : undefined,
  };
}

/** The stage a job is currently working on, or null when it is done. */
export function currentStage(job: ProductJob): StagePlan | null {
  return job.stages[job.currentStageIndex] ?? null;
}

/** The most recent completed (ok) run of a stage, for context assembly. */
export function lastGoodRun(job: ProductJob, stage: JobStage): StageRun | undefined {
  for (let i = job.runs.length - 1; i >= 0; i--) {
    const r = job.runs[i];
    if (r.stage === stage && r.status === 'ok') return r;
  }
  return undefined;
}

/**
 * Assemble a stage's prompt from its plan plus the recorded outputs of its
 * upstream stages — the Crew sequential rule that each task's output feeds
 * the next task's context. Prior outputs are quoted and capped so the
 * prompt stays bounded; a stage with no completed context simply gets no
 * context block.
 */
export function buildStagePrompt(job: ProductJob, plan: StagePlan): string {
  const parts = [plan.prompt.trim()];
  const contextBlocks: string[] = [];
  for (const ctxStage of plan.contextStages) {
    const run = lastGoodRun(job, ctxStage);
    if (run?.output) {
      contextBlocks.push(
        `--- Output of the ${ctxStage} stage (by ${run.agentId}, ${new Date(run.finishedAt ?? run.startedAt).toLocaleString()}) ---\n${run.output.slice(0, 1500)}`,
      );
    }
  }
  if (contextBlocks.length > 0) {
    parts.push('Context from earlier stages of this job — build on it, do not redo it:\n' + contextBlocks.join('\n\n'));
  }
  parts.push(`Expected output for this stage: ${plan.expectedOutput.trim()}`);
  // Runner context: the agent's tools need the job id (e.g. stage_patch
  // stages a patch for THIS job), and the agent should know which stage
  // it is running. Appended last so it never crowds out the task itself.
  parts.push(`[runner context: job id "${job.id}", stage "${plan.stage}", channel "${job.channelId}"]`);
  return parts.join('\n\n');
}

export type StageStart =
  | { ok: true; job: ProductJob; run: StageRun }
  | { ok: false; blocked: true; needsApproval: boolean; reason: string };

/**
 * Start the job's current stage as a scheduled agent run.
 *
 * The governance gate is enforced here, before any run is recorded: a
 * gated stage with no live approval for this job + stage is blocked and
 * the job is parked in `awaiting_approval` by the caller. A paused or
 * finished job cannot start a stage. On success the run is recorded as
 * `dispatched` with the prompt that was sent; the runner completes it when
 * the agent's reply lands in the channel.
 */
export function startStage(
  job: ProductJob,
  approvals: ApprovalRequest[],
  nowMs: number = Date.now(),
): StageStart {
  const plan = currentStage(job);
  if (!plan) {
    return { ok: false, blocked: true, needsApproval: false, reason: `job "${job.name}" is complete` };
  }
  if (job.status === 'paused') {
    return { ok: false, blocked: true, needsApproval: false, reason: `job "${job.name}" is paused` };
  }
  if (job.status === 'done') {
    return { ok: false, blocked: true, needsApproval: false, reason: `job "${job.name}" is done` };
  }
  if (job.status === 'failed') {
    return { ok: false, blocked: true, needsApproval: false, reason: `job "${job.name}" failed and needs attention` };
  }
  const check = canExecuteStage(job.id, plan.stage, approvals, plan.flags);
  if (!check.allowed) {
    return { ok: false, blocked: true, needsApproval: check.needsApproval, reason: check.reason };
  }
  const live = findLiveApproval(approvals, job.id, plan.stage);
  const run: StageRun = {
    id: uid('run'),
    jobId: job.id,
    stage: plan.stage,
    agentId: plan.agentId,
    prompt: buildStagePrompt(job, plan),
    status: 'dispatched',
    output: null,
    conversationId: job.channelId,
    messageId: null,
    startedAt: nowMs,
    finishedAt: null,
    blockedReason: null,
    approvalId: live?.id ?? null,
    kind: plan.command ? 'command' : 'prompt',
  };
  return {
    ok: true,
    job: { ...job, runs: [...job.runs, run], lastRunAt: nowMs, updatedAt: nowMs },
    run,
  };
}

/**
 * Complete a dispatched stage run with the agent's reply.
 *
 * On success the output is recorded as that stage's output (provenance:
 * run id, agent, channel, message, time), the approval that authorised a
 * gated stage is consumed, and the job advances to the next stage — or to
 * `done` when the last stage completes. On failure the run is recorded as
 * failed and the stage does NOT advance, so the next scheduled tick retries
 * the same stage; the approval is not consumed, so a retry does not need
 * Jesse to approve twice.
 */
export function completeStageRun(
  job: ProductJob,
  runId: string,
  output: string,
  ok: boolean,
  approvals: ApprovalRequest[],
  nowMs: number = Date.now(),
): { job: ProductJob; approvals: ApprovalRequest[] } {
  const run = job.runs.find((r) => r.id === runId);
  if (!run) throw new Error(`no run ${runId} on job "${job.name}"`);
  if (run.status !== 'dispatched') {
    throw new Error(`run ${runId} is already ${run.status}`);
  }
  const finished: StageRun = {
    ...run,
    status: ok ? 'ok' : 'failed',
    output: output.slice(0, 8000),
    finishedAt: nowMs,
  };
  let nextApprovals = approvals;
  let nextJob: ProductJob = {
    ...job,
    runs: job.runs.map((r) => (r.id === runId ? finished : r)),
    updatedAt: nowMs,
  };
  if (ok) {
    if (run.approvalId) {
      const approval = approvals.find((a) => a.id === run.approvalId);
      if (approval) {
        nextApprovals = approvals.map((a) =>
          a.id === approval.id ? consumeApproval(a, nowMs) : a,
        );
      }
    }
    const nextIndex = job.currentStageIndex + 1;
    nextJob = {
      ...nextJob,
      currentStageIndex: nextIndex,
      status: nextIndex >= job.stages.length ? 'done' : job.status === 'awaiting_approval' ? 'active' : job.status,
    };
  }
  return { job: nextJob, approvals: nextApprovals };
}

/** Park a job in `awaiting_approval` (governance-blocked start). */
export function parkForApproval(job: ProductJob, nowMs: number = Date.now()): ProductJob {
  if (job.status === 'done') return job;
  return { ...job, status: 'awaiting_approval', updatedAt: nowMs };
}

/** Resume a parked or paused job so the next tick can fire its stage. */
export function resumeJob(job: ProductJob, nowMs: number = Date.now()): ProductJob {
  if (job.status !== 'awaiting_approval' && job.status !== 'paused') return job;
  return { ...job, status: 'active', updatedAt: nowMs };
}

export function pauseJob(job: ProductJob, nowMs: number = Date.now()): ProductJob {
  if (job.status === 'done') return job;
  return { ...job, status: 'paused', updatedAt: nowMs };
}

/**
 * Is this job's schedule due at `now`? Manual jobs are never due on a tick;
 * interval jobs follow the trigger rule; cron jobs follow the cron rule
 * (including the same-minute dedupe as `lib/scheduler.ts`). A job that is
 * not active (paused, awaiting approval, done) is never due.
 */
export function isJobDue(job: ProductJob, now: Date): boolean {
  if (!job.enabled || job.status !== 'active') return false;
  if (job.currentStageIndex >= job.stages.length) return false;
  const s = job.schedule;
  if (s.kind === 'manual') return false;
  if (s.kind === 'interval') {
    if (job.lastRunAt == null) return true;
    return now.getTime() - job.lastRunAt >= s.everyMs;
  }
  if (!new Schedule(s.expr).matches(now)) return false;
  if (job.lastRunAt !== null && minuteKey(job.lastRunAt) === minuteKey(now.getTime())) return false;
  return true;
}

/* ---------------------------------------------------------------------------
 * Serialisation — validated on the way back in, so a corrupt or hand-edited
 * localStorage blob can never smuggle in an out-of-order stage chain or a
 * bad cron expression. Invalid entries are rejected by the caller, not
 * silently repaired.
 * ------------------------------------------------------------------------- */

export function serializeJob(job: ProductJob): string {
  return JSON.stringify(job);
}

export function deserializeJob(raw: unknown): ProductJob {
  if (!raw || typeof raw !== 'object') throw new Error('job record is not an object');
  const d = raw as Record<string, unknown>;
  const stages = d.stages;
  if (!Array.isArray(stages)) throw new Error('job record has no stages array');
  const job = createJob(
    {
      name: String(d.name ?? ''),
      description: typeof d.description === 'string' ? d.description : '',
      channelId: String(d.channelId ?? ''),
      managerAgentId: typeof d.managerAgentId === 'string' ? d.managerAgentId : null,
      stages: stages.map((s) => {
        const p = s as Record<string, unknown>;
        if (typeof p.stage !== 'string' || !(PRODUCT_STAGES as readonly string[]).includes(p.stage)) {
          throw new Error(`unknown stage ${JSON.stringify(p.stage)}`);
        }
        return {
          stage: p.stage as JobStage,
          agentId: String(p.agentId ?? ''),
          prompt: String(p.prompt ?? ''),
          expectedOutput: String(p.expectedOutput ?? ''),
          contextStages: Array.isArray(p.contextStages)
            ? (p.contextStages as string[]).filter((c): c is JobStage =>
                (PRODUCT_STAGES as readonly string[]).includes(c),
              )
            : [],
          flags:
            p.flags && typeof p.flags === 'object'
              ? (p.flags as GateFlags)
              : undefined,
          command:
            p.command && typeof p.command === 'object' && Array.isArray((p.command as { argv?: unknown }).argv)
              ? { argv: ((p.command as { argv: unknown[] }).argv as unknown[]).map(String) }
              : undefined,
        };
      }),
      schedule: isJobSchedule(d.schedule) ? d.schedule : { kind: 'manual' },
      enabled: d.enabled !== false,
      workdir: typeof d.workdir === 'string' ? d.workdir : undefined,
      allowedCommands: Array.isArray(d.allowedCommands)
        ? (d.allowedCommands as unknown[]).map((a) => (Array.isArray(a) ? a.map(String) : []))
        : undefined,
    },
    typeof d.createdAt === 'number' ? d.createdAt : Date.now(),
  );
  // Restore runtime state (id, progress, history) — createJob validated the shape.
  return {
    ...job,
    id: typeof d.id === 'string' && d.id ? d.id : job.id,
    currentStageIndex:
      typeof d.currentStageIndex === 'number'
        ? Math.min(Math.max(0, d.currentStageIndex), job.stages.length)
        : 0,
    status: isJobStatus(d.status) ? d.status : 'active',
    lastRunAt: typeof d.lastRunAt === 'number' ? d.lastRunAt : null,
    runs: Array.isArray(d.runs) ? (d.runs as StageRun[]) : [],
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : job.createdAt,
  };
}

function isJobSchedule(v: unknown): v is JobSchedule {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (s.kind === 'manual') return true;
  if (s.kind === 'interval') return typeof s.everyMs === 'number' && s.everyMs >= 1000;
  if (s.kind === 'cron') return typeof s.expr === 'string';
  return false;
}

function isJobStatus(v: unknown): v is JobStatus {
  return (
    v === 'active' || v === 'paused' || v === 'awaiting_approval' || v === 'done' || v === 'failed'
  );
}

/* ---------------------------------------------------------------------------
 * Job templates — the mem20 product loop as real data.
 *
 * A template is a function that builds a real job from the caller's real
 * agents and channel: one agent id per stage (a single `agentId` covers
 * every stage, with per-stage overrides), never a made-up agent. The
 * prompts name mem20 concretely because this loop exists to run mem20.
 * ------------------------------------------------------------------------- */

export interface TemplateInput {
  /** Display name for the job. */
  name?: string;
  /** Channel the stage runs are delivered to. */
  channelId: string;
  /** Agent used for every stage unless overridden per stage. */
  agentId: string;
  /** Per-stage agent overrides, e.g. a different agent for `sell`. */
  stageAgents?: Partial<Record<JobStage, string>>;
  /** Manager agent that distributes the stages (Crew-style). */
  managerAgentId?: string | null;
  /** How often the job's next stage fires. Defaults to manual (Run now). */
  schedule?: JobSchedule;
}

function stageAgent(input: TemplateInput, stage: JobStage): string {
  return input.stageAgents?.[stage] ?? input.agentId;
}

/**
 * "Ship a release": the full eight-stage product loop for one mem20
 * release — design it, build it, implement it, upgrade the running surface,
 * release it (gated), document it, advertise it (gated), sell it (gated).
 * Each stage's context is the stages before it, so the release notes quote
 * the design, the docs quote the implementation, and the sales copy quotes
 * the docs.
 */
export function shipReleaseTemplate(input: TemplateInput, nowMs: number = Date.now()): ProductJob {
  return createJob(
    {
      name: input.name ?? 'Ship a mem20 release',
      description:
        'Full product loop for one mem20 release: design, build, implement, upgrade, release, document, advertise, sell. Release, advertise, and sell wait for Jesse’s approval.',
      channelId: input.channelId,
      managerAgentId: input.managerAgentId ?? null,
      schedule: input.schedule ?? { kind: 'manual' },
      stages: [
        {
          stage: 'design',
          agentId: stageAgent(input, 'design'),
          prompt:
            'Design the next mem20 release. Read the current state of the mem20 repo (live tool surface, open drift items, recent changes) and write a release design: what changes, what stays the same, what "done" means for each change, and what must not break. Keep it concrete — no feature may be dropped or faked to hit the design.',
          expectedOutput:
            'A release design: the change list with acceptance criteria per change, and the explicit non-goals.',
          contextStages: [],
        },
        {
          stage: 'build',
          agentId: stageAgent(input, 'build'),
          prompt:
            'Build what the design stage specified. Work in small, verifiable steps and report exactly what changed, file by file. If something in the design cannot be built as specified, say so and propose the smallest honest change — do not silently substitute.',
          expectedOutput:
            'A build report: files changed, what each change does, and anything from the design that could not be built as specified.',
          contextStages: ['design'],
        },
        {
          stage: 'implement',
          agentId: stageAgent(input, 'implement'),
          prompt:
            'Implement the built changes into the live mem20 runtime: wire them up, run the real checks (tests, preflight, live tool calls where they exist), and report what is actually live versus what is only written. Nothing counts as implemented until it has been called and returned a real result.',
          expectedOutput:
            'An implementation report: what is live and verified, with the evidence (test results, tool-call results) for each item.',
          contextStages: ['design', 'build'],
        },
        {
          stage: 'upgrade',
          agentId: stageAgent(input, 'upgrade'),
          prompt:
            'Upgrade the running mem20 surface for this release: version numbers, manifests, docs indexes, and any migration the implementation needs. Verify version consistency across VERSION, pyproject, and release notes — no version skew.',
          expectedOutput:
            'An upgrade report: versions bumped, manifests regenerated and verified, migrations applied.',
          contextStages: ['build', 'implement'],
        },
        {
          stage: 'release',
          agentId: stageAgent(input, 'release'),
          prompt:
            'Prepare the release for Jesse to approve: release notes from the design, build, implementation, and upgrade outputs; the version; and the exact checklist of what was verified. Do not publish, tag, or push anything — this stage only prepares the release for approval.',
          expectedOutput:
            'Release notes and a verification checklist, ready for Jesse’s approval. Nothing published yet.',
          contextStages: ['design', 'build', 'implement', 'upgrade'],
        },
        {
          stage: 'document',
          agentId: stageAgent(input, 'document'),
          prompt:
            'Write or update the mem20 documentation for this release: what changed, how to use it, and what moved. Docs must match the implementation as it actually is — if the docs and the code disagree, fix the docs or say what in the code needs fixing.',
          expectedOutput:
            'Documentation updates (drafted, not yet published) that match the implemented release.',
          contextStages: ['implement', 'upgrade', 'release'],
        },
        {
          stage: 'advertise',
          agentId: stageAgent(input, 'advertise'),
          prompt:
            'Draft the announcement for this mem20 release: what it does, who it is for, and what changed since the last release. Base every claim on the release notes and docs — no invented capabilities. Draft only; do not post or publish anything.',
          expectedOutput:
            'An announcement draft with every claim traceable to the release notes. Nothing posted yet.',
          contextStages: ['release', 'document'],
        },
        {
          stage: 'sell',
          agentId: stageAgent(input, 'sell'),
          prompt:
            'Draft the sales material for this mem20 release: the landing-page copy and the offer (what a buyer gets, what it costs, what support looks like). Every claim must trace to the release notes or docs. Draft only; do not publish, list, or charge anything.',
          expectedOutput:
            'Sales copy draft with the offer, every claim traceable to the release. Nothing published or charged.',
          contextStages: ['release', 'document', 'advertise'],
        },
      ],
    },
    nowMs,
  );
}

/**
 * "Check the repo": the nightly verification loop for a checked-out repo —
 * plan what to verify, verify one live claim with the repo tools, then —
 * only for a Reviewer-approved change — commit and push it, and write up
 * the findings. The command stages are the executor's proof of work: each
 * command is an exact argv on the job's allowlist, run with no shell, in
 * `workdir`.
 *
 * The push path (see docs/PUSH_PATH.md): the implement stage is a prompt
 * stage — the agent reads repo files with the repo_read tool and stages
 * the smallest verified correction with the stage_patch tool (the patch
 * file lives outside the repo; nothing is edited yet). The upgrade stage
 * is the only command stage: it runs the governed push script, which
 * re-checks the Reviewer approval, the branch, and the diff before it
 * commits and pushes anything. The upgrade stage is gated with
 * `requiresReview`, so it never runs without a Reviewer approval
 * (decidedBy 'reviewer'); releases, public publishing, and destructive
 * changes still route to Jesse, never to the Reviewer. Most nights there
 * is nothing to fix: the implement stage replies NO-CHANGE, the push
 * script reports NOTHING-TO-PUSH, and the document stage records that.
 */
export function repoCheckTemplate(
  input: TemplateInput & { workdir: string },
  nowMs: number = Date.now(),
): ProductJob {
  const allowedCommands = [['sudo', '/opt/teamz-runner/push-mem20.py']];
  return createJob(
    {
      name: input.name ?? 'Nightly repo check',
      description:
        'Nightly verification of the checked-out repo: plan the check, verify one live claim with the repo tools, and — only for a Reviewer-approved change — commit and push it. The push runs only from the job allowlist, with no shell, through the governed push script.',
      channelId: input.channelId,
      managerAgentId: input.managerAgentId ?? null,
      schedule: input.schedule ?? { kind: 'cron', expr: '0 7 * * *' },
      workdir: input.workdir,
      allowedCommands,
      stages: [
        {
          stage: 'design',
          agentId: stageAgent(input, 'design'),
          prompt:
            'Plan tonight’s repo check: given the repo’s recent history, which live claims (surface numbers, episode/production status, links) are most likely stale, and which exact files would prove or disprove each one? List the checks and what each one would prove.',
          expectedOutput: 'A check plan: the live claims to verify, the exact file for each, and what each check would prove.',
          contextStages: [],
        },
        {
          stage: 'implement',
          agentId: stageAgent(input, 'implement'),
          prompt:
            'Verify one live claim from the design plan with the repo_read tool (read the exact file, find the exact sentence) and, ONLY if the file text proves the claim wrong, stage the smallest correction with the stage_patch tool (exact old text, exact new text, one file, one short commit message). Rules: never stage a change you cannot verify from the file text itself; never touch .github/, requirements.txt, secrets, or any history/dated record (daily reports, changelogs, evidence files state what was true then — leave them alone); if nothing is verifiably wrong, reply NO-CHANGE and stage nothing. Your job id is in the runner context at the end of this prompt — pass it to stage_patch exactly.',
          expectedOutput:
            'Either NO-CHANGE (nothing verifiably wrong), or the staged patch summary: file, old text, new text, and why the old text was wrong.',
          contextStages: ['design'],
        },
        {
          stage: 'upgrade',
          agentId: stageAgent(input, 'upgrade'),
          prompt:
            'Push the staged change (if any) to GitHub through the governed push script. This stage runs the allowlisted command only — it never edits files itself. The push happens only because the Reviewer approved this stage; the script re-checks the approval, the branch, and the diff before pushing.',
          expectedOutput:
            'The push record: the commit hash and remote main, or NOTHING-TO-PUSH when no patch was staged.',
          contextStages: ['design', 'implement'],
          flags: { requiresReview: true },
          command: { argv: ['sudo', '/opt/teamz-runner/push-mem20.py'] },
        },
        {
          stage: 'document',
          agentId: stageAgent(input, 'document'),
          prompt:
            'Write the nightly repo-check report from the design plan, the implement output, and the push record: what changed, what was pushed (commit hash, remote main) or why nothing was pushed, what is unfinished, and what needs a human decision. Quote the push record; do not invent findings.',
          expectedOutput:
            'A short report: the change (if any), the push record with commit hash and remote main, unfinished work, and decisions needed.',
          contextStages: ['design', 'implement', 'upgrade'],
        },
      ],
    },
    nowMs,
  );
}
export function publishDocsTemplate(input: TemplateInput, nowMs: number = Date.now()): ProductJob {
  return createJob(
    {
      name: input.name ?? 'Publish mem20 docs',
      description:
        'Documentation loop: outline the docs, then write and publish them. Publishing is public, so the document stage waits for Jesse’s approval.',
      channelId: input.channelId,
      managerAgentId: input.managerAgentId ?? null,
      schedule: input.schedule ?? { kind: 'manual' },
      stages: [
        {
          stage: 'design',
          agentId: stageAgent(input, 'design'),
          prompt:
            'Design the mem20 documentation update: which pages change, what each page must say, and what is out of scope. Base the outline on the current docs and the current implementation — flag anywhere they already disagree.',
          expectedOutput: 'A docs outline: pages, required content per page, and known doc/code disagreements.',
          contextStages: [],
        },
        {
          stage: 'document',
          agentId: stageAgent(input, 'document'),
          prompt:
            'Write the documentation from the design outline and publish it to the public docs site. Keep it accurate to the implementation as it actually is, with concrete examples. This stage publishes publicly, so it only runs after Jesse approves it.',
          expectedOutput: 'Documentation published for every page in the outline, matching the implementation.',
          contextStages: ['design'],
          flags: { publishesPublic: true },
        },
      ],
    },
    nowMs,
  );
}
