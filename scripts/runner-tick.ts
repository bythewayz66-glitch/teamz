/**
 * One runner tick with the rhythm rules applied (Phase 0, part 2).
 *
 * `processDueWithRhythm` wraps `processDue` without editing it: it applies the
 * rules in runner-rhythm.ts to the state before the tick, orders the jobs
 * fairly, and wraps the dispatch so a provider's out-of-credits refusal is a
 * failed run. The live runner calls this instead of `processDue`.
 */

import {
  assessDispatchSlots,
  countDueProductJobs,
  DISPATCH_TIMEOUT_MS,
  loadRunnerState,
  processDue,
  RESCUE_BACKOFF_MAX_MS,
  saveRunnerState,
  type ProcessDueResult,
  type RateLimitEvent,
  type RunnerDeps,
  type RunnerState,
} from './runner-lib';
import { currentStage, resumeJob } from '../src/lib/jobs';
import {
  assertNotCreditRefusal,
  creditExhaustedProviders,
  estimateDrainMs,
  expireStaleApprovals,
  expireStaleBackoff,
  markOutOfCredits,
  pickJobsToStart,
  reapOrphanedRuns,
  reportStaleParkedJobs,
  type RhythmEvent,
} from './runner-rhythm';

/** RunnerDeps plus the hook the live runner uses to put rhythm events in the telemetry log. */
export type TickDeps = RunnerDeps & {
  onRhythmEvent?: (type: string, fields: Record<string, unknown>) => void;
};

/** Parked-job reports already made by this process (see reportStaleParkedJobs). */
const parkedNoted = new Map<string, number>();

/**
 * Runner boot: nothing can be in flight in a process that just started, so
 * every run still `dispatched` on disk is an orphan of the previous process.
 * Fail them and save, so the jobs they were holding run on the first tick.
 */
export function reapOrphansOnDisk(path: string, nowMs: number): RhythmEvent[] {
  const { state } = loadRunnerState(path);
  const events = reapOrphanedRuns(state, nowMs, 0);
  if (events.length > 0) saveRunnerState(path, state);
  return events;
}

export async function processDueWithRhythm(
  input: RunnerState,
  now: Date,
  deps: TickDeps,
): Promise<ProcessDueResult> {
  const nowMs = now.getTime();
  const state: RunnerState = structuredClone(input);
  const events: RhythmEvent[] = [];

  events.push(...reapOrphanedRuns(state, nowMs));
  const expired = expireStaleApprovals(state, nowMs);
  events.push(...expired);
  // processDue resumes a transiently parked job (no pending or denied request
  // for its stage) but counts an expired request as still pending. Apply the
  // same rule here with expired requests ignored, so a job parked behind a
  // request that expired, now or on an earlier tick, asks the Reviewer again.
  for (const job of state.jobs) {
    const plan = currentStage(job);
    if (!plan || job.status !== 'awaiting_approval') continue;
    const blocked = state.approvals.some(
      (a) => a.jobId === job.id && a.stage === plan.stage && !a.expiredAt && (a.status === 'pending' || a.status === 'denied'),
    );
    if (!blocked) state.jobs = state.jobs.map((j) => (j.id === job.id ? resumeJob(j, nowMs) : j));
  }
  events.push(...reportStaleParkedJobs(state, nowMs, parkedNoted));
  for (const provider of expireStaleBackoff(state.rateLimitBackoff, nowMs, RESCUE_BACKOFF_MAX_MS)) {
    deps.log(`rate-limit rescue: backoff for "${provider}" was quiet past its window — cleared`);
  }
  for (const e of events) {
    deps.log(e.line);
    try {
      deps.onRhythmEvent?.(e.type, e.fields);
    } catch {
      // Telemetry never breaks the tick.
    }
  }

  const due = countDueProductJobs(state, now);
  if (due > 0 && deps.onRhythmEvent) {
    const drainMs = estimateDrainMs(due, assessDispatchSlots(state, now), deps.minDispatchGapMs ?? 0, DISPATCH_TIMEOUT_MS / 2);
    try {
      deps.onRhythmEvent('backlog', { due, drainHours: Math.round((drainMs / 3600000) * 10) / 10 });
    } catch {
      // Telemetry never breaks the tick.
    }
  }

  // processDue starts the first due jobs in array order. Order the array
  // fairly for the tick, then put it back so the file's order never churns.
  const originalOrder = state.jobs.map((j) => j.id);
  state.jobs = pickJobsToStart(state.jobs, state.jobs.length);

  let seenEvents: RateLimitEvent[] = [];
  const { onRhythmEvent: _telemetryOnly, ...runnerDeps } = deps;
  void _telemetryOnly;
  const wrapped: RunnerDeps = {
    ...runnerDeps,
    rateLimitEvents: deps.rateLimitEvents
      ? async () => {
          seenEvents = await deps.rateLimitEvents!();
          return seenEvents;
        }
      : undefined,
    dispatchPrompt: async (agent, prompt, channelId) => {
      let sent = prompt;
      if (agent.id === 'agent-provider-researcher' && prompt.startsWith('RATE-LIMIT RESCUE')) {
        sent = markOutOfCredits(prompt, creditExhaustedProviders(seenEvents, nowMs));
      }
      const reply = await deps.dispatchPrompt(agent, sent, channelId);
      assertNotCreditRefusal(agent.name, reply);
      return reply;
    },
  };
  const out = await processDue(state, now, wrapped);

  const byId = new Map(out.state.jobs.map((j) => [j.id, j]));
  const restored = originalOrder.map((id) => byId.get(id)).filter((j): j is NonNullable<typeof j> => Boolean(j));
  for (const j of out.state.jobs) if (!originalOrder.includes(j.id)) restored.push(j);
  out.state.jobs = restored;
  return { ...out, fired: [...events.map((e) => e.line), ...out.fired] };
}
