import { useMemo, useState } from 'react';
import type { CatalogSkill, SkillBundle, TemplateCategory } from '../types';
import {
  CATEGORY_LABELS,
  bundleIsFullySelected,
  bundleIsPartiallySelected,
  expandBundle,
  getBundles,
  searchSkills,
  toggleBundle,
} from '../data/templates';
import { CheckIcon, SearchIcon } from './Icons';

interface SkillPickerProps {
  /** Registry keys (`category.id`) currently selected, in display order. */
  selectedKeys: string[];
  onChange: (keys: string[]) => void;
  /**
   * Category the picker is most interested in — its bundles are shown
   * first, and the category filter defaults to it. Omit for "all".
   */
  focusCategory?: TemplateCategory;
}

type CategoryFilter = 'all' | TemplateCategory;

function skillKey(skill: CatalogSkill): string {
  return `${skill.category}.${skill.id}`;
}

/**
 * Pick skills — with real names and descriptions — and bundles.
 *
 * A bundle is one click: it adds every member skill, and the picker shows
 * the members so each one can be removed on its own afterwards. A skill is
 * never an empty label: the row always shows the name and the description
 * from the registry, and the caller stores the keys on the agent.
 */
export function SkillPicker({ selectedKeys, onChange, focusCategory }: SkillPickerProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>(focusCategory ?? 'all');
  const [expandedBundleId, setExpandedBundleId] = useState<string | null>(null);

  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys]);

  const bundles = useMemo(() => {
    const all = getBundles();
    if (!focusCategory) return all;
    // The role's own bundles first, then the rest — nothing is hidden.
    const own = all.filter((b) =>
      b.skillKeys.some((k) => k.startsWith(`${focusCategory}.`)),
    );
    const rest = all.filter((b) => !own.includes(b));
    return [...own, ...rest];
  }, [focusCategory]);

  const skills = useMemo(() => {
    const found = searchSkills(query);
    return category === 'all' ? found : found.filter((s) => s.category === category);
  }, [query, category]);

  const categories = useMemo(() => {
    const seen = new Map<TemplateCategory, number>();
    for (const skill of searchSkills(query)) {
      seen.set(skill.category, (seen.get(skill.category) ?? 0) + 1);
    }
    return [...seen.entries()];
  }, [query]);

  const toggleSkill = (skill: CatalogSkill) => {
    const key = skillKey(skill);
    onChange(
      selected.has(key) ? selectedKeys.filter((k) => k !== key) : [...selectedKeys, key],
    );
  };

  const toggleBundleById = (bundle: SkillBundle) => {
    onChange(toggleBundle(bundle, selectedKeys));
  };

  return (
    <div>
      <div className="input-with-icon tpl-search">
        <SearchIcon size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills — try “review”, “sql”, “interview”…"
          spellCheck={false}
          aria-label="Search skills"
        />
        {query && (
          <button className="tpl-clear" onClick={() => setQuery('')} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      <div className="tpl-tabs" role="tablist" aria-label="Skill categories">
        <button
          className={`tpl-tab${category === 'all' ? ' is-on' : ''}`}
          onClick={() => setCategory('all')}
          role="tab"
          aria-selected={category === 'all'}
        >
          All <em>{searchSkills(query).length}</em>
        </button>
        {categories.map(([cat, count]) => (
          <button
            key={cat}
            className={`tpl-tab${category === cat ? ' is-on' : ''}`}
            onClick={() => setCategory(cat)}
            role="tab"
            aria-selected={category === cat}
          >
            {CATEGORY_LABELS[cat]} <em>{count}</em>
          </button>
        ))}
      </div>

      <div className="field">
        <span className="field-label">
          Bundles
          <em>one click adds the whole group — members can be removed individually</em>
        </span>
        <div className="tpl-list" role="list">
          {bundles.map((bundle) => {
            const full = bundleIsFullySelected(bundle, selectedKeys);
            const partial = bundleIsPartiallySelected(bundle, selectedKeys);
            const isOpen = expandedBundleId === bundle.id;
            const members = expandBundle(bundle);
            return (
              <div key={bundle.id} className="tpl-card" role="listitem">
                <div className="tpl-card-main">
                  <button
                    className={`checkbox${full ? ' is-on' : ''}`}
                    onClick={() => toggleBundleById(bundle)}
                    aria-pressed={full}
                    aria-label={`${full ? 'Remove' : 'Add'} the ${bundle.name} bundle`}
                  >
                    {full && <CheckIcon size={12} />}
                  </button>
                  <button
                    className="tpl-card-body"
                    onClick={() => setExpandedBundleId(isOpen ? null : bundle.id)}
                    aria-expanded={isOpen}
                  >
                    <span className="tpl-card-title">
                      {bundle.name}
                      {partial && !full && <span className="tpl-chip">partial</span>}
                      {full && <span className="tpl-chip">added</span>}
                    </span>
                    <span className="tpl-card-desc">{bundle.description}</span>
                    <span className="tpl-skills">
                      {members.map((m) => (
                        <span key={m.id} className="tpl-skill">
                          {m.name}
                        </span>
                      ))}
                    </span>
                  </button>
                </div>
                {isOpen && (
                  <div className="tpl-detail">
                    <ul className="tpl-skill-list">
                      {members.map((m) => (
                        <li key={m.id}>
                          <strong>{m.name}</strong>
                          <span>{m.description}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="field">
        <span className="field-label">
          Skills
          <em>
            {selectedKeys.length === 0
              ? 'none picked yet'
              : `${selectedKeys.length} picked`}
          </em>
        </span>
        <div className="tpl-list" role="list">
          {skills.length === 0 && (
            <div className="tpl-empty">
              <strong>Nothing matches “{query}”.</strong>
              <span>Try a broader term, or pick a category above.</span>
            </div>
          )}
          {skills.map((skill) => {
            const key = skillKey(skill);
            const on = selected.has(key);
            return (
              <div key={key} className={`tpl-card${on ? ' is-selected' : ''}`} role="listitem">
                <button className="tpl-card-main" onClick={() => toggleSkill(skill)}>
                  <span className={`checkbox${on ? ' is-on' : ''}`}>
                    {on && <CheckIcon size={12} />}
                  </span>
                  <span className="tpl-card-body">
                    <span className="tpl-card-title">
                      {skill.name}
                      <span className="tpl-chip">{CATEGORY_LABELS[skill.category]}</span>
                    </span>
                    <span className="tpl-card-desc">{skill.description}</span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
