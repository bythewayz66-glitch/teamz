import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Endpoint repo tools (repo_read / stage_patch) against a throwaway
 * mem20 checkout and runner state — never the live paths. Env vars are
 * set before the dynamic import because agent.mjs reads them at load.
 */
const dir = mkdtempSync(join(tmpdir(), 'teamz-agent-endpoint-'));
const mem20 = join(dir, 'mem20');
const patches = join(dir, 'patches');
const statePath = join(dir, 'state.json');
const cartoon = join(mem20, 'docs', 'series', 'cartoon', 'index.html');

mkdirSync(join(mem20, 'docs', 'series', 'cartoon'), { recursive: true });
mkdirSync(join(mem20, '.github', 'workflows'), { recursive: true });
mkdirSync(join(mem20, 'secrets'), { recursive: true });
writeFileSync(
  cartoon,
  '<p>the season is written in the series bible and no episode has been produced yet.</p>\n<p>Other line. Other line again.</p>\n',
  'utf-8',
);
writeFileSync(join(mem20, 'requirements.txt'), 'starlette<0.47\n', 'utf-8');
writeFileSync(join(mem20, '.github', 'workflows', 'pr-gate.yml'), 'name: gate\n', 'utf-8');
writeFileSync(join(mem20, 'secrets', 'x.txt'), 'top secret\n', 'utf-8');

function writeState(currentStageIndex: number, jobId = 'job-push-verify'): void {
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      agents: [],
      jobs: [
        {
          id: jobId,
          name: 'Verify',
          channelId: 'conv-build-room',
          managerAgentId: null,
          stages: [
            { stage: 'design', agentId: 'agent-atlas', prompt: 'p', expectedOutput: 'e', contextStages: [] },
            { stage: 'implement', agentId: 'agent-atlas', prompt: 'p', expectedOutput: 'e', contextStages: ['design'] },
            { stage: 'upgrade', agentId: 'agent-atlas', prompt: 'p', expectedOutput: 'e', contextStages: [] },
          ],
          currentStageIndex,
          status: 'active',
          schedule: { kind: 'interval', everyMs: 60000 },
          enabled: true,
          lastRunAt: null,
          runs: [],
          createdAt: 1,
          updatedAt: 1,
          workdir: '/opt/mem20',
        },
      ],
      triggers: [],
      approvals: [],
      cronJobs: [],
      channelMessages: [],
      rateLimitRescues: [],
      rateLimitBackoff: {},
    }),
    'utf-8',
  );
}
writeState(1);

process.env.MEM20_ROOT = mem20;
process.env.PATCH_DIR = patches;
process.env.RUNNER_STATE_PATH = statePath;
process.env.LOG_PATH = join(dir, 'agent.log');
process.env.PROVIDER_REGISTRY_PATH = join(dir, 'providers.json');
process.env.REASSIGNMENTS_PATH = join(dir, 'reassignments.json');
process.env.RATE_LIMIT_EVENTS_PATH = join(dir, 'rate-limit-events.jsonl');
process.env.USAGE_FILE_PATH = join(dir, 'usage-daily.json');

// agent.mjs ships no types; the dynamic import is untyped on purpose.
// @ts-ignore — no declaration file for the endpoint module
const endpoint = await import('../../scripts/agent-endpoint/agent.mjs');

afterAll(() => {
  try {
    endpoint.server.close();
  } catch {
    // Already closed — the import is what matters, not the handle.
  }
  rmSync(dir, { recursive: true, force: true });
});

const FILE = 'docs/series/cartoon/index.html';

describe('repo_read', () => {
  it('reads the head of a file', () => {
    const out = endpoint.runRepoRead(JSON.stringify({ file: FILE }));
    expect(out).toContain('no episode has been produced yet');
    expect(out).toContain('chars total');
  });

  it('centres the excerpt on a find string', () => {
    const out = endpoint.runRepoRead(
      JSON.stringify({ file: FILE, find: 'no episode has been produced yet' }),
    );
    expect(out).toContain('no episode has been produced yet');
    expect(out.length).toBeLessThanOrEqual(1100);
  });

  it('says plainly when the find string is absent', () => {
    const out = endpoint.runRepoRead(JSON.stringify({ file: FILE, find: 'zzz no such sentence' }));
    expect(out).toContain('no match');
  });

  it('refuses escapes, absolute paths, and secrets', () => {
    expect(() => endpoint.runRepoRead(JSON.stringify({ file: '../etc/passwd' }))).toThrow(/bad path/);
    expect(() => endpoint.runRepoRead(JSON.stringify({ file: '/etc/passwd' }))).toThrow(/bad path/);
    expect(() => endpoint.runRepoRead(JSON.stringify({ file: 'secrets/x.txt' }))).toThrow(/not readable/);
  });

  it('is reachable through the tool registry', async () => {
    const res = await endpoint.executeTool('repo_read', JSON.stringify({ file: FILE }));
    expect(res.ok).toBe(true);
    expect(res.output).toContain('no episode has been produced yet');
  });
});

describe('stage_patch', () => {
  const valid = () =>
    JSON.stringify({
      jobId: 'job-push-verify',
      file: FILE,
      oldText: 'no episode has been produced yet',
      newText: 'Episode 1 is in production',
      message: 'docs: fix the stale production status line',
    });

  it('stages a valid patch as JSON (never touches the repo)', () => {
    const out = endpoint.runStagePatch(valid());
    expect(out).toContain('patch staged for job job-push-verify');
    const patchPath = join(patches, 'job-push-verify.json');
    expect(existsSync(patchPath)).toBe(true);
    const patch = JSON.parse(readFileSync(patchPath, 'utf-8'));
    expect(patch.file).toBe(FILE);
    expect(patch.newText).toBe('Episode 1 is in production');
    expect(patch.message).toBe('docs: fix the stale production status line');
    // The repo file itself is untouched by staging.
    expect(readFileSync(cartoon, 'utf-8')).toContain('no episode has been produced yet');
  });

  it('refuses blocked paths: workflows, requirements.txt, secrets', () => {
    for (const file of ['.github/workflows/pr-gate.yml', 'requirements.txt', 'secrets/x.txt']) {
      expect(() =>
        endpoint.runStagePatch(
          JSON.stringify({
            jobId: 'job-push-verify',
            file,
            oldText: 'x',
            newText: 'y',
            message: 'm',
          }),
        ),
      ).toThrow(/blocked/);
    }
  });

  it('refuses oldText occurring zero or two times', () => {
    expect(() =>
      endpoint.runStagePatch(
        JSON.stringify({
          jobId: 'job-push-verify',
          file: FILE,
          oldText: 'zzz absent',
          newText: 'y',
          message: 'm',
        }),
      ),
    ).toThrow(/0 times/);
    expect(() =>
      endpoint.runStagePatch(
        JSON.stringify({
          jobId: 'job-push-verify',
          file: FILE,
          oldText: 'Other line',
          newText: 'y',
          message: 'm',
        }),
      ),
    ).toThrow(/2 times/);
  });

  it('refuses an unknown job and a job not on its implement stage', () => {
    expect(() =>
      endpoint.runStagePatch(
        JSON.stringify({
          jobId: 'job-nope',
          file: FILE,
          oldText: 'no episode has been produced yet',
          newText: 'y',
          message: 'm',
        }),
      ),
    ).toThrow(/unknown job/);
    writeState(0);
    try {
      expect(() => endpoint.runStagePatch(valid())).toThrow(/not on its implement stage/);
    } finally {
      writeState(1);
    }
  });

  it('is reachable through the tool registry', async () => {
    const res = await endpoint.executeTool('stage_patch', valid());
    expect(res.ok).toBe(true);
    expect(res.output).toContain('patch staged');
  });

  it('appears in the tool inventory the model sees', () => {
    expect(endpoint.inventoryText()).toContain('repo_read');
    expect(endpoint.inventoryText()).toContain('stage_patch');
  });
});

describe('dispatch deadline', () => {
  it('gives the tool loop 320s (Jesse, Nov 26, 2026 — was 57s)', () => {
    expect(endpoint.DISPATCH_DEADLINE_MS).toBe(320_000);
  });
});

describe('web_search', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LINKUP_API_KEY;
  });

  const ddgLiteHtml =
    `<html><body>` +
    `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fmem20&amp;rut=abc" class='result-link'>Mem20 docs</a>` +
    `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fbythewayz66-glitch%2Fmem20&amp;rut=def" class='result-link'>mem20 repo</a>` +
    `</body></html>`;
  const bingHtml =
    `<html><body><ol id="b_results">` +
    `<li class="b_algo" data-id iid=SERP.1><h2><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=abc">Bing result title</a></h2></li>` +
    `</ol></body></html>`;
  const emptyHtml = '<html><body><p>nothing here</p></body></html>';
  const linkupJson = JSON.stringify({
    results: [
      { name: 'Linkup result title', url: 'https://example.com/linkup', content: 'Linkup sourced snippet about mem20.', type: 'text', favicon: 'https://example.com/favicon.ico' },
      { name: 'Second linkup result', url: 'https://github.com/bythewayz66-glitch/mem20', content: 'More context.', type: 'text', favicon: '' },
      { name: 'An image', url: 'https://example.com/img.png', type: 'image' },
    ],
  });
  const linkupEmptyJson = JSON.stringify({ results: [] });

  // Values are a plain body (HTTP 200) or { body, ok, status }.
  function mockFetchFor(pages: Record<string, string | { body: string; ok?: boolean; status?: number }>) {
    const fetchMock = vi.fn(async (url: string) => {
      for (const [key, value] of Object.entries(pages)) {
        if (url.includes(key)) {
          const body = typeof value === 'string' ? value : value.body;
          const ok = typeof value === 'string' ? true : (value.ok ?? true);
          const status = typeof value === 'string' ? 200 : (value.status ?? 200);
          return { ok, status, text: async () => body, json: async () => JSON.parse(body) };
        }
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('returns Linkup results first (Linkup is the primary, Jesse Nov 26, 2026)', async () => {
    // Both Linkup and Bing have results; Linkup must win because it is tried first.
    process.env.LINKUP_API_KEY = 'test-key-not-real';
    const fetchMock = mockFetchFor({ 'api.linkup.so': linkupJson, 'www.bing.com': bingHtml, 'lite.duckduckgo.com': ddgLiteHtml });
    const res = await endpoint.executeTool('web_search', 'mem20 0.0.0.0 HTTP transport');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Linkup result title');
    expect(res.output).toContain('https://example.com/linkup');
    expect(res.output).toContain('Linkup sourced snippet about mem20.');
    expect(res.output).not.toContain('Bing result title');
    expect(res.output).not.toContain('Mem20 docs');
    expect(res.output).not.toContain('No web results found');
    // The Linkup call is a POST with the documented body shape.
    const calls = fetchMock.mock.calls as unknown as Array<[string, { method?: string; headers?: Record<string, string>; body?: string }]>;
    const linkupCall = calls.find(([url]) => url.includes('api.linkup.so'));
    expect(linkupCall).toBeDefined();
    const [, options] = linkupCall!;
    expect(options?.method).toBe('POST');
    const body = JSON.parse(String(options?.body));
    expect(body.q).toBe('mem20 0.0.0.0 HTTP transport');
    expect(body.depth).toBe('fast');
    expect(body.outputType).toBe('searchResults');
    expect(body.maxResults).toBe(5);
    expect(options?.headers?.Authorization).toBe('Bearer test-key-not-real');
  });

  it('falls back to Bing when no Linkup key is set', async () => {
    // No LINKUP_API_KEY in the environment: Linkup is skipped silently.
    delete process.env.LINKUP_API_KEY;
    mockFetchFor({ 'www.bing.com': bingHtml, 'lite.duckduckgo.com': ddgLiteHtml });
    const res = await endpoint.executeTool('web_search', 'mem20 0.0.0.0 HTTP transport');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Bing result title');
    expect(res.output).toContain('bing.com/ck/a');
    expect(res.output).not.toContain('Mem20 docs');
    expect(res.output).not.toContain('No web results found');
  });

  it('falls through to Bing when Linkup returns nothing', async () => {
    process.env.LINKUP_API_KEY = 'test-key-not-real';
    mockFetchFor({ 'api.linkup.so': linkupEmptyJson, 'www.bing.com': bingHtml });
    const res = await endpoint.executeTool('web_search', 'mem20 0.0.0.0 HTTP transport');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Bing result title');
    expect(res.output).not.toContain('No web results found');
  });

  it('falls through to Bing when Linkup errors (e.g. out of credits, 429)', async () => {
    process.env.LINKUP_API_KEY = 'test-key-not-real';
    mockFetchFor({ 'api.linkup.so': { body: '{}', ok: false, status: 429 }, 'www.bing.com': bingHtml });
    const res = await endpoint.executeTool('web_search', 'mem20 0.0.0.0 HTTP transport');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Bing result title');
    expect(res.output).not.toContain('No web results found');
  });

  it('falls through to DuckDuckGo Lite when Bing returns nothing', async () => {
    mockFetchFor({
      'www.bing.com': emptyHtml,
      'lite.duckduckgo.com': ddgLiteHtml,
    });
    const res = await endpoint.executeTool('web_search', 'mem20 0.0.0.0 HTTP transport');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Mem20 docs');
    expect(res.output).toContain('https://example.com/mem20');
    expect(res.output).toContain('mem20 repo');
    expect(res.output).not.toContain('No web results found');
  });

  it('says plainly when every source is empty', async () => {
    mockFetchFor({
      'lite.duckduckgo.com': emptyHtml,
      'html.duckduckgo.com': emptyHtml,
      'www.bing.com': emptyHtml,
      'api.duckduckgo.com': '{"Abstract":"","RelatedTopics":[]}',
    });
    const res = await endpoint.executeTool('web_search', 'mem20 0.0.0.0 HTTP transport');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('No web results found');
  });
});

describe('room_read', () => {
  // The endpoint reads RUNNER_STATE_PATH fresh on every call, so these
  // tests overwrite the throwaway state file with a room of their own.
  function writeRoomState(): void {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        agents: [
          { id: 'agent-backend-architect', name: 'Backend Architect', endpointUrl: 'http://127.0.0.1:8897/chat', model: 'kilo-auto/free', provider: 'kilo' },
          { id: 'agent-qa-tester', name: 'QA Tester', endpointUrl: 'http://127.0.0.1:8897/chat', model: 'qwen/qwen3.8-27b', provider: 'groq' },
          { id: 'agent-orchestrator', name: 'Orchestrator', endpointUrl: 'http://127.0.0.1:8897/chat', model: 'kilo-auto/free', provider: 'kilo' },
        ],
        jobs: [],
        triggers: [],
        approvals: [],
        cronJobs: [],
        channelMessages: [
          { id: 'msg-1', channelId: 'conv-build-room', agentId: 'agent-triage', agentName: 'Triage Agent', kind: 'triage', text: 'Triage for denied build of "Verify" (Reviewer: too risky): REASSIGN: @agent-backend-architect — fix the auth check and resubmit.', ts: 1000 },
          { id: 'msg-2', channelId: 'conv-build-room', agentId: 'agent-orchestrator', agentName: 'Orchestrator', kind: 'gate', text: 'Orchestrator assignment for @QA Tester did NOT reach the room: denied by Reviewer. The item was not dropped.', ts: 2000 },
          { id: 'msg-3', channelId: 'conv-build-room', agentId: 'agent-qa-tester', agentName: 'QA Tester', kind: 'mention', text: 'Test plan for the next mem20 change is done: 12 cases, all passing.', ts: 3000 },
        ],
        rateLimitRescues: [],
        rateLimitBackoff: {},
      }),
      'utf-8',
    );
  }

  it('unassigned (default) surfaces triage + gate items and recent messages', async () => {
    writeRoomState();
    const res = await endpoint.executeTool('room_read', JSON.stringify({ what: 'unassigned' }));
    expect(res.ok).toBe(true);
    expect(res.output).toContain('TRIAGE (needs reassigning)');
    expect(res.output).toContain('@agent-backend-architect');
    expect(res.output).toContain('GATE (did not reach the room)');
    expect(res.output).toContain('QA Tester');
    // Compact: the Orchestrator sees the whole digest in one observation.
    expect(res.output.length).toBeLessThanOrEqual(1100);
  });

  it('unassigned with no args is the same default', async () => {
    writeRoomState();
    const res = await endpoint.executeTool('room_read', '{}');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('TRIAGE (needs reassigning)');
  });

  it('room returns the recent Build Room messages', async () => {
    writeRoomState();
    const res = await endpoint.executeTool('room_read', JSON.stringify({ what: 'room' }));
    expect(res.ok).toBe(true);
    expect(res.output).toContain('[triage] Triage Agent:');
    expect(res.output).toContain('[mention] QA Tester:');
    expect(res.output).toContain('Test plan for the next mem20 change');
  });

  it('agents with a role lists matching agents with their @handles', async () => {
    writeRoomState();
    const res = await endpoint.executeTool('room_read', JSON.stringify({ what: 'agents', role: 'backend' }));
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Backend Architect (@agent-backend-architect) [kilo]');
    expect(res.output).not.toContain('QA Tester');
  });

  it('agents without a role gives a provider breakdown and a hint', async () => {
    writeRoomState();
    const res = await endpoint.executeTool('room_read', JSON.stringify({ what: 'agents' }));
    expect(res.ok).toBe(true);
    expect(res.output).toContain('3 agents');
    expect(res.output).toContain('kilo 2');
    expect(res.output).toContain('Pass a role keyword');
  });

  it('agents with no match says so plainly', async () => {
    writeRoomState();
    const res = await endpoint.executeTool('room_read', JSON.stringify({ what: 'agents', role: 'zookeeper' }));
    expect(res.ok).toBe(true);
    expect(res.output).toContain('no agents match role');
  });

  it('an empty room says there is nothing to assign', async () => {
    writeFileSync(
      statePath,
      JSON.stringify({ version: 1, agents: [], jobs: [], triggers: [], approvals: [], cronJobs: [], channelMessages: [], rateLimitRescues: [], rateLimitBackoff: {} }),
      'utf-8',
    );
    const res = await endpoint.executeTool('room_read', JSON.stringify({ what: 'unassigned' }));
    expect(res.ok).toBe(true);
    expect(res.output).toContain('No unassigned work');
  });

  it('appears in the tool inventory the model sees', () => {
    expect(endpoint.inventoryText()).toContain('room_read');
  });
});

describe('usage tracking (Jesse, Nov 26, 2026 — exact daily totals, not estimates)', () => {
  const usagePath = join(dir, 'usage-daily.json');

  it('extractUsage reads prompt/completion/total tokens', () => {
    expect(
      endpoint.extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
    ).toEqual({ prompt: 100, completion: 20, total: 120 });
  });

  it('extractUsage falls back to prompt + completion when total is missing', () => {
    expect(endpoint.extractUsage({ usage: { prompt_tokens: 50, completion_tokens: 10 } })).toEqual({
      prompt: 50,
      completion: 10,
      total: 60,
    });
  });

  it('extractUsage returns zeros for missing or malformed usage, never throws', () => {
    expect(endpoint.extractUsage({})).toEqual({ prompt: 0, completion: 0, total: 0 });
    expect(endpoint.extractUsage(null)).toEqual({ prompt: 0, completion: 0, total: 0 });
    expect(endpoint.extractUsage({ usage: 'junk' })).toEqual({ prompt: 0, completion: 0, total: 0 });
    expect(
      endpoint.extractUsage({ usage: { prompt_tokens: '100', completion_tokens: -5, total_tokens: Number.NaN } }),
    ).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it('recordUsage accumulates totals overall, by provider, and by agent', () => {
    const before = endpoint.getUsageDay();
    endpoint.recordUsage({
      provider: 'pollinations',
      agentId: 'agent-atlas',
      usage: { prompt: 100, completion: 20, total: 120 },
    });
    endpoint.recordUsage({
      provider: 'groq',
      agentId: 'agent-atlas',
      usage: { prompt: 50, completion: 10, total: 60 },
    });
    const reloaded = JSON.parse(readFileSync(usagePath, 'utf-8'));
    expect(reloaded.calls - before.calls).toBe(2);
    expect(reloaded.totalTokens - before.totalTokens).toBe(180);
    expect(reloaded.promptTokens - before.promptTokens).toBe(150);
    expect((reloaded.byProvider.groq?.calls ?? 0) - (before.byProvider.groq?.calls ?? 0)).toBe(1);
    expect((reloaded.byAgent['agent-atlas']?.calls ?? 0) - (before.byAgent['agent-atlas']?.calls ?? 0)).toBe(2);
  });

  it('recordUsage starts a fresh day when the file is from yesterday', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    writeFileSync(
      usagePath,
      JSON.stringify({
        date: yesterday,
        calls: 99,
        promptTokens: 9999,
        completionTokens: 999,
        totalTokens: 10998,
        byProvider: {},
        byAgent: {},
      }),
      'utf-8',
    );
    const day = endpoint.recordUsage({
      provider: 'kilo',
      agentId: 'agent-scout',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    expect(day.date).toBe(new Date().toISOString().slice(0, 10));
    expect(day.calls).toBe(1);
    expect(day.totalTokens).toBe(15);
  });

  it('a /chat dispatch records its usage and GET /usage reports it', async () => {
    const payload = JSON.stringify({
      choices: [{ message: { content: '{"action":"final","final":"hello there"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
    // Mock only the upstream provider call; localhost calls to the
    // server under test pass through to the real fetch.
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: string, init?: unknown) => {
      if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init as RequestInit);
      return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const before = endpoint.getUsageDay();
    const { server } = endpoint;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: { id: 'agent-usage-test', name: 'Usage Test', systemPrompt: 'You are Usage Test.' },
          messages: [{ role: 'user', content: 'Say hi.' }],
          channel: { id: 'conv-build-room' },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reply).toBe('hello there');
      const after = endpoint.getUsageDay();
      expect(after.calls - before.calls).toBe(1);
      expect(after.totalTokens - before.totalTokens).toBe(120);
      expect(after.promptTokens - before.promptTokens).toBe(100);
      expect(after.completionTokens - before.completionTokens).toBe(20);
      expect((after.byProvider.pollinations?.totalTokens ?? 0) - (before.byProvider.pollinations?.totalTokens ?? 0)).toBe(120);
      expect(after.byAgent['agent-usage-test'].totalTokens).toBe(120);
      const usageRes = await fetch(`http://127.0.0.1:${port}/usage`);
      expect(usageRes.status).toBe(200);
      const usageBody = await usageRes.json();
      expect(usageBody.totalTokens).toBe(after.totalTokens);
      expect(usageBody.calls).toBe(after.calls);
      expect(usageBody.date).toBe(new Date().toISOString().slice(0, 10));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllGlobals();
    }
  });
});
