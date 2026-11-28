/**
 * Runner rhythm — the pure rules that keep the 24/7 runner from going quiet.
 *
 * Phase 0 of the overhaul roadmap: end silent failure. Everything here is a
 * pure function over runner state (no I/O, no clock, no timers) so each rule
 * can be proved by a deterministic test; runner-lib.ts calls them from
 * processDue and the live runner reports their events to the telemetry log.
 */

import { completeStageRun, currentStage, type ProductJob } from '../src/lib/jobs';
import type { ApprovalRequest } from '../src/lib/governance';

/** A rhythm rule changed state, or noticed something worth recording. */
export interface RhythmEvent {
  type: 'run_reaped' | 'approval_expired' | 'job_parked_stale';
  /** Plain-words line for the tick log. */
  line: string;
  /** Structured fields for the telemetry log. */
  fields: Record<string, unknown>;
}

interface RhythmState {
  jobs: ProductJob[];
  approvals: ApprovalRequest[];
}

/** No stage legitimately stays `dispatched` this long (dispatch budget 330s, slot waits < 1h). */
export const ORPHAN_RUN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** An approval is the Reviewer's decision at one moment; unused for this long it is re-asked. */
export const APPROVAL_TTL_MS = 12 * 60 * 60 * 1000;
/** A job parked behind a denial this long is reported (never auto-resumed: a denial is terminal). */
export const PARKED_DENIED_REPORT_MS = 48 * 60 * 60 * 1000;

const minutes = (ms: number): number => Math.round(ms / 60000);

/**
 * A run recorded `dispatched` whose process is gone can never complete: the
 * runner skips any job that has a dispatched run, so the job is skipped
 * forever. Fail the run (the stage does not advance and a gated stage's
 * approval is not consumed) so the schedule retries the same stage.
 *
 * `minAgeMs` 0 is for runner boot, where nothing can be in flight.
 */
export function reapOrphanedRuns(
  state: RhythmState,
  nowMs: number,
  minAgeMs: number = ORPHAN_RUN_MAX_AGE_MS,
): RhythmEvent[] {
  const events: RhythmEvent[] = [];
  for (const job of [...state.jobs]) {
    for (const run of job.runs) {
      if (run.status !== 'dispatched' || nowMs - run.startedAt < minAgeMs) continue;
      const current = state.jobs.find((j) => j.id === job.id) ?? job;
      const ageMs = nowMs - run.startedAt;
      const done = completeStageRun(
        current,
        run.id,
        `orphaned: still "dispatched" after ${minutes(ageMs)} min — the runner that started it is gone; failed so the stage retries`,
        false,
        state.approvals,
        nowMs,
      );
      state.jobs = state.jobs.map((j) => (j.id === job.id ? done.job : j));
      state.approvals = done.approvals;
      events.push({
        type: 'run_reaped',
        line: `job ${job.name} / ${run.stage}: orphaned run reaped after ${minutes(ageMs)} min — the stage will retry`,
        fields: { jobId: job.id, job: job.name, stage: run.stage, runId: run.id, ageMin: minutes(ageMs) },
      });
    }
  }
  return events;
}

/** Epoch ms a request began waiting to be used: its decision time once decided. */
function approvalAnchor(a: ApprovalRequest): number {
  return a.status === 'approved' && a.decidedAt !== null ? a.decidedAt : a.requestedAt;
}

/**
 * Expire approvals that sat unused past the TTL: pending (the Reviewer never
 * answered) and approved-but-unconsumed (decided, never executed). An expired
 * approval is not live and not pending (see governance.ts), so the stage asks
 * the Reviewer again instead of running on a stale decision. Denied and
 * consumed approvals are history and are never touched.
 */
export function expireStaleApprovals(
  state: RhythmState,
  nowMs: number,
  ttlMs: number = APPROVAL_TTL_MS,
): RhythmEvent[] {
  const events: RhythmEvent[] = [];
  state.approvals = state.approvals.map((a) => {
    if (a.expiredAt) return a;
    const waiting = (a.status === 'pending') || (a.status === 'approved' && a.consumedAt === null);
    if (!waiting || nowMs - approvalAnchor(a) < ttlMs) return a;
    const ageMs = nowMs - approvalAnchor(a);
    events.push({
      type: 'approval_expired',
      line: `approval ${a.id} (${a.jobName} / ${a.stage}, ${a.status}) expired after ${Math.round(ageMs / 3600000)} h unused — the stage will be re-reviewed`,
      fields: { approvalId: a.id, jobId: a.jobId, job: a.jobName, stage: a.stage, was: a.status, ageHours: Math.round(ageMs / 3600000) },
    });
    return { ...a, expiredAt: nowMs };
  });
  return events;
}

/**
 * Jobs parked behind a denial for longer than the threshold. A denial is
 * terminal by design, so this only reports them (once per `notedAt` window per
 * job) so the fleet-health view and the telemetry log say so.
 */
export function reportStaleParkedJobs(
  state: RhythmState,
  nowMs: number,
  notedAt: Map<string, number>,
  thresholdMs: number = PARKED_DENIED_REPORT_MS,
  renoteMs: number = 6 * 60 * 60 * 1000,
): RhythmEvent[] {
  const events: RhythmEvent[] = [];
  for (const job of state.jobs) {
    if (job.status !== 'awaiting_approval') continue;
    const plan = currentStage(job);
    if (!plan) continue;
    const denied = state.approvals.find(
      (a) => a.jobId === job.id && a.stage === plan.stage && a.status === 'denied' && !a.expiredAt,
    );
    if (!denied || nowMs - job.updatedAt < thresholdMs) continue;
    const last = notedAt.get(job.id);
    if (last !== undefined && nowMs - last < renoteMs) continue;
    notedAt.set(job.id, nowMs);
    const ageH = Math.round((nowMs - job.updatedAt) / 3600000);
    events.push({
      type: 'job_parked_stale',
      line: `job ${job.name}: parked behind a denied ${plan.stage} approval for ${ageH} h — needs a decision or a new plan`,
      fields: { jobId: job.id, job: job.name, stage: plan.stage, parkedHours: ageH, approvalId: denied.id },
    });
  }
  return events;
}

/**
 * Which due jobs take this tick's dispatch slots. The old rule took the
 * first N in array order, so a job early in the list that came due again
 * always beat a job later in the list: with ~4 dispatches an hour and
 * more than 4 recurring jobs, the tail never ran. Fair order: never-run jobs
 * first, then the job that has waited longest since its last start; array
 * order breaks ties (sort is stable).
 */
export function pickJobsToStart<T extends Pick<ProductJob, 'lastRunAt'>>(due: T[], max: number): T[] {
  const rank = (j: T): number => (j.lastRunAt === null ? Number.NEGATIVE_INFINITY : j.lastRunAt);
  return [...due].sort((a, b) => rank(a) - rank(b)).slice(0, Math.max(0, max));
}

/**
 * How long a backlog of `dueJobs` takes to drain at the current pacing:
 * each slot starts one dispatch per (gap + dispatch time). A lower bound on
 * the wait for the last job — a stage that needs several dispatches takes
 * longer.
 */
export function estimateDrainMs(dueJobs: number, slots: number, gapMs: number, avgDispatchMs: number): number {
  if (dueJobs <= 0) return 0;
  const lanes = Math.max(1, slots);
  return Math.ceil(dueJobs / lanes) * (gapMs + avgDispatchMs);
}

/** Refusals returned as replies. Shorter than a real answer, so bounded by length. */
const CREDIT_REFUSAL = [
  /doesn'?t have enough credits/i,
  /enter\.pollinations\.ai\/top-up/i,
  /\b(insufficient|not enough)\s+(credits?|funds|balance|quota)\b/i,
  /\bout of (credits?|quota)\b/i,
  /\b(credit|quota)s?\s+(limit\s+)?(exceeded|exhausted|depleted)\b/i,
  /\bplease top[- ]?up\b/i,
];
const CREDIT_REFUSAL_MAX_CHARS = 600;

/**
 * A provider that is out of credits sometimes answers HTTP 200 with the
 * refusal as the model's content. The runner would record it as finished work
 * (and Slack would post it). Only short replies count, so an agent legitimately
 * writing about credits is not mistaken for a refusal.
 */
export function isCreditRefusalReply(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t || t.length > CREDIT_REFUSAL_MAX_CHARS) return false;
  return CREDIT_REFUSAL.some((re) => re.test(t));
}

/** A rate-limit event's error says credits, not just a transient 429. */
export function isCreditExhaustion(error: string): boolean {
  return /\b402\b|credit|top[- ]?up|quota|insufficient/i.test(error);
}

/** Providers with a credit-exhaustion event inside the window: not to be rescued into. */
export function creditExhaustedProviders(
  events: Array<{ provider: string; ts: number; error: string }>,
  nowMs: number,
  windowMs: number = 6 * 60 * 60 * 1000,
): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (nowMs - e.ts <= windowMs && isCreditExhaustion(e.error)) out.add(e.provider);
  }
  return out;
}

/**
 * Drop backoff entries that have been quiet for a full max-backoff window past
 * their next-allowed time. Until then they matter (the doubling continues); after
 * that a new failure should start again at the base delay, not resume a count from
 * yesterday.
 */
export function expireStaleBackoff<B extends { nextAllowedTs: number }>(
  backoff: Record<string, B>,
  nowMs: number,
  quietMs: number,
): string[] {
  const dropped: string[] = [];
  for (const [provider, b] of Object.entries(backoff)) {
    if (nowMs >= b.nextAllowedTs + quietMs) {
      delete backoff[provider];
      dropped.push(provider);
    }
  }
  return dropped;
}
