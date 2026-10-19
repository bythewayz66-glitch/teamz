/**
 * ============================================================================
 *  Template model — the shape of a catalog entry, plus the helpers each
 *  category file uses to declare its templates.
 * ============================================================================
 *
 *  A template is inert data. It becomes a real `Agent` only when the user
 *  picks it and `instantiateTemplate()` copies it into the workspace.
 *
 *  Category files stay terse by using `makeSeeds(category)`:
 *
 *    const t = makeSeeds('engineering');
 *    t('Frontend Engineer', '⚛️', '#7c9cff', 'claude-sonnet-4',
 *      'Short description.',
 *      'System prompt.',
 *      ['react', 'ts'])
 *
 *  Skill ids are short names resolved against `skills.ts`, so a category file
 *  never repeats skill prose.
 */

import type { AgentSkill, CatalogSkill, TemplateCategory } from '../../types';
import { getSkill } from './skills';
import {
  LEADERSHIP_SKILL,
  PRINCIPAL_SKILL,
  baseRoleOf,
  levelAt,
  seniorityOf,
  type Seniority,
} from './seniority';

/** One catalog entry, fully resolved and ready to render or instantiate. */
export interface AgentTemplate {
  /** Stable, namespaced id: `${category}.${slug(name)}`. */
  id: string;
  name: string;
  emoji: string;
  category: TemplateCategory;
  /** One line shown under the name in the picker. */
  description: string;
  /** Copied verbatim onto the Agent's `systemPrompt`. */
  systemPrompt: string;
  /** Suggested model; the user can point it anywhere their server expects. */
  model: string;
  /** Accent colour, same palette as the workspace's seeded agents. */
  accent: string;
  /** Fully resolved catalogue capabilities. */
  skills: CatalogSkill[];
  /** Extra search terms — category, synonyms, tools. Not shown in the UI. */
  tags: string[];
  /**
   * Level implied by this template's own name. Unmarked names are `mid`.
   * Derived, never declared — see `./seniority`.
   */
  seniority: Seniority;
  /**
   * The role with its level marker stripped, e.g. "Frontend Engineer" for
   * "Senior Frontend Engineer". This is what stays constant across levels, so
   * it is what the seniority filter groups on.
   */
  baseRole: string;
}

/** What a category file actually declares. */
export interface TemplateSeed {
  category: TemplateCategory;
  name: string;
  emoji: string;
  accent: string;
  model: string;
  description: string;
  systemPrompt: string;
  skills: string[];
  tags?: string[];
}

/** "Senior Frontend Engineer (React)" -> "senior-frontend-engineer-react" */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the curried `t(...)` helper a category file uses.
 * Positional because 500 entries of key/value pairs is unreadable noise.
 */
export function makeSeeds(category: TemplateCategory) {
  return function seed(
    name: string,
    emoji: string,
    accent: string,
    model: string,
    description: string,
    systemPrompt: string,
    skills: string[],
    tags: string[] = [],
  ): TemplateSeed {
    return { category, name, emoji, accent, model, description, systemPrompt, skills, tags };
  };
}

/** Resolve seeds into templates: namespaced ids, unique slugs, real skills. */
export function defineTemplates(
  category: TemplateCategory,
  seeds: TemplateSeed[],
): AgentTemplate[] {
  const seen = new Set<string>();

  return seeds.map((seed) => {
    // Guards against a seed built with one category being filed under another.
    if (seed.category !== category) {
      throw new Error(
        `Seed "${seed.name}" was declared as "${seed.category}" but filed under "${category}"`,
      );
    }

    const slug = slugify(seed.name);
    if (!slug) throw new Error(`Template name produces an empty slug: "${seed.name}"`);

    if (seen.has(slug)) {
      throw new Error(`Duplicate template in "${category}": "${seed.name}"`);
    }
    seen.add(slug);

    return {
      id: `${category}.${slug}`,
      name: seed.name,
      emoji: seed.emoji,
      category,
      description: seed.description,
      systemPrompt: seed.systemPrompt,
      model: seed.model,
      accent: seed.accent,
      skills: seed.skills.map((skillId) => getSkill(category, skillId)),
      tags: seed.tags ?? [],
      seniority: seniorityOf(seed.name),
      baseRole: baseRoleOf(seed.name),
    };
  });
}

/**
 * Convert a template's catalogue skills into the flattened, levelled list an
 * *agent* carries.
 *
 * The catalogue declares order of importance (a role's first skill is its
 * defining one), so depth falls off with position rather than being random:
 * index 0 -> 5, then 4, 4, 3, 3, ... Anything past the fifth lands at 2.
 * Levels are what the skill chips show and what the mock API sorts on when it
 * writes an agent's in-character intro.
 */
export function skillsFor(skills: CatalogSkill[]): AgentSkill[] {
  return skills.map((skill, index) => ({
    key: `${skill.category}.${skill.id}`,
    label: skill.name,
    level: Math.max(2, 5 - Math.floor(index * 0.7)),
  }));
}

/**
 * The same conversion, but levelled for a specific seniority.
 *
 * This is what makes the level axis real rather than cosmetic: a junior's
 * defining skill sits at 3, a principal's at 5, so the same role genuinely
 * reads differently at each rank.
 *
 * At `lead` and `principal` the agent also gains the category's leadership
 * capability (and, at principal, a second one). Those ids come from the
 * existing skill registry, so a projected template can never reference a
 * skill that does not exist.
 */
export function skillsForLevel(
  skills: CatalogSkill[],
  seniority: Seniority,
  category: TemplateCategory,
): AgentSkill[] {
  const levelled: AgentSkill[] = skills.map((skill, index) => ({
    key: `${skill.category}.${skill.id}`,
    label: skill.name,
    level: levelAt(seniority, index),
  }));

  if (seniority !== 'lead' && seniority !== 'principal') return levelled;

  const extraIds = [LEADERSHIP_SKILL[category]];
  if (seniority === 'principal') extraIds.push(PRINCIPAL_SKILL[category]);

  const seen = new Set(levelled.map((s) => s.key));
  for (const id of extraIds) {
    const skill = getSkill(category, id);
    const key = `${skill.category}.${skill.id}`;
    // A role may already declare its category's leadership skill; do not
    // list it twice.
    if (seen.has(key)) continue;
    seen.add(key);
    levelled.push({ key, label: skill.name, level: seniority === 'principal' ? 5 : 4 });
  }

  return levelled;
}

/** The accent used when a template does not declare one. */
export const DEFAULT_ACCENT = '#7c9cff';

/** Human labels for the category tabs. */
export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  engineering: 'Engineering',
  design: 'Design',
  product: 'Product',
  data: 'Data',
  research: 'Research',
  marketing: 'Marketing',
  sales: 'Sales',
  support: 'Support',
  finance: 'Finance',
  legal: 'Legal',
  people: 'People',
  operations: 'Operations',
  education: 'Education',
  health: 'Health',
  creative: 'Creative',
};

/** Category tab order — broad-to-narrow, engineering first. */
export const CATEGORY_ORDER: TemplateCategory[] = [
  'engineering',
  'design',
  'product',
  'data',
  'research',
  'marketing',
  'sales',
  'support',
  'finance',
  'legal',
  'people',
  'operations',
  'education',
  'health',
  'creative',
];

/** One emoji per category, used on the category tabs. */
export const CATEGORY_EMOJI: Record<TemplateCategory, string> = {
  engineering: '🛠️',
  design: '🎨',
  product: '🧭',
  data: '📊',
  research: '🔍',
  marketing: '📣',
  sales: '🤝',
  support: '🎧',
  finance: '💵',
  legal: '⚖️',
  people: '👥',
  operations: '⚙️',
  education: '🎓',
  health: '🩺',
  creative: '✨',
};
