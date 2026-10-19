import { useMemo, useState } from 'react';
import type { TemplateCategory } from '../types';
import {
  type AgentTemplate,
  getCatalogueSummary,
  getCategories,
  getTemplatesByCategory,
  searchTemplates,
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

/**
 * Browse + search the template catalogue.
 *
 * Everything here is pure data lookups over `src/data/templates` — no agent is
 * created until the caller acts on `onCreate`, so opening this panel costs
 * nothing beyond rendering the current result page.
 */
export function TemplatePicker({ selectedId, onSelect, onCreate }: TemplatePickerProps) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [expandedId, setExpandedId] = useState<string | null>(selectedId);

  const categories = useMemo(() => getCategories(), []);
  const summary = useMemo(() => getCatalogueSummary(), []);

  const results = useMemo(() => {
    const base = query.trim() ? searchTemplates(query) : getTemplatesByCategory(tab as TemplateCategory);
    if (query.trim() && tab !== 'all') return base.filter((t) => t.category === tab);
    return base;
  }, [query, tab]);

  const totalForTab = tab === 'all' ? summary.templates : categories.find((c) => c.category === tab)?.count ?? 0;

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

      <div className="tpl-meta">
        <span>
          {results.length === totalForTab || query
            ? `${results.length} ${results.length === 1 ? 'template' : 'templates'}`
            : `${results.length} of ${totalForTab}`}
          {query && <em> matching “{query}”</em>}
        </span>
        <span className="tpl-meta-hint">{summary.skills} skills bundled · pick one to create on demand</span>
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
              key={template.id}
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
