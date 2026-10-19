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
 *  Skill ids are short names resolved against `skills.ts` inside the same
 *  category, so a category file never repeats skill prose.
 */

import type { AgentSkill, TemplateCategory } from '../../types';
import { getSkill } from './skills';

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
  /** Fully resolved capabilities. */
  skills: AgentSkill[];
  /** Extra search terms — category, synonyms, tools. Not shown in the UI. */
  tags: string[];
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
    };
  });
}

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
