import { describe, expect, it } from 'vitest';
import {
  createAutomationFromProposal,
  parseOptimizedPrompt,
  parseReviewerReply,
  parseTriageReply,
  resolveMentionedAgents,
  validateAutomationProposal,
  type RunnerAgent,
} from '../../scripts/runner-lib';

function agent(id: string, name: string): RunnerAgent {
  return { id, name, endpointUrl: 'http://127.0.0.1:8897/chat', model: 'openai-fast' };
}

const AGENTS = [
  agent('agent-orchestrator', 'Orchestrator'),
  agent('agent-qa-tester', 'QA Tester'),
  agent('agent-code-reviewer', 'Code Reviewer'),
  agent('agent-frontend-developer', 'Frontend Developer'),
];

describe('resolveMentionedAgents — the Orchestrator mention flow', () => {
  it('resolves @mentions to agents, longest name wins, in order', () => {
    const out = resolveMentionedAgents(
      'Triage: @QA Tester write the test plan. @Code Reviewer check it.',
      AGENTS,
      'agent-orchestrator',
    );
    expect(out.map((a) => a.id)).toEqual(['agent-qa-tester', 'agent-code-reviewer']);
  });

  it('resolves the id form too (@agent-qa-tester) — the form the Orchestrator actually writes', () => {
    const out = resolveMentionedAgents(
      '@agent-qa-tester Please craft a test plan for the next mem20 change.',
      AGENTS,
      'agent-orchestrator',
    );
    expect(out.map((a) => a.id)).toEqual(['agent-qa-tester']);
  });

  it('never dispatches the Orchestrator to itself', () => {
    const out = resolveMentionedAgents('@Orchestrator do it yourself, @QA Tester help.', AGENTS, 'agent-orchestrator');
    expect(out.map((a) => a.id)).toEqual(['agent-qa-tester']);
  });

  it('ignores names that are not agents', () => {
    const out = resolveMentionedAgents('@Nobody Here do this. @QA Tester do that.', AGENTS, 'agent-orchestrator');
    expect(out.map((a) => a.id)).toEqual(['agent-qa-tester']);
  });

  it('caps the fan-out at 8, one level, no chaining', () => {
    const many = Array.from({ length: 12 }, (_, i) => agent(`agent-worker-${i}`, `Worker ${i}`));
    const reply = many.map((a) => `@${a.name}`).join(' ');
    const out = resolveMentionedAgents(reply, [...AGENTS, ...many], 'agent-orchestrator');
    expect(out.length).toBe(8);
  });

  it('returns nothing when there are no mentions', () => {
    expect(resolveMentionedAgents('Nothing to assign this run.', AGENTS, 'agent-orchestrator')).toEqual([]);
  });
});

describe('parseOptimizedPrompt — the Prompt Engineer returns the assignment', () => {
  const draft = 'Assignment from @Orchestrator: @QA Tester write the test plan.';

  it('returns a plain optimized reply as-is', () => {
    expect(parseOptimizedPrompt('Assignment: @QA Tester write the test plan, with exact steps.', draft)).toBe(
      'Assignment: @QA Tester write the test plan, with exact steps.',
    );
  });

  it('strips a trailing NOTE: line', () => {
    expect(
      parseOptimizedPrompt(
        'Assignment: @QA Tester write the test plan.\nNOTE: tightened the expected output.',
        draft,
      ),
    ).toBe('Assignment: @QA Tester write the test plan.');
  });

  it('takes the first fenced code block when the reply wraps the assignment in one', () => {
    expect(
      parseOptimizedPrompt(
        'Here is the optimized assignment:\n```\nAssignment: @QA Tester write the test plan.\n```\nNOTE: one variable changed.',
        draft,
      ),
    ).toBe('Assignment: @QA Tester write the test plan.');
  });

  it('falls back to the draft when the reply is empty or only a note', () => {
    expect(parseOptimizedPrompt('', draft)).toBe(draft);
    expect(parseOptimizedPrompt('NOTE: nothing to change.', draft)).toBe(draft);
  });
});

describe('parseTriageReply — the Triage Agent returns a reassignment', () => {
  it('parses REASSIGN plus the corrected assignment', () => {
    expect(
      parseTriageReply(
        'REASSIGN: @agent-code-reviewer\n@Code Reviewer write the test plan, with exact steps.',
      ),
    ).toEqual({
      agentId: 'agent-code-reviewer',
      prompt: '@Code Reviewer write the test plan, with exact steps.',
    });
  });

  it('returns null with no REASSIGN line', () => {
    expect(parseTriageReply('This looks fine, just send it.')).toBeNull();
  });

  it('returns null when the corrected prompt is empty', () => {
    expect(parseTriageReply('REASSIGN: @agent-qa-tester')).toBeNull();
  });
});

describe('parseReviewerReply — one-line verdicts only', () => {
  it('parses APPROVE with its reason', () => {
    expect(parseReviewerReply('APPROVE: routine code change, no spend or publish.')).toEqual({
      decision: 'approve',
      reason: 'routine code change, no spend or publish.',
    });
  });

  it('parses DENY with its reason', () => {
    expect(parseReviewerReply('DENY: too risky, needs rework.')).toEqual({
      decision: 'deny',
      reason: 'too risky, needs rework.',
    });
  });

  it('rejects prose with no verdict — the runner parks the job and retries the Reviewer', () => {
    expect(parseReviewerReply('Looks fine to me, go ahead I suppose.')).toBeNull();
    expect(parseReviewerReply('')).toBeNull();
  });
});

describe('validateAutomationProposal — the governed job-creation rules', () => {
  const base = {
    name: 'Hourly: QA Tester',
    schedule: '0 * * * *',
    agentId: 'agent-qa-tester',
    channelId: 'conv-build-room',
    target: 'Write the test plan for the next mem20 change.',
  };

  it('accepts a well-formed prompt automation', () => {
    expect(validateAutomationProposal(base, AGENTS)).toEqual({ ok: true });
  });

  it('refuses a bad cron schedule', () => {
    expect(validateAutomationProposal({ ...base, schedule: 'every hour' }, AGENTS).ok).toBe(false);
    expect(validateAutomationProposal({ ...base, schedule: '0 25 * * *' }, AGENTS).ok).toBe(false);
  });

  it('refuses an unknown agent', () => {
    const r = validateAutomationProposal({ ...base, agentId: 'agent-ghost' }, AGENTS);
    expect(r.ok).toBe(false);
  });

  it('refuses any channel but the Build Room', () => {
    const r = validateAutomationProposal({ ...base, channelId: 'conv-scout' }, AGENTS);
    expect(r.ok).toBe(false);
  });

  it('refuses an empty or oversized target', () => {
    expect(validateAutomationProposal({ ...base, target: '  ' }, AGENTS).ok).toBe(false);
    expect(validateAutomationProposal({ ...base, target: 'x'.repeat(2001) }, AGENTS).ok).toBe(false);
  });

  it('refuses spending, publishing, releasing, and deleting as high-stakes proposals', () => {
    for (const target of [
      'Buy the ads for the launch.',
      'Publish the release notes to the public site.',
      'Release version 4.1 to the store.',
      'Delete the old staging data.',
    ]) {
      const r = validateAutomationProposal({ ...base, target }, AGENTS);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.carveOut).toBe(true);
    }
  });

  it('builds a real CronJob from a valid proposal', () => {
    const job = createAutomationFromProposal(base, AGENTS);
    expect(job.type).toBe('prompt');
    expect(job.schedule).toBe('0 * * * *');
    expect(job.agentId).toBe('agent-qa-tester');
    expect(job.channelId).toBe('conv-build-room');
    expect(job.enabled).toBe(true);
  });

  it('throws instead of building from an invalid proposal', () => {
    expect(() => createAutomationFromProposal({ ...base, schedule: 'nope' }, AGENTS)).toThrow();
  });
});
