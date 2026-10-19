/**
 * ============================================================================
 *  Seniority — the axis that lets one role be compared across levels.
 * ============================================================================
 *
 *  The catalogue holds 473 *distinct roles*, not 473 seniority variants: only
 *  a handful of names carry a level marker ("Senior Frontend Engineer",
 *  "Staff Engineer"). That is deliberate — 100 roles × 5 levels is 500 entries
 *  of near-duplicate prose.
 *
 *  Instead, seniority is *derived*:
 *
 *    seniorityOf('Senior Frontend Engineer')  -> 'senior'
 *    baseRoleOf('Senior Frontend Engineer')   -> 'Frontend Engineer'
 *
 *  and any template can be projected onto another level on demand
 *  (`projectTemplate` in `./index`), which renames it, re-levels its skills and
 *  prepends a level-appropriate clause to its prompt. So "Senior Frontend
 *  Engineer" and "Frontend Engineer" can be put side by side without either
 *  being stored twice.
 *
 *  This module is deliberately dependency-free (it imports only types) so
 *  `model.ts` can use it without creating an import cycle.
 */

import type { Seniority, TemplateCategory } from '../../types';

export type { Seniority };

/** Display order, junior first — the order the filter shows them in. */
export const SENIORITY_ORDER: Seniority[] = ['junior', 'mid', 'senior', 'lead', 'principal'];

export const SENIORITY_LABELS: Record<Seniority, string> = {
  junior: 'Junior',
  mid: 'Mid',
  senior: 'Senior',
  lead: 'Lead',
  principal: 'Principal',
};

/** One-line description of what each level means, shown in the filter. */
export const SENIORITY_BLURB: Record<Seniority, string> = {
  junior: 'Executes a defined task, asks before assuming.',
  mid: 'Owns a workstream end to end.',
  senior: 'Sets the approach and explains the trade-offs.',
  lead: 'Directs others and owns the outcome.',
  principal: 'Sets direction across teams and time horizons.',
};

/**
 * The name prefix each level adds. `mid` is the unmarked base role, which is
 * why it maps to an empty string.
 */
export const SENIORITY_PREFIX: Record<Seniority, string> = {
  junior: 'Junior',
  mid: '',
  senior: 'Senior',
  lead: 'Lead',
  principal: 'Principal',
};

/**
 * Name prefixes that *imply* a level, longest first so "Head of" is tested
 * before "Head". Matched case-insensitively at the start of the name.
 */
const PREFIX_TO_LEVEL: [string, Seniority][] = [
  ['principal ', 'principal'],
  ['staff ', 'principal'],
  ['head of ', 'lead'],
  ['director of ', 'lead'],
  ['director ', 'lead'],
  ['chief ', 'lead'],
  ['vp of ', 'lead'],
  ['vp ', 'lead'],
  ['lead ', 'lead'],
  ['senior ', 'senior'],
  ['sr. ', 'senior'],
  ['sr ', 'senior'],
  ['junior ', 'junior'],
  ['jr. ', 'junior'],
  ['jr ', 'junior'],
  ['associate ', 'junior'],
  ['intern ', 'junior'],
  ['entry-level ', 'junior'],
];

/**
 * The level a template's own name implies. Anything unmarked is `mid`, which
 * is the honest reading: the catalogue describes the role, not a rank.
 */
export function seniorityOf(name: string): Seniority {
  const lower = name.trim().toLowerCase();
  for (const [prefix, level] of PREFIX_TO_LEVEL) {
    if (lower.startsWith(prefix)) return level;
  }
  return 'mid';
}

/**
 * The role with its level marker removed — the thing that stays constant as
 * you move up and down the levels.
 *
 *   'Senior Frontend Engineer' -> 'Frontend Engineer'
 *   'Head of Design'           -> 'Design'
 *   'Backend Engineer'         -> 'Backend Engineer'
 */
export function baseRoleOf(name: string): string {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  for (const [prefix] of PREFIX_TO_LEVEL) {
    if (lower.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length).trim();
      // Guard against a name that is *only* a prefix ("Lead").
      if (rest) return rest;
    }
  }
  return trimmed;
}

/**
 * Skill depth by position, per level. Index 0 is the role's defining skill, so
 * it is always the deepest; the curve falls off from there.
 *
 * A junior's defining skill sits at 3 rather than 5 — the point of the level
 * axis is that the *same* role reads differently at each rank.
 */
const CURVES: Record<Seniority, number[]> = {
  junior: [3, 2, 2],
  mid: [4, 3, 3],
  senior: [5, 4, 4],
  lead: [5, 5, 4],
  principal: [5, 5, 5],
};

/** Depth for the skill at `index` at a given level. Clamps past the curve. */
export function levelAt(seniority: Seniority, index: number): number {
  const curve = CURVES[seniority];
  return curve[Math.min(index, curve.length - 1)];
}

/**
 * The extra capability a lead or principal carries, per category. These are
 * ids from the existing skill registry — nothing new is invented, so a
 * projected template can never reference a skill that does not exist.
 */
export const LEADERSHIP_SKILL: Record<TemplateCategory, string> = {
  engineering: 'code-review',
  design: 'design-systems',
  product: 'roadmapping',
  data: 'statistics',
  research: 'synthesis',
  marketing: 'content-strategy',
  sales: 'negotiation',
  support: 'escalation',
  finance: 'modeling',
  legal: 'risk',
  people: 'org-design',
  operations: 'okrs',
  education: 'learning-science',
  health: 'safety',
  creative: 'art-direction',
};

/** The second extra capability, added only at principal. */
export const PRINCIPAL_SKILL: Record<TemplateCategory, string> = {
  engineering: 'security',
  design: 'accessibility',
  product: 'metrics',
  data: 'warehouse',
  research: 'source-evaluation',
  marketing: 'analytics',
  sales: 'forecasting',
  support: 'root-cause',
  finance: 'reporting',
  legal: 'compliance',
  people: 'performance',
  operations: 'process-mapping',
  education: 'assessment',
  health: 'care-coordination',
  creative: 'editing',
};

/**
 * The clause prepended to a projected template's prompt. Kept short and
 * concrete — it changes how the agent behaves, not just how it is labelled.
 */
export const SENIORITY_PROMPT: Record<Seniority, string> = {
  junior:
    'You are early in your career. You do the task you were given, ask before assuming, and say plainly when you are unsure rather than guessing.',
  mid: 'You own your workstream end to end and flag risks early.',
  senior:
    'You are senior. You choose the approach, state the trade-off you accepted, and say what you would do differently with more time.',
  lead: 'You lead others. You set direction, unblock people, and own the outcome rather than the activity.',
  principal:
    'You operate at principal level. You set direction across teams and time horizons, and you optimise for the decision that is still right in a year.',
};
