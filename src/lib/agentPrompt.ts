/**
 * ============================================================================
 *  Agent prompt composer — role → goal → backstory → capabilities → values.
 * ============================================================================
 *
 *  The mem20crewz Agent self-model shape, ported to plain TypeScript: an
 *  agent is a role with a goal, a backstory, capabilities and values, and
 *  those fields *compose* the system prompt. The creation wizard collects
 *  the fields; this module turns them into the prompt. Nothing here is a
 *  skeleton — an agent built from these fields is usable immediately, and a
 *  prompt composed from empty fields still says something real: the defaults
 *  below are the mem20crewz Agent defaults (capabilities) plus the honest
 *  working principles every agent in this workspace is held to.
 *
 *  A skill is never an empty label here: each skill contributes its name
 *  *and* its description as a guidance line in the prompt.
 */

import type { Seniority } from '../types';
import { SENIORITY_PROMPT } from '../data/templates/seniority';

/** The model a new agent gets on the Pollinations anonymous tier. */
export const DEFAULT_AGENT_MODEL = 'openai-fast';

/** The endpoint a new agent points at until the user moves it. */
export const DEFAULT_ENDPOINT_URL = 'http://localhost:8001/chat';

/** mem20crewz Agent default: 10 tool iterations per task. */
export const DEFAULT_MAX_ITERATIONS = 10;

/** What a skill contributes to a prompt — name plus real guidance. */
export interface SkillGuidance {
  name: string;
  description?: string;
}

/** Everything the composer needs. Only `name` and `role` are required. */
export interface AgentIdentityInput {
  /** Display name, e.g. "Scout". */
  name: string;
  /** Role, e.g. "Senior Frontend Engineer". */
  role: string;
  /** What the agent is for, in one sentence. */
  goal?: string;
  /** Where the agent comes from / how it works — free-form, may be empty. */
  backstory?: string;
  /** Free-form capability lines, e.g. "review pull requests for blast radius". */
  capabilities?: string[];
  /** Working principles, e.g. "cite the source, never the summary". */
  values?: string[];
  /**
   * A template's own system prompt, included verbatim as the role brief.
   * Template agents keep their authored brief; the composed sections layer
   * on top of it rather than replacing it.
   */
  brief?: string;
  /** Skills the agent draws on — each contributes name + description. */
  skills?: SkillGuidance[];
  /** Seniority clause, prepended when the role was picked at a level. */
  seniority?: Seniority;
  /** Max tool iterations per task. Absent means the workspace default. */
  maxIterations?: number;
  /** Hard deadline in seconds. Absent (or 0) means unlimited. */
  maxExecutionTimeSeconds?: number;
}

/** mem20crewz Agent defaults, used when no capabilities are given. */
export const DEFAULT_CAPABILITIES: string[] = [
  'plan',
  'reason',
  'reflect',
  'self-model',
  'memory',
];

/** The working principles every agent in this workspace is held to. */
export const DEFAULT_VALUES: string[] = [
  'no workarounds',
  'proper root-cause fixes',
  'say when you are unsure rather than guessing',
];

function cleanLines(lines: readonly (string | undefined)[]): string[] {
  return lines.map((l) => (l ?? '').trim()).filter(Boolean);
}

function articleFor(role: string): string {
  return /^[aeiou]/i.test(role.trim()) ? 'an' : 'a';
}

function defaultGoal(role: string): string {
  return (
    `Help with ${role} work: understand what is being asked, do it well, ` +
    `and say plainly when something is unclear or out of reach.`
  );
}

/**
 * Compose a complete system prompt from an agent's identity.
 *
 * Never returns an empty string: with no fields at all the result is still
 * a working prompt ("You are New Agent, a helpful assistant…" plus the
 * default goal, capabilities and values).
 */
export function composeSystemPrompt(input: AgentIdentityInput): string {
  const name = input.name.trim() || 'New Agent';
  const role = input.role.trim() || 'helpful assistant';
  const goal = input.goal?.trim() || defaultGoal(role);
  const capabilities = cleanLines(input.capabilities ?? []);
  const values = cleanLines(input.values ?? []);
  const skills = (input.skills ?? []).filter((s) => s.name.trim());

  const blocks: string[] = [`You are ${name}, ${articleFor(role)} ${role}.`];

  if (input.seniority) blocks.push(SENIORITY_PROMPT[input.seniority]);

  const brief = input.brief?.trim();
  if (brief) blocks.push(brief);

  blocks.push(`Your goal: ${goal}`);

  const backstory = input.backstory?.trim();
  if (backstory) blocks.push(backstory);

  blocks.push(
    `You are able to:\n${(capabilities.length > 0 ? capabilities : DEFAULT_CAPABILITIES)
      .map((c) => `- ${c}`)
      .join('\n')}`,
  );

  blocks.push(
    `You work by these principles:\n${(values.length > 0 ? values : DEFAULT_VALUES)
      .map((v) => `- ${v}`)
      .join('\n')}`,
  );

  const guidance = formatSkillGuidance(skills);
  if (guidance) blocks.push(guidance);

  const limits: string[] = [];
  if (input.maxIterations !== undefined && input.maxIterations > 0) {
    limits.push(`at most ${input.maxIterations} tool iterations per task`);
  }
  if (input.maxExecutionTimeSeconds !== undefined && input.maxExecutionTimeSeconds > 0) {
    limits.push(
      `stop after ${input.maxExecutionTimeSeconds} seconds and report where you got to`,
    );
  }
  if (limits.length > 0) blocks.push(`Work within these limits: ${limits.join('; ')}.`);

  return blocks.join('\n\n');
}

/**
 * The skills block alone — "Skills you draw on:\n- Name: guidance…".
 * Empty string when there are no skills, so callers can append it only when
 * it adds something.
 */
export function formatSkillGuidance(skills: readonly SkillGuidance[]): string {
  const lines = skills
    .filter((s) => s.name.trim())
    .map((s) => {
      const description = (s.description ?? '').trim();
      return description ? `- ${s.name.trim()}: ${description}` : `- ${s.name.trim()}`;
    });
  if (lines.length === 0) return '';
  return `Skills you draw on:\n${lines.join('\n')}`;
}

/**
 * Which of the given skills are not already named in the prompt — used when
 * appending guidance to an existing prompt, so a skill is never added twice.
 */
export function skillsMissingFromPrompt(
  prompt: string,
  skills: readonly SkillGuidance[],
): SkillGuidance[] {
  const lower = prompt.toLowerCase();
  return skills.filter((s) => s.name.trim() && !lower.includes(s.name.trim().toLowerCase()));
}
