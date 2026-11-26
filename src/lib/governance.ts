/**
 * Governance — approval gates for the autonomous product loop.
 *
 * The hard rule: the runner NEVER spends money, publishes something public,
 * or releases anything without Jesse's approval. That rule is enforced in
 * code, in this module, not just in the UI: `startStage` in `jobs.ts` calls
 * `canExecuteStage` here, and a gated stage with no unconsumed approval for
 * that job + stage comes back blocked. The UI can only approve or deny; it
 * cannot make a gated stage run.
 *
 * Stages that always require approval: `release`, `advertise`, `sell`.
 * Anything that would spend money or publish something public requires
 * approval regardless of stage — a `document` stage that publishes to the
 * public site is gated even though drafting docs is not.
 *
 * Routine stages (`design`, `build`, `implement`, `upgrade`, and drafting
 * in `document`) proceed autonomously.
 *
 * Approvals are records, not flags: an approval is created by requesting
 * one, decided by Jesse (approved or denied), and consumed when the gated
 * stage it covers completes successfully. A failed run does not consume the
 * approval, so a retry after a failure does not need Jesse to approve twice.
 * A denied request never becomes an approval — a new request must be made.
 */

import type { JobStage } from './jobs';

/** Stages that always need Jesse's approval before they execute. */
export const GATED_STAGES: readonly JobStage[] = ['release', 'advertise', 'sell'];

/** A stage that would spend money or publish publicly is gated either way. */
export interface GateFlags {
  /** The stage's work would spend money (ads, paid API calls, purchases). */
  spendsMoney?: boolean;
  /** The stage's work would publish something where the public can see it. */
  publishesPublic?: boolean;
  /** The stage's work would delete or destroy data, code, or infrastructure. */
  destructive?: boolean;
  /**
   * The stage is routine (not a carve-out) but still needs a decision
   * before it runs — the Reviewer decides these, Jesse never has to.
   * See `isCarveOut`: a requiresReview stage that is also a carve-out
   * always goes to Jesse, never to the Reviewer.
   */
  requiresReview?: boolean;
}

export function stageRequiresApproval(stage: JobStage, flags: GateFlags = {}): boolean {
  return (
    (GATED_STAGES as readonly JobStage[]).includes(stage) ||
    flags.spendsMoney === true ||
    flags.publishesPublic === true ||
    flags.destructive === true ||
    flags.requiresReview === true
  );
}

/**
 * The carve-outs: stages that ALWAYS need Jesse himself, never the
 * Reviewer. Checked first, before any Reviewer routing — see
 * docs/REVIEWER_POLICY.md. A stage is a carve-out when it is a gated
 * lifecycle stage (release / advertise / sell) or its flags say it would
 * spend money, publish publicly, or destroy something.
 */
export function isCarveOut(stage: JobStage, flags: GateFlags = {}): boolean {
  return (
    (GATED_STAGES as readonly JobStage[]).includes(stage) ||
    flags.spendsMoney === true ||
    flags.publishesPublic === true ||
    flags.destructive === true
  );
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

/**
 * One approval decision for one job + stage. `consumedAt` is set when the
 * gated stage it covers completes, so the same approval cannot silently
 * authorise a second, later run of that stage.
 */
export interface ApprovalRequest {
  id: string;
  jobId: string;
  jobName: string;
  stage: JobStage;
  /** Why approval is needed — shown in the approvals queue. */
  reason: string;
  requestedAt: number;
  status: ApprovalStatus;
  decidedAt: number | null;
  /** Epoch ms the approved stage completed, if it has. */
  consumedAt: number | null;
  /**
   * Who decided this request: Jesse himself, or the Reviewer agent acting
   * under the Reviewer policy (routine decisions only — carve-outs are
   * never decided by the Reviewer). Absent on old records: Jesse.
   */
  decidedBy?: 'jesse' | 'reviewer';
}

/** The outcome of asking "may this stage execute right now?" */
export interface GateCheck {
  allowed: boolean;
  /** True when the block is specifically a missing approval. */
  needsApproval: boolean;
  /** Human-readable reason, for the job history and the UI. */
  reason: string;
}

export function requestApproval(
  jobId: string,
  jobName: string,
  stage: JobStage,
  reason: string,
  nowMs: number = Date.now(),
): ApprovalRequest {
  return {
    id: `appr-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    jobId,
    jobName,
    stage,
    reason,
    requestedAt: nowMs,
    status: 'pending',
    decidedAt: null,
    consumedAt: null,
  };
}

/**
 * Find the live approval for a job + stage: approved and not yet consumed.
 * A denied request is never returned, and a consumed approval cannot be
 * reused for a later run of the same stage.
 */
export function findLiveApproval(
  approvals: ApprovalRequest[],
  jobId: string,
  stage: JobStage,
): ApprovalRequest | undefined {
  return approvals.find(
    (a) => a.jobId === jobId && a.stage === stage && a.status === 'approved' && a.consumedAt === null,
  );
}

/** Is there already an undecided request for this job + stage? */
export function findPendingApproval(
  approvals: ApprovalRequest[],
  jobId: string,
  stage: JobStage,
): ApprovalRequest | undefined {
  return approvals.find(
    (a) => a.jobId === jobId && a.stage === stage && a.status === 'pending',
  );
}

/**
 * The enforcement point. Returns whether the stage may execute now, and
 * why not when it may not. A gated stage without a live approval is
 * blocked; everything else is allowed.
 */
export function canExecuteStage(
  jobId: string,
  stage: JobStage,
  approvals: ApprovalRequest[],
  flags: GateFlags = {},
): GateCheck {
  if (!stageRequiresApproval(stage, flags)) {
    return { allowed: true, needsApproval: false, reason: 'routine stage — no approval needed' };
  }
  const live = findLiveApproval(approvals, jobId, stage);
  if (live) {
    return { allowed: true, needsApproval: false, reason: `approved (${live.id})` };
  }
  const pending = findPendingApproval(approvals, jobId, stage);
  if (pending) {
    return {
      allowed: false,
      needsApproval: true,
      reason: `awaiting approval (${pending.id}) — requested ${new Date(pending.requestedAt).toLocaleString()}`,
    };
  }
  return {
    allowed: false,
    needsApproval: true,
    reason: `stage "${stage}" requires Jesse's approval before it can run`,
  };
}

/**
 * Enforce the gate or throw. Callers that need a value rather than an
 * exception use `canExecuteStage` directly.
 */
export function assertCanExecute(
  jobId: string,
  stage: JobStage,
  approvals: ApprovalRequest[],
  flags: GateFlags = {},
): void {
  const check = canExecuteStage(jobId, stage, approvals, flags);
  if (!check.allowed) {
    throw new Error(`governance: ${check.reason}`);
  }
}

/** Record Jesse's decision on a pending request. Only pending requests move. */
export function decideApproval(
  request: ApprovalRequest,
  decision: 'approved' | 'denied',
  nowMs: number = Date.now(),
): ApprovalRequest {
  if (request.status !== 'pending') {
    throw new Error(`approval ${request.id} is already ${request.status}`);
  }
  return { ...request, status: decision, decidedAt: nowMs, decidedBy: 'jesse' };
}

/**
 * Record the Reviewer agent's decision on a request. Only for routine
 * decisions — callers must have checked `isCarveOut` first and routed
 * carve-outs to Jesse. The record says who decided it, so an audit can
 * tell a Reviewer approval from a Jesse approval.
 */
export function decideApprovalByReviewer(
  request: ApprovalRequest,
  decision: 'approved' | 'denied',
  reason: string,
  nowMs: number = Date.now(),
): ApprovalRequest {
  if (request.status !== 'pending') {
    throw new Error(`approval ${request.id} is already ${request.status}`);
  }
  return {
    ...request,
    status: decision,
    decidedAt: nowMs,
    decidedBy: 'reviewer',
    reason: `${request.reason} — Reviewer ${decision}: ${reason}`,
  };
}

/** Mark an approval consumed once the stage it covered completed. */
export function consumeApproval(
  request: ApprovalRequest,
  nowMs: number = Date.now(),
): ApprovalRequest {
  if (request.status !== 'approved') {
    throw new Error(`cannot consume an approval that is ${request.status}`);
  }
  return { ...request, consumedAt: nowMs };
}

/** Requests still waiting on Jesse, oldest first. */
export function pendingApprovals(approvals: ApprovalRequest[]): ApprovalRequest[] {
  return approvals
    .filter((a) => a.status === 'pending')
    .sort((a, b) => a.requestedAt - b.requestedAt);
}
