import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRunnerState } from './runnerState';

const realFetch = globalThis.fetch;
const realWindow = (globalThis as Record<string, unknown>).window;

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as Record<string, unknown>).window = realWindow;
  vi.restoreAllMocks();
});

function stubWindow() {
  (globalThis as Record<string, unknown>).window = {
    location: { hostname: '100.87.46.34', protocol: 'http:' },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(body: unknown, status = 200) {
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    expect(String(url)).toBe('http://100.87.46.34:8897/runner-state');
    return jsonResponse(body, status);
  }) as unknown as typeof fetch;
}

describe('fetchRunnerState', () => {
  it('returns the server cron jobs typed as CronJobs, plus channel messages', async () => {
    stubWindow();
    stubFetch({
      ok: true,
      runner: {
        jobs: [{ id: 'job-nightly-repo-check', name: 'Nightly repo check' }],
        triggers: [],
        cronJobs: [
          {
            id: 'cron-hourly-mem20-assistant',
            name: 'Hourly: Mem20 Assistant',
            schedule: '0 * * * *',
            type: 'prompt',
            target: 'Drift snapshot',
            enabled: true,
            agentId: 'agent-mem20-assistant',
            channelId: 'conv-build-room',
            lastRunAt: null,
            runs: [],
          },
          {
            id: 'cron-orchestrator',
            name: 'Orchestrator',
            schedule: '*/15 * * * *',
            type: 'prompt',
            target: 'Triage',
            enabled: true,
            agentId: 'agent-orchestrator',
            channelId: 'conv-build-room',
            lastRunAt: 1795687200000,
            runs: [{ ts: 1795687200000, ok: true, detail: 'dispatched' }],
          },
        ],
        approvals: [],
        agents: [{ id: 'agent-mem20-assistant', name: 'Mem20 Assistant', model: 'openai-fast' }],
        channelMessages: [
          {
            id: 'msg-abc123',
            channelId: 'conv-build-room',
            agentId: 'agent-orchestrator',
            agentName: 'Orchestrator',
            kind: 'orchestrator',
            text: '@agent-qa-tester test plan please',
            ts: 1795687200000,
          },
        ],
      },
    });

    const s = await fetchRunnerState();
    expect(s.ok).toBe(true);
    expect(s.jobs).toHaveLength(1);
    expect(s.cronJobs).toHaveLength(2);
    expect(s.cronJobs[0].name).toBe('Hourly: Mem20 Assistant');
    expect(s.cronJobs[0].schedule).toBe('0 * * * *');
    expect(s.cronJobs[0].type).toBe('prompt');
    expect(s.cronJobs[1].lastRunAt).toBe(1795687200000);
    expect(s.cronJobs[1].runs).toEqual([{ ts: 1795687200000, ok: true, detail: 'dispatched' }]);
    expect(s.channelMessages).toHaveLength(1);
    expect(s.channelMessages[0].agentName).toBe('Orchestrator');
    expect(s.channelMessages[0].text).toBe('@agent-qa-tester test plan please');
  });

  it('drops malformed cron jobs and channel messages instead of rendering them half-formed', async () => {
    stubWindow();
    stubFetch({
      ok: true,
      runner: {
        jobs: [],
        triggers: [],
        cronJobs: [
          { id: 'cron-good', name: 'Good', schedule: '0 * * * *', type: 'prompt', target: '', enabled: true, lastRunAt: null, runs: [] },
          { name: 'no id', schedule: '0 * * * *' },
          'not an object',
          null,
        ],
        approvals: [],
        agents: [],
        channelMessages: [
          { id: 'msg-good', channelId: 'conv-build-room', text: 'hi', ts: 1 },
          { id: 'msg-no-text', channelId: 'conv-build-room', ts: 1 },
          null,
        ],
      },
    });

    const s = await fetchRunnerState();
    expect(s.cronJobs).toHaveLength(1);
    expect(s.cronJobs[0].id).toBe('cron-good');
    expect(s.channelMessages).toHaveLength(1);
    expect(s.channelMessages[0].id).toBe('msg-good');
  });

  it('throws when the endpoint is not ok', async () => {
    stubWindow();
    stubFetch({ ok: false }, 502);
    await expect(fetchRunnerState()).rejects.toThrow('HTTP 502');
  });

  it('tolerates a payload with no runner key at all', async () => {
    stubWindow();
    stubFetch({ ok: true });
    const s = await fetchRunnerState();
    expect(s.jobs).toEqual([]);
    expect(s.cronJobs).toEqual([]);
    expect(s.channelMessages).toEqual([]);
    expect(s.agents).toEqual([]);
  });
});
