import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyRunnerState,
  loadRunnerState,
  processDue,
  resetDispatchThrottle,
  saveRunnerState,
  type RunnerAgent,
  type RunnerState,
} from '../../scripts/runner-lib';
import { processDueWithRhythm, reapOrphansOnDisk } from '../../scripts/runner-tick';
import {
  APPROVAL_TTL_MS,
  ORPHAN_RUN_MAX_AGE_MS,
  creditExhaustedProviders,
  estimateDrainMs,
  expireStaleApprovals,
  expireStaleBackoff,
  isCreditRefusalReply,
  markOutOfCredits,
  pickJobsToStart,
  reapOrphanedRuns,
  reportStaleParkedJobs,
} from '../../scripts/runner-rhythm';
import { createJob, currentStage, startStage, type ProductJob } from './jobs';
import { createCronJob } from './scheduler';
import {
  canExecuteStage,
  decideApprovalByReviewer,
  findLiveApproval,
  findPendingApproval,
  requestApproval,
  pendingApprovals,
  type ApprovalRequest,
} from './governance';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const MIN = 60_000;

const ask = (job: ProductJob, stage: Parameters<typeof requestApproval>[2], at: number) =>
  requestApproval(job.id, job.name, stage, 'needs the Reviewer', at);

const atlas: RunnerAgent = { id: 'agent-atlas', name: 'Atlas', endpointUrl: 'http://127.0.0.1:9/chat', model: 'test', systemPrompt: '' };
const reviewer: RunnerAgent = { id: 'agent-reviewer', name: 'Reviewer', endpointUrl: 'http://127.0.0.1:9/chat', model: 'test', systemPrompt: '' };

function oneStageJob(name: string, everyMs = HOUR): ProductJob {
  return createJob(
    {
      name,
      channelId: 'conv-build-room',
      stages: [{ stage: 'design', agentId: 'agent-atlas', prompt: `Do ${name}.`, expectedOutput: 'Done.' }],
      schedule: { kind: 'interval', everyMs },
    },
    T0,
  );
}

function stateWith(jobs: ProductJob[], extra: Partial<RunnerState> = {}): RunnerState {
  const s = emptyRunnerState();
  s.agents = [atlas, reviewer];
  s.jobs = jobs;
  return Object.assign(s, extra);
}

beforeEach(() => resetDispatchThrottle());

describe('restart mid-tick — checkpoint plus orphan reaping', () => {
  function twoStageJob(): ProductJob {
    return createJob(
      {
        name: 'nightly',
        channelId: 'conv-build-room',
        stages: [
          { stage: 'design', agentId: 'agent-atlas', prompt: 'Design.', expectedOutput: 'A design.' },
          { stage: 'implement', agentId: 'agent-atlas', prompt: 'Build.', expectedOutput: 'A build.', contextStages: ['design'] },
        ],
        schedule: { kind: 'interval', everyMs: MIN },
      },
      T0,
    );
  }

  /** The state a process killed mid-dispatch leaves on disk: the last checkpoint before the outcome. */
  async function killedMidStage(): Promise<RunnerState> {
    const cron = createCronJob({
      name: 'hourly ping',
      schedule: '* * * * *',
      target: 'ping',
      agentId: 'agent-atlas',
      channelId: 'conv-build-room',
    });
    const snapshots: RunnerState[] = [];
    await processDue(stateWith([twoStageJob()], { cronJobs: [cron] }), new Date(T0), {
      dispatchPrompt: async () => 'ok',
      executeCommand: async () => {
        throw new Error('no commands');
      },
      log: () => {},
      onCheckpoint: (s) => {
        snapshots.push(structuredClone(s));
      },
    });
    // Last snapshot in which the product stage is recorded 'dispatched' and has no outcome yet.
    const midStage = [...snapshots].reverse().find((s) => s.jobs[0].runs.some((r) => r.status === 'dispatched'));
    expect(midStage, 'a checkpoint must exist between "dispatched" and the outcome').toBeTruthy();
    return midStage!;
  }

  it('the checkpoint keeps the cron lastRunAt, so a restart does not re-fire it', async () => {
    const onDisk = await killedMidStage();
    expect(onDisk.cronJobs[0].lastRunAt).not.toBeNull();
    const fired: string[] = [];
    await processDueWithRhythm(onDisk, new Date(T0 + 5_000), {
      dispatchPrompt: async (_a, p) => {
        fired.push(p);
        return 'ok';
      },
      executeCommand: async () => {
        throw new Error('no commands');
      },
      log: () => {},
    });
    expect(fired).not.toContain('ping');
  });

  it('without the boot sweep, the orphan blocks its job until the 2 h age backstop reaps it', async () => {
    const deps = (prompts: string[]) => ({
      dispatchPrompt: async (_a: RunnerAgent, p: string) => {
        prompts.push(p);
        return 'ok';
      },
      executeCommand: async () => {
        throw new Error('no commands');
      },
      log: () => {},
      maxJobsPerTick: 1,
    });
    let state = await killedMidStage();
    const early: string[] = [];
    for (let i = 1; i <= 11; i++) {
      state = (await processDueWithRhythm(state, new Date(T0 + i * 10 * MIN), deps(early))).state;
    }
    expect(early.filter((p) => /Design|Build/.test(p))).toHaveLength(0);
    const late: string[] = [];
    state = (await processDueWithRhythm(state, new Date(T0 + ORPHAN_RUN_MAX_AGE_MS + 10 * MIN), deps(late))).state;
    expect(late.some((p) => /Design|Build/.test(p))).toBe(true);
  });

  it('boot sweep fails the orphan, keeps the stage, and the job runs on the first tick', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamz-rhythm-'));
    try {
      const path = join(dir, 'state.json');
      const onDisk = await killedMidStage();
      saveRunnerState(path, onDisk);
      const stageBefore = onDisk.jobs[0].currentStageIndex;

      const events = reapOrphansOnDisk(path, T0 + 10 * MIN);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run_reaped');

      const reloaded = loadRunnerState(path).state;
      const run = reloaded.jobs[0].runs.find((r) => r.id === events[0].fields.runId)!;
      expect(run.status).toBe('failed');
      expect(run.output).toMatch(/orphaned/);
      expect(reloaded.jobs[0].currentStageIndex).toBe(stageBefore);

      const prompts: string[] = [];
      const out = await processDueWithRhythm(reloaded, new Date(T0 + 10 * MIN + 61_000), {
        dispatchPrompt: async (_a, p) => {
          prompts.push(p);
          return 'recovered';
        },
        executeCommand: async () => {
          throw new Error('no commands');
        },
        log: () => {},
      });
      expect(prompts.some((p) => /Design|Build/.test(p))).toBe(true);
      expect(out.state.jobs[0].currentStageIndex).toBe(stageBefore + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('age reaping leaves a fresh in-flight run alone and reaps one past the max age', () => {
    const job = oneStageJob('x');
    const started = startStage(job, [], T0);
    if (!started.ok) throw new Error('stage did not start');
    const state = stateWith([started.job]);
    expect(reapOrphanedRuns(state, T0 + ORPHAN_RUN_MAX_AGE_MS - 1)).toHaveLength(0);
    expect(state.jobs[0].runs[0].status).toBe('dispatched');
    expect(reapOrphanedRuns(state, T0 + ORPHAN_RUN_MAX_AGE_MS)).toHaveLength(1);
    expect(state.jobs[0].runs[0].status).toBe('failed');
  });

  it('a reaped gated stage keeps its approval unconsumed, so the retry needs no second review', () => {
    const job = createJob(
      {
        name: 'gated',
        channelId: 'conv-build-room',
        stages: [{ stage: 'release', agentId: 'agent-atlas', prompt: 'Ship.', expectedOutput: 'Shipped.', flags: { requiresReview: true } }],
        schedule: { kind: 'interval', everyMs: HOUR },
      },
      T0,
    );
    const stage = currentStage(job)!;
    const req = decideApprovalByReviewer(ask(job, stage.stage, T0), 'approved', 'verified', T0 + MIN);
    const started = startStage(job, [req], T0 + 2 * MIN);
    if (!started.ok) throw new Error('stage did not start');
    const state = stateWith([started.job], { approvals: [req] });
    reapOrphanedRuns(state, T0 + 3 * HOUR);
    expect(findLiveApproval(state.approvals, job.id, stage.stage)).toBeTruthy();
  });
});

describe('stale approvals expire and the stage is re-reviewed', () => {
  function gatedJob(): ProductJob {
    return createJob(
      {
        name: 'gated',
        channelId: 'conv-build-room',
        stages: [{ stage: 'release', agentId: 'agent-atlas', prompt: 'Ship.', expectedOutput: 'Shipped.', flags: { requiresReview: true } }],
        schedule: { kind: 'interval', everyMs: HOUR },
      },
      T0,
    );
  }

  it('an approved-but-unconsumed approval past the TTL is no longer live', () => {
    const job = gatedJob();
    const req = decideApprovalByReviewer(ask(job, 'release', T0), 'approved', 'ok', T0 + MIN);
    const state = stateWith([job], { approvals: [req] });
    expect(expireStaleApprovals(state, T0 + MIN + APPROVAL_TTL_MS - 1)).toHaveLength(0);
    const events = expireStaleApprovals(state, T0 + MIN + APPROVAL_TTL_MS + 15 * HOUR);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('approval_expired');
    expect(findLiveApproval(state.approvals, job.id, 'release')).toBeUndefined();
    expect(canExecuteStage(job.id, 'release', state.approvals, { requiresReview: true }).allowed).toBe(false);
  });

  it('a pending request past the TTL stops blocking a fresh request', () => {
    const job = gatedJob();
    const req = ask(job, 'release', T0);
    const state = stateWith([job], { approvals: [req] });
    expect(pendingApprovals(state.approvals)).toHaveLength(1);
    expireStaleApprovals(state, T0 + APPROVAL_TTL_MS);
    expect(pendingApprovals(state.approvals)).toHaveLength(0);
    expect(findPendingApproval(state.approvals, job.id, 'release')).toBeUndefined();
  });

  it('denied and consumed approvals are history and never expire', () => {
    const job = gatedJob();
    const denied = decideApprovalByReviewer(ask(job, 'release', T0), 'denied', 'no', T0 + MIN);
    const consumed: ApprovalRequest = { ...decideApprovalByReviewer(ask(job, 'release', T0), 'approved', 'ok', T0 + MIN), consumedAt: T0 + 2 * MIN };
    const state = stateWith([job], { approvals: [denied, consumed] });
    expect(expireStaleApprovals(state, T0 + 100 * HOUR)).toHaveLength(0);
  });

  it('a job parked behind an expired pending request is resumed and re-reviewed on the next tick', async () => {
    const job = gatedJob();
    const req = ask(job, 'release', T0);
    const parked: ProductJob = { ...job, status: 'awaiting_approval', updatedAt: T0 };
    const reviewerCalls: string[] = [];
    const out = await processDueWithRhythm(stateWith([parked], { approvals: [req] }), new Date(T0 + APPROVAL_TTL_MS + HOUR), {
      dispatchPrompt: async (a, p) => {
        if (a.id === 'agent-reviewer') {
          reviewerCalls.push(p);
          return 'APPROVE: verified again.';
        }
        return 'shipped';
      },
      executeCommand: async () => {
        throw new Error('no commands');
      },
      log: () => {},
    });
    expect(out.fired.some((l) => /expired/.test(l))).toBe(true);
    expect(reviewerCalls.length).toBeGreaterThan(0);
  });

  it('a job parked by a later transient failure is not held by an old expired request', async () => {
    const job = gatedJob();
    const old = { ...ask(job, 'release', T0), expiredAt: T0 + APPROVAL_TTL_MS };
    const parked: ProductJob = { ...job, status: 'awaiting_approval', updatedAt: T0 + APPROVAL_TTL_MS };
    const reviewerCalls: string[] = [];
    await processDueWithRhythm(stateWith([parked], { approvals: [old] }), new Date(T0 + APPROVAL_TTL_MS + 5 * HOUR), {
      dispatchPrompt: async (a, p) => {
        if (a.id === 'agent-reviewer') reviewerCalls.push(p);
        return 'APPROVE: ok.';
      },
      executeCommand: async () => {
        throw new Error('no commands');
      },
      log: () => {},
    });
    expect(reviewerCalls.length).toBeGreaterThan(0);
  });

  it('reports a job parked behind a denial past the threshold once, not every tick', () => {
    const job = gatedJob();
    const denied = decideApprovalByReviewer(ask(job, 'release', T0), 'denied', 'no', T0 + MIN);
    const parked: ProductJob = { ...job, status: 'awaiting_approval', updatedAt: T0 };
    const state = stateWith([parked], { approvals: [denied] });
    const noted = new Map<string, number>();
    expect(reportStaleParkedJobs(state, T0 + 47 * HOUR, noted)).toHaveLength(0);
    expect(reportStaleParkedJobs(state, T0 + 49 * HOUR, noted)).toHaveLength(1);
    expect(reportStaleParkedJobs(state, T0 + 49 * HOUR + MIN, noted)).toHaveLength(0);
    expect(reportStaleParkedJobs(state, T0 + 56 * HOUR, noted)).toHaveLength(1);
  });
});

describe('provider resilience', () => {
  it('REFUSAL-AS-SUCCESS: a provider out-of-credits text returned as the reply is a failed run, not work', async () => {
    const refusal =
      "The account behind this API key doesn't have enough credits. Please [top up](https://enter.pollinations.ai/top-up?ref=x) or [complete a quest](https://enter.pollinations.ai/quests).";
    const out = await processDueWithRhythm(stateWith([oneStageJob('a')]), new Date(T0), {
      dispatchPrompt: async () => refusal,
      executeCommand: async () => {
        throw new Error('no commands');
      },
      log: () => {},
    });
    const job = out.state.jobs[0];
    expect(job.runs[0].status).toBe('failed');
    expect(job.currentStageIndex).toBe(0);
    expect(job.runs[0].output ?? '').toMatch(/402|credits/i);
  });

  it('recognises the refusal wordings and not an agent talking about credits', () => {
    expect(isCreditRefusalReply("The account behind this API key doesn't have enough credits.")).toBe(true);
    expect(isCreditRefusalReply('Error: insufficient credits for this request')).toBe(true);
    expect(isCreditRefusalReply('You are out of credits. Please top up.')).toBe(true);
    expect(isCreditRefusalReply('Quota exceeded')).toBe(true);
    expect(isCreditRefusalReply('see enter.pollinations.ai/top-up')).toBe(true);
    expect(isCreditRefusalReply('APPROVE: the credits table in the docs is correct.')).toBe(false);
    expect(isCreditRefusalReply('hello')).toBe(false);
    expect(isCreditRefusalReply('')).toBe(false);
    expect(isCreditRefusalReply(null)).toBe(false);
    expect(isCreditRefusalReply('There is not enough credits '.repeat(40))).toBe(false);
  });

  it('a provider with a recent 402 event is out of credits; an old one or a plain 429 is not', () => {
    const now = T0;
    const out = creditExhaustedProviders(
      [
        { provider: 'pollinations', ts: now - HOUR, error: 'Pollinations 402: no credits' },
        { provider: 'oldie', ts: now - 8 * HOUR, error: '402 insufficient credits' },
        { provider: 'busy', ts: now - MIN, error: 'HTTP 429 too many requests' },
      ],
      now,
    );
    expect([...out]).toEqual(['pollinations']);
  });

  it('the rescue prompt names out-of-credit providers and never lists them as healthy', async () => {
    const state = stateWith([], {});
    state.agents = [
      { ...atlas, provider: 'pollinations' },
      { id: 'agent-b', name: 'B', endpointUrl: atlas.endpointUrl, model: 't', systemPrompt: '', provider: 'ovh' },
      { id: 'agent-provider-researcher', name: 'Provider Researcher', endpointUrl: atlas.endpointUrl, model: 't', systemPrompt: '', provider: 'ovh' },
    ];
    const prompts: string[] = [];
    await processDueWithRhythm(state, new Date(T0), {
      dispatchPrompt: async (a, p) => {
        if (a.id === 'agent-provider-researcher') prompts.push(p);
        return 'noted';
      },
      executeCommand: async () => {
        throw new Error('no commands');
      },
      log: () => {},
      rateLimitEvents: async () => [
        { id: 'e1', ts: T0 - MIN, agentId: 'agent-atlas', agentName: 'Atlas', channelId: 'c', prompt: 'p', provider: 'pollinations', error: 'Pollinations 402: out of credits' },
      ],
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/OUT OF CREDITS[^.]*pollinations/);
    const healthy = /Healthy right now[^:]*: ([^.]*)\./.exec(prompts[0])![1];
    expect(healthy).not.toContain('pollinations');
  });

  it('markOutOfCredits moves a provider from healthy to limited and names it, and still warns on an unexpected shape', () => {
    const prompt =
      'RATE-LIMIT RESCUE — wake up. Already-programmed providers: pollinations, ovh. Healthy right now (not rate-limited): pollinations, ovh. Rate-limited right now: none. FIRST: check.';
    const out = markOutOfCredits(prompt, new Set(['pollinations']));
    expect(out).toContain('Healthy right now (not rate-limited): ovh. Rate-limited right now: pollinations. FIRST: check.');
    expect(out).toMatch(/OUT OF CREDITS[^.]*pollinations\.$/);
    expect(markOutOfCredits(prompt, new Set())).toBe(prompt);
    const odd = markOutOfCredits('something else entirely', new Set(['x']));
    expect(odd).toMatch(/OUT OF CREDITS[^.]*x\.$/);
  });

  it('stale backoff is dropped after a quiet window and kept inside it', () => {
    const backoff = {
      fresh: { consecutiveFailures: 3, lastFailedTs: T0, nextAllowedTs: T0 + HOUR },
      stale: { consecutiveFailures: 8, lastFailedTs: T0 - 20 * HOUR, nextAllowedTs: T0 - 16 * HOUR },
    };
    const dropped = expireStaleBackoff(backoff, T0, 4 * HOUR);
    expect(dropped).toEqual(['stale']);
    expect(Object.keys(backoff)).toEqual(['fresh']);
  });

  it('processDue clears stale backoff entries from state', async () => {
    const s = stateWith([]);
    s.rateLimitBackoff = { stale: { consecutiveFailures: 8, lastFailedTs: T0 - 30 * HOUR, nextAllowedTs: T0 - 26 * HOUR } };
    const out = await processDueWithRhythm(s, new Date(T0), {
      dispatchPrompt: async () => 'ok',
      executeCommand: async () => {
        throw new Error('no commands');
      },
      log: () => {},
    });
    expect(out.state.rateLimitBackoff).toEqual({});
  });
});

describe('starvation — 163 recurring jobs, 4 dispatches an hour', () => {
  const JOBS = 163;
  const NEVER_RUN = 49;
  const TICK_MS = 15 * MIN;

  function fleet(): ProductJob[] {
    return Array.from({ length: JOBS }, (_, i) => {
      const job = oneStageJob(`job-${String(i).padStart(3, '0')}`);
      // The last 49 have never run; the rest ran once, long enough ago to be due again.
      return i >= JOBS - NEVER_RUN ? job : { ...job, lastRunAt: T0 - (JOBS - i) * 3 * MIN - HOUR };
    });
  }

  it('the old array-order rule starves the never-run tail forever (control)', () => {
    const jobs = fleet();
    const neverRunIds = new Set(jobs.slice(JOBS - NEVER_RUN).map((j) => j.id));
    // The replaced rule: of the due jobs (never run, or interval elapsed) take the first in array order.
    const state = jobs.map((j) => ({ ...j }));
    const ran = new Set<string>();
    for (let t = 0; t < 400; t++) {
      const now = T0 + t * TICK_MS;
      const due = state.filter((j) => j.lastRunAt === null || now - j.lastRunAt >= HOUR);
      const first = due[0];
      if (!first) continue;
      first.lastRunAt = now;
      ran.add(first.id);
    }
    const starved = [...neverRunIds].filter((id) => !ran.has(id));
    expect(starved.length).toBe(NEVER_RUN);
  });

  it('pickJobsToStart gives every one of the 163 jobs a run, never-run jobs first', () => {
    const state = fleet().map((j) => ({ ...j }));
    const ran = new Set<string>();
    let firstNeverRunTick = -1;
    for (let t = 0; t < JOBS; t++) {
      const now = T0 + t * TICK_MS;
      const due = state.filter((j) => j.lastRunAt === null || now - j.lastRunAt >= HOUR);
      const [pick] = pickJobsToStart(due, 1);
      if (!pick) continue;
      if (pick.lastRunAt === null && firstNeverRunTick < 0) firstNeverRunTick = t;
      pick.lastRunAt = now;
      ran.add(pick.id);
    }
    expect(firstNeverRunTick).toBe(0);
    const neverRunNow = state.filter((j) => j.lastRunAt === null);
    expect(neverRunNow).toHaveLength(0);
    expect(ran.size).toBeGreaterThanOrEqual(NEVER_RUN);
  });

  it('through the real processDue: the 49 never-run jobs all run within 49 ticks', async () => {
    let state = stateWith(fleet());
    const ranJobs = new Set<string>();
    for (let t = 0; t < NEVER_RUN; t++) {
      const out = await processDueWithRhythm(state, new Date(T0 + t * TICK_MS), {
        dispatchPrompt: async (_a, p) => {
          ranJobs.add(/Do (job-\d+)/.exec(p)![1]);
          return 'done';
        },
        executeCommand: async () => {
          throw new Error('no commands');
        },
        log: () => {},
        maxJobsPerTick: 1,
      });
      state = out.state;
    }
    const never = state.jobs.slice(JOBS - NEVER_RUN).map((j) => j.name);
    for (const n of never) expect(ranJobs.has(n), `${n} never ran`).toBe(true);
  });

  it('pickJobsToStart orders never-run first, then longest-waiting, stable on ties', () => {
    const picked = pickJobsToStart(
      [
        { id: 'a', lastRunAt: 500 },
        { id: 'b', lastRunAt: null },
        { id: 'c', lastRunAt: 100 },
        { id: 'd', lastRunAt: null },
      ],
      3,
    );
    expect(picked.map((j) => j.id)).toEqual(['b', 'd', 'c']);
    expect(pickJobsToStart([{ id: 'a', lastRunAt: 1 }], 0)).toEqual([]);
  });

  it('drain time: 163 due jobs at one slot and a 15 min gap take more than 40 hours', () => {
    const ms = estimateDrainMs(JOBS, 1, 15 * MIN, 2.5 * MIN);
    expect(ms / HOUR).toBeGreaterThan(40);
    expect(estimateDrainMs(0, 1, 15 * MIN, 0)).toBe(0);
    expect(estimateDrainMs(10, 2, 15 * MIN, 0)).toBe(5 * 15 * MIN);
  });

  it('reports the backlog and its drain time through onRhythmEvent', async () => {
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    await processDueWithRhythm(stateWith(fleet()), new Date(T0), {
      dispatchPrompt: async () => 'done',
      executeCommand: async () => {
        throw new Error('no commands');
      },
      log: () => {},
      maxJobsPerTick: 1,
      minDispatchGapMs: 0,
      onRhythmEvent: (type, fields) => events.push({ type, fields }),
    });
    const backlog = events.find((e) => e.type === 'backlog');
    expect(backlog?.fields.due).toBe(JOBS);
  });
});
