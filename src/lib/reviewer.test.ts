import { describe, expect, it } from 'vitest';
import {
  decideApproval,
  decideApprovalByReviewer,
  isHighStakes,
  requestApproval,
  stageRequiresApproval,
} from './governance';

describe('isHighStakes — extra Reviewer scrutiny, never a different approver', () => {
  it('release, advertise, and sell are always high-stakes', () => {
    expect(isHighStakes('release')).toBe(true);
    expect(isHighStakes('advertise')).toBe(true);
    expect(isHighStakes('sell')).toBe(true);
  });

  it('spending, publishing, and destructive flags are high-stakes on any stage', () => {
    expect(isHighStakes('document', { spendsMoney: true })).toBe(true);
    expect(isHighStakes('document', { publishesPublic: true })).toBe(true);
    expect(isHighStakes('implement', { destructive: true })).toBe(true);
    expect(isHighStakes('build', { spendsMoney: true })).toBe(true);
  });

  it('a routine stage that only requires review is NOT high-stakes', () => {
    expect(isHighStakes('build', { requiresReview: true })).toBe(false);
    expect(isHighStakes('design')).toBe(false);
    expect(isHighStakes('implement')).toBe(false);
    expect(isHighStakes('document')).toBe(false);
  });
});

describe('stageRequiresApproval — the review marker gates without changing the approver', () => {
  it('requiresReview gates a routine stage', () => {
    expect(stageRequiresApproval('build', { requiresReview: true })).toBe(true);
    expect(stageRequiresApproval('build')).toBe(false);
  });

  it('a high-stakes flag gates even when it is not a gated stage', () => {
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

  it('every decision is the Reviewer’s — decideApproval records the Reviewer too, including for high-stakes stages', () => {
    const req = requestApproval('job-1', 'Job', 'release', 'needs a decision', 1000);
    const decided = decideApproval(req, 'approved', 2000);
    expect(decided.decidedBy).toBe('reviewer');
  });
});
