import { describe, expect, it } from 'vitest';
import {
  emptyRunnerState,
  processDue,
  type RateLimitEvent,
  type RunnerAgent,
  type RunnerState,
} from '../../scripts/runner-lib';
import { createCronJob } from './scheduler';
import { createJob } from './jobs';

const T0 = new Date(2026, 10, 26, 10, 0, 0); // minute 0: hourly + */15 both match

function agent(id: string, name: string): RunnerAgent {
  return { id, name, endpointUrl: 'http://127.0.0.1:8897/chat', model: 'openai-fast', provider: 'pollinations' };
}

function silentLog(): (message: string) => void {
  return () => {};
}

function commandStub() {
  return async () => ({
    ok: true,
    exitCode: 0,
    output: '',
    timedOut: false,
    blocked: false,
    blockedReason: null,
  });
}

describe('processDue — Orchestrator mention flow', () => {
  it('dispatches each @mentioned agent once and records the room messages', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-orchestrator', 'Orchestrator'), agent('agent-qa-tester', 'QA Tester')],
      cronJobs: [
        createCronJob({
          name: 'Orchestrator triage',
          schedule: '*/15 * * * *',
          type: 'prompt',
          target: 'Triage the Build Room.',
          agentId: 'agent-orchestrator',
          channelId: 'conv-build-room',
        }),
      ],
    };
    const calls: Array<{ agentId: string; prompt: string }> = [];
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a, prompt) => {
        calls.push({ agentId: a.id, prompt });
        if (a.id === 'agent-orchestrator') {
          return '@QA Tester please write the test plan for the next mem20 change and report back.';
        }
        return 'Test plan done.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls.map((c) => c.agentId)).toEqual(['agent-orchestrator', 'agent-qa-tester']);
    expect(calls[1].prompt).toContain('Assignment from @Orchestrator');
    expect(calls[1].prompt).toContain('@QA Tester');
    expect(out.channelMessages.map((m) => m.kind)).toEqual(['orchestrator', 'mention']);
    expect(out.channelMessages[0].channelId).toBe('conv-build-room');
    expect(out.cronJobs[0].runs).toHaveLength(1);
    expect(out.cronJobs[0].runs[0].ok).toBe(true);
    expect(fired.some((f) => f.includes('orchestrator → @QA Tester'))).toBe(true);
  });

  it('records the Orchestrator reply in the room even when it mentions nobody', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-orchestrator', 'Orchestrator')],
      cronJobs: [
        createCronJob({
          name: 'Orchestrator triage',
          schedule: '*/15 * * * *',
          type: 'prompt',
          target: 'Triage the Build Room.',
          agentId: 'agent-orchestrator',
          channelId: 'conv-build-room',
        }),
      ],
    };
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async () => 'Nothing to assign this run.',
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(out.channelMessages).toHaveLength(1);
    expect(out.channelMessages[0].kind).toBe('orchestrator');
    expect(fired.some((f) => f.includes('no @mentions'))).toBe(true);
  });
});

describe('processDue — Reviewer approval flow', () => {
  function reviewableJob() {
    return createJob({
      name: 'Reviewable job',
      channelId: 'conv-build-room',
      schedule: { kind: 'interval', everyMs: 1000 },
      stages: [
        {
          stage: 'build',
          agentId: 'agent-atlas',
          prompt: 'Do the routine build step.',
          expectedOutput: 'Built.',
          flags: { requiresReview: true },
        },
      ],
    });
  }

  function carveOutJob() {
    return createJob({
      name: 'Release job',
      channelId: 'conv-build-room',
      schedule: { kind: 'interval', everyMs: 1000 },
      stages: [
        {
          stage: 'release',
          agentId: 'agent-atlas',
          prompt: 'Prepare the release.',
          expectedOutput: 'Release notes.',
        },
      ],
    });
  }

  it('a routine gated stage is approved by the Reviewer and proceeds in the same tick', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [reviewableJob()],
    };
    const calls: string[] = [];
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        if (a.id === 'agent-reviewer') return 'APPROVE: routine code change, no spend or publish.';
        return 'Build step done.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls).toEqual(['agent-reviewer', 'agent-atlas']);
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0].status).toBe('approved');
    expect(out.approvals[0].decidedBy).toBe('reviewer');
    expect(out.jobs[0].status).toBe('done');
    expect(out.jobs[0].currentStageIndex).toBe(1);
  });

  it('a Reviewer denial parks the job and never runs the stage', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [reviewableJob()],
    };
    const calls: string[] = [];
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        if (a.id === 'agent-reviewer') return 'DENY: too risky, needs a human look.';
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls).toEqual(['agent-reviewer']);
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0].status).toBe('denied');
    expect(out.approvals[0].decidedBy).toBe('reviewer');
    expect(out.jobs[0].status).toBe('awaiting_approval');
    expect(out.jobs[0].currentStageIndex).toBe(0);
  });

  it('a release stage is a carve-out: Jesse is asked, the Reviewer is never called', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [carveOutJob()],
    };
    const calls: string[] = [];
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls).toEqual([]);
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0].status).toBe('pending');
    expect(out.approvals[0].decidedBy).toBeUndefined();
    expect(out.approvals[0].reason).toContain('Carve-out');
    expect(out.jobs[0].status).toBe('awaiting_approval');
    expect(fired.some((f) => f.includes('approval requested from Jesse'))).toBe(true);
  });

  it('an unreachable Reviewer falls back to a Jesse approval request — never silently approves', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [reviewableJob()],
    };
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        if (a.id === 'agent-reviewer') throw new Error('endpoint down');
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0].status).toBe('pending');
    expect(out.approvals[0].reason).toContain('Reviewer unavailable');
    expect(out.jobs[0].status).toBe('awaiting_approval');
  });

  it('an unreadable Reviewer reply falls back to Jesse', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [reviewableJob()],
    };
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        if (a.id === 'agent-reviewer') return 'Looks fine to me, I guess?';
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0].status).toBe('pending');
    expect(out.jobs[0].status).toBe('awaiting_approval');
  });
});

describe('processDue — inter-dispatch spacing', () => {
  it('waits the configured gap between dispatches, outside any dispatch budget', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-qa-tester', 'QA Tester'), agent('agent-code-reviewer', 'Code Reviewer')],
      cronJobs: [
        createCronJob({
          name: 'Hourly: QA Tester',
          schedule: '* * * * *',
          type: 'prompt',
          target: 'Write the test plan.',
          agentId: 'agent-qa-tester',
          channelId: 'conv-build-room',
        }),
        createCronJob({
          name: 'Hourly: Code Reviewer',
          schedule: '* * * * *',
          type: 'prompt',
          target: 'Write the review checklist.',
          agentId: 'agent-code-reviewer',
          channelId: 'conv-build-room',
        }),
      ],
    };
    const starts: number[] = [];
    const ends: number[] = [];
    await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, 10));
        ends.push(Date.now());
        return `${a.name} done.`;
      },
      executeCommand: commandStub(),
      log: silentLog(),
      minDispatchGapMs: 150,
    });
    expect(starts).toHaveLength(2);
    // The second dispatch started at least ~150ms after the first ended.
    expect(starts[1] - ends[0]).toBeGreaterThanOrEqual(120);
  });

  it('does not wait at all when no gap is configured (default 0)', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-qa-tester', 'QA Tester')],
      cronJobs: [
        createCronJob({
          name: 'Hourly: QA Tester',
          schedule: '* * * * *',
          type: 'prompt',
          target: 'Write the test plan.',
          agentId: 'agent-qa-tester',
          channelId: 'conv-build-room',
        }),
      ],
    };
    const t0 = Date.now();
    await processDue(state, T0, {
      dispatchPrompt: async () => 'done.',
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('processDue — rate-limit rescue loop', () => {
  it('wakes the Researcher, resends the retained request, and records the rescue', async () => {
    const qa = agent('agent-qa-tester', 'QA Tester');
    const researcher = agent('agent-provider-researcher', 'Provider Researcher');
    const state: RunnerState = { ...emptyRunnerState(), agents: [qa, researcher] };
    const event: RateLimitEvent = {
      id: 'rl-test-1',
      ts: T0.getTime(),
      agentId: 'agent-qa-tester',
      agentName: 'QA Tester',
      channelId: 'conv-build-room',
      prompt: 'Write the test plan for the next mem20 change.',
      provider: 'pollinations',
      error: 'Pollinations 402: rate limited',
    };
    const calls: string[] = [];
    const acknowledged: string[] = [];
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        if (a.id === 'agent-provider-researcher') {
          return 'Searched for new keyless providers; none validated. Staying on Pollinations.';
        }
        return 'Resent test plan: here it is.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
      rateLimitEvents: async () => [event],
      acknowledgeRateLimitEvents: async (ids) => {
        acknowledged.push(...ids);
      },
      reloadAgents: async () => [qa, researcher],
    });
    expect(calls).toEqual(['agent-provider-researcher', 'agent-qa-tester']);
    expect(out.rateLimitRescues).toHaveLength(1);
    const rescue = out.rateLimitRescues[0];
    expect(rescue.eventId).toBe('rl-test-1');
    expect(rescue.fromProvider).toBe('pollinations');
    expect(rescue.toProvider).toBe('pollinations');
    expect(rescue.resent).toBe(true);
    expect(rescue.resendCompleted).toBe(true);
    expect(rescue.researcherReply).toContain('none validated');
    expect(acknowledged).toEqual(['rl-test-1']);
    expect(out.channelMessages.map((m) => m.kind)).toEqual(['researcher', 'resend']);
    expect(fired.some((f) => f.includes('rate-limit rescue: resent @QA Tester'))).toBe(true);
  });

  it('does not retry an event whose rescue already completed', async () => {
    const qa = agent('agent-qa-tester', 'QA Tester');
    const researcher = agent('agent-provider-researcher', 'Provider Researcher');
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [qa, researcher],
      rateLimitRescues: [
        {
          eventId: 'rl-test-1',
          ts: T0.getTime(),
          agentId: 'agent-qa-tester',
          fromProvider: 'pollinations',
          toProvider: 'pollinations',
          resent: true,
          resendCompleted: true,
          researcherReply: 'done',
          attempts: 1,
        },
      ],
    };
    const calls: string[] = [];
    const event: RateLimitEvent = {
      id: 'rl-test-1',
      ts: T0.getTime(),
      agentId: 'agent-qa-tester',
      agentName: 'QA Tester',
      channelId: 'conv-build-room',
      prompt: 'Write the test plan.',
      provider: 'pollinations',
      error: 'Pollinations 402',
    };
    await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        return 'x';
      },
      executeCommand: commandStub(),
      log: silentLog(),
      rateLimitEvents: async () => [event],
    });
    expect(calls).toEqual([]);
  });
});
