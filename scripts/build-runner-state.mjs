#!/usr/bin/env node
/**
 * build-runner-state.mjs — build /var/lib/teamz-runner/state.json from
 * the canonical roster (runner-agents.json) plus the automation inventory
 * defined below.
 *
 *   node scripts/build-runner-state.mjs \
 *     --agents runner-agents.json \
 *     --in  /var/lib/teamz-runner/state.json \
 *     --out /tmp/state-new.json
 *
 * What it does:
 *   - Agents: wholesale from runner-agents.json (the single source of
 *     truth — 31 records: 26 Teamily agents + Reviewer + Orchestrator +
 *     Provider Researcher + Keymaster + Atlas). Any `provider` field on a
 *     record is carried through; it is how the Provider Researcher's
 *     reassignments persist.
 *   - CronJobs: wholesale from the inventory below — 26 hourly prompt jobs
 *     (one per Teamily agent, `0 * * * *`, conv-build-room), the
 *     Orchestrator every 15 minutes (`*\/15 * * * *`), the Provider
 *     Researcher every 6 hours (`0 *\/6 * * *`), and the Keymaster daily
 *     audit (`0 8 * * *`). Every target is a concrete, bounded task the
 *     agent can finish in ONE dispatch, read-only against /opt/mem20.
 *   - Preserved from --in (when it exists): jobs (including the Nightly
 *     repo check), approvals, triggers, channelMessages, rateLimitRescues.
 *
 * It never touches /opt/mem20 and never invents an agent: every cron job
 * names an agent id present in the roster, and the script exits non-zero
 * if any target references an agent that is not there.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BUILD_ROOM = 'conv-build-room';

/** The 26 hourly jobs: agent id -> the one-dispatch task. */
export const HOURLY_TASKS = {
  'agent-mem20-assistant':
    'Drift snapshot: list the five most likely sources of drift in mem20 right now (version skew, stale pins, doc/code disagreement, unwired tools, subsystem gaps), one line each with what would prove or disprove it. Work from what you know; do not claim to have read files you cannot see.',
  'agent-daily-planner':
    "Write the plan for the next hour: the single most important mem20 task, the next two, and what gets dropped if time runs out. One short paragraph per item, no more.",
  'agent-research-assistant':
    'Find one primary source relevant to mem20 this hour (a doc, a release note, or a standard) and summarise it in five lines with its citation. If you cannot reach a source, say so and name the source you tried.',
  'agent-writing-assistant':
    "Polish one paragraph of mem20 copy: take the mem20 one-line description and rewrite it tighter in Jesse's voice (direct, plain, concrete). Show the before and after, and name what you cut.",
  'agent-code-reviewer':
    'Review checklist for the next mem20 change: the five checks a reviewer must run before merge (correctness, minimal scope, naming, blast radius, tests) and the exact evidence each check needs. Do not claim to have read a diff you have not seen.',
  'agent-qa-tester':
    'Write the test plan for the next mem20 change: the five highest-risk areas, one test per area with exact steps and the expected result. A test that cannot fail for the right reason is not a test — flag any you write that way.',
  'agent-bug-analysis-agent':
    'Take the most recent mem20 failure mode you know of (a drift item, a blocked stage, a failed run) and narrow it: separate the trigger from the underlying condition, name the one datum that would split your hypotheses, and propose the smallest fix for the root cause.',
  'agent-frontend-developer':
    "Review the Teamz front end's narrow-screen case: list the three most likely breakages on a phone-width screen and the one-line fix for each. No code changes — findings only.",
  'agent-backend-architect':
    "Design note: the runner's next API contract change. Name the endpoint, its request/response shape, its error envelope, and the one failure mode it must survive. Keep it to ten lines.",
  'agent-data-engineer':
    'Data check: name the three datasets the runner produces (cron runs, stage runs, approvals) and for each, state its grain, what a duplicate row would look like, and how a re-run stays idempotent.',
  'agent-ai-engineer':
    'Evaluation note: pick one agent behaviour to measure this hour (e.g. Orchestrator mention accuracy), define the baseline, the eval set of five cases, and what "better" would look like as a number with uncertainty.',
  'agent-prompt-engineer':
    "Prompt audit: take one agent's system prompt and propose the shortest change that would make its behaviour more reliable — one variable changed, the failure mode it fixes, and how you would test it.",
  'agent-minimal-change-engineer':
    'Smallest-diff review: describe the smallest diff that would fix the most recent mem20 drift item you know of. No drive-by refactors; name exactly which files change and which do not.',
  'agent-git-workflow-master':
    "Git hygiene check: list the three rules that keep mem20's history clean right now (commit size, messages, no force-pushes to shared branches) and the one violation most likely this week, with how to prevent it.",
  'agent-codebase-onboarding-engineer':
    'Onboarding note: the smallest real task a newcomer could ship in mem20 this week. Name the task, the three files involved, and the concept they would learn by doing it.',
  'agent-technical-writer':
    'Docs check: name one place where the mem20 docs and the implementation most likely disagree right now, what the doc says, what the code does, and which one should change.',
  'agent-application-security-engineer':
    'Threat note: name the one injection or privilege-escalation path most worth checking in the runner/agent endpoint this hour, its likelihood and impact, and the mitigation.',
  'agent-product-researcher':
    "Competitive signal: name one public signal about agent-memory or multi-agent products from the last day, what it means for mem20's next decision, and its timestamp.",
  'agent-analytics-reporter':
    'Report: one primary metric for the runner this hour (e.g. dispatches completed vs failed), its guardrails, and how it could be gamed. State the uncertainty on the number.',
  'agent-reading-companion':
    'Reading note: summarise one mem20 doc or decision in five lines — what it actually says, the claims worth keeping, and the question that makes the next page land.',
  'agent-reality-checker':
    "Reality check: pick one claim about mem20's current state and trace it to its origin. State your confidence level and say plainly if it cannot be verified.",
  'agent-content-creator':
    "Content draft: one short post about what mem20 does, for one platform, in Jesse's voice. Lead with the concrete benefit, cut every hedge word, and name what the post will not claim.",
  'agent-meeting-notes-specialist':
    'Meeting note: from the last hour of Build Room activity, list the decisions actually made, the owner and deadline for each action item, and anything agreed without an owner.',
  'agent-ceo-assistant':
    "Priorities brief: what needs Jesse's decision today, what is waiting on whom, and what slipped in the last hour. No new commitments, no dates or prices without his say-so.",
  'agent-senior-project-manager':
    'Critical path: name the one dependency most likely to slip in mem20 this week, what it blocks, and the earliest warning sign.',
  'agent-personal-growth-mentor':
    'Habit check: one habit small enough to survive a bad week, tied to the mem20 goal, with one next step and how progress will be measured without noise.',
};

export const ORCHESTRATOR_TARGET =
  'Triage the Build Room (conv-build-room). Start by calling room_read with {"what": "unassigned"} to see what the agents delivered since your last run and what is still unassigned. ' +
  'For each piece of unassigned work, find the right agent with room_read {"what": "agents", "role": "<keyword>"} and @mention that agent by its exact name or @agent-id with a clear brief and the expected output, so the work moves. ' +
  'Never invent an agent or an assignment you cannot see in room_read. ' +
  'If you notice a need that keeps recurring, propose a new automation with the create_automation tool. ' +
  'If there is nothing to assign, say so in one line and report what each agent delivered. ' +
  'Standing orders: Teamz owns mem20 and operates without a human in the loop, autonomously 24 hours a day, driving mem20 to success and completion. ' +
  'You never spend money, release anything publicly, or delete anything — those need the Reviewer’s approval.';

export const PROVIDER_RESEARCHER_TARGET =
  'Provider research sweep: use web_search to find one new keyless, free LLM provider (no API key, no payment, no card) you have not tried before. ' +
  'Test it with a live call — reachable, keyless, returns a real reply. If it validates, add it with add_provider and reassign one agent to it with reassign_agent, recording the change and the reason. ' +
  'If it fails validation, record why and move on — never add a provider that failed, never add one that needs a key or payment. ' +
  'Then check the current load balancing: are agents spread across providers, or piled on one? Report the provider inventory and the assignment table.';

export const KEYMASTER_TARGET =
  'Credential audit: review the credential inventory (which credentials the system needs, where each one lives, what it is for, which system needs it). ' +
  'Report exactly what is present and what is missing and how Jesse can place each missing one through the secure flow. ' +
  'NEVER write, speak, or log a credential value — presence only. If a credential is missing, report it as missing; never proceed as if you had it.';

function buildCronJobs(agents) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const jobs = [];
  for (const [agentId, target] of Object.entries(HOURLY_TASKS)) {
    if (!byId.has(agentId)) throw new Error(`hourly task names unknown agent ${agentId}`);
    const agent = byId.get(agentId);
    jobs.push({
      id: `cron-hourly-${agentId.replace(/^agent-/, '')}`,
      name: `Hourly: ${agent.name}`,
      schedule: '0 * * * *',
      type: 'prompt',
      target,
      enabled: true,
      agentId,
      channelId: BUILD_ROOM,
      lastRunAt: null,
      runs: [],
    });
  }
  for (const [id, name, schedule, target, agentId] of [
    ['cron-orchestrator-15m', 'Orchestrator triage', '*/15 * * * *', ORCHESTRATOR_TARGET, 'agent-orchestrator'],
    ['cron-provider-researcher-6h', 'Provider research sweep', '0 */6 * * *', PROVIDER_RESEARCHER_TARGET, 'agent-provider-researcher'],
    ['cron-keymaster-daily-audit', 'Keymaster credential audit', '0 8 * * *', KEYMASTER_TARGET, 'agent-keymaster'],
  ]) {
    if (!byId.has(agentId)) throw new Error(`scheduled job ${id} names unknown agent ${agentId}`);
    jobs.push({
      id,
      name,
      schedule,
      type: 'prompt',
      target,
      enabled: true,
      agentId,
      channelId: BUILD_ROOM,
      lastRunAt: null,
      runs: [],
    });
  }
  return jobs;
}

export function buildRunnerState(roster, existing = {}) {
  // A runtime reassignment (Provider Researcher) sets an agent's
  // provider in state.json; the roster may not carry it yet. Preserve
  // an existing explicit provider when the roster record has none, so
  // rebuilding the state never silently wipes a live assignment.
  const existingProviders = new Map(
    (Array.isArray(existing.agents) ? existing.agents : [])
      .filter((a) => a && typeof a.id === 'string' && typeof a.provider === 'string')
      .map((a) => [a.id, a.provider]),
  );
  const agents = roster.map((a) => ({
    id: a.id,
    name: a.name,
    endpointUrl: a.endpointUrl,
    model: a.model,
    ...(a.provider ?? existingProviders.get(a.id)
      ? { provider: a.provider ?? existingProviders.get(a.id) }
      : {}),
    systemPrompt: a.systemPrompt,
  }));
  return {
    version: 1,
    agents,
    jobs: Array.isArray(existing.jobs) ? existing.jobs : [],
    triggers: Array.isArray(existing.triggers) ? existing.triggers : [],
    approvals: Array.isArray(existing.approvals) ? existing.approvals : [],
    cronJobs: buildCronJobs(agents),
    channelMessages: Array.isArray(existing.channelMessages) ? existing.channelMessages : [],
    rateLimitRescues: Array.isArray(existing.rateLimitRescues) ? existing.rateLimitRescues : [],
  };
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1 || !args[i + 1]) throw new Error(`missing ${flag} <path>`);
    return args[i + 1];
  };
  const roster = JSON.parse(readFileSync(get('--agents'), 'utf-8'));
  if (!Array.isArray(roster) || roster.length === 0) throw new Error('roster is not a non-empty array');
  const inPath = get('--in');
  const existing = existsSync(inPath) ? JSON.parse(readFileSync(inPath, 'utf-8')) : {};
  const state = buildRunnerState(roster, existing);
  const outPath = get('--out');
  writeFileSync(outPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  console.log(
    `built ${outPath}: ${state.agents.length} agents, ${state.cronJobs.length} cron jobs ` +
      `(${Object.keys(HOURLY_TASKS).length} hourly + orchestrator + provider researcher + keymaster), ` +
      `${state.jobs.length} product jobs preserved, ${state.approvals.length} approvals preserved`,
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
