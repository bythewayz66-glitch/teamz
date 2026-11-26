/**
 * ============================================================================
 *  Skill bundles — named groups picked in one click.
 * ============================================================================
 *
 *  The mem20agentz SkillsStore bundle shape, ported to plain data: a bundle
 *  names skills, and expanding it resolves those names against the live skill
 *  registry (`skills.ts`). A bundle never carries its own prose — the member
 *  skills' descriptions are the guidance — so a bundle can never drift out of
 *  sync with the skills it groups.
 *
 *  Bundles are selectable as one click in the picker and expandable to their
 *  member skills: picking "Code Review" adds code-review + testing +
 *  refactoring, and each member can then be removed on its own.
 *
 *  Adding a bundle: add a row below with real registry keys
 *  (`category.id`). An unknown key throws at module load — deliberately, so
 *  a typo never ships as a silently smaller bundle.
 */

import type { AgentSkill, CatalogSkill, SkillBundle, TemplateCategory } from '../../types';
import { getSkillByKey } from './skills';
import { skillsFor } from './model';

/** The catalogue of bundles. Treat as read-only — the array is shared. */
export const SKILL_BUNDLES: SkillBundle[] = [
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Review a change for correctness, tests and blast radius before it lands.',
    skillKeys: ['engineering.code-review', 'engineering.testing', 'engineering.refactoring'],
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Find primary sources, weigh them honestly, and cite where each fact came from.',
    skillKeys: [
      'research.literature-search',
      'research.source-evaluation',
      'research.synthesis',
      'research.citation',
      'research.fact-checking',
    ],
  },
  {
    id: 'writing',
    name: 'Writing & Editing',
    description: 'Write plainly, cut filler, and keep one idea per paragraph.',
    skillKeys: [
      'creative.editing',
      'creative.storytelling',
      'marketing.copywriting',
      'creative.scripting',
    ],
  },
  {
    id: 'data-analysis',
    name: 'Data Analysis',
    description: 'Answer a question with numbers: query, test, and chart the result.',
    skillKeys: [
      'data.sql-analytics',
      'data.statistics',
      'data.visualisation',
      'data.experiment-analysis',
    ],
  },
  {
    id: 'design-critique',
    name: 'Design Critique',
    description: 'Judge a design on its system, its accessibility, and its type and colour.',
    skillKeys: [
      'design.design-systems',
      'design.accessibility',
      'design.typography',
      'design.color',
    ],
  },
  {
    id: 'product-discovery',
    name: 'Product Discovery',
    description: 'Separate the problem from the feature request, then spec what is worth building.',
    skillKeys: [
      'product.discovery',
      'product.user-stories',
      'product.competitive-analysis',
      'product.metrics',
    ],
  },
  {
    id: 'support-excellence',
    name: 'Support Excellence',
    description: 'Triage by impact, troubleshoot from evidence, and escalate with a clear ask.',
    skillKeys: [
      'support.triage',
      'support.troubleshooting',
      'support.tone',
      'support.escalation',
      'support.root-cause',
    ],
  },
  {
    id: 'sales-closer',
    name: 'Sales Closer',
    description: 'Run a discovery call that ends with a next step, then propose and negotiate.',
    skillKeys: [
      'sales.discovery-calls',
      'sales.objection-handling',
      'sales.proposals',
      'sales.negotiation',
    ],
  },
  {
    id: 'hiring',
    name: 'Hiring',
    description: 'Source on the specific work, interview against a rubric, and onboard to a first win.',
    skillKeys: [
      'people.sourcing',
      'people.interviewing',
      'people.onboarding-hr',
      'people.performance',
    ],
  },
  {
    id: 'ops-reliability',
    name: 'Ops & Reliability',
    description: 'Map the process, automate the stable step, and run the incident when it breaks.',
    skillKeys: [
      'operations.incident-response',
      'operations.process-mapping',
      'operations.automation',
      'operations.project-mgmt',
    ],
  },
  {
    id: 'finance-close',
    name: 'Finance Close',
    description: 'Model from labelled assumptions, budget from drivers, and explain the variance.',
    skillKeys: ['finance.modeling', 'finance.budgeting', 'finance.variance', 'finance.reporting'],
  },
  {
    id: 'legal-review',
    name: 'Legal Review',
    description: 'Summarise obligations first, redline minimally, and name the residual risk.',
    skillKeys: ['legal.contract-review', 'legal.redlining', 'legal.risk', 'legal.compliance'],
  },
  {
    id: 'teaching',
    name: 'Teaching',
    description: 'Sequence outcomes, plan one objective per lesson, and test understanding, not recall.',
    skillKeys: [
      'education.curriculum',
      'education.lesson-planning',
      'education.assessment',
      'education.tutoring',
    ],
  },
  {
    id: 'care-support',
    name: 'Care Support',
    description: 'Take a structured history, route on red flags, and explain in plain language.',
    skillKeys: [
      'health.intake',
      'health.triage-support',
      'health.patient-education',
      'health.safety',
    ],
  },
  {
    id: 'growth-marketing',
    name: 'Growth Marketing',
    description: 'Map intent to pages, write the copy that earns the click, and attribute honestly.',
    skillKeys: [
      'marketing.seo',
      'marketing.content-strategy',
      'marketing.copywriting',
      'marketing.analytics',
    ],
  },
];

const BY_ID = new Map<string, SkillBundle>(SKILL_BUNDLES.map((b) => [b.id, b]));

/** Every bundle. Treat as read-only — the array is shared. */
export function getBundles(): SkillBundle[] {
  return SKILL_BUNDLES;
}

/** One bundle by id, or undefined. */
export function getBundle(id: string): SkillBundle | undefined {
  return BY_ID.get(id);
}

/**
 * Resolve a bundle to its member skills, in bundle order, deduplicated.
 * Throws on an unknown skill key, so a broken bundle fails loudly.
 */
export function expandBundle(bundle: SkillBundle): CatalogSkill[] {
  const seen = new Set<string>();
  const out: CatalogSkill[] = [];
  for (const key of bundle.skillKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(getSkillByKey(key));
  }
  return out;
}

/** Resolve an arbitrary list of registry keys to skills, deduplicated, in order. */
export function expandSkillKeys(keys: string[]): CatalogSkill[] {
  const seen = new Set<string>();
  const out: CatalogSkill[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(getSkillByKey(key));
  }
  return out;
}

/**
 * Convert registry keys to the flattened, levelled list an *agent* carries —
 * the same position-based depth the template path uses, so a hand-picked
 * skill reads the same as a template skill at the same position.
 */
export function agentSkillsForKeys(keys: string[]): AgentSkill[] {
  return skillsFor(expandSkillKeys(keys));
}

/** True when every member of the bundle is in the selected key set. */
export function bundleIsFullySelected(bundle: SkillBundle, selectedKeys: string[]): boolean {
  const selected = new Set(selectedKeys);
  return bundle.skillKeys.every((key) => selected.has(key));
}

/** True when at least one member of the bundle is selected, but not all. */
export function bundleIsPartiallySelected(bundle: SkillBundle, selectedKeys: string[]): boolean {
  const selected = new Set(selectedKeys);
  const count = bundle.skillKeys.filter((key) => selected.has(key)).length;
  return count > 0 && count < bundle.skillKeys.length;
}

/**
 * Toggle a bundle against the current selection, picker-style: if every
 * member is already selected, remove them all; otherwise add the missing
 * members and keep everything else untouched. Selection order is preserved —
 * newly added members go on the end.
 */
export function toggleBundle(bundle: SkillBundle, selectedKeys: string[]): string[] {
  if (bundleIsFullySelected(bundle, selectedKeys)) {
    const members = new Set(bundle.skillKeys);
    return selectedKeys.filter((key) => !members.has(key));
  }
  const selected = new Set(selectedKeys);
  const out = [...selectedKeys];
  for (const key of bundle.skillKeys) {
    if (!selected.has(key)) out.push(key);
  }
  return out;
}

/**
 * Bundles that touch a category — every bundle with at least one member in
 * it. Used to narrow the picker to the role's own domain without hiding the
 * cross-category bundles that also apply.
 */
export function bundlesForCategory(category: TemplateCategory): SkillBundle[] {
  return SKILL_BUNDLES.filter((bundle) =>
    bundle.skillKeys.some((key) => key.startsWith(`${category}.`)),
  );
}

// Fail loudly at module load if any bundle names a skill that does not exist.
for (const bundle of SKILL_BUNDLES) expandBundle(bundle);
