import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Phase 0: reassign_agent refuses a provider that just reported out of
 * credits. Throwaway paths only; env is set before the dynamic import
 * because agent.mjs reads it at load.
 */
const dir = mkdtempSync(join(tmpdir(), 'teamz-credit-guard-'));
const eventsPath = join(dir, 'rate-limit-events.jsonl');
const noop = (...names: string[]) => names.forEach((n) => (process.env[n] = join(dir, n.toLowerCase())));
noop('LOG_PATH', 'PROVIDER_REGISTRY_PATH', 'REASSIGNMENTS_PATH', 'USAGE_FILE_PATH');
process.env.RATE_LIMIT_EVENTS_PATH = eventsPath;
process.env.RUNNER_STATE_PATH = join(dir, 'state.json');
writeFileSync(
  process.env.RUNNER_STATE_PATH,
  JSON.stringify({ version: 1, agents: [{ id: 'agent-x', name: 'X', endpointUrl: 'http://127.0.0.1:9/chat', model: 'm', systemPrompt: '', provider: 'ovh' }], jobs: [], triggers: [], approvals: [], cronJobs: [], channelMessages: [], rateLimitRescues: [], rateLimitBackoff: {} }),
  'utf-8',
);

// @ts-ignore — no declaration file for the endpoint module
const endpoint = await import('../../scripts/agent-endpoint/agent.mjs');

const event = (provider: string, ts: number, error: string) =>
  JSON.stringify({ id: `ev-${ts}`, ts, agentId: 'agent-x', agentName: 'X', channelId: 'c', prompt: 'p', provider, error }) + '\n';

afterEach(() => writeFileSync(eventsPath, '', 'utf-8'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('reassign_agent refuses a provider that just reported out of credits', () => {
  it('a recent 402 for the provider blocks the reassignment, and the agent is not moved', async () => {
    writeFileSync(eventsPath, event('pollinations', Date.now() - 60_000, 'Pollinations 402: out of credits'), 'utf-8');
    expect(endpoint.providerOutOfCredits('pollinations')).toBe(true);
    const out = await endpoint.executeTool('reassign_agent', JSON.stringify({ agentId: 'agent-x', provider: 'pollinations', reason: 't' }));
    expect(JSON.stringify(out)).toMatch(/out of credits/);
  });

  it('an old event, another provider, or a plain 429 does not block it', () => {
    writeFileSync(
      eventsPath,
      event('pollinations', Date.now() - 7 * 3_600_000, 'Pollinations 402: out of credits') + event('ovh', Date.now() - 1000, 'HTTP 429 too many requests'),
      'utf-8',
    );
    expect(endpoint.providerOutOfCredits('pollinations')).toBe(false);
    expect(endpoint.providerOutOfCredits('ovh')).toBe(false);
    expect(endpoint.providerOutOfCredits('nobody')).toBe(false);
  });

  it('a missing or corrupt events file never blocks a reassignment', () => {
    writeFileSync(eventsPath, 'not json\n{"provider":"pollinations"}\n', 'utf-8');
    expect(endpoint.providerOutOfCredits('pollinations')).toBe(false);
  });
});
