/**
 * useAutonomy — the in-tab runner and the autonomy store.
 *
 * Owns the autonomy state (product jobs, cron jobs, interval triggers,
 * approval requests), persists it to localStorage alongside the workspace
 * (`teamz:autonomy:v1`, same debounced-write + cross-tab pattern as
 * `useWorkspace`), and runs the in-tab tick: every 30s it asks the pure
 * `tick()` primitive what is due and fires it through the workspace's own
 * send path (`ws.sendMessage` with an @mention), never by duplicating the
 * send logic.
 *
 * How a job stage fires, end to end:
 *   1. The tick finds a due job and `startStage` checks the governance
 *      gate. A gated stage with no live approval is blocked: an approval
 *      request is filed (if none is pending) and the job parks in
 *      `awaiting_approval`. Nothing is sent.
 *   2. An allowed stage is recorded as a dispatched run and queued. The
 *      dispatcher switches to the job's channel (the run belongs in that
 *      channel's history — that is its provenance) and sends
 *      `@Agent <stage prompt>` through `sendMessage`, so delivery, history,
 *      and streaming all behave exactly like a user message.
 *   3. When the agent's reply lands in the channel, the completion watcher
 *      records it as the stage's output, advances the job, and consumes the
 *      approval that authorised a gated stage.
 *
 * Honest limits (also shown in the Jobs panel and the README): this runner
 * fires only while this tab is open, and browsers throttle timers in
 * background tabs, so it is a dev/preview runner. The real 24/7 runner is
 * the Node service in `scripts/runner.ts`, deployed on jnet1.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, Conversation } from '../types';
import type { UseWorkspace } from './useWorkspace';
import {
  createCronJob,
  createTrigger,
  recordCronRun,
  tick as schedulerTick,
  Schedule,
  type CronJob,
  type IntervalTrigger,
} from '../lib/scheduler';
import {
  completeStageRun,
  currentStage,
  deserializeJob,
  isJobDue,
  parkForApproval,
  publishDocsTemplate,
  repoCheckTemplate,
  resumeJob,
  pauseJob as pauseJobFn,
  shipReleaseTemplate,
  startStage,
  type JobSchedule,
  type JobStage,
  type ProductJob,
  type TemplateInput,
} from '../lib/jobs';
import {
  decideApproval,
  findPendingApproval,
  pendingApprovals,
  requestApproval,
  type ApprovalRequest,
} from '../lib/governance';

export const AUTONOMY_STORAGE_KEY = 'teamz:autonomy:v1';

/** How often the in-tab tick checks for due work. */
export const RUNNER_TICK_MS = 30_000;

export interface AutonomyState {
  jobs: ProductJob[];
  triggers: IntervalTrigger[];
  approvals: ApprovalRequest[];
  cronJobs: CronJob[];
}

const EMPTY_STATE: AutonomyState = { jobs: [], triggers: [], approvals: [], cronJobs: [] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function loadState(): AutonomyState {
  try {
    const raw = localStorage.getItem(AUTONOMY_STORAGE_KEY);
    if (!raw) return { ...EMPTY_STATE };
    const parsed = JSON.parse(raw) as Partial<AutonomyState>;
    const jobs: ProductJob[] = [];
    for (const rawJob of Array.isArray(parsed.jobs) ? parsed.jobs : []) {
      try {
        jobs.push(deserializeJob(rawJob));
      } catch {
        // A corrupt or hand-edited job is dropped, never silently repaired.
        console.warn('[teamz] dropping an unreadable autonomy job from storage');
      }
    }
    const triggers = (Array.isArray(parsed.triggers) ? parsed.triggers : []).filter(
      (t): t is IntervalTrigger =>
        isRecord(t) &&
        typeof t.id === 'string' &&
        typeof t.channelId === 'string' &&
        typeof t.agentId === 'string' &&
        typeof t.prompt === 'string' &&
        typeof t.everyMs === 'number',
    );
    const cronJobs = (Array.isArray(parsed.cronJobs) ? parsed.cronJobs : []).filter(
      (j): j is CronJob => {
        if (!isRecord(j) || typeof j.schedule !== 'string') return false;
        try {
          new Schedule(j.schedule);
        } catch {
          return false;
        }
        return typeof j.id === 'string' && typeof j.target === 'string';
      },
    );
    const approvals = (Array.isArray(parsed.approvals) ? parsed.approvals : []).filter(
      (a): a is ApprovalRequest =>
        isRecord(a) &&
        typeof a.id === 'string' &&
        typeof a.jobId === 'string' &&
        typeof a.stage === 'string' &&
        (a.status === 'pending' || a.status === 'approved' || a.status === 'denied'),
    );
    return { jobs, triggers, approvals, cronJobs };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** One queued delivery: a prompt to send to one agent in one channel. */
interface Dispatch {
  channelId: string;
  agentId: string;
  text: string;
  label: string;
}

export interface UseAutonomy {
  jobs: ProductJob[];
  triggers: IntervalTrigger[];
  approvals: ApprovalRequest[];
  cronJobs: CronJob[];
  pendingApprovalCount: number;
  /** True while a queued run is being delivered. */
  dispatching: boolean;
  addJobFromTemplate: (
    kind: 'ship-release' | 'publish-docs' | 'repo-check',
    input: TemplateInput & { workdir?: string },
  ) => ProductJob;
  setJobEnabled: (jobId: string, enabled: boolean) => void;
  setJobSchedule: (jobId: string, schedule: JobSchedule) => void;
  setStageAgent: (jobId: string, stage: JobStage, agentId: string) => void;
  pauseJob: (jobId: string) => void;
  resumeJob: (jobId: string) => void;
  deleteJob: (jobId: string) => void;
  runJobNow: (jobId: string) => void;
  addTrigger: (input: {
    channelId: string;
    agentId: string;
    prompt: string;
    everyMs: number;
  }) => IntervalTrigger;
  setTriggerEnabled: (id: string, enabled: boolean) => void;
  deleteTrigger: (id: string) => void;
  addCronJob: (input: {
    name: string;
    schedule: string;
    target: string;
    agentId: string;
    channelId: string;
  }) => CronJob;
  setCronJobEnabled: (id: string, enabled: boolean) => void;
  deleteCronJob: (id: string) => void;
  approve: (approvalId: string) => void;
  deny: (approvalId: string) => void;
  requestApprovalFor: (jobId: string) => void;
}

export function useAutonomy(ws: UseWorkspace): UseAutonomy {
  const [state, setState] = useState<AutonomyState>(loadState);
  const [queueVersion, setQueueVersion] = useState(0);
  const [dispatching, setDispatching] = useState(false);
  const stateRef = useRef(state);
  const wsRef = useRef(ws);
  const queueRef = useRef<Dispatch[]>([]);
  const inFlightRef = useRef(false);
  const commandStageNotedRef = useRef(new Set<string>());

  stateRef.current = state;
  wsRef.current = ws;

  // Persist on every change (debounced), mirroring useWorkspace.
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(AUTONOMY_STORAGE_KEY, JSON.stringify(state));
      } catch (err) {
        if (err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22)) {
          console.warn('[teamz] localStorage quota exceeded; autonomy state not saved.');
        }
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [state]);

  // Cross-tab sync.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== AUTONOMY_STORAGE_KEY || !e.newValue) return;
      try {
        const parsed = JSON.parse(e.newValue) as Partial<AutonomyState>;
        setState((s) => ({
          jobs: parsed.jobs ? parsed.jobs.map((j) => {
            try {
              return deserializeJob(j);
            } catch {
              return null;
            }
          }).filter((j): j is ProductJob => j !== null) : s.jobs,
          triggers: Array.isArray(parsed.triggers) ? parsed.triggers : s.triggers,
          approvals: Array.isArray(parsed.approvals) ? parsed.approvals : s.approvals,
          cronJobs: Array.isArray(parsed.cronJobs) ? parsed.cronJobs : s.cronJobs,
        }));
      } catch {
        /* ignore malformed */
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const enqueue = useCallback((d: Dispatch) => {
    queueRef.current = [...queueRef.current, d];
    setQueueVersion((v) => v + 1);
  }, []);

  /**
   * Attempt one job's current stage: governance first, then dispatch.
   * Returns a note for the log; blocked-gated stages file an approval
   * request and park the job instead of sending anything.
   */
  const attemptStage = useCallback(
    (job: ProductJob, nowMs: number): string | null => {
      if (job.runs.some((r) => r.status === 'dispatched')) {
        return null; // A stage is already in flight for this job.
      }
      const plan = currentStage(job);
      if (plan?.command) {
        // Command stages run on the server runner only. The tab records
        // nothing and sends nothing — the stage stays due until the server
        // runner picks it up. Noted once per stage so the log stays quiet.
        const key = `${job.id}:${plan.stage}`;
        if (!commandStageNotedRef.current.has(key)) {
          commandStageNotedRef.current.add(key);
          console.info(
            `[teamz] autonomy: job "${job.name}" stage "${plan.stage}" is a command stage — it runs on the server runner, not in this tab.`,
          );
        }
        return null;
      }
      const started = startStage(job, stateRef.current.approvals, nowMs);
      if (!started.ok) {
        if (started.needsApproval) {
          const plan = currentStage(job);
          if (plan && !findPendingApproval(stateRef.current.approvals, job.id, plan.stage)) {
            const req = requestApproval(
              job.id,
              job.name,
              plan.stage,
              `Stage "${plan.stage}" of "${job.name}" needs the Reviewer's approval: ${started.reason}`,
              nowMs,
            );
            setState((s) => ({
              ...s,
              approvals: [...s.approvals, req],
              jobs: s.jobs.map((j) => (j.id === job.id ? parkForApproval(j, nowMs) : j)),
            }));
            return `approval requested for ${job.name} / ${plan.stage}`;
          }
          setState((s) => ({
            ...s,
            jobs: s.jobs.map((j) => (j.id === job.id ? parkForApproval(j, nowMs) : j)),
          }));
        }
        return null;
      }
      const agent = wsRef.current.agentsById.get(started.run.agentId);
      if (!agent) {
        console.warn(`[teamz] job "${job.name}" targets unknown agent ${started.run.agentId}; run not dispatched`);
        return null;
      }
      setState((s) => ({
        ...s,
        jobs: s.jobs.map((j) => (j.id === job.id ? started.job : j)),
      }));
      enqueue({
        channelId: started.job.channelId,
        agentId: started.run.agentId,
        text: `@${agent.name} ${started.run.prompt}`,
        label: `${job.name} / ${started.run.stage}`,
      });
      return `dispatched ${job.name} / ${started.run.stage} to ${agent.name}`;
    },
    [enqueue],
  );

  /** One tick: find due work and fire it. Pure `tick()` decides; this acts. */
  const runTick = useCallback(() => {
    const now = new Date();
    const nowMs = now.getTime();
    const s = stateRef.current;
    const { dueJobs, dueTriggers } = schedulerTick(now, s.cronJobs, s.triggers);

    for (const trigger of dueTriggers) {
      const agent = wsRef.current.agentsById.get(trigger.agentId);
      if (!agent) continue;
      setState((prev) => ({
        ...prev,
        triggers: prev.triggers.map((t) =>
          t.id === trigger.id ? { ...t, lastRunAt: nowMs } : t,
        ),
      }));
      enqueue({
        channelId: trigger.channelId,
        agentId: trigger.agentId,
        text: `@${agent.name} ${trigger.prompt}`,
        label: `trigger: ${trigger.prompt.slice(0, 60)}`,
      });
    }

    for (const cron of dueJobs) {
      if (cron.type === 'command') {
        // A browser tab cannot run shell commands. Record the block honestly
        // instead of pretending the command ran; the server runner does these.
        setState((prev) => ({
          ...prev,
          cronJobs: prev.cronJobs.map((j) =>
            j.id === cron.id
              ? recordCronRun({ ...j, lastRunAt: nowMs }, {
                  ts: nowMs,
                  ok: false,
                  detail: 'command jobs need the server runner (see scripts/runner.ts)',
                })
              : j,
          ),
        }));
        continue;
      }
      const agent = cron.agentId ? wsRef.current.agentsById.get(cron.agentId) : undefined;
      if (!agent || !cron.channelId) continue;
      setState((prev) => ({
        ...prev,
        cronJobs: prev.cronJobs.map((j) =>
          j.id === cron.id ? { ...j, lastRunAt: nowMs } : j,
        ),
      }));
      enqueue({
        channelId: cron.channelId,
        agentId: agent.id,
        text: `@${agent.name} ${cron.target}`,
        label: `cron: ${cron.name}`,
      });
    }

    for (const job of s.jobs) {
      if (isJobDue(job, now)) {
        const note = attemptStage(job, nowMs);
        if (note) console.info(`[teamz] autonomy: ${note}`);
      }
    }
  }, [attemptStage, enqueue]);

  // The in-tab tick: every 30s, plus once shortly after mount so a due
  // trigger fires soon after the tab opens instead of waiting a full cycle.
  // Cleanup clears both timers, so StrictMode's double-mount in dev never
  // leaves a stale interval behind or fires the first tick twice.
  useEffect(() => {
    const first = setTimeout(runTick, 1000);
    const timer = setInterval(runTick, RUNNER_TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [runTick]);

  // Dispatcher: work the queue one item at a time, through sendMessage.
  // A delivery belongs in its channel's history, so the dispatcher switches
  // to that channel first and sends once the switch has landed.
  useEffect(() => {
    if (inFlightRef.current) return;
    const head = queueRef.current[0];
    if (!head) return;
    const current = wsRef.current;
    if (current.activeConversation?.id !== head.channelId) {
      const exists = current.state.conversations.some((c) => c.id === head.channelId);
      if (!exists) {
        console.warn(`[teamz] autonomy: channel ${head.channelId} no longer exists; dropping ${head.label}`);
        queueRef.current = queueRef.current.slice(1);
        setQueueVersion((v) => v + 1);
        return;
      }
      current.setActiveConversation(head.channelId);
      return;
    }
    inFlightRef.current = true;
    setDispatching(true);
    void current
      .sendMessage(head.text)
      .catch((err) => console.warn(`[teamz] autonomy: dispatch failed for ${head.label}`, err))
      .finally(() => {
        queueRef.current = queueRef.current.slice(1);
        inFlightRef.current = false;
        setDispatching(false);
        setQueueVersion((v) => v + 1);
      });
  }, [queueVersion, ws.activeConversation?.id]);

  // Completion watcher: when an agent's reply lands in a channel after a
  // dispatched run started, record it as that stage's output and advance.
  useEffect(() => {
    const s = stateRef.current;
    for (const job of s.jobs) {
      const run = job.runs.find((r) => r.status === 'dispatched' && r.kind === 'prompt');
      if (!run) continue;
      const messages = ws.state.messages[run.conversationId] ?? [];
      const reply = messages.find(
        (m) =>
          m.authorType === 'agent' &&
          m.authorId === run.agentId &&
          m.createdAt > run.startedAt &&
          (m.status === 'sent' || m.status === 'error') &&
          m.text.trim().length > 0,
      );
      if (!reply) continue;
      const ok = reply.status === 'sent';
      setState((prev) => {
        const target = prev.jobs.find((j) => j.id === job.id);
        if (!target) return prev;
        const { job: nextJob, approvals: nextApprovals } = completeStageRun(
          target,
          run.id,
          reply.text,
          ok,
          prev.approvals,
          Date.now(),
        );
        const withMessage: ProductJob = {
          ...nextJob,
          runs: nextJob.runs.map((r) =>
            r.id === run.id ? { ...r, messageId: reply.id } : r,
          ),
        };
        return {
          ...prev,
          jobs: prev.jobs.map((j) => (j.id === job.id ? withMessage : j)),
          approvals: nextApprovals,
        };
      });
    }
  }, [ws.state.messages]);

  const addJobFromTemplate = useCallback(
    (kind: 'ship-release' | 'publish-docs' | 'repo-check', input: TemplateInput & { workdir?: string }) => {
      const job =
        kind === 'ship-release'
          ? shipReleaseTemplate(input)
          : kind === 'publish-docs'
            ? publishDocsTemplate(input)
            : repoCheckTemplate({ ...input, workdir: input.workdir ?? '' });
      setState((s) => ({ ...s, jobs: [...s.jobs, job] }));
      return job;
    },
    [],
  );

  const setJobEnabled = useCallback((jobId: string, enabled: boolean) => {
    setState((s) => ({
      ...s,
      jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, enabled, updatedAt: Date.now() } : j)),
    }));
  }, []);

  const setJobSchedule = useCallback((jobId: string, schedule: JobSchedule) => {
    setState((s) => ({
      ...s,
      jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, schedule, updatedAt: Date.now() } : j)),
    }));
  }, []);

  const setStageAgent = useCallback((jobId: string, stage: JobStage, agentId: string) => {
    setState((s) => ({
      ...s,
      jobs: s.jobs.map((j) =>
        j.id === jobId
          ? {
              ...j,
              stages: j.stages.map((st) => (st.stage === stage ? { ...st, agentId } : st)),
              updatedAt: Date.now(),
            }
          : j,
      ),
    }));
  }, []);

  const pauseJob = useCallback((jobId: string) => {
    setState((s) => ({
      ...s,
      jobs: s.jobs.map((j) => (j.id === jobId ? pauseJobFn(j) : j)),
    }));
  }, []);

  const resumeJobAction = useCallback((jobId: string) => {
    setState((s) => ({
      ...s,
      jobs: s.jobs.map((j) => (j.id === jobId ? resumeJob(j) : j)),
    }));
  }, []);

  const deleteJob = useCallback((jobId: string) => {
    setState((s) => ({
      ...s,
      jobs: s.jobs.filter((j) => j.id !== jobId),
      approvals: s.approvals.filter((a) => a.jobId !== jobId),
    }));
  }, []);

  const runJobNow = useCallback(
    (jobId: string) => {
      const job = stateRef.current.jobs.find((j) => j.id === jobId);
      if (!job) return;
      const note = attemptStage(job, Date.now());
      if (note) console.info(`[teamz] autonomy: ${note}`);
    },
    [attemptStage],
  );

  const addTrigger = useCallback(
    (input: { channelId: string; agentId: string; prompt: string; everyMs: number }) => {
      const trigger = createTrigger(input);
      setState((s) => ({ ...s, triggers: [...s.triggers, trigger] }));
      return trigger;
    },
    [],
  );

  const setTriggerEnabled = useCallback((id: string, enabled: boolean) => {
    setState((s) => ({
      ...s,
      triggers: s.triggers.map((t) => (t.id === id ? { ...t, enabled } : t)),
    }));
  }, []);

  const deleteTrigger = useCallback((id: string) => {
    setState((s) => ({ ...s, triggers: s.triggers.filter((t) => t.id !== id) }));
  }, []);

  const addCronJob = useCallback(
    (input: { name: string; schedule: string; target: string; agentId: string; channelId: string }) => {
      const job = createCronJob({ ...input, type: 'prompt' });
      setState((s) => ({ ...s, cronJobs: [...s.cronJobs, job] }));
      return job;
    },
    [],
  );

  const setCronJobEnabled = useCallback((id: string, enabled: boolean) => {
    setState((s) => ({
      ...s,
      cronJobs: s.cronJobs.map((j) => (j.id === id ? { ...j, enabled } : j)),
    }));
  }, []);

  const deleteCronJob = useCallback((id: string) => {
    setState((s) => ({ ...s, cronJobs: s.cronJobs.filter((j) => j.id !== id) }));
  }, []);

  const approve = useCallback((approvalId: string) => {
    setState((s) => {
      const req = s.approvals.find((a) => a.id === approvalId);
      if (!req || req.status !== 'pending') return s;
      const decided = decideApproval(req, 'approved');
      return {
        ...s,
        approvals: s.approvals.map((a) => (a.id === approvalId ? decided : a)),
        jobs: s.jobs.map((j) =>
          j.id === req.jobId && j.status === 'awaiting_approval' ? resumeJob(j) : j,
        ),
      };
    });
  }, []);

  const deny = useCallback((approvalId: string) => {
    setState((s) => {
      const req = s.approvals.find((a) => a.id === approvalId);
      if (!req || req.status !== 'pending') return s;
      return {
        ...s,
        approvals: s.approvals.map((a) =>
          a.id === approvalId ? decideApproval(a, 'denied') : a,
        ),
      };
    });
  }, []);

  const requestApprovalFor = useCallback((jobId: string) => {
    setState((s) => {
      const job = s.jobs.find((j) => j.id === jobId);
      const plan = job ? currentStage(job) : null;
      if (!job || !plan) return s;
      if (findPendingApproval(s.approvals, jobId, plan.stage)) return s;
      const req = requestApproval(
        job.id,
        job.name,
        plan.stage,
        `Stage "${plan.stage}" of "${job.name}" — approval requested for a Reviewer decision`,
        Date.now(),
      );
      return {
        ...s,
        approvals: [...s.approvals, req],
        jobs: s.jobs.map((j) => (j.id === jobId ? parkForApproval(j) : j)),
      };
    });
  }, []);

  const pending = pendingApprovals(state.approvals);

  return {
    jobs: state.jobs,
    triggers: state.triggers,
    approvals: state.approvals,
    cronJobs: state.cronJobs,
    pendingApprovalCount: pending.length,
    dispatching,
    addJobFromTemplate,
    setJobEnabled,
    setJobSchedule,
    setStageAgent,
    pauseJob,
    resumeJob: resumeJobAction,
    deleteJob,
    runJobNow,
    addTrigger,
    setTriggerEnabled,
    deleteTrigger,
    addCronJob,
    setCronJobEnabled,
    deleteCronJob,
    approve,
    deny,
    requestApprovalFor,
  };
}

/** Re-exported for panels that need agent/channel labels. */
export type { Agent, Conversation };
