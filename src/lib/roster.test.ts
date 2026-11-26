import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const roster = JSON.parse(readFileSync(join(ROOT, 'runner-agents.json'), 'utf-8'));
const mockText = readFileSync(join(ROOT, 'src/data/mock.ts'), 'utf-8');

const TEAMLY_26 = [
  'agent-mem20-assistant',
  'agent-daily-planner',
  'agent-research-assistant',
  'agent-writing-assistant',
  'agent-code-reviewer',
  'agent-qa-tester',
  'agent-bug-analysis-agent',
  'agent-frontend-developer',
  'agent-backend-architect',
  'agent-data-engineer',
  'agent-ai-engineer',
  'agent-prompt-engineer',
  'agent-minimal-change-engineer',
  'agent-git-workflow-master',
  'agent-codebase-onboarding-engineer',
  'agent-technical-writer',
  'agent-application-security-engineer',
  'agent-product-researcher',
  'agent-analytics-reporter',
  'agent-reading-companion',
  'agent-reality-checker',
  'agent-content-creator',
  'agent-meeting-notes-specialist',
  'agent-ceo-assistant',
  'agent-senior-project-manager',
  'agent-personal-growth-mentor',
];

describe('roster — runner-agents.json is the single source of truth', () => {
  it('has 31 records: 26 Teamily agents + Reviewer + Orchestrator + Provider Researcher + Keymaster + Atlas', () => {
    expect(roster).toHaveLength(31);
    const ids = roster.map((a: { id: string }) => a.id);
    expect(new Set(ids).size).toBe(31);
    for (const id of TEAMLY_26) expect(ids).toContain(id);
    for (const id of ['agent-reviewer', 'agent-orchestrator', 'agent-provider-researcher', 'agent-keymaster', 'agent-atlas']) {
      expect(ids).toContain(id);
    }
  });

  it('every agent points at the teamz-agent endpoint with the anonymous-tier model', () => {
    for (const a of roster) {
      expect(a.endpointUrl).toBe('http://127.0.0.1:8897/chat');
      expect(a.model).toBe('openai-fast');
      expect(typeof a.systemPrompt).toBe('string');
      expect(a.systemPrompt.length).toBeGreaterThan(50);
    }
  });

  it('the Orchestrator carries the mission directive', () => {
    const orch = roster.find((a: { id: string }) => a.id === 'agent-orchestrator');
    expect(orch.systemPrompt).toContain('Teamz owns mem20 and operates without a human in the loop, autonomously 24 hours a day, driving mem20 to success and completion.');
  });

  it('the Keymaster never holds a credential value in its prompt', () => {
    const km = roster.find((a: { id: string }) => a.id === 'agent-keymaster');
    expect(km.systemPrompt).toContain('NEVER write, speak, or log a credential VALUE');
    expect(km.systemPrompt).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(km.systemPrompt).not.toMatch(/gho_[A-Za-z0-9]/);
  });

  it('the Reviewer draws the push-path line: a routine repo commit is not a public release', () => {
    const reviewer = roster.find((a: { id: string }) => a.id === 'agent-reviewer');
    expect(reviewer.systemPrompt).toContain('One distinction matters');
    expect(reviewer.systemPrompt).toContain('not a public release');
    expect(reviewer.systemPrompt).toContain('release / advertise / sell stages');
  });
});

describe('UI seed — mock.ts matches the roster exactly', () => {
  it('defines all 34 seed agents: 4 original + 30 new', () => {
    // The 4 original agents use id constants (AGENT_SCOUT, …); the 30 new
    // agents use literal ids. Both forms count.
    const literalDefs = mockText.match(/id: 'agent-[a-z0-9-]+',/g) ?? [];
    expect(literalDefs.length).toBe(30);
    for (const c of ['AGENT_SCOUT', 'AGENT_ATLAS', 'AGENT_PIXEL', 'AGENT_SAGE']) {
      expect(mockText).toContain(`id: ${c},`);
    }
  });

  it('every roster system prompt is identical in the UI seed', () => {
    for (const a of roster) {
      expect(mockText).toContain(`'${a.id}'`);
      expect(mockText).toContain(a.systemPrompt);
    }
  });

  it('the Build Room holds all 34 agents', () => {
    const m = /name: 'Build Room',\s+agentIds: \[([\s\S]*?)\],/.exec(mockText);
    expect(m).not.toBeNull();
    const members = (m![1].match(/'agent-[a-z0-9-]+'/g) ?? []).map((s) => s.replace(/'/g, ''));
    expect(members).toHaveLength(30);
    // Plus the 4 original agents, listed by constant — Atlas is one of
    // them, so it appears as AGENT_ATLAS, not as the literal id.
    for (const c of ['AGENT_SCOUT', 'AGENT_ATLAS', 'AGENT_PIXEL', 'AGENT_SAGE']) {
      expect(m![1]).toContain(c);
    }
    expect(new Set(members).size).toBe(30);
    for (const a of roster) {
      if (a.id === 'agent-atlas') continue;
      expect(members).toContain(a.id);
    }
  });

  it('the Orchestrator standing orders are posted in the Build Room', () => {
    expect(mockText).toContain('Standing orders for the Build Room: Teamz owns mem20 and operates without a human in the loop, autonomously 24 hours a day, driving mem20 to success and completion.');
    expect(mockText).toContain("'agent-orchestrator',\n    ),");
  });

  it('every new agent has skills and the tool set', () => {
    for (const a of roster) {
      if (a.id === 'agent-atlas') continue; // the original seed Atlas predates the tool set
      const idx = mockText.indexOf(`id: '${a.id}'`);
      expect(idx).toBeGreaterThan(-1);
      const block = mockText.slice(idx, idx + 6000);
      expect(block).toContain('skills:');
      expect(block).toContain("enabledTools: ['wikipedia', 'weather', 'calculator']");
    }
  });
});

describe('build-runner-state.mjs — the automation inventory', () => {
  it('builds 31 agents and 29 cron jobs and preserves existing product jobs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamz-roster-'));
    try {
      const inPath = join(dir, 'in.json');
      const outPath = join(dir, 'out.json');
      writeFileSync(
        inPath,
        JSON.stringify({
          version: 1,
          agents: [],
          jobs: [{ id: 'job-nightly-repo-check', name: 'Nightly repo check' }],
          triggers: [],
          approvals: [],
          cronJobs: [],
        }),
      );
      const out = execFileSync(
        'node',
        [join(ROOT, 'scripts/build-runner-state.mjs'), '--agents', join(ROOT, 'runner-agents.json'), '--in', inPath, '--out', outPath],
        { encoding: 'utf-8' },
      );
      expect(out).toContain('31 agents');
      expect(out).toContain('29 cron jobs');
      const state = JSON.parse(readFileSync(outPath, 'utf-8'));
      expect(state.agents).toHaveLength(31);
      expect(state.cronJobs).toHaveLength(29);
      expect(state.jobs).toHaveLength(1);
      expect(state.jobs[0].id).toBe('job-nightly-repo-check');
      const hourly = state.cronJobs.filter((j: { schedule: string }) => j.schedule === '0 * * * *');
      expect(hourly).toHaveLength(26);
      expect(new Set(hourly.map((j: { agentId: string }) => j.agentId)).size).toBe(26);
      for (const id of TEAMLY_26) {
        expect(hourly.map((j: { agentId: string }) => j.agentId)).toContain(id);
      }
      const byId = new Map(state.cronJobs.map((j: { id: string }) => [j.id, j]));
      expect((byId.get('cron-orchestrator-15m') as { schedule: string }).schedule).toBe('*/15 * * * *');
      expect((byId.get('cron-provider-researcher-6h') as { schedule: string }).schedule).toBe('0 */6 * * *');
      expect((byId.get('cron-keymaster-daily-audit') as { schedule: string }).schedule).toBe('0 8 * * *');
      for (const job of state.cronJobs) {
        expect(job.type).toBe('prompt');
        expect(job.channelId).toBe('conv-build-room');
        expect(job.target.length).toBeGreaterThan(40);
        expect(job.target.length).toBeLessThanOrEqual(2000);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a live provider assignment from the existing state when the roster has none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamz-roster-'));
    try {
      const inPath = join(dir, 'in.json');
      const outPath = join(dir, 'out.json');
      writeFileSync(
        inPath,
        JSON.stringify({
          version: 1,
          agents: [{ id: 'agent-qa-tester', provider: 'pollinations' }],
          jobs: [],
          triggers: [],
          approvals: [],
          cronJobs: [],
        }),
      );
      execFileSync(
        'node',
        [join(ROOT, 'scripts/build-runner-state.mjs'), '--agents', join(ROOT, 'runner-agents.json'), '--in', inPath, '--out', outPath],
        { encoding: 'utf-8' },
      );
      const state = JSON.parse(readFileSync(outPath, 'utf-8'));
      const qa = state.agents.find((a: { id: string }) => a.id === 'agent-qa-tester');
      expect(qa.provider).toBe('pollinations');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
