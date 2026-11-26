import { describe, expect, it } from 'vitest';
import {
  decideApproval,
  decideApprovalByReviewer,
  isCarveOut,
  requestApproval,
  stageRequiresApproval,
} from './governance';

describe('isCarveOut — the Reviewer never decides these', () => {
  it('release, advertise, and sell are always carve-outs', () => {
    expect(isCarveOut('release')).toBe(true);
    expect(isCarveOut('advertise')).toBe(true);
    expect(isCarveOut('sell')).toBe(true);
  });

  it('spending, publishing, and destructive flags are carve-outs on any stage', () => {
    expect(isCarveOut('document', { spendsMoney: true })).toBe(true);
    expect(isCarveOut('document', { publishesPublic: true })).toBe(true);
    expect(isCarveOut('implement', { destructive: true })).toBe(true);
    expect(isCarveOut('build', { spendsMoney: true })).toBe(true);
  });

  it('a routine stage that only requires review is NOT a carve-out', () => {
    expect(isCarveOut('build', { requiresReview: true })).toBe(false);
    expect(isCarveOut('design')).toBe(false);
    expect(isCarveOut('implement')).toBe(false);
    expect(isCarveOut('document')).toBe(false);
  });
});

describe('stageRequiresApproval — the review marker gates without carving out', () => {
  it('requiresReview gates a routine stage', () => {
    expect(stageRequiresApproval('build', { requiresReview: true })).toBe(true);
    expect(stageRequiresApproval('build')).toBe(false);
  });

  it('a carve-out flag gates even when it is not a gated stage', () => {
    expect(stageRequiresApproval('implement', { destructive: true })).toBe(true);
  });
});

describe('decideApprovalByReviewer — the record says who decided', () => {
  it('marks the approval decided by the Reviewer, with the reason attached', () => {
    const req = requestApproval('job-1', 'Job', 'build', 'needs a decision', 1000);
    const decided = decideApprovalByReviewer(req, 'approved', 'routine code change', 2000);
    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe('reviewer');
    expect(decided.decidedAt).toBe(2000);
    expect(decided.reason).toContain('routine code change');
  });

  it('a Reviewer denial is recorded, never silently dropped', () => {
    const req = requestApproval('job-1', 'Job', 'build', 'needs a decision', 1000);
    const decided = decideApprovalByReviewer(req, 'denied', 'too risky', 2000);
    expect(decided.status).toBe('denied');
    expect(decided.decidedBy).toBe('reviewer');
  });

  it('a decided request cannot be decided again', () => {
    const req = requestApproval('job-1', 'Job', 'build', 'needs a decision', 1000);
    const decided = decideApprovalByReviewer(req, 'approved', 'ok', 2000);
    expect(() => decideApprovalByReviewer(decided, 'approved', 'again', 3000)).toThrow();
  });

  it("Jesse's decisions are still marked as Jesse's", () => {
    const req = requestApproval('job-1', 'Job', 'release', 'needs Jesse', 1000);
    const decided = decideApproval(req, 'approved', 2000);
    expect(decided.decidedBy).toBe('jesse');
  });
});
