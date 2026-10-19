/**
 * ============================================================================
 *  Template catalogue — the public surface of `src/data/templates/`.
 * ============================================================================
 *
 *    getTemplates()                 all ~500 templates
 *    searchTemplates(query)         free-text over name/description/tags/skills
 *    getTemplateById(id)            one template or undefined
 *    getCategories()                category tabs with live counts
 *    instantiateTemplate(id)        -> a fresh Agent ready for the store
 *
 *  Templates are plain data. Nothing is created until `instantiateTemplate()`
 *  is called, so shipping the catalogue costs byte size and nothing else — no
 *  agents, no endpoints, no requests.
 */

import type { Agent, AgentSkill, TemplateCategory } from '../../types';
import {
  CATEGORY_EMOJI,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type AgentTemplate,
} from './model';

import { engineeringTemplates } from './engineering';
import { designTemplates } from './design';
import { productTemplates } from './product';
import { dataTemplates } from './data';
import { researchTemplates } from './research';
import { marketingTemplates } from './marketing';
import { salesTemplates } from './sales';
import { supportTemplates } from './support';
import { financeTemplates } from './finance';
import { legalTemplates } from './legal';
import { peopleTemplates } from './people';
import { operationsTemplates } from './operations';
import { educationTemplates } from './education';
import { healthTemplates } from './health';
import { creativeTemplates } from './creative';

export type { AgentTemplate, TemplateSeed } from './model';
export {
  CATEGORY_EMOJI,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  slugify,
} from './model';
export { SKILLS, getSkill, getSkillsForCategory } from './skills';

/** Every template, in category-tab order. Built once at module load. */
const ALL: AgentTemplate[] = [
  ...engineeringTemplates,
  ...designTemplates,
  ...productTemplates,
  ...dataTemplates,
  ...researchTemplates,
  ...marketingTemplates,
  ...salesTemplates,
  ...supportTemplates,
  ...financeTemplates,
  ...legalTemplates,
  ...peopleTemplates,
  ...operationsTemplates,
  ...educationTemplates,
  ...healthTemplates,
  ...creativeTemplates,
];

const BY_ID = new Map<string, AgentTemplate>(ALL.map((t) => [t.id, t]));

/** The whole catalogue. Treat as read-only — the array is shared. */
export function getTemplates(): AgentTemplate[] {
  return ALL;
}

export function getTemplateById(id: string): AgentTemplate | undefined {
  return BY_ID.get(id);
}

export interface TemplateCategorySummary {
  category: TemplateCategory;
  label: string;
  emoji: string;
  count: number;
}

/** Category tabs, in the order the picker shows them, with live counts. */
export function getCategories(): TemplateCategorySummary[] {
  const counts = new Map<TemplateCategory, number>();
  for (const t of ALL) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);

  return CATEGORY_ORDER.filter((c) => (counts.get(c) ?? 0) > 0).map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    emoji: CATEGORY_EMOJI[category],
    count: counts.get(category) ?? 0,
  }));
}

/** Templates in one category, alphabetical so the list is stable. */
export function getTemplatesByCategory(category: TemplateCategory): AgentTemplate[] {
  return ALL.filter((t) => t.category === category).sort((a, b) => a.name.localeCompare(b.name));
}

/** Lowercased haystack for one template, built lazily and cached. */
const HAYSTACK = new Map<string, string>();

function haystack(t: AgentTemplate): string {
  const cached = HAYSTACK.get(t.id);
  if (cached) return cached;

  const text = [
    t.name,
    t.description,
    t.category,
    CATEGORY_LABELS[t.category],
    t.model,
    ...t.tags,
    ...t.skills.flatMap((s: AgentSkill) => [s.name, s.id, s.description]),
  ]
    .join(' ')
    .toLowerCase();

  HAYSTACK.set(t.id, text);
  return text;
}

/**
 * Free-text search. Every whitespace-separated token must appear somewhere in
 * the template — so "senior react" narrows rather than widens, which is what
 * people expect from a filter box.
 *
 * An empty query returns everything. Results are ranked: name matches first,
 * then skill matches, then description/tag matches.
 */
export function searchTemplates(query: string): AgentTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return ALL;

  const tokens = q.split(/\s+/).filter(Boolean);

  const matches = ALL.filter((t) => {
    const hay = haystack(t);
    return tokens.every((token) => hay.includes(token));
  });

  const rank = (t: AgentTemplate): number => {
    const name = t.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (t.skills.some((s) => s.name.toLowerCase().includes(q))) return 2;
    if (t.category.includes(q)) return 3;
    return 4;
  };

  return matches.sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
}

/** Search within a category (the picker's per-tab search). */
export function searchTemplatesInCategory(
  query: string,
  category: TemplateCategory | 'all',
): AgentTemplate[] {
  const pool = category === 'all' ? searchTemplates(query) : searchTemplates(query);
  return category === 'all' ? pool : pool.filter((t) => t.category === category);
}

let counter = 0;

/** Fresh, collision-resistant id — same shape as the store's own ids. */
function freshAgentId(): string {
  counter += 1;
  return `agent-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export interface InstantiateOptions {
  /** Override the template's suggested model (e.g. what the user's server runs). */
  model?: string;
  /** Override the endpoint; defaults to the same placeholder the dialog uses. */
  endpointUrl?: string;
  /** Override the display name — handy when instantiating two of the same type. */
  name?: string;
}

/**
 * Turn a template id into a brand-new `Agent`.
 *
 * The agent is NOT added to the workspace here — the caller hands it to the
 * store. Skills are deep-copied so editing one agent's skills can never leak
 * back into the shared catalogue.
 */
export function instantiateTemplate(templateId: string, options: InstantiateOptions = {}): Agent {
  const template = BY_ID.get(templateId);
  if (!template) {
    throw new Error(`Unknown template id: "${templateId}"`);
  }

  return {
    id: freshAgentId(),
    name: options.name?.trim() || template.name,
    emoji: template.emoji,
    accent: template.accent,
    status: 'online',
    endpointUrl: options.endpointUrl?.trim() || 'http://localhost:8001/chat',
    model: options.model?.trim() || template.model,
    systemPrompt: template.systemPrompt,
    skills: template.skills.map((s) => ({ ...s })),
    templateId: template.id,
    createdAt: Date.now(),
  };
}

/** Stable summary for the picker footer: "500 templates across 15 categories". */
export function getCatalogueSummary(): { templates: number; categories: number; skills: number } {
  const skillIds = new Set<string>();
  for (const t of ALL) for (const s of t.skills) skillIds.add(`${s.category}.${s.id}`);
  return {
    templates: ALL.length,
    categories: getCategories().length,
    skills: skillIds.size,
  };
}
