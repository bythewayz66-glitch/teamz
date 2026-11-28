/**
 * What an agent can reach outside Teamz, and under what policy.
 *
 * Every row says two separate things: the policy it is declared under
 * (Gamut's default is "needs approval") and whether anything in Teamz
 * actually enforces it. A declared policy that nothing enforces is shown as
 * advisory, never as protection.
 */

import type { Agent } from '../types';
import type { RunnerSnapshot } from './agentHome';
import { GITHUB_NODE_ID, WEB_NODE_ID, type FleetGraph } from './graph';

export type PolicyValue = 'needs-approval' | 'allow' | 'block';
export type Enforcement = 'enforced' | 'advisory';
export type ConnectionState = 'in-use' | 'available' | 'unknown' | 'none';

export const DEFAULT_POLICY: PolicyValue = 'needs-approval';
export const POLICY_LABEL: Record<PolicyValue, string> = {
  'needs-approval': 'Needs approval',
  allow: 'Allowed',
  block: 'Blocked',
};

export interface ConnectionRow {
  id: 'model' | 'web' | 'github' | 'slack' | 'mcp' | 'toolchest';
  label: string;
  state: ConnectionState;
  stateLabel: string;
  detail: string;
  /** Null when no per-agent policy applies. */
  policy: PolicyValue | null;
  /** Editable rows hold a declared policy stored in this browser. */
  editable: boolean;
  enforcement: Enforcement | null;
  enforcementNote: string;
  calls: number | null;
  lastAt: number | null;
  basis: string;
}

export const CONNECTION_POLICY_KEY = 'teamz:connection-policy:v1';

export type PolicyMap = Record<string, PolicyValue>;

export function parsePolicies(raw: string | null): PolicyMap {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object') return {};
    const out: PolicyMap = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (v === 'needs-approval' || v === 'allow' || v === 'block') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export const policyKey = (agentId: string, rowId: ConnectionRow['id']) => `${agentId}:${rowId}`;

const BROWSER_WEB_TOOLS = ['web_search', 'wikipedia', 'weather'];

export function buildConnectionRows(input: {
  agent: Agent;
  runner: RunnerSnapshot | null;
  graph: FleetGraph | null;
  policies: PolicyMap;
}): ConnectionRow[] {
  const { agent, runner, graph, policies } = input;
  const runnerAgent = runner?.agents.find((a) => a.id === agent.id) ?? null;
  const onRunner = runnerAgent !== null;
  const edges = graph?.edges.filter((e) => e.from === agent.id) ?? [];
  const edgeTo = (to: string) => edges.find((e) => e.to === to);
  const declaredPolicy = (id: ConnectionRow['id']): PolicyValue => policies[policyKey(agent.id, id)] ?? DEFAULT_POLICY;
  const rows: ConnectionRow[] = [];

  const provider = runnerAgent?.provider ?? null;
  const modelEdge = edges.find((e) => e.relation === 'model');
  rows.push({
    id: 'model',
    label: 'Model provider',
    state: provider ? 'in-use' : onRunner ? 'unknown' : 'none',
    stateLabel: provider ? 'In use' : onRunner ? 'Not reported' : 'Not on the runner',
    detail: provider
      ? `${provider}${runnerAgent?.model ? ` · ${runnerAgent.model}` : ''}`
      : onRunner
        ? 'The runner did not report a provider for this agent.'
        : 'Replies use the provider chosen in this browser’s AI provider settings.',
    policy: null,
    editable: false,
    enforcement: null,
    enforcementNote: 'The runner assigns the provider; there is no per-agent approval step.',
    calls: modelEdge ? modelEdge.count : null,
    lastAt: modelEdge?.lastAt ?? null,
    basis: 'runner agent list; usage ledger',
  });

  const browserWeb = (agent.enabledTools ?? []).filter((t) => BROWSER_WEB_TOOLS.includes(t));
  const hasWeb = onRunner || browserWeb.length > 0;
  rows.push({
    id: 'web',
    label: 'Web tools',
    state: hasWeb ? 'available' : 'none',
    stateLabel: hasWeb ? 'Available' : 'Not enabled',
    detail: onRunner
      ? 'The runner endpoint gives every runner agent web_search, fetch_url, wikipedia and weather (read-only).'
      : browserWeb.length > 0
        ? `Enabled in this browser: ${browserWeb.join(', ')}.`
        : 'No web tools enabled for this agent.',
    policy: hasWeb ? declaredPolicy('web') : null,
    editable: hasWeb,
    enforcement: hasWeb ? 'advisory' : null,
    enforcementNote: onRunner
      ? 'Declared only. The runner does not ask before using these tools.'
      : 'Enabling a tool is enforced (only enabled tools are offered); an approval step is not.',
    calls: edgeTo(WEB_NODE_ID)?.count ?? null,
    lastAt: null,
    basis: onRunner ? 'scripts/agent-endpoint/agent.mjs toolset' : 'agent.enabledTools',
  });

  const pushEdge = edgeTo(GITHUB_NODE_ID);
  rows.push({
    id: 'github',
    label: 'GitHub',
    state: pushEdge ? 'available' : 'none',
    stateLabel: pushEdge ? 'Push stage' : 'No push stage',
    detail: pushEdge
      ? 'A job gives this agent a push stage that commits through the governed push script.'
      : 'No job gives this agent a push stage. Direct commit and PR tools are blocked for every agent.',
    policy: pushEdge ? 'needs-approval' : null,
    editable: false,
    enforcement: pushEdge ? 'enforced' : null,
    enforcementNote: pushEdge
      ? 'The stage is Reviewer-gated and the push script re-checks the approval on disk before it pushes (docs/PUSH_PATH.md; not verified live from here).'
      : 'Blocked in the endpoint’s tool list.',
    calls: pushEdge ? pushEdge.count : null,
    lastAt: pushEdge?.lastAt ?? null,
    basis: 'job stages and runs',
  });

  rows.push({
    id: 'slack',
    label: 'Slack',
    state: 'unknown',
    stateLabel: 'Not visible here',
    detail: 'The runner posts job results to Slack through a webhook. Whether it is configured is not visible from the browser, and nothing is recorded per agent.',
    policy: null,
    editable: false,
    enforcement: 'enforced',
    enforcementNote: 'Agents cannot send Slack messages themselves: comm_slack_message is blocked in the endpoint.',
    calls: null,
    lastAt: null,
    basis: 'scripts/slack-poster.ts; endpoint block list',
  });

  rows.push({
    id: 'toolchest',
    label: 'Toolchest (mem20 tools)',
    state: onRunner ? 'available' : 'none',
    stateLabel: onRunner ? 'Available' : 'Not on the runner',
    detail: onRunner
      ? 'toolchest_search and toolchest_call reach the tool surface on the runner host, not an outside service.'
      : 'Only runner agents have it.',
    policy: onRunner ? 'allow' : null,
    editable: false,
    enforcement: onRunner ? 'enforced' : null,
    enforcementNote: onRunner
      ? 'Read-only tools run; destructive, publishing and sending tools are refused by the endpoint.'
      : '',
    calls: null,
    lastAt: null,
    basis: 'scripts/agent-endpoint/agent.mjs isDestructiveTool',
  });

  rows.push({
    id: 'mcp',
    label: 'MCP servers',
    state: 'none',
    stateLabel: 'None',
    detail: 'Teamz has no MCP client, so no MCP connection exists for this agent.',
    policy: null,
    editable: false,
    enforcement: null,
    enforcementNote: '',
    calls: null,
    lastAt: null,
    basis: 'source tree',
  });

  return rows;
}
