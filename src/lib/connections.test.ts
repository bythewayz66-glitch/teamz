import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '../types';
import { buildConnectionRows, parsePolicies, policyKey, type ConnectionRow } from './connections';
import { buildFleetGraph } from './graph';
import type { RunnerSnapshot } from './agentHome';
import { EMPTY_LEDGER } from './usageLedger';

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const mk = (id: string, tools?: string[]): Agent => ({ id, name: id, emoji: 'A', accent: '#fff', status: 'online', endpointUrl: '', model: 'm', systemPrompt: '', skills: [], createdAt: 0, enabledTools: tools });
const runner: RunnerSnapshot = {
  jobs: [{ id: 'j', name: 'J', schedule: { kind: 'interval' }, enabled: true, status: 'active', currentStageIndex: 0, stages: [{ stage: 'upgrade', agentId: 'pusher' }], runs: [], lastRunAt: null }],
  triggers: [], cronJobs: [], channelMessages: [], fetchedAt: NOW,
  agents: [{ id: 'pusher', name: 'pusher', provider: 'deepinfra', model: 'x' }, { id: 'worker', name: 'worker', provider: 'deepinfra' }],
};
const rowsFor = (agent: Agent, policies = {}) => {
  const graph = buildFleetGraph({ agents: [agent], messages: {}, runner, local: null, ledger: EMPTY_LEDGER, now: NOW });
  return Object.fromEntries(buildConnectionRows({ agent, runner, graph, policies }).map((r) => [r.id, r])) as Record<ConnectionRow['id'], ConnectionRow>;
};

describe('connection rows', () => {
  it('lists every surface for any agent, including the ones that do not exist', () => {
    const r = rowsFor(mk('worker'));
    expect(Object.keys(r).sort()).toEqual(['github', 'mcp', 'model', 'slack', 'toolchest', 'web']);
    expect(r.mcp.state).toBe('none');
    expect(r.mcp.detail).toMatch(/no MCP client/i);
  });

  it('declares web tools as needs-approval but says plainly that nothing enforces it', () => {
    const w = rowsFor(mk('worker')).web;
    expect(w.policy).toBe('needs-approval');
    expect(w.enforcement).toBe('advisory');
    expect(w.enforcementNote).toMatch(/does not ask/i);
    expect(w.editable).toBe(true);
  });

  it('honours a stored declared policy and ignores junk in storage', () => {
    const w = rowsFor(mk('worker'), { [policyKey('worker', 'web')]: 'block' }).web;
    expect(w.policy).toBe('block');
    expect(parsePolicies('{"a:web":"allow","b:web":"yes","c":5}')).toEqual({ 'a:web': 'allow' });
    expect(parsePolicies('not json')).toEqual({});
    expect(parsePolicies(null)).toEqual({});
  });

  it('GitHub is enforced only for the agent that owns a push stage', () => {
    const push = rowsFor(mk('pusher')).github;
    expect(push.state).toBe('available');
    expect(push.enforcement).toBe('enforced');
    expect(push.editable).toBe(false);
    const none = rowsFor(mk('worker')).github;
    expect(none.state).toBe('none');
    expect(none.policy).toBeNull();
  });

  it('a browser-only agent gets web tools from what is enabled, not from the runner', () => {
    const off = rowsFor(mk('local')).web;
    expect(off.state).toBe('none');
    const on = rowsFor(mk('local', ['web_search'])).web;
    expect(on.state).toBe('available');
    expect(on.enforcementNote).toMatch(/enforced/i);
    expect(rowsFor(mk('local')).toolchest.state).toBe('none');
  });

  it('Slack is reported as not visible from the browser, never as connected', () => {
    const s = rowsFor(mk('worker')).slack;
    expect(s.state).toBe('unknown');
    expect(s.stateLabel).toMatch(/not visible/i);
  });
});

describe('claims are checked against the endpoint source', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/agent-endpoint/agent.mjs'), 'utf-8');
  const openaiTools = src.slice(src.indexOf('export const OPENAI_TOOLS'));

  it('the web, repo and toolchest tools the rows describe exist in the endpoint tool list', () => {
    for (const t of ['web_search', 'fetch_url', 'wikipedia', 'weather', 'toolchest_search', 'toolchest_call']) {
      expect(openaiTools, t).toContain(`name: '${t}'`);
    }
  });

  it('direct Slack, commit and PR tools are in the endpoint block list', () => {
    const block = src.slice(src.indexOf('TOOLCHEST_BLOCKED_TOOLS = new Set'), src.indexOf('export function isDestructiveTool'));
    for (const t of ['comm_slack_message', 'vcs_git_commit', 'vcs_github_pr']) expect(block, t).toContain(`'${t}'`);
  });
});
