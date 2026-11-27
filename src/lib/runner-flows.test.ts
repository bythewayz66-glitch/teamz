import { describe, expect, it } from 'vitest';
import {
  emptyRunnerState,
  processDue,
  RESCUE_BACKOFF_BASE_MS,
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
    // 5 attempts (the cap), each a Researcher wake + a resend.
    expect(calls).toHaveLength(10);
    expect(out.rateLimitRescues).toHaveLength(5);
    // Newest first: the 5 newest events (rl-cap-6 down to rl-cap-2).
    expect(out.rateLimitRescues.map((r) => r.eventId)).toEqual([
      'rl-cap-6',
      'rl-cap-5',
      'rl-cap-4',
      'rl-cap-3',
      'rl-cap-2',
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
    // Default cap (6): 6 of 10 start; the other 4 stay due.
    expect(calls).toHaveLength(6);
    expect(out.jobs.filter((j) => j.cyclesCompleted === 1)).toHaveLength(6);
    expect(out.jobs.filter((j) => j.cyclesCompleted === 0)).toHaveLength(4);
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
