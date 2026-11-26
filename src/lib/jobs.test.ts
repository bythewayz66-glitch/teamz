import { describe, expect, it } from 'vitest';
import {
  buildStagePrompt,
  completeStageRun,
  createJob,
  currentStage,
  deserializeJob,
  isCommandAllowed,
  isJobDue,
  parkForApproval,
  pauseJob,
  publishDocsTemplate,
  repoCheckTemplate,
  resumeJob,
  serializeJob,
  shipReleaseTemplate,
  startStage,
  PRODUCT_STAGES,
  type ProductJob,
} from './jobs';
import { decideApproval, requestApproval, type ApprovalRequest } from './governance';

const T0 = 1_700_000_000_000;
const CHANNEL = 'conv-build-room';

function twoStageJob(nowMs: number = T0): ProductJob {
  return createJob(
    {
      name: 'Test job',
      channelId: CHANNEL,
      stages: [
        {
          stage: 'design',
          agentId: 'agent-scout',
          prompt: 'Design it.',
          expectedOutput: 'A design.',
        },
        {
          stage: 'build',
          agentId: 'agent-atlas',
          prompt: 'Build it.',
          expectedOutput: 'A build report.',
          contextStages: ['design'],
        },
      ],
      schedule: { kind: 'manual' },
    },
    nowMs,
  );
}

describe('createJob validation', () => {
  it('requires a name, channel, and at least one stage', () => {
    expect(() =>
      createJob({ name: ' ', channelId: CHANNEL, stages: [{ stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e' }] }),
    ).toThrow(/needs a name/);
    expect(() =>
      createJob({ name: 'x', channelId: '', stages: [{ stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e' }] }),
    ).toThrow(/needs a channelId/);
    expect(() => createJob({ name: 'x', channelId: CHANNEL, stages: [] })).toThrow(/at least one stage/);
  });

  it('enforces lifecycle order and rejects repeats', () => {
    expect(() =>
      createJob({
        name: 'x',
        channelId: CHANNEL,
        stages: [
          { stage: 'build', agentId: 'a', prompt: 'p', expectedOutput: 'e' },
          { stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e' },
        ],
      }),
    ).toThrow(/lifecycle order/);
    expect(() =>
      createJob({
        name: 'x',
        channelId: CHANNEL,
        stages: [
          { stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e' },
          { stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e' },
        ],
      }),
    ).toThrow(/appears twice/);
  });

  it('rejects context from a stage that is not earlier', () => {
    expect(() =>
      createJob({
        name: 'x',
        channelId: CHANNEL,
        stages: [
          { stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e', contextStages: ['build'] },
          { stage: 'build', agentId: 'a', prompt: 'p', expectedOutput: 'e' },
        ],
      }),
    ).toThrow(/not an earlier stage/);
    expect(() =>
      createJob({
        name: 'x',
        channelId: CHANNEL,
        stages: [
          { stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e', contextStages: ['design'] },
        ],
      }),
    ).toThrow(/cannot take context/);
  });

  it('rejects bad cron schedules and tiny intervals', () => {
    expect(() =>
      createJob({
        name: 'x',
        channelId: CHANNEL,
        stages: [{ stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e' }],
        schedule: { kind: 'cron', expr: 'nope' },
      }),
    ).toThrow();
    expect(() =>
      createJob({
        name: 'x',
        channelId: CHANNEL,
        stages: [{ stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e' }],
        schedule: { kind: 'interval', everyMs: 500 },
      }),
    ).toThrow(/at least 1000ms/);
  });

  it('marks gated stages as humanInput', () => {
    const job = createJob({
      name: 'x',
      channelId: CHANNEL,
      stages: [
        { stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e' },
        { stage: 'release', agentId: 'a', prompt: 'p', expectedOutput: 'e' },
      ],
    });
    expect(job.stages[0].humanInput).toBe(false);
    expect(job.stages[1].humanInput).toBe(true);
  });
});

describe('stage progression', () => {
  it('advances stage by stage, recording each reply as that stage’s output', () => {
    let job = twoStageJob();
    expect(currentStage(job)?.stage).toBe('design');

    const started = startStage(job, [], T0);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    job = started.job;
    expect(started.run.status).toBe('dispatched');
    expect(started.run.prompt).toContain('Design it.');
    expect(started.run.prompt).toContain('Expected output');

    const done1 = completeStageRun(job, started.run.id, 'The design: three modules.', true, [], T0 + 60_000);
    job = done1.job;
    expect(job.runs[0].status).toBe('ok');
    expect(job.runs[0].output).toBe('The design: three modules.');
    expect(job.runs[0].finishedAt).toBe(T0 + 60_000);
    expect(currentStage(job)?.stage).toBe('build');

    // The build prompt carries the design output as context.
    const built = buildStagePrompt(job, currentStage(job)!);
    expect(built).toContain('The design: three modules.');
    expect(built).toContain('Build it.');
    // And the runner context the agent's tools need (job id, stage).
    expect(built).toContain(`job id "${job.id}"`);
    expect(built).toContain('stage "build"');

    const started2 = startStage(job, [], T0 + 120_000);
    expect(started2.ok).toBe(true);
    if (!started2.ok) throw new Error('unreachable');
    const done2 = completeStageRun(started2.job, started2.run.id, 'Built.', true, [], T0 + 180_000);
    expect(done2.job.status).toBe('done');
    expect(currentStage(done2.job)).toBeNull();
    expect(startStage(done2.job, [], T0 + 200_000).ok).toBe(false);
  });

  it('a failed run does not advance the stage, so the next tick retries it', () => {
    let job = twoStageJob();
    const started = startStage(job, [], T0);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    const done = completeStageRun(started.job, started.run.id, 'endpoint timed out', false, [], T0 + 5000);
    job = done.job;
    expect(job.runs[0].status).toBe('failed');
    expect(currentStage(job)?.stage).toBe('design');
    expect(job.status).toBe('active');
    // Retry works.
    expect(startStage(job, [], T0 + 10_000).ok).toBe(true);
  });

  it('completing an unknown or already-finished run throws', () => {
    const job = twoStageJob();
    expect(() => completeStageRun(job, 'run-nope', 'x', true, [], T0)).toThrow(/no run/);
    const started = startStage(job, [], T0);
    if (!started.ok) throw new Error('unreachable');
    const done = completeStageRun(started.job, started.run.id, 'ok', true, [], T0 + 1000);
    expect(() =>
      completeStageRun(done.job, started.run.id, 'again', true, [], T0 + 2000),
    ).toThrow(/already ok/);
  });

  it('a paused job cannot start a stage; resume reopens it', () => {
    let job = pauseJob(twoStageJob());
    expect(startStage(job, [], T0).ok).toBe(false);
    job = resumeJob(job);
    expect(startStage(job, [], T0).ok).toBe(true);
  });
});

describe('governance inside startStage', () => {
  function gatedJob(): ProductJob {
    return createJob({
      name: 'Gated',
      channelId: CHANNEL,
      stages: [
        { stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e' },
        { stage: 'release', agentId: 'a', prompt: 'p', expectedOutput: 'e' },
      ],
    });
  }

  it('a gated stage cannot start without an approval record', () => {
    let job = gatedJob();
    const first = startStage(job, [], T0);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    job = completeStageRun(first.job, first.run.id, 'designed', true, [], T0 + 1000).job;
    const blocked = startStage(job, [], T0 + 2000);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('unreachable');
    expect(blocked.needsApproval).toBe(true);
    expect(blocked.reason).toMatch(/approval/);
    // Parking the job records the state; the stage has not run.
    job = parkForApproval(job);
    expect(job.status).toBe('awaiting_approval');
    expect(job.runs).toHaveLength(1);
  });

  it('an approved gated stage starts, and the approval is consumed on completion', () => {
    let job = gatedJob();
    const first = startStage(job, [], T0);
    if (!first.ok) throw new Error('unreachable');
    job = completeStageRun(first.job, first.run.id, 'designed', true, [], T0 + 1000).job;
    const req = requestApproval(job.id, job.name, 'release', 'release needs sign-off', T0 + 2000);
    let approvals: ApprovalRequest[] = [decideApproval(req, 'approved', T0 + 3000)];
    const started = startStage(job, approvals, T0 + 4000);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    expect(started.run.approvalId).toBe(req.id);
    const done = completeStageRun(started.job, started.run.id, 'released', true, approvals, T0 + 5000);
    job = done.job;
    approvals = done.approvals;
    expect(job.status).toBe('done');
    expect(approvals[0].consumedAt).toBe(T0 + 5000);
    // The consumed approval does not authorise a second release run.
    expect(startStage(job, approvals, T0 + 6000).ok).toBe(false);
  });
});

describe('isJobDue', () => {
  it('manual jobs are never due on a tick; interval and cron jobs are', () => {
    const manual = twoStageJob();
    expect(isJobDue(manual, new Date(T0))).toBe(false);
    const interval = createJob({
      name: 'i',
      channelId: CHANNEL,
      stages: [{ stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e' }],
      schedule: { kind: 'interval', everyMs: 3_600_000 },
    });
    expect(isJobDue(interval, new Date(T0))).toBe(true); // never run
    const cron = createJob({
      name: 'c',
      channelId: CHANNEL,
      stages: [{ stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e' }],
      schedule: { kind: 'cron', expr: '0 7 * * *' },
    });
    expect(isJobDue(cron, new Date(2026, 10, 25, 7, 0))).toBe(true);
    expect(isJobDue(cron, new Date(2026, 10, 25, 7, 1))).toBe(false);
    expect(isJobDue({ ...cron, enabled: false }, new Date(2026, 10, 25, 7, 0))).toBe(false);
    expect(isJobDue(pauseJob(cron), new Date(2026, 10, 25, 7, 0))).toBe(false);
  });
});

describe('templates', () => {
  it('shipReleaseTemplate builds the full eight-stage loop in order', () => {
    const job = shipReleaseTemplate({ channelId: CHANNEL, agentId: 'agent-atlas' });
    expect(job.stages.map((s) => s.stage)).toEqual([...PRODUCT_STAGES]);
    expect(job.stages.every((s) => s.agentId === 'agent-atlas')).toBe(true);
    expect(job.stages.every((s) => s.prompt.length > 20 && s.expectedOutput.length > 10)).toBe(true);
    expect(job.stages[4].humanInput).toBe(true); // release
    expect(job.stages[6].humanInput).toBe(true); // advertise
    expect(job.stages[7].humanInput).toBe(true); // sell
    expect(job.stages[0].humanInput).toBe(false); // design
    // Context chains: advertise builds on release + document, sell on all three.
    expect(job.stages[6].contextStages).toEqual(['release', 'document']);
    expect(job.stages[7].contextStages).toEqual(['release', 'document', 'advertise']);
    // Per-stage overrides work.
    const mixed = shipReleaseTemplate({
      channelId: CHANNEL,
      agentId: 'agent-atlas',
      stageAgents: { sell: 'agent-sage' },
    });
    expect(mixed.stages[7].agentId).toBe('agent-sage');
    expect(mixed.stages[0].agentId).toBe('agent-atlas');
  });

  it('publishDocsTemplate builds the design → document chain, gated on publish', () => {
    const job = publishDocsTemplate({ channelId: CHANNEL, agentId: 'agent-sage' });
    expect(job.stages.map((s) => s.stage)).toEqual(['design', 'document']);
    expect(job.stages[0].humanInput).toBe(false);
    expect(job.stages[1].humanInput).toBe(true);
    expect(job.stages[1].flags?.publishesPublic).toBe(true);
  });

  it('a template job runs its stages end to end', () => {
    let job = publishDocsTemplate({ channelId: CHANNEL, agentId: 'agent-sage' });
    let approvals: ApprovalRequest[] = [];
    // design
    let s = startStage(job, approvals, T0);
    expect(s.ok).toBe(true);
    if (!s.ok) throw new Error('unreachable');
    job = completeStageRun(s.job, s.run.id, 'Outline: 4 pages.', true, approvals, T0 + 1000).job;
    // document publishes publicly, so it is gated — blocked until approved.
    expect(startStage(job, approvals, T0 + 2000).ok).toBe(false);
    const req = requestApproval(job.id, job.name, 'document', 'docs go public', T0 + 2500);
    approvals = [decideApproval(req, 'approved', T0 + 3000)];
    s = startStage(job, approvals, T0 + 4000);
    expect(s.ok).toBe(true);
    if (!s.ok) throw new Error('unreachable');
    expect(s.run.prompt).toContain('Outline: 4 pages.');
    const done = completeStageRun(s.job, s.run.id, 'Docs published.', true, approvals, T0 + 5000);
    expect(done.job.status).toBe('done');
  });
});

describe('command stages and the allowlist', () => {
  it('a command stage runs only when its argv matches the allowlist exactly', () => {
    const job = createJob({
      name: 'cmd',
      channelId: CHANNEL,
      workdir: '/srv/mem20',
      allowedCommands: [['git', 'status', '--short']],
      stages: [
        {
          stage: 'implement',
          agentId: 'agent-atlas',
          prompt: 'Check status.',
          expectedOutput: 'Status output.',
          command: { argv: ['git', 'status', '--short'] },
        },
      ],
    });
    expect(isCommandAllowed(job, ['git', 'status', '--short'])).toBe(true);
    expect(isCommandAllowed(job, ['git', 'status'])).toBe(false);
    expect(isCommandAllowed(job, ['git', 'status', '--short', '--branch'])).toBe(false);
    expect(isCommandAllowed(job, ['git', 'status', '--short; rm -rf /'])).toBe(false);
    expect(isCommandAllowed(job, ['rm', '-rf', '/'])).toBe(false);
    const started = startStage(job, [], T0);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    expect(started.run.kind).toBe('command');
  });

  it('a job cannot be created with a command outside its allowlist', () => {
    expect(() =>
      createJob({
        name: 'cmd',
        channelId: CHANNEL,
        allowedCommands: [['git', 'status']],
        stages: [
          {
            stage: 'implement',
            agentId: 'a',
            prompt: 'p',
            expectedOutput: 'e',
            command: { argv: ['git', 'push'] },
          },
        ],
      }),
    ).toThrow(/not on the job's allowlist/);
    expect(() =>
      createJob({
        name: 'cmd',
        channelId: CHANNEL,
        stages: [
          {
            stage: 'implement',
            agentId: 'a',
            prompt: 'p',
            expectedOutput: 'e',
            command: { argv: ['git', 'status'] },
          },
        ],
      }),
    ).toThrow(/not on the job's allowlist/);
  });

  it('a prompt stage is kind prompt and needs no allowlist', () => {
    const job = twoStageJob();
    const started = startStage(job, [], T0);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    expect(started.run.kind).toBe('prompt');
  });

  it('repoCheckTemplate builds a design → implement → upgrade(push) → document chain', () => {
    const job = repoCheckTemplate({
      channelId: CHANNEL,
      agentId: 'agent-atlas',
      workdir: '/srv/mem20',
    });
    expect(job.stages.map((s) => s.stage)).toEqual(['design', 'implement', 'upgrade', 'document']);
    expect(job.workdir).toBe('/srv/mem20');
    expect(job.schedule).toEqual({ kind: 'cron', expr: '0 7 * * *' });
    // The only command stage is the governed push; it is gated on the
    // Reviewer and allowlisted — and nothing else is.
    expect(job.stages[2].command).toEqual({ argv: ['sudo', '/opt/teamz-runner/push-mem20.py'] });
    expect(job.stages[2].flags).toEqual({ requiresReview: true });
    expect(job.stages[2].humanInput).toBe(true);
    expect(job.stages[0].command).toBeUndefined();
    expect(job.stages[1].command).toBeUndefined();
    expect(job.stages[3].command).toBeUndefined();
    expect(isCommandAllowed(job, ['sudo', '/opt/teamz-runner/push-mem20.py'])).toBe(true);
    expect(isCommandAllowed(job, ['git', 'status', '--short'])).toBe(false);
    // Round-trips through serialisation with the command and gate intact.
    const restored = deserializeJob(JSON.parse(serializeJob(job)));
    expect(restored.stages[2].command).toEqual({ argv: ['sudo', '/opt/teamz-runner/push-mem20.py'] });
    expect(restored.stages[2].flags).toEqual({ requiresReview: true });
    expect(restored.allowedCommands).toEqual([['sudo', '/opt/teamz-runner/push-mem20.py']]);
    expect(restored.workdir).toBe('/srv/mem20');
  });
});

describe('serialisation', () => {
  it('round-trips a job with progress and history', () => {
    const job = twoStageJob();
    const started = startStage(job, [], T0);
    if (!started.ok) throw new Error('unreachable');
    const done = completeStageRun(started.job, started.run.id, 'Designed.', true, [], T0 + 1000);
    const restored = deserializeJob(JSON.parse(serializeJob(done.job)));
    expect(restored.id).toBe(job.id);
    expect(restored.currentStageIndex).toBe(1);
    expect(restored.runs).toHaveLength(1);
    expect(restored.runs[0].output).toBe('Designed.');
    expect(currentStage(restored)?.stage).toBe('build');
  });

  it('rejects a blob with an out-of-order stage chain or unknown stage', () => {
    const bad = {
      ...JSON.parse(serializeJob(twoStageJob())),
      stages: [
        { stage: 'build', agentId: 'a', prompt: 'p', expectedOutput: 'e', contextStages: [] },
        { stage: 'design', agentId: 'a', prompt: 'p', expectedOutput: 'e', contextStages: [] },
      ],
    };
    expect(() => deserializeJob(bad)).toThrow(/lifecycle order/);
    const unknown = {
      ...JSON.parse(serializeJob(twoStageJob())),
      stages: [
        { stage: 'teleport', agentId: 'a', prompt: 'p', expectedOutput: 'e', contextStages: [] },
      ],
    };
    expect(() => deserializeJob(unknown)).toThrow(/unknown stage/);
  });
});
