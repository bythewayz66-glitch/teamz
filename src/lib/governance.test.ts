import { describe, expect, it } from 'vitest';
import {
  canExecuteStage,
  consumeApproval,
  decideApproval,
  findLiveApproval,
  findPendingApproval,
  pendingApprovals,
  requestApproval,
  stageRequiresApproval,
  assertCanExecute,
  type ApprovalRequest,
} from './governance';
import type { JobStage } from './jobs';

const T0 = 1_700_000_000_000;

function approved(jobId: string, stage: JobStage, at: number = T0): ApprovalRequest {
  return {
    ...requestApproval(jobId, 'Test job', stage, 'gated stage', at),
    status: 'approved',
    decidedAt: at + 1000,
  };
}

describe('stageRequiresApproval', () => {
  it('gates release, advertise, and sell', () => {
    for (const stage of ['release', 'advertise', 'sell'] as JobStage[]) {
      expect(stageRequiresApproval(stage)).toBe(true);
    }
  });

  it('lets routine stages through', () => {
    for (const stage of ['design', 'build', 'implement', 'upgrade', 'document'] as JobStage[]) {
      expect(stageRequiresApproval(stage)).toBe(false);
    }
  });

  it('gates any stage that spends money or publishes publicly', () => {
    expect(stageRequiresApproval('document', { publishesPublic: true })).toBe(true);
    expect(stageRequiresApproval('build', { spendsMoney: true })).toBe(true);
    expect(stageRequiresApproval('design', { spendsMoney: true, publishesPublic: true })).toBe(true);
    expect(stageRequiresApproval('design', { spendsMoney: false })).toBe(false);
  });
});

describe('canExecuteStage — the gate', () => {
  it('a gated stage refuses to run with no approval record', () => {
    const check = canExecuteStage('job-1', 'release', []);
    expect(check.allowed).toBe(false);
    expect(check.needsApproval).toBe(true);
    expect(check.reason).toMatch(/requires approval before it can run/);
  });

  it('a gated stage refuses to run on a pending request alone', () => {
    const pending = requestApproval('job-1', 'Test job', 'release', 'release needs sign-off', T0);
    const check = canExecuteStage('job-1', 'release', [pending]);
    expect(check.allowed).toBe(false);
    expect(check.needsApproval).toBe(true);
    expect(check.reason).toMatch(/awaiting approval/);
  });

  it('a gated stage refuses to run on a denied request', () => {
    const denied = decideApproval(
      requestApproval('job-1', 'Test job', 'release', 'release needs sign-off', T0),
      'denied',
      T0 + 5000,
    );
    expect(canExecuteStage('job-1', 'release', [denied]).allowed).toBe(false);
  });

  it('an approved stage runs', () => {
    expect(canExecuteStage('job-1', 'release', [approved('job-1', 'release')]).allowed).toBe(true);
  });

  it('an approval for another job or stage does not open the gate', () => {
    const approvals = [approved('job-2', 'release'), approved('job-1', 'advertise')];
    expect(canExecuteStage('job-1', 'release', approvals).allowed).toBe(false);
    expect(canExecuteStage('job-1', 'sell', approvals).allowed).toBe(false);
  });

  it('a consumed approval does not authorise a second run', () => {
    const used = consumeApproval(approved('job-1', 'release'), T0 + 9000);
    expect(findLiveApproval([used], 'job-1', 'release')).toBeUndefined();
    expect(canExecuteStage('job-1', 'release', [used]).allowed).toBe(false);
  });

  it('a routine stage runs with no approvals at all', () => {
    expect(canExecuteStage('job-1', 'design', []).allowed).toBe(true);
    expect(canExecuteStage('job-1', 'build', []).allowed).toBe(true);
  });

  it('assertCanExecute throws on a blocked stage and passes on an allowed one', () => {
    expect(() => assertCanExecute('job-1', 'sell', [])).toThrow(/governance:/);
    expect(() => assertCanExecute('job-1', 'sell', [approved('job-1', 'sell')])).not.toThrow();
    expect(() => assertCanExecute('job-1', 'design', [])).not.toThrow();
  });
});

describe('approval lifecycle', () => {
  it('request → approve → consume is a one-way street', () => {
    const req = requestApproval('job-1', 'Test job', 'advertise', 'ad spend', T0);
    expect(req.status).toBe('pending');
    expect(req.decidedAt).toBeNull();
    const ok = decideApproval(req, 'approved', T0 + 1000);
    expect(ok.status).toBe('approved');
    expect(ok.decidedAt).toBe(T0 + 1000);
    const used = consumeApproval(ok, T0 + 2000);
    expect(used.consumedAt).toBe(T0 + 2000);
  });

  it('a decided request cannot be decided again', () => {
    const req = decideApproval(
      requestApproval('job-1', 'Test job', 'sell', 'sell', T0),
      'denied',
      T0 + 1000,
    );
    expect(() => decideApproval(req, 'approved')).toThrow(/already denied/);
  });

  it('a pending or denied approval cannot be consumed', () => {
    const pending = requestApproval('job-1', 'Test job', 'sell', 'sell', T0);
    expect(() => consumeApproval(pending)).toThrow(/cannot consume/);
  });

  it('findPendingApproval finds the undecided request, pendingApprovals sorts oldest first', () => {
    const a = requestApproval('job-1', 'Job 1', 'release', 'r', T0 + 2000);
    const b = requestApproval('job-2', 'Job 2', 'sell', 's', T0 + 1000);
    const decided = decideApproval(
      requestApproval('job-3', 'Job 3', 'advertise', 'a', T0),
      'approved',
      T0 + 500,
    );
    expect(findPendingApproval([a, b], 'job-1', 'release')).toBe(a);
    expect(findPendingApproval([a, b], 'job-1', 'sell')).toBeUndefined();
    expect(pendingApprovals([a, b, decided]).map((x) => x.id)).toEqual([b.id, a.id]);
  });
});
