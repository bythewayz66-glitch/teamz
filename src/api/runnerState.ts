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

export interface RunnerStateSummary {
  ok: boolean;
  jobs: RunnerJobSummary[];
  triggers: unknown[];
  cronJobs: unknown[];
  approvals: unknown[];
  agents: RunnerAgentSummary[];
  fetchedAt: number;
}

export function runnerStateUrl(): string {
  const host = window.location.hostname || '127.0.0.1';
  const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${proto}//${host}:8897/runner-state`;
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
    cronJobs: Array.isArray(r.cronJobs) ? r.cronJobs : [],
    approvals: Array.isArray(r.approvals) ? r.approvals : [],
    agents: Array.isArray(r.agents) ? (r.agents as RunnerAgentSummary[]) : [],
    fetchedAt: Date.now(),
  };
}
