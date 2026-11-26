/**
 * runnerState — read-only view of the headless server runner on jnet1.
 *
 * The Teamz UI's own Jobs panel is driven by the in-tab runner, whose
 * state lives in localStorage on this device. The 24/7 runner on jnet1
 * keeps its state in /var/lib/teamz-runner/state.json instead, and the
 * UI cannot see it — that is why Jesse asked "where's all the mem20
 * automations". The teamz-agent service (port 8897) exposes that state
 * read-only at GET /runner-state; this module fetches it.
 *
 * The endpoint lives on the same host as the UI, one port over
 * (8897 vs 8895), so the URL is derived from window.location.hostname.
 * The service sends CORS headers for the cross-port fetch. No writes:
 * the panel shows the runner's jobs, it never changes them.
 */

import type { CronJob } from '../lib/scheduler';

export interface RunnerJobSummary {
  id: string;
  name: string;
  description?: string;
  schedule: { kind: string; expr?: string; everyMs?: number };
  enabled: boolean;
  status: string;
  currentStageIndex: number;
  stages: Array<{ stage: string; agentId: string; humanInput?: boolean }>;
  runs: Array<{
    id?: string;
    stage?: string;
    status?: string;
    startedAt?: number;
    output?: string;
  }>;
  lastRunAt: number | null;
  workdir?: string;
  channelId?: string;
}

export interface RunnerAgentSummary {
  id: string;
  name: string;
  model?: string;
  endpointUrl?: string;
}

/**
 * One recorded runner dispatch in a channel. The runner keeps the newest
 * 200 in state.json; the endpoint exposes the last 20. These are the
 * messages the Build Room's local workspace never sees — the UI merges
 * them into the room (dedupe by id) so Jesse can watch the agents
 * actually working.
 */
export interface RunnerChannelMessage {
  id: string;
  channelId: string;
  agentId: string;
  agentName: string;
  kind: string;
  text: string;
  ts: number;
}

export interface RunnerStateSummary {
  ok: boolean;
  jobs: RunnerJobSummary[];
  triggers: unknown[];
  cronJobs: CronJob[];
  approvals: unknown[];
  agents: RunnerAgentSummary[];
  channelMessages: RunnerChannelMessage[];
  fetchedAt: number;
}

export function runnerStateUrl(): string {
  const host = window.location.hostname || '127.0.0.1';
  const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${proto}//${host}:8897/runner-state`;
}

/**
 * The endpoint returns the runner's cron jobs raw, so normalise them
 * defensively: only objects with a string id, name and schedule become
 * CronJobs; anything else is dropped rather than rendered half-formed.
 */
function normalizeCronJob(raw: unknown): CronJob | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.schedule !== 'string') {
    return null;
  }
  const runs = Array.isArray(r.runs)
    ? r.runs
        .filter(
          (x): x is Record<string, unknown> =>
            x !== null && typeof x === 'object' && typeof (x as Record<string, unknown>).ts === 'number',
        )
        .map((x) => ({
          ts: x.ts as number,
          ok: x.ok === true,
          detail: typeof x.detail === 'string' ? x.detail : undefined,
        }))
    : [];
  return {
    id: r.id,
    name: r.name,
    schedule: r.schedule,
    type: r.type === 'command' ? 'command' : 'prompt',
    target: typeof r.target === 'string' ? r.target : '',
    profile: typeof r.profile === 'string' ? r.profile : undefined,
    enabled: r.enabled === true,
    agentId: typeof r.agentId === 'string' ? r.agentId : undefined,
    channelId: typeof r.channelId === 'string' ? r.channelId : undefined,
    lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
    runs,
  };
}

function normalizeChannelMessage(raw: unknown): RunnerChannelMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.channelId !== 'string' ||
    typeof r.text !== 'string' ||
    typeof r.ts !== 'number'
  ) {
    return null;
  }
  return {
    id: r.id,
    channelId: r.channelId,
    agentId: typeof r.agentId === 'string' ? r.agentId : '',
    agentName: typeof r.agentName === 'string' ? r.agentName : '',
    kind: typeof r.kind === 'string' ? r.kind : '',
    text: r.text,
    ts: r.ts,
  };
}

export async function fetchRunnerState(): Promise<RunnerStateSummary> {
  const res = await fetch(runnerStateUrl(), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`runner-state answered HTTP ${res.status}`);
  }
  const data: unknown = await res.json();
  const runner =
    data !== null && typeof data === 'object'
      ? ((data as Record<string, unknown>).runner ?? {})
      : {};
  const r = runner as Record<string, unknown>;
  return {
    ok: (data as Record<string, unknown>).ok === true,
    jobs: Array.isArray(r.jobs) ? (r.jobs as RunnerJobSummary[]) : [],
    triggers: Array.isArray(r.triggers) ? r.triggers : [],
    cronJobs: Array.isArray(r.cronJobs)
      ? r.cronJobs
          .map(normalizeCronJob)
          .filter((j): j is CronJob => j !== null)
      : [],
    approvals: Array.isArray(r.approvals) ? r.approvals : [],
    agents: Array.isArray(r.agents) ? (r.agents as RunnerAgentSummary[]) : [],
    channelMessages: Array.isArray(r.channelMessages)
      ? r.channelMessages
          .map(normalizeChannelMessage)
          .filter((m): m is RunnerChannelMessage => m !== null)
      : [],
    fetchedAt: Date.now(),
  };
}
