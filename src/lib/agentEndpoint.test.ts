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

  function mockFetchFor(pages: Record<string, string>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        for (const [key, body] of Object.entries(pages)) {
          if (url.includes(key)) {
            return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
          }
        }
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      }),
    );
  }

  it('returns Bing results first (Bing is the primary, Jesse Nov 26, 2026)', async () => {
    // Both sources have results; Bing must win because it is tried first.
    mockFetchFor({ 'www.bing.com': bingHtml, 'lite.duckduckgo.com': ddgLiteHtml });
    const res = await endpoint.executeTool('web_search', 'mem20 0.0.0.0 HTTP transport');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Bing result title');
    expect(res.output).toContain('bing.com/ck/a');
    expect(res.output).not.toContain('Mem20 docs');
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
