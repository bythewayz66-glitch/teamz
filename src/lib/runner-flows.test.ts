import { describe, expect, it } from 'vitest';
import {
  assignmentReviewPrompt,
  emptyRunnerState,
  findStrandedAgents,
  isLowRiskReview,
  optimizerPrompt,
  processDue,
  recordChannelMessage,
  resetDispatchThrottle,
  RESCUE_BACKOFF_BASE_MS,
  stageReviewPrompt,
  triagePrompt,
  type RateLimitEvent,
  type RunnerAgent,
  type RunnerState,
} from '../../scripts/runner-lib';
import { decideApprovalByReviewer, requestApproval } from './governance';
import { createCronJob } from './scheduler';
import { createJob, currentStage } from './jobs';

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
  function gateAgents() {
    return [
      agent('agent-orchestrator', 'Orchestrator'),
      agent('agent-qa-tester', 'QA Tester'),
      agent('agent-code-reviewer', 'Code Reviewer'),
      agent('agent-prompt-engineer', 'Prompt Engineer'),
      agent('agent-reviewer', 'Reviewer'),
      agent('agent-triage', 'Triage Agent'),
    ];
  }

  it('dispatches each @mentioned agent once, after the optimizer and the Reviewer approve it', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: gateAgents(),
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
        if (a.id === 'agent-prompt-engineer') {
          return 'Assignment from @Orchestrator: @QA Tester write the test plan for the next mem20 change and report back with the completed output.';
        }
        if (a.id === 'agent-reviewer') return 'APPROVE: clear, bounded task with an explicit expected output.';
        return 'Test plan done.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls.map((c) => c.agentId)).toEqual([
      'agent-orchestrator',
      'agent-prompt-engineer',
      'agent-reviewer',
      'agent-qa-tester',
    ]);
    // The room receives the OPTIMIZED prompt, not the raw draft.
    expect(calls[3].prompt).toContain('Assignment from @Orchestrator');
    expect(calls[3].prompt).toContain('@QA Tester');
    expect(calls[3].prompt).toContain('report back with the completed output');
    // The Reviewer saw the optimized prompt and the core drive.
    expect(calls[2].prompt).toContain('CORE DRIVE');
    expect(calls[2].prompt).toContain("mem20's success and livelihood");
    expect(calls[2].prompt).toContain('best product of its kind');
    expect(calls[2].prompt).toContain('actively making money');
    expect(out.channelMessages.map((m) => m.kind)).toEqual(['orchestrator', 'mention']);
    expect(out.channelMessages[0].channelId).toBe('conv-build-room');
    expect(out.cronJobs[0].runs).toHaveLength(1);
    expect(out.cronJobs[0].runs[0].ok).toBe(true);
    expect(fired.some((f) => f.includes('orchestrator → @QA Tester'))).toBe(true);
    expect(fired.some((f) => f.includes('orchestrator gate: @QA Tester — APPROVED by Reviewer'))).toBe(true);
  });

  it('assigns at most 2 mentioned agents per Orchestrator run — the rest stay in the room for the next run (Nov 27, 2026 fleet slowdown)', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [...gateAgents(), agent('agent-scout', 'Scout')],
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
    const calls: Array<{ agentId: string }> = [];
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push({ agentId: a.id });
        if (a.id === 'agent-orchestrator') {
          return '@QA Tester write the test plan. @Code Reviewer write the review checklist. @Scout scout the next change.';
        }
        if (a.id === 'agent-prompt-engineer') {
          return 'Assignment from @Orchestrator: do the addressed part and report back.';
        }
        if (a.id === 'agent-reviewer') return 'APPROVE: clear, bounded task.';
        return 'Done.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    // Two mentions assigned (each: optimizer + Reviewer + target);
    // the third is deferred, not dropped — the Orchestrator's reply
    // is recorded in the room, so the next run can pick it up.
    expect(calls.map((c) => c.agentId)).toEqual([
      'agent-orchestrator',
      'agent-prompt-engineer',
      'agent-reviewer',
      'agent-qa-tester',
      'agent-prompt-engineer',
      'agent-reviewer',
      'agent-code-reviewer',
    ]);
    expect(fired.some((f) => f.includes('@Scout not assigned this tick'))).toBe(true);
    expect(out.channelMessages.filter((m) => m.kind === 'mention')).toHaveLength(2);
  });

  it('a Reviewer denial sends the item to triage, and the fixed item re-passes the gates before reaching the room', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: gateAgents(),
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
    let reviewerCalls = 0;
    let optimizerCalls = 0;
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a, prompt) => {
        calls.push({ agentId: a.id, prompt });
        if (a.id === 'agent-orchestrator') {
          return '@QA Tester please write the test plan, no details yet.';
        }
        if (a.id === 'agent-prompt-engineer') {
          optimizerCalls += 1;
          return optimizerCalls === 1
            ? 'Assignment from @Orchestrator: @QA Tester write the test plan.'
            : 'Assignment from @Orchestrator: @Code Reviewer write the test plan for the next mem20 change, with exact steps and the expected result for each test.';
        }
        if (a.id === 'agent-reviewer') {
          reviewerCalls += 1;
          return reviewerCalls === 1
            ? 'DENY: too vague — no expected output, no scope.'
            : 'APPROVE: clear, bounded task with an explicit expected output.';
        }
        if (a.id === 'agent-triage') {
          return 'REASSIGN: @agent-code-reviewer\n@Code Reviewer write the test plan for the next mem20 change, with exact steps and the expected result for each test.';
        }
        return 'Test plan done.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    // Orchestrator → optimizer → Reviewer (deny) → triage → optimizer → Reviewer (approve) → reassignee.
    expect(calls.map((c) => c.agentId)).toEqual([
      'agent-orchestrator',
      'agent-prompt-engineer',
      'agent-reviewer',
      'agent-triage',
      'agent-prompt-engineer',
      'agent-reviewer',
      'agent-code-reviewer',
    ]);
    // The triage dispatch carried the Reviewer's notes.
    expect(calls[3].prompt).toContain('too vague');
    expect(calls[3].prompt).toContain('the Reviewer DENIED this work');
    // The room received the corrected prompt, via the reassignee — never the denied draft, never the original target.
    expect(calls[6].prompt).toContain('exact steps and the expected result');
    expect(out.channelMessages.map((m) => m.kind)).toEqual(['orchestrator', 'mention']);
    expect(out.channelMessages[1].agentId).toBe('agent-code-reviewer');
    expect(fired.some((f) => f.includes('DENIED by Reviewer'))).toBe(true);
    expect(fired.some((f) => f.includes('triage replied'))).toBe(true);
    expect(fired.some((f) => f.includes('APPROVED after triage'))).toBe(true);
  });

  it('a second Reviewer denial after triage never reaches the room', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: gateAgents(),
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
    const calls: string[] = [];
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        if (a.id === 'agent-orchestrator') return '@QA Tester do the vague thing.';
        if (a.id === 'agent-prompt-engineer') return 'Assignment: @QA Tester do the vague thing.';
        if (a.id === 'agent-reviewer') return 'DENY: still vague, still no scope.';
        if (a.id === 'agent-triage') return 'REASSIGN: @agent-qa-tester\n@QA Tester do the vague thing, more clearly.';
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls).toEqual([
      'agent-orchestrator',
      'agent-prompt-engineer',
      'agent-reviewer',
      'agent-triage',
      'agent-prompt-engineer',
      'agent-reviewer',
    ]);
    // No mention dispatch, no room message for the target — only the
    // Orchestrator reply and the gate record of the denial.
    expect(out.channelMessages.map((m) => m.kind)).toEqual(['orchestrator', 'gate']);
    expect(fired.some((f) => f.includes('DENIED again after triage'))).toBe(true);
    expect(fired.some((f) => f.includes('assignment NOT sent'))).toBe(true);
  });

  it('no gate agents configured means no assignment reaches the room', async () => {
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
    const calls: string[] = [];
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        return '@QA Tester please write the test plan.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls).toEqual(['agent-orchestrator']);
    expect(out.channelMessages.map((m) => m.kind)).toEqual(['orchestrator', 'gate']);
    expect(fired.some((f) => f.includes('NO PROMPT ENGINEER CONFIGURED'))).toBe(true);
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

  function highStakesJob() {
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
    // The job is interval-scheduled, so finishing its only stage
    // auto-resets it to a fresh cycle instead of parking as `done`.
    expect(out.jobs[0].status).toBe('active');
    expect(out.jobs[0].currentStageIndex).toBe(0);
    expect(out.jobs[0].cyclesCompleted).toBe(1);
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

  it('a Reviewer denial sends the work to the Triage Agent — recorded, never silently dropped, job stays parked', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [
        agent('agent-atlas', 'Atlas'),
        agent('agent-reviewer', 'Reviewer'),
        agent('agent-triage', 'Triage Agent'),
      ],
      jobs: [reviewableJob()],
    };
    const calls: Array<{ agentId: string; prompt: string }> = [];
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a, prompt) => {
        calls.push({ agentId: a.id, prompt });
        if (a.id === 'agent-reviewer') return 'DENY: the build step touches a blocked path.';
        if (a.id === 'agent-triage') {
          return 'REASSIGN: @agent-atlas\n@Atlas redo the build step without the blocked path, then report the exact files changed.';
        }
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    // Reviewer decides, then Triage gets the denied item with the notes.
    expect(calls.map((c) => c.agentId)).toEqual(['agent-reviewer', 'agent-triage']);
    expect(calls[1].prompt).toContain('the build step touches a blocked path');
    expect(calls[1].prompt).toContain('the Reviewer DENIED this work');
    // The denial stands and the job stays parked — triage proposes, it does not un-park.
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0].status).toBe('denied');
    expect(out.jobs[0].status).toBe('awaiting_approval');
    expect(out.jobs[0].currentStageIndex).toBe(0);
    // The triage reply is recorded in the room for the Orchestrator to pick up.
    const triageMsgs = out.channelMessages.filter((m) => m.kind === 'triage');
    expect(triageMsgs).toHaveLength(1);
    expect(triageMsgs[0].text).toContain('redo the build step without the blocked path');
    expect(fired.some((f) => f.includes('triage replied'))).toBe(true);
  });

  it('a release stage goes to the Reviewer like any other gated stage — the Reviewer is the sole decision-maker', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [highStakesJob()],
    };
    const calls: string[] = [];
    const reviewerPrompts: string[] = [];
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async (a, prompt) => {
        calls.push(a.id);
        if (a.id === 'agent-reviewer') {
          reviewerPrompts.push(prompt);
          return 'APPROVE: release notes verified against the code and history, nothing faked.';
        }
        return 'Release prepared.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls).toEqual(['agent-reviewer', 'agent-atlas']);
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0].status).toBe('approved');
    expect(out.approvals[0].decidedBy).toBe('reviewer');
    // Interval-scheduled: finishing auto-resets to a fresh cycle.
    expect(out.jobs[0].status).toBe('active');
    expect(out.jobs[0].currentStageIndex).toBe(0);
    expect(out.jobs[0].cyclesCompleted).toBe(1);
    // The dispatch tells the Reviewer it is the sole decision-maker, that
    // this is high-stakes, and what standing rules to apply.
    expect(reviewerPrompts[0]).toContain('SOLE decision-maker');
    expect(reviewerPrompts[0]).toContain('HIGH-STAKES');
    expect(reviewerPrompts[0]).toContain('never remove a feature and never fake one');
    expect(reviewerPrompts[0]).toContain('repo-root AGENTS.md is canonical');
    expect(reviewerPrompts[0]).toContain('mem20core and mem20corez are distinct');
    // And the core drive governs the decision, above the standing rules.
    expect(reviewerPrompts[0]).toContain('CORE DRIVE');
    expect(reviewerPrompts[0]).toContain("mem20's success and livelihood");
    expect(reviewerPrompts[0]).toContain('best product of its kind');
    expect(reviewerPrompts[0]).toContain('actively making money');
  });

  it('a Reviewer denial of a high-stakes stage parks the job and never runs the stage', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [highStakesJob()],
    };
    const calls: string[] = [];
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        if (a.id === 'agent-reviewer') return 'DENY: release notes do not match the code.';
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

  it('an unreachable Reviewer parks the job with no approval filed — never silently approves, never falls back to anyone', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [reviewableJob()],
    };
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        if (a.id === 'agent-reviewer') throw new Error('endpoint down');
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(out.approvals).toHaveLength(0);
    expect(out.jobs[0].status).toBe('awaiting_approval');
    expect(fired.some((f) => f.includes('will retry the Reviewer on a later tick'))).toBe(true);
  });

  it('an unreadable Reviewer reply parks the job with no approval filed', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [reviewableJob()],
    };
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        if (a.id === 'agent-reviewer') return 'Looks fine to me, I guess?';
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(out.approvals).toHaveLength(0);
    expect(out.jobs[0].status).toBe('awaiting_approval');
    expect(fired.some((f) => f.includes('will retry the Reviewer on a later tick'))).toBe(true);
  });

  it('a job parked by an unreachable Reviewer retries the Reviewer on a later tick', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [reviewableJob()],
    };
    let reviewerCalls = 0;
    const deps = {
      dispatchPrompt: async (a: RunnerAgent) => {
        if (a.id === 'agent-reviewer') {
          reviewerCalls += 1;
          if (reviewerCalls === 1) throw new Error('endpoint down');
          return 'APPROVE: routine code change, no spend or publish.';
        }
        return 'Build step done.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    };
    const first = await processDue(state, T0, deps);
    expect(first.state.approvals).toHaveLength(0);
    expect(first.state.jobs[0].status).toBe('awaiting_approval');
    const second = await processDue(first.state, new Date(T0.getTime() + 2000), deps);
    expect(reviewerCalls).toBe(2);
    expect(second.state.approvals).toHaveLength(1);
    expect(second.state.approvals[0].status).toBe('approved');
    expect(second.state.approvals[0].decidedBy).toBe('reviewer');
    // Interval-scheduled: finishing auto-resets to a fresh cycle.
    expect(second.state.jobs[0].status).toBe('active');
    expect(second.state.jobs[0].currentStageIndex).toBe(0);
    expect(second.state.jobs[0].cyclesCompleted).toBe(1);
  });

  it('no Reviewer configured parks the job as a config error — no approval filed, retried once a Reviewer exists', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas')],
      jobs: [reviewableJob()],
    };
    const deps = {
      dispatchPrompt: async () => 'should never run',
      executeCommand: commandStub(),
      log: silentLog(),
    };
    const first = await processDue(state, T0, deps);
    expect(first.state.approvals).toHaveLength(0);
    expect(first.state.jobs[0].status).toBe('awaiting_approval');
    expect(first.fired.some((f) => f.includes('NO REVIEWER CONFIGURED'))).toBe(true);
    const withReviewer: RunnerState = {
      ...first.state,
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
    };
    const second = await processDue(withReviewer, new Date(T0.getTime() + 2000), {
      ...deps,
      dispatchPrompt: async (a: RunnerAgent) => {
        if (a.id === 'agent-reviewer') return 'APPROVE: routine code change.';
        return 'Build step done.';
      },
    });
    expect(second.state.approvals).toHaveLength(1);
    expect(second.state.approvals[0].decidedBy).toBe('reviewer');
    // Interval-scheduled: finishing auto-resets to a fresh cycle.
    expect(second.state.jobs[0].status).toBe('active');
    expect(second.state.jobs[0].currentStageIndex).toBe(0);
    expect(second.state.jobs[0].cyclesCompleted).toBe(1);
  });

  it('the Reviewer request carries completed stage outputs, so it judges the actual change', async () => {
    const job = createJob({
      name: 'Two-stage reviewable job',
      channelId: 'conv-build-room',
      schedule: { kind: 'interval', everyMs: 1000 },
      stages: [
        {
          stage: 'design',
          agentId: 'agent-atlas',
          prompt: 'Plan the check.',
          expectedOutput: 'A check plan.',
        },
        {
          stage: 'build',
          agentId: 'agent-atlas',
          prompt: 'Do the routine build step.',
          expectedOutput: 'Built.',
          flags: { requiresReview: true },
        },
      ],
    });
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [job],
    };
    const reviewerPrompts: string[] = [];
    const deps = {
      dispatchPrompt: async (a: RunnerAgent, prompt: string) => {
        if (a.id === 'agent-reviewer') {
          reviewerPrompts.push(prompt);
          return 'APPROVE: routine, matches the plan.';
        }
        return 'Design done: check the cartoon page for the stale line.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    };
    // Tick 1: design completes. Tick 2: the gated build stage asks the
    // Reviewer — with the design output in the request.
    let out = await processDue(state, T0, deps);
    expect(out.state.jobs[0].currentStageIndex).toBe(1);
    out = await processDue(out.state, new Date(T0.getTime() + 2000), deps);
    expect(reviewerPrompts).toHaveLength(1);
    expect(reviewerPrompts[0]).toContain('Design done: check the cartoon page for the stale line.');
    expect(reviewerPrompts[0]).toContain('judge the actual change');
    // And the push-path distinction: a routine repo commit is not a
    // public release, so the Reviewer can judge it on its merits.
    expect(reviewerPrompts[0]).toContain('NOT a public release');
    expect(out.state.approvals[0].decidedBy).toBe('reviewer');
  });

  it('a gated command stage persists state before executing (onBeforeCommand), so the push script can verify the approval', async () => {
    const job = createJob({
      name: 'Push job',
      channelId: 'conv-build-room',
      schedule: { kind: 'interval', everyMs: 1000 },
      workdir: '/srv/mem20',
      allowedCommands: [['sudo', '/opt/teamz-runner/push-mem20.py']],
      stages: [
        {
          stage: 'upgrade',
          agentId: 'agent-atlas',
          prompt: 'Push the staged change.',
          expectedOutput: 'The push record.',
          flags: { requiresReview: true },
          command: { argv: ['sudo', '/opt/teamz-runner/push-mem20.py'] },
        },
      ],
    });
    const liveApproval = {
      id: 'appr-live',
      jobId: job.id,
      jobName: job.name,
      stage: 'upgrade' as const,
      reason: 'Stage "upgrade" needs a decision',
      requestedAt: T0.getTime(),
      status: 'approved' as const,
      decidedAt: T0.getTime(),
      consumedAt: null,
      decidedBy: 'reviewer' as const,
    };
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [job],
      approvals: [liveApproval],
    };
    const order: string[] = [];
    let persistedApprovals: unknown = null;
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async () => {
        throw new Error('no prompt dispatch on a gated command tick');
      },
      executeCommand: async () => {
        order.push('execute');
        return { ok: true, exitCode: 0, output: 'PUSHED abc123', timedOut: false, blocked: false, blockedReason: null };
      },
      onBeforeCommand: async (s) => {
        order.push('persist');
        persistedApprovals = s.approvals;
      },
      log: silentLog(),
    });
    expect(order).toEqual(['persist', 'execute']);
    expect(persistedApprovals).toHaveLength(1);
    expect((persistedApprovals as Array<{ id: string }>)[0].id).toBe('appr-live');
    // Interval-scheduled: finishing auto-resets to a fresh cycle.
    expect(out.jobs[0].status).toBe('active');
    expect(out.jobs[0].currentStageIndex).toBe(0);
    expect(out.jobs[0].cyclesCompleted).toBe(1);
    expect(out.approvals[0].consumedAt).not.toBeNull();
  });

  it('a failing onBeforeCommand refuses the gated command stage — nothing executes, approval unconsumed', async () => {
    const job = createJob({
      name: 'Push job',
      channelId: 'conv-build-room',
      schedule: { kind: 'interval', everyMs: 1000 },
      workdir: '/srv/mem20',
      allowedCommands: [['sudo', '/opt/teamz-runner/push-mem20.py']],
      stages: [
        {
          stage: 'upgrade',
          agentId: 'agent-atlas',
          prompt: 'Push the staged change.',
          expectedOutput: 'The push record.',
          flags: { requiresReview: true },
          command: { argv: ['sudo', '/opt/teamz-runner/push-mem20.py'] },
        },
      ],
    });
    const liveApproval = {
      id: 'appr-live',
      jobId: job.id,
      jobName: job.name,
      stage: 'upgrade' as const,
      reason: 'Stage "upgrade" needs a decision',
      requestedAt: T0.getTime(),
      status: 'approved' as const,
      decidedAt: T0.getTime(),
      consumedAt: null,
      decidedBy: 'reviewer' as const,
    };
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [job],
      approvals: [liveApproval],
    };
    let executed = false;
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async () => {
        throw new Error('no prompt dispatch on a gated command tick');
      },
      executeCommand: async () => {
        executed = true;
        return { ok: true, exitCode: 0, output: '', timedOut: false, blocked: false, blockedReason: null };
      },
      onBeforeCommand: async () => {
        throw new Error('disk full');
      },
      log: silentLog(),
    });
    expect(executed).toBe(false);
    expect(out.jobs[0].runs[0].status).toBe('failed');
    expect(out.jobs[0].currentStageIndex).toBe(0);
    expect(out.approvals[0].consumedAt).toBeNull();
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

  it('the gap persists across ticks — the next tick still waits the full gap (Nov 27, 2026 fleet slowdown)', async () => {
    resetDispatchThrottle();
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-qa-tester', 'QA Tester')],
      cronJobs: [
        createCronJob({
          name: 'Every minute: QA Tester',
          schedule: '* * * * *',
          type: 'prompt',
          target: 'Write the test plan.',
          agentId: 'agent-qa-tester',
          channelId: 'conv-build-room',
        }),
      ],
    };
    const starts: number[] = [];
    const ends: number[] = [];
    const deps = {
      dispatchPrompt: async (a: RunnerAgent) => {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, 10));
        ends.push(Date.now());
        return `${a.name} done.`;
      },
      executeCommand: commandStub(),
      log: silentLog(),
      minDispatchGapMs: 150,
    };
    // Tick 1 fires the every-minute cron. Tick 2, a minute later, has
    // the same cron due again (new minute slot) — but its first
    // dispatch must still wait the full gap after tick 1's dispatch
    // ended. The gap is global, not per-tick.
    const first = await processDue(state, T0, deps);
    expect(starts).toHaveLength(1);
    await processDue(first.state, new Date(T0.getTime() + 60_000), deps);
    expect(starts).toHaveLength(2);
    expect(starts[1] - ends[0]).toBeGreaterThanOrEqual(120);
    resetDispatchThrottle();
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

  it('a rescue that itself 402s backs off the provider — no dispatch until the cooldown expires', async () => {
    const qa = agent('agent-qa-tester', 'QA Tester');
    const researcher = agent('agent-provider-researcher', 'Provider Researcher');
    const event: RateLimitEvent = {
      id: 'rl-test-backoff',
      ts: T0.getTime(),
      agentId: 'agent-qa-tester',
      agentName: 'QA Tester',
      channelId: 'conv-build-room',
      prompt: 'Write the test plan.',
      provider: 'pollinations',
      error: 'Pollinations 402: Free limit reached',
    };
    const calls: string[] = [];
    const deps = {
      dispatchPrompt: async (a: RunnerAgent) => {
        calls.push(a.id);
        throw new Error('Pollinations 402: Free limit reached: 100 replies a day per IP');
      },
      executeCommand: commandStub(),
      log: silentLog(),
      rateLimitEvents: async () => [event],
    };
    // Tick 1: the rescue is attempted and itself 402s — backoff is set.
    const first = await processDue({ ...emptyRunnerState(), agents: [qa, researcher] }, T0, deps);
    expect(calls).toEqual(['agent-provider-researcher', 'agent-qa-tester']);
    expect(first.state.rateLimitRescues).toHaveLength(1);
    expect(first.state.rateLimitRescues[0].resendCompleted).toBe(false);
    expect(first.state.rateLimitRescues[0].attempts).toBe(1);
    const backoff = first.state.rateLimitBackoff['pollinations'];
    expect(backoff).toBeDefined();
    expect(backoff?.consecutiveFailures).toBe(1);
    expect(backoff?.nextAllowedTs).toBe(T0.getTime() + RESCUE_BACKOFF_BASE_MS);
    // Tick 2 (1 minute later): the same event is still pending, but the
    // provider is backing off — no dispatch happens at all.
    const second = await processDue(first.state, new Date(T0.getTime() + 60 * 1000), deps);
    expect(calls).toEqual(['agent-provider-researcher', 'agent-qa-tester']);
    expect(second.fired.some((f) => f.includes('backing off for provider "pollinations"'))).toBe(true);
    expect(second.state.rateLimitRescues[0].attempts).toBe(1);
    // Tick 3 (31 minutes later, cooldown expired): the rescue is attempted
    // again, and the backoff doubles to 60 minutes.
    const third = await processDue(second.state, new Date(T0.getTime() + 31 * 60 * 1000), deps);
    expect(calls).toEqual([
      'agent-provider-researcher',
      'agent-qa-tester',
      'agent-provider-researcher',
      'agent-qa-tester',
    ]);
    expect(third.state.rateLimitRescues[0].attempts).toBe(2);
    expect(third.state.rateLimitBackoff['pollinations']?.consecutiveFailures).toBe(2);
    expect(third.state.rateLimitBackoff['pollinations']?.nextAllowedTs).toBe(
      T0.getTime() + 31 * 60 * 1000 + 2 * RESCUE_BACKOFF_BASE_MS,
    );
  });

  it('a completed resend clears the provider backoff', async () => {
    const qa = agent('agent-qa-tester', 'QA Tester');
    const researcher = agent('agent-provider-researcher', 'Provider Researcher');
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [qa, researcher],
      rateLimitBackoff: {
        pollinations: {
          consecutiveFailures: 2,
          lastFailedTs: T0.getTime() - 31 * 60 * 1000,
          nextAllowedTs: T0.getTime() - 1000, // expired
        },
      },
    };
    const event: RateLimitEvent = {
      id: 'rl-test-clear',
      ts: T0.getTime(),
      agentId: 'agent-qa-tester',
      agentName: 'QA Tester',
      channelId: 'conv-build-room',
      prompt: 'Write the test plan.',
      provider: 'pollinations',
      error: 'Pollinations 402',
    };
    const calls: string[] = [];
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        if (a.id === 'agent-provider-researcher') return 'No new provider needed; agent already moved.';
        return 'Resent test plan: here it is.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
      rateLimitEvents: async () => [event],
      acknowledgeRateLimitEvents: async () => {},
      reloadAgents: async () => [qa, researcher],
    });
    expect(calls).toEqual(['agent-provider-researcher', 'agent-qa-tester']);
    expect(out.rateLimitRescues[0].resendCompleted).toBe(true);
    expect(out.rateLimitBackoff['pollinations']).toBeUndefined();
  });

  it('a stale event — the agent already moved off the 429ing provider — is acknowledged and skipped, never waking the Researcher', async () => {
    // The freeai backlog: every freeai event is stale because no agent
    // is on freeai any more (agents moved to kilo/groq/gemini). The
    // rescue must not burn a Researcher wake + resend on each one.
    const qa = { ...agent('agent-qa-tester', 'QA Tester'), provider: 'groq' };
    const researcher = agent('agent-provider-researcher', 'Provider Researcher');
    const state: RunnerState = { ...emptyRunnerState(), agents: [qa, researcher] };
    const event: RateLimitEvent = {
      id: 'rl-stale-freeai',
      ts: T0.getTime(),
      agentId: 'agent-qa-tester',
      agentName: 'QA Tester',
      channelId: 'conv-build-room',
      prompt: 'Write the test plan.',
      provider: 'freeai',
      error: 'freeai 429: daily limit reached',
    };
    const calls: string[] = [];
    const acknowledged: string[] = [];
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        return 'should never be called';
      },
      executeCommand: commandStub(),
      log: silentLog(),
      rateLimitEvents: async () => [event],
      acknowledgeRateLimitEvents: async (ids) => {
        acknowledged.push(...ids);
      },
    });
    expect(calls).toEqual([]);
    expect(acknowledged).toEqual(['rl-stale-freeai']);
    expect(out.rateLimitRescues).toHaveLength(0);
    expect(fired.some((f) => f.includes('is stale') && f.includes('freeai') && f.includes('groq'))).toBe(true);
  });

  it('the rescue is capped per tick and newest-first — the urgent recent events win, the backlog drains later', async () => {
    const qa = agent('agent-qa-tester', 'QA Tester');
    const researcher = agent('agent-provider-researcher', 'Provider Researcher');
    const state: RunnerState = { ...emptyRunnerState(), agents: [qa, researcher] };
    // 7 unhandled events, oldest first in the file (as the file holds them).
    const events: RateLimitEvent[] = Array.from({ length: 7 }, (_, i) => ({
      id: `rl-cap-${i}`,
      ts: T0.getTime() - (6 - i) * 60_000,
      agentId: 'agent-qa-tester',
      agentName: 'QA Tester',
      channelId: 'conv-build-room',
      prompt: `Request ${i}.`,
      provider: 'pollinations',
      error: 'Pollinations 429',
    }));
    const calls: string[] = [];
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        if (a.id === 'agent-provider-researcher') return 'Reassigned; resend it.';
        return 'Resent.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
      rateLimitEvents: async () => events,
      acknowledgeRateLimitEvents: async () => {},
      reloadAgents: async () => [qa, researcher],
    });
    // 2 attempts (the cap), each a Researcher wake + a resend.
    expect(calls).toHaveLength(4);
    expect(out.rateLimitRescues).toHaveLength(2);
    // Newest first: the 2 newest events (rl-cap-6, rl-cap-5).
    expect(out.rateLimitRescues.map((r) => r.eventId)).toEqual([
      'rl-cap-6',
      'rl-cap-5',
    ]);
  });
});

describe('processDue — per-tick product-job cap', () => {
  function cronJobAt10(name: string) {
    // Last ran yesterday at 10:00, so today's 10:00 slot is due at T0
    // and still due a minute later if the per-tick cap held it back —
    // the catch-up rule, not the old 1-minute window.
    const job = createJob(
      {
        name,
        channelId: 'conv-build-room',
        schedule: { kind: 'cron', expr: '0 10 * * *' },
        stages: [
          {
            stage: 'design',
            agentId: 'agent-atlas',
            prompt: `Do the ${name} design step.`,
            expectedOutput: 'Designed.',
          },
        ],
      },
      new Date(2026, 10, 25, 9, 0).getTime(),
    );
    return { ...job, lastRunAt: new Date(2026, 10, 25, 10, 0).getTime() };
  }

  it('starts at most maxJobsPerTick product jobs per tick — the rest stay due and drain on later ticks', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas')],
      jobs: [cronJobAt10('job-one'), cronJobAt10('job-two'), cronJobAt10('job-three')],
    };
    const calls: string[] = [];
    const deps = {
      dispatchPrompt: async (a: RunnerAgent) => {
        calls.push(a.id);
        return 'Design done.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
      maxJobsPerTick: 1,
    };
    // Tick 1 (T0 = 10:00, all three due): only the first starts.
    const first = await processDue(state, T0, deps);
    expect(calls).toEqual(['agent-atlas']);
    // A completed single-stage recurring job auto-resets (runs cleared,
    // cyclesCompleted +1) — that is the signal it ran.
    expect(first.state.jobs[0].cyclesCompleted).toBe(1);
    expect(first.state.jobs[1].cyclesCompleted).toBe(0);
    expect(first.state.jobs[2].cyclesCompleted).toBe(0);
    // Tick 2 (one minute later): the first job is caught up (not due),
    // the second starts; the third is still untouched.
    const second = await processDue(first.state, new Date(T0.getTime() + 60_000), deps);
    expect(calls).toEqual(['agent-atlas', 'agent-atlas']);
    expect(second.state.jobs[1].cyclesCompleted).toBe(1);
    expect(second.state.jobs[2].cyclesCompleted).toBe(0);
    // Tick 3: the third starts. Nothing was dropped.
    const third = await processDue(second.state, new Date(T0.getTime() + 120_000), deps);
    expect(calls).toHaveLength(3);
    expect(third.state.jobs[2].cyclesCompleted).toBe(1);
  });

  it('the default cap still bounds a tick with many due jobs', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas')],
      jobs: Array.from({ length: 10 }, (_, i) => cronJobAt10(`job-${i}`)),
    };
    const calls: string[] = [];
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async () => {
        calls.push('agent-atlas');
        return 'Design done.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    // Default cap (1): 1 of 10 starts; the other 9 stay due.
    expect(calls).toHaveLength(1);
    expect(out.jobs.filter((j) => j.cyclesCompleted === 1)).toHaveLength(1);
    expect(out.jobs.filter((j) => j.cyclesCompleted === 0)).toHaveLength(9);
  });
});

describe('processDue — due crons fire most-frequent-first', () => {
  it('the 15-min Orchestrator jumps ahead of the hourly crons listed before it', async () => {
    // Live shape: the Orchestrator cron sits at index 26 in state, after
    // 26 hourly crons. On a catch-up tick they are all due at once; if
    // they fired in state order the Orchestrator would wait ~26 minutes
    // behind the hourly backlog every hour. Most-frequent-first fixes it.
    const hourly = {
      ...createCronJob({
        name: 'Hourly drift check',
        schedule: '0 * * * *',
        type: 'prompt',
        target: 'Check drift.',
        agentId: 'agent-atlas',
        channelId: 'conv-build-room',
      }),
      lastRunAt: new Date(2026, 10, 26, 9, 0).getTime(),
    };
    const orchestrator = {
      ...createCronJob({
        name: 'Orchestrator triage',
        schedule: '*/15 * * * *',
        type: 'prompt',
        target: 'Triage the Build Room.',
        agentId: 'agent-orchestrator',
        channelId: 'conv-build-room',
      }),
      lastRunAt: new Date(2026, 10, 26, 9, 0).getTime(),
    };
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-orchestrator', 'Orchestrator')],
      // Hourly listed FIRST, Orchestrator second — the sort must flip them.
      cronJobs: [hourly, orchestrator],
    };
    const calls: string[] = [];
    await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push(a.id);
        return 'Nothing to assign.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls).toEqual(['agent-orchestrator', 'agent-atlas']);
  });
});

describe('processDue — per-tick cron cap (Nov 27, 2026 fleet slowdown)', () => {
  it('fires at most 2 due crons per tick — the rest stay due and drain on later ticks, nothing dropped', async () => {
    const hourly = (name: string) => ({
      ...createCronJob({
        name,
        schedule: '0 * * * *',
        type: 'prompt',
        target: 'Check drift.',
        agentId: 'agent-atlas',
        channelId: 'conv-build-room',
      }),
      lastRunAt: new Date(2026, 10, 26, 9, 0).getTime(),
    });
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas')],
      cronJobs: [hourly('Hourly one'), hourly('Hourly two'), hourly('Hourly three')],
    };
    const calls: string[] = [];
    const deps = {
      dispatchPrompt: async () => {
        calls.push('agent-atlas');
        return 'Checked.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    };
    // Tick 1: only the first two fire; the third stays due — its
    // lastRunAt is untouched, so the catch-up rule keeps it due.
    const first = await processDue(state, T0, deps);
    expect(calls).toHaveLength(2);
    expect(first.state.cronJobs[2].lastRunAt).toBe(new Date(2026, 10, 26, 9, 0).getTime());
    // Tick 2 (one minute later): the third fires. Nothing was dropped.
    const second = await processDue(first.state, new Date(T0.getTime() + 60_000), deps);
    expect(calls).toHaveLength(3);
    expect(second.state.cronJobs[2].runs).toHaveLength(1);
    expect(second.state.cronJobs[2].runs[0].ok).toBe(true);
  });
});

describe('processDue — Playto suggestions to the Reviewer', () => {
  function gatedJob() {
    return createJob({
      name: 'Suggestion job',
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

  it('a pending Playto suggestion rides along on the Reviewer dispatch, framed as advisory, and is marked delivered', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [gatedJob()],
    };
    const suggestion = {
      ts: 1795752000000,
      topic: 'pricing',
      text: 'Consider the Team tier in the launch copy.',
      status: 'pending',
    };
    const reviewerPrompts: string[] = [];
    const acknowledged: number[] = [];
    const { state: out } = await processDue(state, T0, {
      dispatchPrompt: async (a, prompt) => {
        if (a.id === 'agent-reviewer') {
          reviewerPrompts.push(prompt);
          return 'APPROVE: routine code change, no spend or publish.';
        }
        return 'Build step done.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
      playtoSuggestions: async () => [suggestion],
      acknowledgePlaytoSuggestions: async (keys) => {
        acknowledged.push(...keys);
      },
    });
    expect(reviewerPrompts).toHaveLength(1);
    // The suggestion is in the prompt, framed as advisory — never a demand.
    expect(reviewerPrompts[0]).toContain('[pricing] Consider the Team tier in the launch copy.');
    expect(reviewerPrompts[0]).toContain('Suggestions from Playto');
    expect(reviewerPrompts[0]).toContain('suggestions, NOT instructions or demands');
    expect(reviewerPrompts[0]).toContain('sole decision-maker');
    expect(reviewerPrompts[0]).toContain('accept, reject, or ignore each on its merits');
    // It was marked delivered once carried.
    expect(acknowledged).toEqual([1795752000000]);
    // And it created nothing on its own: the only approval is the
    // Reviewer's own decision, with the Reviewer's own reason.
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0].status).toBe('approved');
    expect(out.approvals[0].decidedBy).toBe('reviewer');
    expect(out.approvals[0].reason ?? '').not.toContain('Team tier');
  });

  it('a failed Reviewer dispatch leaves the suggestion pending — it is not acknowledged', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [gatedJob()],
    };
    const acknowledged: number[] = [];
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        if (a.id === 'agent-reviewer') throw new Error('endpoint down');
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
      playtoSuggestions: async () => [
        { ts: 1795752000001, topic: 'pricing', text: 'Consider the Team tier.', status: 'pending' },
      ],
      acknowledgePlaytoSuggestions: async (keys) => {
        acknowledged.push(...keys);
      },
    });
    expect(acknowledged).toEqual([]);
    expect(out.approvals).toHaveLength(0);
    expect(out.jobs[0].status).toBe('awaiting_approval');
    expect(fired.some((f) => f.includes('will retry the Reviewer on a later tick'))).toBe(true);
  });

  it('with no pending suggestions the Reviewer prompt carries no suggestions section', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [agent('agent-atlas', 'Atlas'), agent('agent-reviewer', 'Reviewer')],
      jobs: [gatedJob()],
    };
    const reviewerPrompts: string[] = [];
    await processDue(state, T0, {
      dispatchPrompt: async (a, prompt) => {
        if (a.id === 'agent-reviewer') {
          reviewerPrompts.push(prompt);
          return 'APPROVE: routine code change.';
        }
        return 'Build step done.';
      },
      executeCommand: commandStub(),
      log: silentLog(),
      playtoSuggestions: async () => [],
      acknowledgePlaytoSuggestions: async () => {},
    });
    expect(reviewerPrompts).toHaveLength(1);
    expect(reviewerPrompts[0]).not.toContain('Suggestions from Playto');
  });
});

describe('processDue — deny→rework loop, triage recovery, stranded sweep (Nov 27 direct fixes)', () => {
  function gateAgents() {
    return [
      agent('agent-orchestrator', 'Orchestrator'),
      agent('agent-atlas', 'Atlas'),
      agent('agent-scout', 'Scout'),
      agent('agent-prompt-engineer', 'Prompt Engineer'),
      agent('agent-reviewer', 'Reviewer'),
      agent('agent-triage', 'Triage Agent'),
      agent('agent-provider-researcher', 'Provider Researcher'),
    ];
  }

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

  it('a denial routes the rework inline through the gates in the same tick — no Orchestrator cron needed', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: gateAgents(),
      jobs: [reviewableJob()],
    };
    const calls: Array<{ agentId: string; prompt: string }> = [];
    let reviewerCalls = 0;
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a, prompt) => {
        calls.push({ agentId: a.id, prompt });
        if (a.id === 'agent-reviewer') {
          reviewerCalls += 1;
          return reviewerCalls === 1
            ? 'DENY: the build step touches a blocked path.'
            : 'APPROVE: corrected assignment is bounded and verified.';
        }
        if (a.id === 'agent-triage') {
          return '1. The build step touches a blocked path.\nREASSIGN: @agent-scout\n@Scout redo the build step without the blocked path, then report the exact files changed.';
        }
        if (a.id === 'agent-prompt-engineer') {
          return 'Assignment from @Orchestrator: @Scout redo the build step without the blocked path, with exact steps and the expected result for each step.';
        }
        if (a.id === 'agent-scout') return 'Build fixed without the blocked path.';
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    // Reviewer denies, Triage reassigns to a DIFFERENT agent, the fix
    // goes through the Prompt Engineer and the Reviewer, then out.
    expect(calls.map((c) => c.agentId)).toEqual([
      'agent-reviewer',
      'agent-triage',
      'agent-prompt-engineer',
      'agent-reviewer',
      'agent-scout',
    ]);
    // The triage prompt names the failure and demands a different agent.
    expect(calls[1].prompt).toContain('the build step touches a blocked path');
    expect(calls[1].prompt).toContain('DIFFERENT agent');
    expect(calls[1].prompt).toContain('agent-atlas');
    expect(calls[1].prompt).toContain('list the specific denial issues');
    // The Reviewer was told to verify before deciding, and the docs rule.
    expect(calls[0].prompt).toContain('VERIFY BEFORE YOU DECIDE');
    expect(calls[0].prompt).toContain('DOCS RULE');
    expect(calls[0].prompt).toContain('trust ONLY a document you wrote yourself');
    // The rework reached the room as a mention — and the job still stays
    // parked: rework proposes, it never un-parks the denied stage.
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0].status).toBe('denied');
    expect(out.jobs[0].status).toBe('awaiting_approval');
    const mentions = out.channelMessages.filter((m) => m.kind === 'mention');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].agentId).toBe('agent-scout');
    expect(mentions[0].text).toContain('Build fixed without the blocked path.');
    expect(fired.some((f) => f.includes('rework dispatched to @Scout'))).toBe(true);
  });

  it('triage reassigning to the same agent that failed falls back to the Orchestrator', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: gateAgents(),
      jobs: [reviewableJob()],
    };
    const calls: Array<{ agentId: string }> = [];
    let reviewerCalls = 0;
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push({ agentId: a.id });
        if (a.id === 'agent-reviewer') {
          reviewerCalls += 1;
          return reviewerCalls === 1
            ? 'DENY: the build step touches a blocked path.'
            : 'APPROVE: re-draft is bounded.';
        }
        if (a.id === 'agent-triage') {
          return 'REASSIGN: @agent-atlas\n@Atlas redo the build step without the blocked path.';
        }
        if (a.id === 'agent-prompt-engineer') {
          return 'Assignment from @Orchestrator: @Orchestrator re-draft the build step without the blocked path.';
        }
        if (a.id === 'agent-orchestrator') return 'Re-drafted the build step.';
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls.map((c) => c.agentId)).toEqual([
      'agent-reviewer',
      'agent-triage',
      'agent-prompt-engineer',
      'agent-reviewer',
      'agent-orchestrator',
    ]);
    expect(fired.some((f) => f.includes('falling back to @Orchestrator'))).toBe(true);
    expect(out.jobs[0].status).toBe('awaiting_approval');
  });

  it('triage naming an invented agent id falls back to the Orchestrator (Nov 27, 2026: nemotron named agent-webpage-builder)', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: gateAgents(),
      jobs: [reviewableJob()],
    };
    const calls: Array<{ agentId: string }> = [];
    let reviewerCalls = 0;
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push({ agentId: a.id });
        if (a.id === 'agent-reviewer') {
          reviewerCalls += 1;
          return reviewerCalls === 1
            ? 'DENY: the build step touches a blocked path.'
            : 'APPROVE: re-draft is bounded.';
        }
        if (a.id === 'agent-triage') {
          return 'REASSIGN: @agent-webpage-builder\n@Webpage Builder redo the build step without the blocked path.';
        }
        if (a.id === 'agent-prompt-engineer') {
          return 'Assignment from @Orchestrator: @Orchestrator re-draft the build step without the blocked path.';
        }
        if (a.id === 'agent-orchestrator') return 'Re-drafted the build step.';
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls.map((c) => c.agentId)).toEqual([
      'agent-reviewer',
      'agent-triage',
      'agent-prompt-engineer',
      'agent-reviewer',
      'agent-orchestrator',
    ]);
    expect(fired.some((f) => f.includes('named unknown agent agent-webpage-builder'))).toBe(true);
    expect(fired.some((f) => f.includes('falling back to @Orchestrator'))).toBe(true);
    expect(fired.some((f) => f.includes('rework dispatched to @Orchestrator'))).toBe(true);
    expect(out.jobs[0].status).toBe('awaiting_approval');
  });

  it('a second denial after triage never reaches the room — recorded as a gate message', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: gateAgents(),
      jobs: [reviewableJob()],
    };
    const calls: Array<{ agentId: string }> = [];
    const { state: out, fired } = await processDue(state, T0, {
      dispatchPrompt: async (a) => {
        calls.push({ agentId: a.id });
        if (a.id === 'agent-reviewer') return 'DENY: still wrong, the blocked path is still in it.';
        if (a.id === 'agent-triage') {
          return 'REASSIGN: @agent-scout\n@Scout redo the build step without the blocked path.';
        }
        if (a.id === 'agent-prompt-engineer') {
          return 'Assignment from @Orchestrator: @Scout redo the build step without the blocked path.';
        }
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    });
    expect(calls.map((c) => c.agentId)).toEqual([
      'agent-reviewer',
      'agent-triage',
      'agent-prompt-engineer',
      'agent-reviewer',
    ]);
    // Scout was never dispatched: the second denial stops the send.
    expect(calls.some((c) => c.agentId === 'agent-scout')).toBe(false);
    const gates = out.channelMessages.filter((m) => m.kind === 'gate');
    expect(gates).toHaveLength(1);
    expect(gates[0].text).toContain('did NOT reach the room');
    expect(out.jobs[0].status).toBe('awaiting_approval');
    expect(fired.some((f) => f.includes('DENIED again after triage'))).toBe(true);
  });

  it('a job parked behind a denied approval gets its triage re-run by recovery, then stays parked', async () => {
    const job = reviewableJob();
    const denied = decideApprovalByReviewer(
      requestApproval(job.id, job.name, 'build', 'Stage "build" needs a decision', T0.getTime()),
      'denied',
      'the build step touches a blocked path.',
      T0.getTime(),
    );
    const parked: RunnerState = {
      ...emptyRunnerState(),
      agents: gateAgents(),
      jobs: [{ ...job, status: 'awaiting_approval' }],
      approvals: [denied],
    };
    let triageCalls = 0;
    const calls: Array<{ agentId: string }> = [];
    const deps = {
      dispatchPrompt: async (a: RunnerAgent) => {
        calls.push({ agentId: a.id });
        if (a.id === 'agent-triage') {
          triageCalls += 1;
          return 'REASSIGN: @agent-scout\n@Scout redo the build step without the blocked path.';
        }
        if (a.id === 'agent-prompt-engineer') {
          return 'Assignment from @Orchestrator: @Scout redo the build step without the blocked path.';
        }
        if (a.id === 'agent-reviewer') return 'APPROVE: corrected assignment is bounded and verified.';
        if (a.id === 'agent-scout') return 'Build fixed without the blocked path.';
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
    };
    const first = await processDue(parked, T0, deps);
    expect(triageCalls).toBe(1);
    expect(calls.map((c) => c.agentId)).toEqual([
      'agent-triage',
      'agent-prompt-engineer',
      'agent-reviewer',
      'agent-scout',
    ]);
    expect(first.state.triageRecovery[job.id]).toBeGreaterThan(0);
    expect(first.state.jobs[0].status).toBe('awaiting_approval');
    const triageMsgs = first.state.channelMessages.filter((m) => m.kind === 'triage');
    expect(triageMsgs).toHaveLength(1);
    expect(triageMsgs[0].text).toContain('(recovery)');
    // Second tick: the 6h cooldown means no re-run.
    const second = await processDue(first.state, new Date(T0.getTime() + 2000), deps);
    expect(triageCalls).toBe(1);
    expect(second.state.jobs[0].status).toBe('awaiting_approval');
  });

  it('findStrandedAgents catches no-provider and dead-provider agents, not healthy ones', () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [
        agent('agent-atlas', 'Atlas'),
        agent('agent-scout', 'Scout'),
        agent('agent-pixel', 'Pixel'),
      ],
    };
    // Atlas: no provider. Scout: provider the registry does not know.
    // Pixel: a live provider.
    state.agents[0].provider = undefined;
    state.agents[1].provider = 'kilo-dead';
    state.agents[2].provider = 'pollinations';
    const found = findStrandedAgents(state, new Set(['pollinations', 'gemini', 'groq']));
    expect(found.map((a) => a.id)).toEqual(['agent-atlas', 'agent-scout']);
    // Without a registry the sweep still catches the no-provider case.
    expect(findStrandedAgents(state).map((a) => a.id)).toEqual(['agent-atlas']);
  });

  it('the stranded sweep dispatches the Provider Researcher once per agent per day', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [
        { ...agent('agent-provider-researcher', 'Provider Researcher'), provider: 'pollinations' },
        { ...agent('agent-atlas', 'Atlas'), provider: undefined },
        { ...agent('agent-scout', 'Scout'), provider: 'kilo-dead' },
        { ...agent('agent-pixel', 'Pixel'), provider: 'pollinations' },
      ],
    };
    let researcherCalls = 0;
    const deps = {
      dispatchPrompt: async (a: RunnerAgent, prompt: string) => {
        if (a.id === 'agent-provider-researcher') {
          researcherCalls += 1;
          expect(prompt).toContain('STRANDED-AGENT SWEEP');
          expect(prompt).toContain('Atlas');
          expect(prompt).toContain('Scout');
          expect(prompt).not.toContain('Pixel');
          return 'Reassigned Atlas to pollinations and Scout to blockrun-free.';
        }
        return 'should never run';
      },
      executeCommand: commandStub(),
      log: silentLog(),
      providerIds: ['pollinations', 'gemini', 'groq', 'blockrun-free'],
    };
    const first = await processDue(state, T0, deps);
    expect(researcherCalls).toBe(1);
    expect(Object.keys(first.state.strandedSweeps).sort()).toEqual(['agent-atlas', 'agent-scout']);
    const researcherMsgs = first.state.channelMessages.filter((m) => m.kind === 'researcher');
    expect(researcherMsgs).toHaveLength(1);
    // Second tick: the 24h cooldown means no re-dispatch.
    await processDue(first.state, new Date(T0.getTime() + 2000), deps);
    expect(researcherCalls).toBe(1);
  });

  it('the stranded sweep is skipped when the Provider Researcher itself cannot run', async () => {
    const state: RunnerState = {
      ...emptyRunnerState(),
      agents: [
        { ...agent('agent-provider-researcher', 'Provider Researcher'), provider: undefined },
        { ...agent('agent-atlas', 'Atlas'), provider: undefined },
      ],
    };
    const { fired } = await processDue(state, T0, {
      dispatchPrompt: async () => 'should never run',
      executeCommand: commandStub(),
      log: silentLog(),
      providerIds: ['pollinations'],
    });
    expect(fired.some((f) => f.includes('Provider Researcher itself has no provider'))).toBe(true);
  });

  it('triage and gate messages are pinned — cron chatter cannot bury them', () => {
    const state = emptyRunnerState();
    for (let i = 0; i < 210; i++) {
      recordChannelMessage(state, {
        channelId: 'conv-build-room',
        agentId: 'agent-ceo-assistant',
        agentName: 'CEO Assistant',
        kind: 'mention',
        text: `CEO priorities ${i}`,
      });
    }
    const pinned = recordChannelMessage(state, {
      channelId: 'conv-build-room',
      agentId: 'agent-triage',
      agentName: 'Triage Agent',
      kind: 'triage',
      text: 'Triage for denied build of "Reviewable job"',
    });
    for (let i = 0; i < 250; i++) {
      recordChannelMessage(state, {
        channelId: 'conv-build-room',
        agentId: 'agent-meeting-notes-specialist',
        agentName: 'Meeting Notes Specialist',
        kind: 'mention',
        text: `Meeting notes triage ${i}`,
      });
    }
    expect(state.channelMessages.some((m) => m.id === pinned.id)).toBe(true);
    expect(state.channelMessages.filter((m) => m.kind === 'triage')).toHaveLength(1);
    expect(state.channelMessages.length).toBeLessThanOrEqual(250);
  });

  it('low-risk fast path: docs work gets the marker, high-stakes work never does', () => {
    expect(isLowRiskReview('Documentation reference', 'document')).toBe(true);
    expect(isLowRiskReview('Docs guide', 'upgrade')).toBe(true);
    expect(isLowRiskReview('Release job', 'release')).toBe(false);
    expect(isLowRiskReview('Docs guide', 'upgrade', { spendsMoney: true })).toBe(false);
    expect(isLowRiskReview('Build job', 'build')).toBe(false);

    const docJob = createJob({
      name: 'Documentation reference',
      channelId: 'conv-build-room',
      schedule: { kind: 'interval', everyMs: 1000 },
      stages: [{ stage: 'document', agentId: 'agent-atlas', prompt: 'Write the doc.', expectedOutput: 'A doc.' }],
    });
    const docPrompt = stageReviewPrompt(docJob, currentStage(docJob)!, false);
    expect(docPrompt).toContain('LOW-RISK FAST PATH');
    expect(docPrompt).toContain('VERIFY BEFORE YOU DECIDE');
    expect(docPrompt).toContain('DOCS RULE');

    const releaseJob = createJob({
      name: 'Release job',
      channelId: 'conv-build-room',
      schedule: { kind: 'interval', everyMs: 1000 },
      stages: [{ stage: 'release', agentId: 'agent-atlas', prompt: 'Prepare the release.', expectedOutput: 'Release notes.' }],
    });
    const releasePrompt = stageReviewPrompt(releaseJob, currentStage(releaseJob)!, true);
    expect(releasePrompt).not.toContain('LOW-RISK FAST PATH');
    expect(releasePrompt).toContain('HIGH-STAKES');
    expect(releasePrompt).toContain('VERIFY BEFORE YOU DECIDE');
  });

  it('prompt builders carry the working rules: stage early, small scope, verify, docs rule', () => {
    const target = agent('agent-atlas', 'Atlas');
    const optimized = optimizerPrompt('Draft the build.', target);
    expect(optimized).toContain('STAGE EARLY');
    expect(optimized).toContain('25 tool iterations');
    expect(optimized).toContain('VERIFY FIRST');
    expect(optimized).toContain('DOCS RULE');
    expect(optimized).toContain('trust ONLY a document you wrote yourself');

    const review = assignmentReviewPrompt('Update the docs reference page.', target);
    expect(review).toContain('VERIFY BEFORE YOU DECIDE');
    expect(review).toContain('DOCS RULE');
    expect(review).toContain('LOW-RISK FAST PATH');

    const highStakesReview = assignmentReviewPrompt('Spend $100 on ads and publish the announcement.', target);
    expect(highStakesReview).not.toContain('LOW-RISK FAST PATH');

    const triage = triagePrompt('Stage "build": do the build.', 'the build step touches a blocked path.', {
      failedAgentId: 'agent-atlas',
    });
    expect(triage).toContain('DIFFERENT agent');
    expect(triage).toContain('agent-atlas');
    expect(triage).toContain('list the specific denial issues');
    expect(triage).toContain('REASSIGN: @<agent-id>');
    expect(triage).toContain('DOCS RULE');
    expect(triage).toContain('at most two repo_read calls');
  });
});
