import { useEffect, useMemo, useState } from 'react';
import type { Agent, Conversation } from '../types';
import { Modal, Field } from './Modal';
import { AgentAvatar } from './Avatar';
import { CheckIcon, HashIcon, PlusIcon, SearchIcon, SparkIcon } from './Icons';
import { ACCENT_PALETTE, EMOJI_PALETTE } from '../data/mock';
import {
  AGENT_TEMPLATES,
  ROLE_FAMILIES,
  SENIORITIES,
  TEMPLATE_GROUPS,
  searchTemplates,
  type AgentTemplate,
  type Seniority,
} from '../data/templates/catalog';

interface NewAgentDialogProps {
  open: boolean;
  onClose: () => void;
  /** Hand-made agent (blank form). */
  onCreate: (input: Omit<Agent, 'id' | 'createdAt' | 'status'>) => void;
  /** Template agent: created AND invited into `room`. */
  onCreateFromTemplate: (templateId: string, name?: string) => void;
  /** Room the new agent will be invited into. */
  room: Conversation | null;
  /** How many templates the catalog currently holds (shown in the header). */
  templateCount?: number;
}

type Tab = 'templates' | 'custom';

export function NewAgentDialog({
  open,
  onClose,
  onCreate,
  onCreateFromTemplate,
  room,
  templateCount = AGENT_TEMPLATES.length,
}: NewAgentDialogProps) {
  const [tab, setTab] = useState<Tab>('templates');

  /* ----------------------------- template tab ----------------------------- */
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string>('All');
  const [seniority, setSeniority] = useState<Seniority | 'any'>('any');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overrideName, setOverrideName] = useState('');

  /* ------------------------------ custom tab ------------------------------ */
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(EMOJI_PALETTE[4]);
  const [accent, setAccent] = useState(ACCENT_PALETTE[0]);
  const [endpointUrl, setEndpointUrl] = useState('http://localhost:8005/chat');
  const [model, setModel] = useState('gpt-4o-mini');
  const [systemPrompt, setSystemPrompt] = useState('');

  useEffect(() => {
    if (!open) return;
    setTab('templates');
    setQuery('');
    setGroup('All');
    setSeniority('any');
    setSelectedId(null);
    setOverrideName('');

    setName('');
    setEmoji(EMOJI_PALETTE[Math.floor(Math.random() * EMOJI_PALETTE.length)]);
    setAccent(ACCENT_PALETTE[Math.floor(Math.random() * ACCENT_PALETTE.length)]);
    setEndpointUrl('http://localhost:8005/chat');
    setModel('gpt-4o-mini');
    setSystemPrompt('');
  }, [open]);

  const results = useMemo(() => {
    // `searchTemplates` already ranks; the group/seniority filters narrow it.
    const base = query.trim() ? searchTemplates(query, 500) : AGENT_TEMPLATES;
    return base.filter(
      (t) =>
        (group === 'All' || t.group === group) &&
        (seniority === 'any' || t.seniority === seniority),
    );
  }, [query, group, seniority]);

  const selected = useMemo(
    () => (selectedId ? AGENT_TEMPLATES.find((t) => t.id === selectedId) ?? null : null),
    [selectedId],
  );

  const pickTemplate = (template: AgentTemplate) => {
    setSelectedId(template.id);
    setOverrideName(template.name);
  };

  const instantiate = () => {
    if (!selected) return;
    const finalName = overrideName.trim() || selected.name;
    onCreateFromTemplate(selected.id, finalName === selected.name ? undefined : finalName);
    onClose();
  };

  const createCustom = () => {
    onCreate({
      name: name.trim() || 'New Agent',
      emoji,
      accent,
      endpointUrl: endpointUrl.trim(),
      model: model.trim(),
      systemPrompt,
      skills: [],
    });
    onClose();
  };

  const roomLabel = room
    ? room.kind === 'channel'
      ? `#${room.name}`
      : room.name
    : 'your workspace';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add an agent"
      subtitle={
        tab === 'templates'
          ? `${templateCount} templates. Pick a role and it joins ${roomLabel} as a member, with the skills of that role.`
          : 'An agent is just a name, an endpoint and a prompt. Nothing else is required.'
      }
      width={780}
      footer={
        <>
          <div className="foot-left">
            {tab === 'templates' && selected && (
              <span className="picker-count">
                <HashIcon size={12} /> joins {roomLabel}
              </span>
            )}
          </div>
          <div className="foot-right">
            <button className="btn ghost sm" onClick={onClose}>
              Cancel
            </button>
            {tab === 'templates' ? (
              <button className="btn primary sm" onClick={instantiate} disabled={!selected}>
                <PlusIcon size={14} /> Create &amp; invite
              </button>
            ) : (
              <button className="btn primary sm" onClick={createCustom}>
                <PlusIcon size={14} /> Create agent
              </button>
            )}
          </div>
        </>
      }
    >
      <div className="tabs" role="tablist">
        <button
          className={`tab${tab === 'templates' ? ' is-on' : ''}`}
          onClick={() => setTab('templates')}
          role="tab"
          aria-selected={tab === 'templates'}
        >
          <SparkIcon size={14} /> From a template
          <span className="tab-count">{templateCount}</span>
        </button>
        <button
          className={`tab${tab === 'custom' ? ' is-on' : ''}`}
          onClick={() => setTab('custom')}
          role="tab"
          aria-selected={tab === 'custom'}
        >
          <PlusIcon size={14} /> Custom
        </button>
      </div>

      {tab === 'templates' ? (
        <>
          <div className="tpl-search">
            <SearchIcon size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 500 templates — try \u201creact\u201d, \u201cseo\u201d, \u201ckubernetes\u201d…"
              aria-label="Search templates"
              autoFocus
            />
            {query && (
              <button className="tpl-clear" onClick={() => setQuery('')} aria-label="Clear search">
                ×
              </button>
            )}
          </div>

          <div className="tpl-filters">
            <div className="filter-chips">
              <button
                className={`chip${group === 'All' ? ' is-on' : ''}`}
                onClick={() => setGroup('All')}
              >
                All
              </button>
              {TEMPLATE_GROUPS.map((g) => (
                <button
                  key={g}
                  className={`chip${group === g ? ' is-on' : ''}`}
                  onClick={() => setGroup(g)}
                >
                  {g}
                </button>
              ))}
            </div>
            <select
              className="tpl-select"
              value={seniority}
              onChange={(e) => setSeniority(e.target.value as Seniority | 'any')}
              aria-label="Filter by seniority"
            >
              <option value="any">Any level</option>
              {SENIORITIES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="tpl-split">
            <ul className="tpl-list" aria-label="Templates">
              {results.map((t) => {
                const family = ROLE_FAMILIES.find((f) => f.slug === t.familySlug);
                return (
                  <li key={t.id}>
                    <button
                      className={`tpl-item${selectedId === t.id ? ' is-on' : ''}`}
                      onClick={() => pickTemplate(t)}
                    >
                      <span className="tpl-emoji">{t.emoji}</span>
                      <span className="tpl-item-text">
                        <span className="tpl-name">{t.name}</span>
                        <span className="tpl-group">{t.group}</span>
                      </span>
                      {family?.aliases?.length ? (
                        <span className="tpl-alias">{family.aliases[0]}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
              {results.length === 0 && (
                <li className="rail-empty">No templates match “{query}”.</li>
              )}
            </ul>

            <div className="tpl-detail">
              {selected ? (
                <>
                  <div className="tpl-detail-head">
                    <AgentAvatar
                      agent={{ name: selected.name, emoji: selected.emoji, accent: accent }}
                      size={48}
                    />
                    <div>
                      <strong>{selected.name}</strong>
                      <span>
                        {selected.group} · {selected.model}
                      </span>
                    </div>
                  </div>

                  <p className="tpl-blurb">{selected.blurb}</p>

                  <div className="tpl-section">
                    <span className="tpl-section-label">Skills it inherits</span>
                    <div className="skill-chips">
                      {selected.skills.map((skill) => (
                        <span key={skill.key} className="skill-chip" title={`depth ${skill.level}/5`}>
                          {skill.label}
                          <em>{skill.level}</em>
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="tpl-section">
                    <span className="tpl-section-label">Picks up</span>
                    <ul className="tpl-duties">
                      {selected.duties.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  </div>

                  <Field label="Name">
                    <input
                      value={overrideName}
                      onChange={(e) => setOverrideName(e.target.value)}
                      placeholder={selected.name}
                      onKeyDown={(e) => e.key === 'Enter' && instantiate()}
                    />
                  </Field>

                  <div className="tpl-invite-note">
                    <CheckIcon size={13} />
                    Creates the agent and invites it into <strong>{roomLabel}</strong>.
                  </div>
                </>
              ) : (
                <div className="tpl-detail-empty">
                  <span className="empty-glyph">✨</span>
                  <p>Pick a template on the left to see its skills.</p>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="settings-preview">
            <AgentAvatar agent={{ name, emoji, accent }} size={52} />
            <div>
              <strong>{name.trim() || 'New Agent'}</strong>
              <span>
                {model || 'no model set'} · {endpointUrl || 'no endpoint yet'}
              </span>
            </div>
          </div>

          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Reviewer"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && createCustom()}
            />
          </Field>

          <Field label="Avatar">
            <div className="emoji-picker">
              {EMOJI_PALETTE.slice(0, 12).map((e) => (
                <button
                  key={e}
                  className={`emoji-opt${emoji === e ? ' is-on' : ''}`}
                  onClick={() => setEmoji(e)}
                  aria-label={`Use ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Accent colour">
            <div className="accent-picker">
              {ACCENT_PALETTE.map((c) => (
                <button
                  key={c}
                  className={`accent-opt${accent === c ? ' is-on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setAccent(c)}
                  aria-label={`Accent ${c}`}
                />
              ))}
            </div>
          </Field>

          <div className="field-grid">
            <Field label="Endpoint URL">
              <input
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                placeholder="http://localhost:8001/chat"
                spellCheck={false}
              />
            </Field>
            <Field label="Model">
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4o-mini"
                spellCheck={false}
              />
            </Field>
          </div>

          <Field label="System prompt" hint="optional">
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={3}
              placeholder="You are a helpful agent that…"
            />
          </Field>
        </>
      )}
    </Modal>
  );
}
