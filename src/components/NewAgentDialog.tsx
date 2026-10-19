import { useEffect, useState } from 'react';
import type { Agent, Conversation } from '../types';
import { Modal, Field } from './Modal';
import { AgentAvatar } from './Avatar';
import { CheckIcon, HashIcon, PlusIcon, SparkIcon } from './Icons';
import { TemplatePicker } from './TemplatePicker';
import { ACCENT_PALETTE, EMOJI_PALETTE } from '../data/mock';
import { getCatalogueSummary, type AgentTemplate } from '../data/templates';

interface NewAgentDialogProps {
  open: boolean;
  onClose: () => void;
  /** Hand-made agent (blank form). */
  onCreate: (input: Omit<Agent, 'id' | 'createdAt' | 'status'>) => void;
  /** Template agent: created AND invited into the current room. */
  onCreateFromTemplate: (templateId: string, name?: string) => void;
  /** Room the new agent will be invited into. */
  room: Conversation | null;
}

type Tab = 'templates' | 'custom';

export function NewAgentDialog({
  open,
  onClose,
  onCreate,
  onCreateFromTemplate,
  room,
}: NewAgentDialogProps) {
  const [tab, setTab] = useState<Tab>('templates');

  /* ----------------------------- template tab ----------------------------- */
  const [selected, setSelected] = useState<AgentTemplate | null>(null);
  const [overrideName, setOverrideName] = useState('');

  /* ------------------------------ custom tab ------------------------------ */
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(EMOJI_PALETTE[4]);
  const [accent, setAccent] = useState(ACCENT_PALETTE[0]);
  const [endpointUrl, setEndpointUrl] = useState('http://localhost:8005/chat');
  const [model, setModel] = useState('gpt-4o-mini');
  const [systemPrompt, setSystemPrompt] = useState('');

  const [summary] = useState(getCatalogueSummary);

  useEffect(() => {
    if (!open) return;
    setTab('templates');
    setSelected(null);
    setOverrideName('');

    setName('');
    setEmoji(EMOJI_PALETTE[Math.floor(Math.random() * EMOJI_PALETTE.length)]);
    setAccent(ACCENT_PALETTE[Math.floor(Math.random() * ACCENT_PALETTE.length)]);
    setEndpointUrl('http://localhost:8005/chat');
    setModel('gpt-4o-mini');
    setSystemPrompt('');
  }, [open]);

  const handleSelect = (template: AgentTemplate | null) => {
    setSelected(template);
    if (template) setOverrideName(template.name);
  };

  const instantiate = (template: AgentTemplate | null = selected) => {
    if (!template) return;
    const finalName = overrideName.trim() || template.name;
    onCreateFromTemplate(template.id, finalName === template.name ? undefined : finalName);
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
          ? `${summary.templates} templates across ${summary.categories} categories. Pick a role and it joins ${roomLabel} as a member, with the skills of that role.`
          : 'An agent is just a name, an endpoint and a prompt. Nothing else is required.'
      }
      width={820}
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
              <button className="btn primary sm" onClick={() => instantiate()} disabled={!selected}>
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
          <span className="tab-count">{summary.templates}</span>
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
          <TemplatePicker
            selectedId={selected?.id ?? null}
            onSelect={handleSelect}
            onCreate={instantiate}
          />

          {selected && (
            <div className="tpl-invite-row">
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
            </div>
          )}
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
