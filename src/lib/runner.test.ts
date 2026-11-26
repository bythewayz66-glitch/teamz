import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  dispatchPromptToAgent,
  emptyRunnerState,
  executeAllowedCommand,
  loadRunnerState,
  parseAgentReply,
  processDue,
  saveRunnerState,
  type CommandResult,
  type RunnerAgent,
  type RunnerState,
} from '../../scripts/runner-lib';
import { createJob, repoCheckTemplate, type ProductJob } from './jobs';
import { decideApproval, type ApprovalRequest } from './governance';

const T0 = 1_700_000_000_000;

function cmdJob(overrides: Partial<ProductJob> = {}): ProductJob {
  return createJob({
    name: 'cmd job',
    channelId: 'conv-build-room',
    workdir: process.cwd(),
    allowedCommands: [
      ['node', '--version'],
      ['echo', 'a; echo pwned'],
      ['node', '-e', 'setTimeout(()=>{},30000)'],
    ],
    stages: [
      {
        stage: 'implement',
        agentId: 'agent-atlas',
        prompt: 'Check the version.',
        expectedOutput: 'The node version.',
        command: { argv: ['node', '--version'] },
      },
    ],
    ...overrides,
  });
}

describe('executeAllowedCommand — the real executor', () => {
  it('runs an allowlisted command and captures its output', async () => {
    const job = cmdJob();
    const result = await executeAllowedCommand(job, ['node', '--version']);
    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it('refuses a command that is not on the allowlist — nothing is spawned', async () => {
    const job = cmdJob();
    const result = await executeAllowedCommand(job, ['node', '-e', 'console.log("pwned")']);
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toMatch(/not on job "cmd job"'s allowlist/);
    expect(result.output).toBe('');
    expect(result.exitCode).toBeNull();
  });

  it('passes argv literally — shell metacharacters are data, not commands', async () => {
    const job = cmdJob();
    const result = await executeAllowedCommand(job, ['echo', 'a; echo pwned']);
    expect(result.ok).toBe(true);
    // If a shell had run this, the output would be two lines ("a" and "pwned").
    // argv passing prints the argument verbatim, on one line.
    expect(result.output.trim()).toBe('a; echo pwned');
  });

  it('times out a hung command and reports it', async () => {
    const job = cmdJob();
    const result = await executeAllowedCommand(job, ['node', '-e', 'setTimeout(()=>{},30000)'], {
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it('reports a failing command with its output and exit code', async () => {
    const job = createJob({
      name: 'fail job',
      channelId: 'c',
      workdir: process.cwd(),
      allowedCommands: [['node', '-e', 'console.error("boom"); process.exit(3)']],
      stages: [
        {
          stage: 'implement',
          agentId: 'a',
          prompt: 'p',
          expectedOutput: 'e',
          command: { argv: ['node', '-e', 'console.error("boom"); process.exit(3)'] },
        },
      ],
    });
    const result = await executeAllowedCommand(job, ['node', '-e', 'console.error("boom"); process.exit(3)']);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('boom');
  });
});

describe('dispatchPromptToAgent — the HTTP transport', () => {
  it('parses every reply shape the browser accepts', () => {
    expect(parseAgentReply('plain')).toBe('plain');
    expect(parseAgentReply({ reply: 'r' })).toBe('r');
    expect(parseAgentReply({ text: 't' })).toBe('t');
    expect(parseAgentReply({ choices: [{ message: { content: 'c' } }] })).toBe('c');
    expect(parseAgentReply({ delta: { content: 'd' } })).toBe('d');
    expect(parseAgentReply({ content: [{ type: 'text', text: 'b' }] })).toBe('b');
    expect(() => parseAgentReply({})).toThrow(/did not contain readable text/);
    expect(() => parseAgentReply(null)).toThrow();
  });

  it('POSTs the documented wire format and returns the reply', async () => {
    const { url, lastBody, close } = await startEchoServer();
    try {
      const agent: RunnerAgent = {
        id: 'agent-atlas',
        name: 'Atlas',
        endpointUrl: url,
        model: 'test',
        systemPrompt: 'Be Atlas.',
      };
      const reply = await dispatchPromptToAgent(agent, 'Hello', 'conv-build-room');
      expect(reply).toBe('Atlas here. You said: "Hello".');
      const body = lastBody() as {
        agent: { name: string };
        messages: Array<{ content: string }>;
        directed: boolean;
      };
      expect(body.agent.name).toBe('Atlas');
      expect(body.messages[0].content).toBe('Hello');
      expect(body.directed).toBe(true);
    } finally {
      close();
    }
  });
});

/** Minimal local HTTP server for the dispatch test (no test-framework server). */
function startEchoServer(): Promise<{
  url: string;
  lastBody: () => unknown;
  close: () => void;
}> {
  let lastBody: unknown = null;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8');
    });
    req.on('end', () => {
      try {
        lastBody = JSON.parse(data || '{}');
      } catch {
        lastBody = data;
      }
      const body = lastBody as { messages?: Array<{ content?: string }> };
      const msgs = body.messages ?? [];
      const last = msgs.length > 0 ? msgs[msgs.length - 1]?.content ?? '' : '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reply: `Atlas here. You said: "${last}".` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/chat`,
        lastBody: () => lastBody,
        close: () => server.close(),
      });
    });
  });
}

describe('processDue — one headless tick', () => {
  function baseState(job: ProductJob, approvals: ApprovalRequest[] = []): RunnerState {
    const state = emptyRunnerState();
    state.agents = [
      { id: 'agent-atlas', name: 'Atlas', endpointUrl: 'http://127.0.0.1:9/chat', model: 'test', systemPrompt: '' },
    ];
    state.jobs = [job];
    state.approvals = approvals;
    return state;
  }

  function intervalJob(): ProductJob {
    return createJob({
      name: 'interval job',
      channelId: 'conv-build-room',
      stages: [
        { stage: 'design', agentId: 'agent-atlas', prompt: 'Design it.', expectedOutput: 'A design.' },
        { stage: 'build', agentId: 'agent-atlas', prompt: 'Build it.', expectedOutput: 'A build.', contextStages: ['design'] },
      ],
      schedule: { kind: 'interval', everyMs: 60_000 },
    });
  }

  it('dispatches a due prompt stage and records the reply as its output', async () => {
    const calls: Array<{ agent: string; prompt: string }> = [];
    const { state } = await processDue(baseState(intervalJob()), new Date(T0), {
      dispatchPrompt: async (agent, prompt) => {
        calls.push({ agent: agent.name, prompt });
        return 'The design: three modules.';
      },
      executeCommand: async () => {
        throw new Error('should not execute for a prompt stage');
      },
      log: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe('Atlas');
    expect(calls[0].prompt).toContain('Design it.');
    const job = state.jobs[0];
    expect(job.runs).toHaveLength(1);
    expect(job.runs[0].status).toBe('ok');
    expect(job.runs[0].output).toBe('The design: three modules.');
    expect(job.currentStageIndex).toBe(1);
  });

  it('a gated stage files an approval request and dispatches nothing', async () => {
    const job = createJob({
      name: 'gated job',
      channelId: 'conv-build-room',
      stages: [
        { stage: 'design', agentId: 'agent-atlas', prompt: 'p', expectedOutput: 'e' },
        { stage: 'release', agentId: 'agent-atlas', prompt: 'p', expectedOutput: 'e' },
      ],
      schedule: { kind: 'interval', everyMs: 60_000 },
    });
    const calls: string[] = [];
    const deps = {
      dispatchPrompt: async () => {
        calls.push('dispatch');
        return 'done';
      },
      executeCommand: async (): Promise<CommandResult> => {
        throw new Error('no commands here');
      },
      log: () => {},
    };
    // First tick: design runs.
    let out = await processDue(baseState(job), new Date(T0), deps);
    expect(calls).toHaveLength(1);
    // Second tick (after the interval): release is gated — no dispatch,
    // an approval request is filed, and the job parks.
    out = await processDue(out.state, new Date(T0 + 61_000), deps);
    expect(calls).toHaveLength(1);
    expect(out.state.approvals).toHaveLength(1);
    expect(out.state.approvals[0].status).toBe('pending');
    expect(out.state.approvals[0].stage).toBe('release');
    expect(out.state.jobs[0].status).toBe('awaiting_approval');
    expect(out.state.jobs[0].runs).toHaveLength(1);
    // Third tick with the approval granted: the release runs.
    const approved: ApprovalRequest[] = [
      decideApproval(out.state.approvals[0], 'approved', T0 + 122_000),
    ];
    const resumed: RunnerState = {
      ...out.state,
      approvals: approved,
      jobs: out.state.jobs.map((j) => ({ ...j, status: 'active' as const })),
    };
    out = await processDue(resumed, new Date(T0 + 123_000), deps);
    expect(calls).toHaveLength(2);
    expect(out.state.jobs[0].status).toBe('done');
    expect(out.state.approvals[0].consumedAt).not.toBeNull();
  });

  it('runs the Nightly chain end to end: design → implement → Reviewer-approved push → document', async () => {
    const job = repoCheckTemplate({
      channelId: 'conv-build-room',
      agentId: 'agent-atlas',
      workdir: process.cwd(),
      schedule: { kind: 'interval', everyMs: 60_000 },
    });
    const state = baseState(job);
    state.agents.push({
      id: 'agent-reviewer',
      name: 'Reviewer',
      endpointUrl: 'http://127.0.0.1:9/chat',
      model: 'test',
      systemPrompt: '',
    });
    const executed: string[][] = [];
    const deps = {
      dispatchPrompt: async (a: RunnerAgent) => {
        if (a.id === 'agent-reviewer') return 'APPROVE: no patch staged, nothing to push — safe.';
        return 'NO-CHANGE: nothing verifiably wrong.';
      },
      executeCommand: async (_j: ProductJob, argv: string[]): Promise<CommandResult> => {
        executed.push(argv);
        return {
          ok: true,
          exitCode: 0,
          output: 'NOTHING-TO-PUSH: no staged patch',
          timedOut: false,
          blocked: false,
          blockedReason: null,
        };
      },
      log: () => {},
    };
    // Tick 1: design (prompt). Tick 2: implement (prompt, NO-CHANGE).
    let out = await processDue(state, new Date(T0), deps);
    expect(out.state.jobs[0].currentStageIndex).toBe(1);
    out = await processDue(out.state, new Date(T0 + 61_000), deps);
    expect(out.state.jobs[0].currentStageIndex).toBe(2);
    expect(out.state.jobs[0].runs[1].output).toContain('NO-CHANGE');
    // Tick 3: the push stage is gated — the Reviewer approves in the same
    // tick (decidedBy 'reviewer'), the allowlisted push command executes,
    // and the approval is consumed on success.
    out = await processDue(out.state, new Date(T0 + 122_000), deps);
    expect(executed).toEqual([['sudo', '/opt/teamz-runner/push-mem20.py']]);
    expect(out.state.approvals).toHaveLength(1);
    expect(out.state.approvals[0].status).toBe('approved');
    expect(out.state.approvals[0].decidedBy).toBe('reviewer');
    expect(out.state.approvals[0].stage).toBe('upgrade');
    expect(out.state.approvals[0].consumedAt).not.toBeNull();
    expect(out.state.jobs[0].runs[2].kind).toBe('command');
    expect(out.state.jobs[0].runs[2].output).toContain('NOTHING-TO-PUSH');
    expect(out.state.jobs[0].currentStageIndex).toBe(3);
    // Tick 4: document records the push (or its absence) and the job ends.
    out = await processDue(out.state, new Date(T0 + 183_000), deps);
    expect(out.state.jobs[0].status).toBe('done');
  });

  it('a failed prompt dispatch is recorded as a failed run and retried next tick', async () => {
    let attempts = 0;
    const deps = {
      dispatchPrompt: async () => {
        attempts++;
        if (attempts === 1) throw new Error('endpoint down');
        return 'Recovered design.';
      },
      executeCommand: async (): Promise<CommandResult> => {
        throw new Error('no commands here');
      },
      log: () => {},
    };
    let out = await processDue(baseState(intervalJob()), new Date(T0), deps);
    expect(out.state.jobs[0].runs[0].status).toBe('failed');
    expect(out.state.jobs[0].currentStageIndex).toBe(0);
    out = await processDue(out.state, new Date(T0 + 61_000), deps);
    expect(out.state.jobs[0].runs[1].status).toBe('ok');
    expect(out.state.jobs[0].currentStageIndex).toBe(1);
  });

  it('a due trigger dispatches, and a cron command job is refused', async () => {
    const state = emptyRunnerState();
    state.agents = [
      { id: 'agent-atlas', name: 'Atlas', endpointUrl: 'http://127.0.0.1:9/chat', model: 'test', systemPrompt: '' },
    ];
    state.triggers = [
      {
        id: 'trg-1',
        channelId: 'conv-build-room',
        agentId: 'agent-atlas',
        prompt: 'Ping',
        everyMs: 60_000,
        lastRunAt: null,
        enabled: true,
      },
    ];
    state.cronJobs = [
      {
        id: 'cron-1',
        name: 'shell thing',
        schedule: '0 7 * * *',
        type: 'command',
        target: 'rm -rf /',
        enabled: true,
        lastRunAt: null,
        runs: [],
      },
    ];
    const calls: string[] = [];
    const out = await processDue(state, new Date(2026, 10, 25, 7, 0), {
      dispatchPrompt: async () => {
        calls.push('trigger');
        return 'pong';
      },
      executeCommand: async () => {
        throw new Error('cron commands must never reach the executor');
      },
      log: () => {},
    });
    expect(calls).toEqual(['trigger']);
    expect(out.state.triggers[0].lastRunAt).toBe(new Date(2026, 10, 25, 7, 0).getTime());
    expect(out.state.cronJobs[0].runs).toHaveLength(1);
    expect(out.state.cronJobs[0].runs[0].ok).toBe(false);
    expect(out.state.cronJobs[0].runs[0].detail).toMatch(/no per-job allowlist/);
  });
});

describe('runner state file', () => {
  it('round-trips through disk, dropping invalid entries with warnings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamz-runner-'));
    try {
      const path = join(dir, 'state.json');
      const state = emptyRunnerState();
      state.agents = [{ id: 'a', name: 'Atlas', endpointUrl: 'http://127.0.0.1:8001/chat' }];
      state.jobs = [repoCheckTemplate({ channelId: 'c', agentId: 'a', workdir: '/srv/mem20' })];
      saveRunnerState(path, state);
      const loaded = loadRunnerState(path);
      expect(loaded.warnings).toEqual([]);
      expect(loaded.state.agents).toHaveLength(1);
      expect(loaded.state.jobs[0].name).toBe('Nightly repo check');
      // A corrupt job is dropped, not repaired; the rest survives.
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      raw.jobs = [
        ...(raw.jobs as unknown[]),
        { id: 'bad', name: 'broken', stages: [{ stage: 'teleport' }] },
      ];
      writeFileSync(path, JSON.stringify(raw));
      const loaded2 = loadRunnerState(path);
      expect(loaded2.state.jobs).toHaveLength(1);
      expect(loaded2.warnings.length).toBeGreaterThan(0);
      // A missing file is an empty state; a malformed file is an error.
      expect(loadRunnerState(join(dir, 'missing.json')).state).toEqual(emptyRunnerState());
      writeFileSync(path, '{not json');
      expect(() => loadRunnerState(path)).toThrow(/cannot parse/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the shipped example state loads cleanly', () => {
    const loaded = loadRunnerState(new URL('../../scripts/runner-state.example.json', import.meta.url).pathname);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.state.jobs).toHaveLength(1);
    expect(loaded.state.jobs[0].name).toBe('Nightly repo check');
  });
});
