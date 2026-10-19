import { useMemo, useState } from 'react';
import type { Seniority, TemplateCategory } from '../types';
import {
  type AgentTemplate,
  SENIORITY_BLURB,
  SENIORITY_LABELS,
  SENIORITY_ORDER,
  filterTemplates,
  getCatalogueSummary,
  getCategories,
  getTemplates,
  projectTemplate,
} from '../data/templates';
import { AgentAvatar } from './Avatar';
import { SearchIcon } from './Icons';

interface TemplatePickerProps {
  /** Currently selected template id, or null. */
  selectedId: string | null;
  onSelect: (template: AgentTemplate | null) => void;
  /** Double-click / Enter creates immediately. */
  onCreate: (template: AgentTemplate) => void;
}

type Tab = 'all' | TemplateCategory;
/** `any` keeps each template at its own level; a level projects every role onto it. */
type LevelFilter = 'any' | Seniority;

/**
 * Browse + search the template catalogue.
 *
 * Everything here is pure data lookups over `src/data/templates` — no agent is
 * created until the caller acts on `onCreate`, so opening this panel costs
 * nothing beyond rendering the current result page.
 *
 * The three controls compose: category narrows the pool, seniority projects
 * it, and the search box filters what is left. All active constraints apply
 * together, so "engineering" + "senior" + "react" is a genuinely narrow query.
 */
export function TemplatePicker({ selectedId, onSelect, onCreate }: TemplatePickerProps) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [level, setLevel] = useState<LevelFilter>('any');
  const [expandedId, setExpandedId] = useState<string | null>(selectedId);

  const categories = useMemo(() => getCategories(), []);
  const summary = useMemo(() => getCatalogueSummary(), []);

  /**
   * The pool the other two controls act on.
   *
   * With no level chosen this is the catalogue as authored. With a level
   * chosen, every role is projected onto that level — which is what makes
   * "Senior Frontend Engineer" and "Frontend Engineer" comparable: they are
   * the same role, rendered at two levels, rather than two unrelated entries.
   */
  const pool = useMemo(() => {
    if (level === 'any') return getTemplates();
    return getTemplates().map((t) => projectTemplate(t, level));
  }, [level]);

  const results = useMemo(() => {
    const inCategory =
      tab === 'all' ? pool : pool.filter((t) => t.category === tab);
    return filterTemplates(inCategory, query);
  }, [pool, tab, query]);

  const totalForTab =
    tab === 'all' ? pool.length : pool.filter((t) => t.category === tab).length;

  const handleClick = (template: AgentTemplate) => {
    const next = expandedId === template.id ? null : template.id;
    setExpandedId(next);
    onSelect(next ? template : null);
  };

  return (
    <div className="tpl-picker">
      <div className="input-with-icon tpl-search">
        <SearchIcon size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${summary.templates} templates — try “react”, “pricing”, “interview”…`}
          spellCheck={false}
          autoFocus
          aria-label="Search templates"
        />
        {query && (
          <button className="tpl-clear" onClick={() => setQuery('')} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      <div className="tpl-tabs" role="tablist" aria-label="Template categories">
        <button
          className={`tpl-tab${tab === 'all' ? ' is-on' : ''}`}
          onClick={() => setTab('all')}
          role="tab"
          aria-selected={tab === 'all'}
        >
          All <em>{summary.templates}</em>
        </button>
        {categories.map((c) => (
          <button
            key={c.category}
            className={`tpl-tab${tab === c.category ? ' is-on' : ''}`}
            onClick={() => setTab(c.category)}
            role="tab"
            aria-selected={tab === c.category}
          >
            <span aria-hidden="true">{c.emoji}</span> {c.label} <em>{c.count}</em>
          </button>
        ))}
      </div>

      <div className="tpl-levels" role="group" aria-label="Seniority filter">
        <span className="tpl-levels-label">Level</span>
        <button
          className={`tpl-level${level === 'any' ? ' is-on' : ''}`}
          onClick={() => setLevel('any')}
          aria-pressed={level === 'any'}
          title="Show each role at the level its name implies"
        >
          Any
        </button>
        {SENIORITY_ORDER.map((s) => (
          <button
            key={s}
            className={`tpl-level${level === s ? ' is-on' : ''}`}
            onClick={() => setLevel(s)}
            aria-pressed={level === s}
            title={SENIORITY_BLURB[s]}
          >
            {SENIORITY_LABELS[s]}
          </button>
        ))}
        {level !== 'any' && (
          <span className="tpl-levels-note">
            every role shown as <strong>{SENIORITY_LABELS[level]}</strong> — compare it against
            another level
          </span>
        )}
      </div>

      <div className="tpl-meta">
        <span>
          {results.length === totalForTab || query
            ? `${results.length} ${results.length === 1 ? 'template' : 'templates'}`
            : `${results.length} of ${totalForTab}`}
          {query && <em> matching “{query}”</em>}
        </span>
        <span className="tpl-meta-hint">
          {summary.skills} skills bundled · pick one to create on demand
        </span>
      </div>

      <div className="tpl-list" role="list">
        {results.length === 0 && (
          <div className="tpl-empty">
            <strong>Nothing matches “{query}”.</strong>
            <span>Try a broader term, or pick a category above.</span>
          </div>
        )}

        {results.map((template) => {
          const isOpen = expandedId === template.id;
          const isSelected = selectedId === template.id;
          return (
            <div
              key={`${template.id}-${template.seniority}`}
              className={`tpl-card${isSelected ? ' is-selected' : ''}${isOpen ? ' is-open' : ''}`}
              role="listitem"
            >
              <button
                className="tpl-card-main"
                onClick={() => handleClick(template)}
                onDoubleClick={() => onCreate(template)}
                aria-expanded={isOpen}
              >
                <AgentAvatar agent={template} size={38} />
                <span className="tpl-card-body">
                  <span className="tpl-card-title">
                    {template.name}
                    <span className="tpl-chip">{template.category}</span>
                    <span className={`tpl-chip is-level lv-${template.seniority}`}>
                      {SENIORITY_LABELS[template.seniority]}
                    </span>
                  </span>
                  <span className="tpl-card-desc">{template.description}</span>
                  <span className="tpl-skills">
                    {template.skills.slice(0, 3).map((s) => (
                      <span key={s.id} className="tpl-skill">
                        {s.name}
                      </span>
                    ))}
                    {template.skills.length > 3 && (
                      <span className="tpl-skill more">+{template.skills.length - 3}</span>
                    )}
                  </span>
                </span>
                <span className="tpl-card-right">
                  <span className="tpl-model">{template.model}</span>
                  <span className="tpl-use">Use →</span>
                </span>
              </button>

              {isOpen && (
                <div className="tpl-detail">
                  <div className="tpl-detail-block">
                    <span className="tpl-detail-label">System prompt</span>
                    <p>{template.systemPrompt}</p>
                  </div>
                  <div className="tpl-detail-block">
                    <span className="tpl-detail-label">Skills ({template.skills.length})</span>
                    <ul className="tpl-skill-list">
                      {template.skills.map((s) => (
                        <li key={s.id}>
                          <strong>{s.name}</strong>
                          <span>{s.description}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="tpl-detail-foot">
                    <button className="btn primary sm" onClick={() => onCreate(template)}>
                      Create this agent
                    </button>
                    <span className="tpl-id">id: {template.id}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
