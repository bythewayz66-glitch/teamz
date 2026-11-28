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

// Toolchest fixture bridge: a tiny stand-in for /opt/teamz-agent/toolchest.py
// with the same CLI (search <query> [domain] / call <tool>, args JSON on
// stdin) and the same destructive refusal, over a canned 4-tool catalog.
// The real bridge is verified live on jnet1, not here.
const toolchestBridge = join(dir, 'toolchest.py');
writeFileSync(
  toolchestBridge,
  [
    '#!/usr/bin/env python3',
    'import json, sys',
    'CATALOG = [',
    '  {"name": "memory_status", "domain": "memory", "description": "Report memory engine status", "args": [], "required": []},',
    '  {"name": "memory_recall", "domain": "memory", "description": "Recall memories matching a query", "args": ["query", "k"], "required": ["query"]},',
    '  {"name": "memory_store", "domain": "memory", "description": "Store a grounded fact", "args": ["fact", "topic"], "required": ["fact"]},',
    '  {"name": "lattice_search", "domain": "lattice", "description": "Search the lattice", "args": ["query"], "required": ["query"]},',
    ']',
    'DESTRUCTIVE = ("delete", "remove", "destroy", "spend", "publish", "release", "sell", "charge", "refund")',
    'if __name__ == "__main__":',
    '    if sys.argv[1] == "search":',
    '        q = sys.argv[2].lower() if len(sys.argv) > 2 else ""',
    '        dom = sys.argv[3].lower() if len(sys.argv) > 3 else ""',
    '        hits = [t for t in CATALOG if (not dom or t["domain"] == dom) and (not q or q in (t["name"] + " " + t["description"]).lower())]',
    '        print(json.dumps({"tools": hits[:10], "count": len(hits), "total": len(CATALOG)}))',
    '    elif sys.argv[1] == "call":',
    '        name = sys.argv[2]',
    '        args = json.loads(sys.stdin.read() or "{}")',
    '        if any(w in name.lower() for w in DESTRUCTIVE):',
    '            print(f"toolchest: refused {name} — destructive actions are not available through the toolchest", file=sys.stderr)',
    '            sys.exit(2)',
    '        if name == "memory_status":',
    '            print(json.dumps({"tool": name, "result": "ledger events : 2\\ndeep entries : 2"}))',
    '        else:',
    '            print(f"toolchest: {name} failed: no such tool", file=sys.stderr)',
    '            sys.exit(1)',
  ].join('\n'),
  'utf-8',
);
process.env.TOOLCHEST_BRIDGE = toolchestBridge;
process.env.TOOLCHEST_PYTHON = 'python3';

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

describe('upstream error replies (Nov 27, 2026 — Pollinations out of credits)', () => {
  const CREDITS_ERROR =
    "The account behind this API key doesn't have enough credits. " +
    'Please [top up](<https://enter.pollinations.ai/top-up?ref=agent_low_balance_topup>) ' +
    'or [complete a quest](<https://enter.pollinations.ai/quests>).';

  it('detects the Pollinations credit-refusal text', () => {
    expect(endpoint.isUpstreamErrorReply(CREDITS_ERROR)).toBe(true);
    // Leading whitespace does not hide it.
    expect(endpoint.isUpstreamErrorReply('  ' + CREDITS_ERROR)).toBe(true);
    // The top-up link alone is enough.
    expect(endpoint.isUpstreamErrorReply('see https://enter.pollinations.ai/top-up for more')).toBe(true);
  });

  it('does not flag ordinary replies, including prose about credits', () => {
    expect(endpoint.isUpstreamErrorReply('hello there')).toBe(false);
    expect(endpoint.isUpstreamErrorReply('The budget has enough credits for this month.')).toBe(false);
    expect(endpoint.isUpstreamErrorReply('')).toBe(false);
    expect(endpoint.isUpstreamErrorReply(null)).toBe(false);
  });

  // Pollinations enforces a 50s gap between upstream calls in-process
  // (callWithSpacing), and the usage test above just used it — so this
  // test waits out the remainder of that window. The timeout is explicit.
  it('a 200 whose content is the credit refusal fails as a 429 with a rate-limit event — never as a reply', async () => {
    const payload = JSON.stringify({
      choices: [{ message: { content: CREDITS_ERROR } }],
    });
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: string, init?: unknown) => {
      if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init as RequestInit);
      return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const eventsPath = join(dir, 'rate-limit-events.jsonl');
    const eventsBefore = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf-8').trim().split('\n').filter(Boolean).length : 0;
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
          agent: { id: 'agent-credits-test', name: 'Credits Test', systemPrompt: 'You are Credits Test.' },
          messages: [{ role: 'user', content: 'Say hi.' }],
          channel: { id: 'conv-build-room' },
        }),
      });
      // 429, not a 200 carrying the error text as the agent's answer.
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toContain('402');
      expect(body.reply).toBeUndefined();
      // The runner's rescue can now see it and move the agent.
      const eventsAfter = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf-8').trim().split('\n').filter(Boolean) : [];
      expect(eventsAfter.length - eventsBefore).toBe(1);
      const event = JSON.parse(eventsAfter[eventsAfter.length - 1]);
      expect(event.agentId).toBe('agent-credits-test');
      expect(event.provider).toBe('pollinations');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllGlobals();
    }
  }, 70_000);
});

describe('native tool calls (Nov 27, 2026 — nemotron Triage could not repo_read)', () => {
  it('extractToolArgs keeps the raw JSON for object-arg tools', () => {
    const repoArgs = '{"file": "comics/the-z-corps/", "find": "README"}';
    expect(endpoint.extractToolArgs(repoArgs, 'repo_read')).toBe(repoArgs);
    expect(endpoint.extractToolArgs('{"jobId": "job-x", "file": "docs/a.md", "oldText": "a", "newText": "b"}', 'stage_patch')).toContain('"jobId": "job-x"');
    expect(endpoint.extractToolArgs('{"what": "unassigned"}', 'room_read')).toBe('{"what": "unassigned"}');
    expect(endpoint.extractToolArgs('{"url": "https://mem20.com/"}', 'fetch_url')).toBe('{"url": "https://mem20.com/"}');
    expect(endpoint.extractToolArgs('{"agentId": "agent-x", "provider": "grexlabs"}', 'reassign_agent')).toContain('agent-x');
  });

  it('extractToolArgs unwraps the declared args parameter for object-arg tools (Nov 28, 2026 — room_read "what" bug)', () => {
    // The native tool schema declares ONE parameter, `args` (a JSON
    // string), so the model calls room_read with the args wrapped:
    // {"args": "{\"what\":\"agents\",\"role\":\"backend\"}"}. Before the
    // fix this passed through verbatim, runRoomRead read `what` at the
    // top level, found nothing, and always returned the default
    // 'unassigned' TRIAGE output — the Orchestrator kept retrying with
    // different roles and got the same output every time.
    const wrapped = '{"args": "{\\"what\\":\\"agents\\",\\"role\\":\\"backend\\"}"}';
    expect(endpoint.extractToolArgs(wrapped, 'room_read')).toBe('{"what":"agents","role":"backend"}');
    // The same wrapping on another object-arg tool unwraps too.
    expect(
      endpoint.extractToolArgs('{"args": "{\\"file\\": \\"docs/a.md\\"}"}', 'repo_read'),
    ).toBe('{"file": "docs/a.md"}');
    // An `args` object (not a string) is stringified.
    expect(
      endpoint.extractToolArgs('{"args": {"what": "agents", "role": "backend"}}', 'room_read'),
    ).toBe('{"what":"agents","role":"backend"}');
    // Direct calls (no wrapping) are unchanged.
    expect(endpoint.extractToolArgs('{"what": "agents"}', 'room_read')).toBe('{"what": "agents"}');
    expect(endpoint.extractToolArgs('{"what": "room"}', 'room_read')).toBe('{"what": "room"}');
    // A non-JSON `args` value falls back to the raw string.
    expect(endpoint.extractToolArgs('{"args": "not json{"}', 'room_read')).toBe('{"args": "not json{"}');
    expect(endpoint.extractToolArgs('plain string', 'room_read')).toBe('plain string');
    // And the wrapped form flows through extractReplyText, the real
    // native-call path: the action's args are the inner JSON.
    const payload = {
      choices: [{
        message: {
          tool_calls: [{ function: { name: 'room_read', arguments: wrapped } }],
          content: '',
        },
      }],
    };
    expect(JSON.parse(endpoint.extractReplyText(payload))).toEqual({
      action: 'tool',
      tool: 'room_read',
      args: '{"what":"agents","role":"backend"}',
    });
  });

  it('extractToolArgs still pulls the one string out for single-string tools', () => {
    expect(endpoint.extractToolArgs('{"expression": "17 * 23"}', 'calculator')).toBe('17 * 23');
    expect(endpoint.extractToolArgs('{"query": "mem20"}', 'web_search')).toBe('mem20');
    expect(endpoint.extractToolArgs('{"term": "Paris"}', 'wikipedia')).toBe('Paris');
    expect(endpoint.extractToolArgs('plain string', 'calculator')).toBe('plain string');
    expect(endpoint.extractToolArgs('', 'repo_read')).toBe('');
  });

  it('extractReplyText converts a native repo_read call without mangling its args', () => {
    const payload = {
      choices: [{
        message: {
          tool_calls: [{ function: { name: 'repo_read', arguments: '{"file": "docs/series/cartoon/index.html"}' } }],
          content: '',
        },
      }],
    };
    const action = JSON.parse(endpoint.extractReplyText(payload));
    expect(action).toEqual({
      action: 'tool',
      tool: 'repo_read',
      args: '{"file": "docs/series/cartoon/index.html"}',
    });
  });

  it('parseAction stringifies object args instead of "[object Object]"', () => {
    const parsed = endpoint.parseAction('{"action": "tool", "tool": "repo_read", "args": {"file": "docs/x.md"}}');
    expect(parsed).toEqual({
      action: 'tool',
      tool: 'repo_read',
      args: '{"file":"docs/x.md"}',
    });
    // String args are untouched.
    expect(endpoint.parseAction('{"action": "tool", "tool": "calculator", "args": "17 * 23"}').args).toBe('17 * 23');
  });

  // The generic provider enforces a 5s gap between upstream calls, so
  // the two-call loop needs a few seconds more than the default 5s.
  it('a /chat dispatch can repo_read through a native tool call (the run-5 Triage path)', async () => {
    // Route the dispatch through a throwaway generic provider so the
    // test does not wait out Pollinations' 50s per-provider spacing.
    // extractReplyText is provider-agnostic, so this covers the same
    // code the live nemotron Triage call hit.
    const registryPath = process.env.PROVIDER_REGISTRY_PATH as string;
    writeFileSync(
      registryPath,
      JSON.stringify({
        providers: [{ id: 'test-provider', name: 'Test', model: 'test-model', baseUrl: 'https://example.com/v1/chat/completions', keyEnv: null }],
        validationLog: [],
      }),
      'utf-8',
    );
    const toolCallPayload = JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{ function: { name: 'repo_read', arguments: '{"file": "docs/series/cartoon/index.html"}' } }],
          content: '',
        },
      }],
    });
    const finalPayload = JSON.stringify({
      choices: [{ message: { content: '{"action":"final","final":"The cartoon page says no episode has been produced yet."}' } }],
    });
    const realFetch = globalThis.fetch;
    let upstreamCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: unknown) => {
      if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init as RequestInit);
      upstreamCalls += 1;
      const payload = upstreamCalls === 1 ? toolCallPayload : finalPayload;
      return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
    });
    vi.stubGlobal('fetch', fetchMock);
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
          agent: { id: 'agent-native-test', name: 'Native Test', provider: 'test-provider', model: 'test-model', systemPrompt: 'You are Native Test.' },
          messages: [{ role: 'user', content: 'Read docs/series/cartoon/index.html with repo_read and report what it says.' }],
          channel: { id: 'conv-build-room' },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reply).toContain('no episode has been produced yet');
      expect(upstreamCalls).toBe(2);
      // The repo_read actually ran and succeeded (not "needs a JSON object").
      const agentLog = readFileSync(join(dir, 'agent.log'), 'utf-8');
      expect(agentLog).toContain('tool=repo_read');
      expect(agentLog).toMatch(/tool=repo_read[^\n]*ok=true/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllGlobals();
      rmSync(registryPath, { force: true });
    }
  }, 15_000);
});

describe('free-API prompt cap (Jesse, Nov 28, 2026 — Pollinations 413, fleet-wide)', () => {
  const { truncateForFreeTier, FREE_PROMPT_CHAR_LIMIT, OPENAI_TOOLS } = endpoint;
  const toolsChars = JSON.stringify(OPENAI_TOOLS).length;
  const totalChars = (msgs: unknown[]) =>
    JSON.stringify(msgs).length + toolsChars;

  it('caps a long room_read-heavy transcript under 10k chars total', () => {
    const roomDump = 'x'.repeat(9000);
    const msgs = [
      { role: 'system', content: 'You are Triage Agent. Triage the room.' },
      { role: 'user', content: 'Triage the Build Room.' },
      { role: 'assistant', content: '{"tool":"room_read","args":{"what":"unassigned"}}' },
      { role: 'tool', content: roomDump },
      { role: 'assistant', content: '{"tool":"room_read","args":{"what":"agents","role":"backend"}}' },
      { role: 'tool', content: 'y'.repeat(6000) },
      { role: 'user', content: 'Assign the denied work now.' },
    ];
    expect(totalChars(msgs)).toBeGreaterThan(FREE_PROMPT_CHAR_LIMIT);
    const fitted = truncateForFreeTier(msgs);
    expect(totalChars(fitted)).toBeLessThanOrEqual(FREE_PROMPT_CHAR_LIMIT);
    // System prompt and the latest message survive.
    expect(fitted[0]).toEqual(msgs[0]);
    expect(fitted[fitted.length - 1]).toEqual(msgs[msgs.length - 1]);
    // The huge room dump was cut, not passed through whole.
    expect(JSON.stringify(fitted)).not.toContain(roomDump);
  });

  it('leaves a short prompt untouched', () => {
    const msgs = [
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: 'Hi.' },
    ];
    expect(truncateForFreeTier(msgs)).toBe(msgs);
  });
});

describe('tool declarations (Jesse, Nov 28, 2026 — the Orchestrator was told to use room_read, but room_read was never declared to the model)', () => {
  it('every implemented tool is declared in OPENAI_TOOLS, so the model can actually call it', () => {
    const { TOOL_NAMES, OPENAI_TOOLS } = endpoint;
    const declared = new Set(OPENAI_TOOLS.map((t: { function: { name: string } }) => t.function.name));
    for (const name of TOOL_NAMES as string[]) {
      expect(declared.has(name)).toBe(true);
    }
    // And nothing declared is unimplemented.
    for (const name of declared) {
      expect((TOOL_NAMES as string[])).toContain(name);
    }
    expect(declared.has('room_read')).toBe(true);
    expect(declared.has('repo_read')).toBe(true);
    expect(declared.has('stage_patch')).toBe(true);
    expect(declared.has('fetch_url')).toBe(true);
    expect(declared.has('toolchest_search')).toBe(true);
    expect(declared.has('toolchest_call')).toBe(true);
  });
});

describe('toolchest gateway (Jesse, Nov 28, 2026 — agents had 3 useless tools each; mem20 has a 527-tool catalog)', () => {
  it('toolchest_search finds a known tool by keyword', async () => {
    const out = await endpoint.runToolchestSearch(JSON.stringify({ query: 'memory' }));
    expect(out).toContain('memory_status');
    expect(out).toContain('memory_recall');
    expect(out).toContain('3 of 4 mem20 tools');
  });

  it('toolchest_search filters by domain', async () => {
    const out = await endpoint.runToolchestSearch(JSON.stringify({ query: 'search', domain: 'lattice' }));
    expect(out).toContain('lattice_search');
    expect(out).not.toContain('memory_status');
  });

  it('toolchest_search says plainly when nothing matches', async () => {
    const out = await endpoint.runToolchestSearch(JSON.stringify({ query: 'zzzznothing' }));
    expect(out).toContain('No mem20 tools match');
  });

  it('toolchest_search needs a query or a domain', async () => {
    await expect(endpoint.runToolchestSearch(JSON.stringify({}))).rejects.toThrow('needs a JSON object');
  });

  it('toolchest_call returns a real result for a safe tool', async () => {
    const out = await endpoint.runToolchestCall(JSON.stringify({ tool: 'memory_status', arguments: {} }));
    expect(out).toContain('memory_status');
    expect(out).toContain('ledger events : 2');
  });

  it('toolchest_call refuses a destructive tool name', async () => {
    await expect(endpoint.runToolchestCall(JSON.stringify({ tool: 'db_delete', arguments: {} }))).rejects.toThrow('refused');
    await expect(endpoint.runToolchestCall(JSON.stringify({ tool: 'stream_publish', arguments: {} }))).rejects.toThrow('refused');
    await expect(endpoint.runToolchestCall(JSON.stringify({ tool: 'cloudstorage_delete', arguments: {} }))).rejects.toThrow('refused');
  });

  it('toolchest_call refuses a bad tool name', async () => {
    await expect(endpoint.runToolchestCall(JSON.stringify({ tool: 'memory_status; rm -rf /', arguments: {} }))).rejects.toThrow('refused');
  });

  it('toolchest_call reports a real failure for an unknown tool', async () => {
    await expect(endpoint.runToolchestCall(JSON.stringify({ tool: 'no_such_tool_xyz', arguments: {} }))).rejects.toThrow('failed');
  });

  it('isDestructiveTool: destructive words refused, read-only audits allowed', () => {
    const { isDestructiveTool } = endpoint;
    expect(isDestructiveTool('db_delete')).toBe(true);
    expect(isDestructiveTool('stream_publish')).toBe(true);
    expect(isDestructiveTool('cloudstorage_delete')).toBe(true);
    expect(isDestructiveTool('mkt_social_post')).toBe(true);
    expect(isDestructiveTool('comm_send_email')).toBe(true);
    expect(isDestructiveTool('vcs_git_commit')).toBe(true);
    expect(isDestructiveTool('vcs_asset_release_audit')).toBe(false);
    expect(isDestructiveTool('memory_status')).toBe(false);
    expect(isDestructiveTool('memory_recall')).toBe(false);
  });

  it('both gateway tools are reachable through the tool registry', async () => {
    const search = await endpoint.executeTool('toolchest_search', JSON.stringify({ query: 'memory' }));
    expect(search.ok).toBe(true);
    expect(search.output).toContain('memory_status');
    const call = await endpoint.executeTool('toolchest_call', JSON.stringify({ tool: 'memory_status', arguments: {} }));
    expect(call.ok).toBe(true);
    expect(call.output).toContain('ledger events : 2');
    const refused = await endpoint.executeTool('toolchest_call', JSON.stringify({ tool: 'db_delete', arguments: {} }));
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain('refused');
  });

  it('both gateway tools appear in the tool inventory the model sees', () => {
    const inventory = endpoint.inventoryText();
    expect(inventory).toContain('toolchest_search');
    expect(inventory).toContain('toolchest_call');
  });
});
