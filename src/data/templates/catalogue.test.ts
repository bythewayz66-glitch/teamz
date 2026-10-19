import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ORDER,
  baseRoleOf,
  getCatalogueSummary,
  getCategories,
  getSeniorityCounts,
  getTemplateById,
  getTemplates,
  getTemplatesByCategory,
  getVariants,
  instantiateTemplate,
  projectTemplate,
  searchTemplates,
  seniorityOf,
} from './index';
import type { TemplateCategory } from '../../types';
import { skillsFor } from './model';

const ALL = getTemplates();

describe('catalogue — shape', () => {
  it('exposes the full catalogue', () => {
    expect(ALL.length).toBeGreaterThan(400);
  });

  it('gives every template a unique id', () => {
    const ids = ALL.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every template a unique display name', () => {
    const names = ALL.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('namespaces every id with its own category', () => {
    for (const t of ALL) {
      expect(t.id.startsWith(`${t.category}.`)).toBe(true);
    }
  });

  it('gives every template a non-empty prompt, description and skill list', () => {
    for (const t of ALL) {
      expect(t.systemPrompt.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(t.skills.length).toBeGreaterThan(0);
    }
  });

  it('resolves every declared skill to a real registry entry', () => {
    for (const t of ALL) {
      for (const s of t.skills) {
        expect(s.id).toBeTruthy();
        expect(s.name).toBeTruthy();
        expect(s.description).toBeTruthy();
        expect(s.category).toBe(t.category);
      }
    }
  });
});

describe('catalogue — categories', () => {
  it('exposes all 15 categories', () => {
    const categories = getCategories();
    expect(categories).toHaveLength(15);
    expect(categories.map((c) => c.category).sort()).toEqual([...CATEGORY_ORDER].sort());
  });

  it('files every template under one of the 15 categories', () => {
    const known = new Set<TemplateCategory>(CATEGORY_ORDER);
    for (const t of ALL) {
      expect(known.has(t.category)).toBe(true);
    }
  });

  it('reports counts that add up to the whole catalogue', () => {
    const total = getCategories().reduce((sum, c) => sum + c.count, 0);
    expect(total).toBe(ALL.length);
  });

  it('gives every category a label, an emoji and at least one template', () => {
    for (const c of getCategories()) {
      expect(c.label.trim().length).toBeGreaterThan(0);
      expect(c.emoji.trim().length).toBeGreaterThan(0);
      expect(c.count).toBeGreaterThan(0);
    }
  });

  it('returns only that category from getTemplatesByCategory', () => {
    for (const c of getCategories()) {
      const inCategory = getTemplatesByCategory(c.category);
      expect(inCategory).toHaveLength(c.count);
      expect(inCategory.every((t) => t.category === c.category)).toBe(true);
    }
  });

  it('summarises the catalogue consistently', () => {
    const summary = getCatalogueSummary();
    expect(summary.templates).toBe(ALL.length);
    expect(summary.categories).toBe(15);
    expect(summary.skills).toBeGreaterThan(0);
  });
});

describe('catalogue — lookup and search', () => {
  it('finds a template by id', () => {
    const first = ALL[0];
    expect(getTemplateById(first.id)).toBe(first);
  });

  it('returns undefined for an unknown id', () => {
    expect(getTemplateById('nope.not-real')).toBeUndefined();
  });

  it('returns everything for an empty query', () => {
    expect(searchTemplates('')).toHaveLength(ALL.length);
  });

  it('narrows rather than widens as tokens are added', () => {
    const one = searchTemplates('engineer');
    const two = searchTemplates('engineer senior');
    expect(two.length).toBeLessThanOrEqual(one.length);
    expect(two.length).toBeGreaterThan(0);
  });

  it('matches on skill names, not just the title', () => {
    const hits = searchTemplates('react');
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.some((t) => t.skills.some((s) => s.name.toLowerCase().includes('react'))),
    ).toBe(true);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchTemplates('zzzzqqqq')).toEqual([]);
  });
});

describe('instantiateTemplate — skill mapping', () => {
  it('maps every declared skill onto the agent, in order', () => {
    for (const template of ALL) {
      const agent = instantiateTemplate(template.id);

      // The agent's own skills are the template's, in order. A lead or
      // principal template may carry one or two extra leadership skills on
      // top, so the declared ones are a prefix rather than the whole list.
      expect(agent.skills.length).toBeGreaterThanOrEqual(template.skills.length);
      expect(agent.skills.slice(0, template.skills.length).map((s) => s.label)).toEqual(
        template.skills.map((s) => s.name),
      );
      expect(agent.skills.slice(0, template.skills.length).map((s) => s.key)).toEqual(
        template.skills.map((s) => `${s.category}.${s.id}`),
      );
    }
  });

  it('gives the defining skill the deepest level and never increases with position', () => {
    for (const template of ALL) {
      const levels = instantiateTemplate(template.id).skills.map((s) => s.level);

      // The defining skill is the deepest one *for that level* — a mid role
      // tops out at 4, a senior at 5. What must hold universally is that the
      // first skill is the deepest and depth never rises down the list.
      expect(levels[0]).toBe(Math.max(...levels));
      for (let i = 1; i < levels.length; i += 1) {
        expect(levels[i]).toBeLessThanOrEqual(levels[i - 1]);
      }
      expect(Math.min(...levels)).toBeGreaterThanOrEqual(2);
      expect(Math.max(...levels)).toBeLessThanOrEqual(5);
    }
  });

  it('produces the documented level curve for a known template', () => {
    // Every catalogue template declares exactly three skills, and the first
    // one is `senior`, whose curve is [5, 4, 4].
    const template = ALL[0];
    expect(template.skills).toHaveLength(3);
    expect(instantiateTemplate(template.id).skills.map((s) => s.level)).toEqual([5, 4, 4]);
  });

  it('follows the documented curve for longer skill lists', () => {
    // Exercised directly, because the catalogue itself never declares more
    // than three skills — the curve still has to be right for the seniority
    // layer, which appends skills.
    const skills = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
      id,
      name: id.toUpperCase(),
      description: '',
      category: 'engineering' as const,
    }));
    expect(skillsFor(skills).map((s) => s.level)).toEqual([5, 5, 4, 3, 3, 2]);
  });

  it('deep-copies skills so an agent cannot mutate the shared catalogue', () => {
    const template = ALL[0];
    const agent = instantiateTemplate(template.id);
    const originalLabel = template.skills[0].name;

    agent.skills[0].label = 'MUTATED';
    agent.skills[0].level = 1;

    expect(template.skills[0].name).toBe(originalLabel);
    expect(instantiateTemplate(template.id).skills[0].label).toBe(originalLabel);
  });
});

describe('instantiateTemplate — seniority', () => {
  // "Senior Frontend Engineer" is the first template in the catalogue, so it
  // is the one the shape tests above exercise. Its own level is `senior`.
  const template = ALL[0];

  it('defaults to the level the template name implies', () => {
    expect(template.seniority).toBe('senior');
    expect(instantiateTemplate(template.id).origin?.seniority).toBe('senior');
  });

  it('creates at a requested level, renaming the role', () => {
    const junior = instantiateTemplate(template.id, { seniority: 'junior' });
    expect(junior.name).toBe('Junior Frontend Engineer');
    expect(junior.origin?.seniority).toBe('junior');
  });

  it('makes the same role read differently at each level', () => {
    const depth = (level: 'junior' | 'mid' | 'senior' | 'lead' | 'principal') =>
      instantiateTemplate(template.id, { seniority: level }).skills[0].level;

    expect(depth('junior')).toBe(3);
    expect(depth('mid')).toBe(4);
    expect(depth('senior')).toBe(5);
    expect(depth('lead')).toBe(5);
    expect(depth('principal')).toBe(5);
  });

  it('adds a leadership skill at lead and a second at principal', () => {
    const base = instantiateTemplate(template.id, { seniority: 'senior' }).skills.length;
    const lead = instantiateTemplate(template.id, { seniority: 'lead' }).skills;
    const principal = instantiateTemplate(template.id, { seniority: 'principal' }).skills;

    expect(lead).toHaveLength(base + 1);
    expect(principal).toHaveLength(base + 2);
    // The extras are real registry skills, not invented labels.
    expect(lead[base].label).toBe('Code review');
    expect(principal[base + 1].label).toBe('App security');
  });

  it('never lists the same skill twice, even when the role already has it', () => {
    // "Code Reviewer" already declares `code-review`, which is also the
    // engineering leadership skill — it must not appear twice at lead.
    const reviewer = ALL.find((t) => t.name === 'Code Reviewer')!;
    const keys = instantiateTemplate(reviewer.id, { seniority: 'lead' }).skills.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('prepends a level-appropriate clause to the prompt', () => {
    const junior = instantiateTemplate(template.id, { seniority: 'junior' });
    expect(junior.systemPrompt).toContain('early in your career');
    expect(junior.systemPrompt).toContain(template.systemPrompt);
  });

  it('leaves the template itself untouched', () => {
    instantiateTemplate(template.id, { seniority: 'principal' });
    expect(template.name).toBe('Senior Frontend Engineer');
    expect(template.seniority).toBe('senior');
    expect(template.skills).toHaveLength(3);
  });
});

describe('projectTemplate and getVariants', () => {
  const template = ALL[0];

  it('returns the same object when the level already matches', () => {
    expect(projectTemplate(template, 'senior')).toBe(template);
  });

  it('produces all five levels of one role, junior first', () => {
    const variants = getVariants(template.id);
    expect(variants.map((v) => v.seniority)).toEqual([
      'junior',
      'mid',
      'senior',
      'lead',
      'principal',
    ]);
    expect(variants.map((v) => v.name)).toEqual([
      'Junior Frontend Engineer',
      'Frontend Engineer',
      'Senior Frontend Engineer',
      'Lead Frontend Engineer',
      'Principal Frontend Engineer',
    ]);
  });

  it('keeps the base role constant across every level', () => {
    for (const v of getVariants(template.id)) {
      expect(v.baseRole).toBe('Frontend Engineer');
      expect(v.category).toBe(template.category);
    }
  });

  it('returns nothing for an unknown id', () => {
    expect(getVariants('nope.not-real')).toEqual([]);
  });
});

describe('seniorityOf and baseRoleOf', () => {
  it('reads the level out of a name', () => {
    expect(seniorityOf('Senior Frontend Engineer')).toBe('senior');
    expect(seniorityOf('Junior Data Analyst')).toBe('junior');
    expect(seniorityOf('Staff Engineer')).toBe('principal');
    expect(seniorityOf('Head of Design')).toBe('lead');
    expect(seniorityOf('Backend Engineer')).toBe('mid');
  });

  it('strips the level marker to get the base role', () => {
    expect(baseRoleOf('Senior Frontend Engineer')).toBe('Frontend Engineer');
    expect(baseRoleOf('Head of Design')).toBe('Design');
    expect(baseRoleOf('Backend Engineer')).toBe('Backend Engineer');
  });

  it('never returns an empty base role', () => {
    for (const t of ALL) {
      expect(t.baseRole.trim().length).toBeGreaterThan(0);
    }
  });

  it('counts the catalogue by level', () => {
    const counts = getSeniorityCounts();
    expect(counts.map((c) => c.seniority)).toEqual([
      'junior',
      'mid',
      'senior',
      'lead',
      'principal',
    ]);
    expect(counts.reduce((sum, c) => sum + c.count, 0)).toBe(ALL.length);
  });
});

describe('instantiateTemplate — agent shape', () => {
  it('copies the template prompt, model, emoji and accent', () => {
    const template = ALL[0];
    const agent = instantiateTemplate(template.id);

    expect(agent.systemPrompt).toBe(template.systemPrompt);
    expect(agent.model).toBe(template.model);
    expect(agent.emoji).toBe(template.emoji);
    expect(agent.accent).toBe(template.accent);
    expect(agent.name).toBe(template.name);
  });

  it('records provenance back to the template', () => {
    const template = ALL[0];
    const agent = instantiateTemplate(template.id);

    expect(agent.origin).toEqual({
      templateId: template.id,
      familySlug: template.category,
      role: template.name,
      seniority: template.seniority,
    });
  });

  it('starts the agent online with a fresh id each time', () => {
    const template = ALL[0];
    const a = instantiateTemplate(template.id);
    const b = instantiateTemplate(template.id);

    expect(a.status).toBe('online');
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^agent-/);
  });

  it('honours a name override without touching the template', () => {
    const template = ALL[0];
    const agent = instantiateTemplate(template.id, { name: '  My Custom Name  ' });

    expect(agent.name).toBe('My Custom Name');
    expect(template.name).not.toBe('My Custom Name');
  });

  it('throws on an unknown template id', () => {
    expect(() => instantiateTemplate('nope.not-real')).toThrow(/Unknown template id/);
  });
});
