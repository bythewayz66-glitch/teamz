import { useEffect, useState } from 'react';
import type { Agent, AgentStatus } from '../types';
import { Modal, Field } from './Modal';
import { AgentAvatar } from './Avatar';
import { CheckIcon, RefreshIcon, TrashIcon } from './Icons';
import { ACCENT_PALETTE, EMOJI_PALETTE } from '../data/mock';
import { pingAgent } from '../api/agents';
import { formatRelative } from '../lib/format';

interface AgentSettingsProps {
  agent: Agent | null;
  onClose: () => void;
  onSave: (id: string, patch: Partial<Agent>) => void;
  onDelete: (id: string) => void;
  onOpenChat: (id: string) => void;
}

const STATUSES: AgentStatus[] = ['online', 'busy', 'offline'];

export function AgentSettings({ agent, onClose, onSave, onDelete, onOpenChat }: AgentSettingsProps) {
  const [draft, setDraft] = useState<Agent | null>(agent);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setDraft(agent);
    setTestResult(null);
    setConfirmDelete(false);
  }, [agent]);

  if (!draft) return null;

  const dirty = agent !== null && JSON.stringify(draft) !== JSON.stringify(agent);

  const patch = (p: Partial<Agent>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const save = () => {
    onSave(draft.id, {
      name: draft.name.trim() || 'Untitled Agent',
      emoji: draft.emoji,
      accent: draft.accent,
      status: draft.status,
      endpointUrl: draft.endpointUrl.trim(),
      model: draft.model.trim(),
      systemPrompt: draft.systemPrompt,
    });
    onClose();
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await pingAgent(draft);
    setTestResult(result);
    setTesting(false);
  };

  return (
    <Modal
      open={Boolean(agent)}
      onClose={onClose}
      title="Agent settings"
      subtitle="Point this agent at a model running on your own server."
      width={560}
      footer={
        <>
          <div className="foot-left">
            {confirmDelete ? (
              <div className="confirm-inline">
                <span>Delete this agent?</span>
                <button className="btn danger sm" onClick={() => onDelete(draft.id)}>
                  Yes, delete
                </button>
                <button className="btn ghost sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="btn ghost sm danger-hover" onClick={() => setConfirmDelete(true)}>
                <TrashIcon size={14} /> Delete
              </button>
            )}
          </div>
          <div className="foot-right">
            <button className="btn ghost sm" onClick={() => { onOpenChat(draft.id); onClose(); }}>
              Open chat
            </button>
            <button className="btn primary sm" onClick={save} disabled={!dirty}>
              <CheckIcon size={14} /> Save changes
            </button>
          </div>
        </>
      }
    >
      <div className="settings-preview">
        <AgentAvatar agent={draft} size={56} showStatus={draft.status} />
        <div>
          <strong>{draft.name || 'Untitled Agent'}</strong>
          <span>
            {draft.origin ? `${draft.origin.role} · ` : ''}
            Created {formatRelative(draft.createdAt)} ago · {draft.model || 'no model set'}
          </span>
        </div>
      </div>

      {draft.skills.length > 0 && (
        <div className="field">
          <span className="field-label">
            Skills
            <em>{draft.origin ? `from ${draft.origin.templateId}` : 'set by hand'}</em>
          </span>
          <div className="skill-chips">
            {draft.skills.map((skill) => (
              <span key={skill.key} className="skill-chip" title={`depth ${skill.level}/5`}>
                {skill.label}
                <em>{skill.level}</em>
              </span>
            ))}
          </div>
        </div>
      )}

      <Field label="Name">
        <input
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="e.g. Researcher"
          autoFocus
        />
      </Field>

      <div className="field-grid">
        <Field label="Avatar emoji">
          <div className="emoji-picker">
            {EMOJI_PALETTE.map((e) => (
              <button
                key={e}
                className={`emoji-opt${draft.emoji === e ? ' is-on' : ''}`}
                onClick={() => patch({ emoji: e })}
                aria-label={`Use ${e}`}
              >
                {e}
              </button>
            ))}
          </div>
        </Field>
      </div>

      <div className="field-grid">
        <Field label="Accent colour">
          <div className="accent-picker">
            {ACCENT_PALETTE.map((c) => (
              <button
                key={c}
                className={`accent-opt${draft.accent === c ? ' is-on' : ''}`}
                style={{ background: c }}
                onClick={() => patch({ accent: c })}
                aria-label={`Accent ${c}`}
              />
            ))}
          </div>
        </Field>
        <Field label="Status">
          <div className="seg">
            {STATUSES.map((s) => (
              <button
                key={s}
                className={draft.status === s ? 'is-on' : ''}
                onClick={() => patch({ status: s })}
              >
                {s}
              </button>
            ))}
          </div>
        </Field>
      </div>

      <Field label="Endpoint URL" hint="where your server listens">
        <input
          value={draft.endpointUrl}
          onChange={(e) => patch({ endpointUrl: e.target.value })}
          placeholder="http://localhost:8001/chat"
          spellCheck={false}
        />
      </Field>

      <div className="test-row">
        <button className="btn ghost sm" onClick={runTest} disabled={testing}>
          <RefreshIcon size={14} /> {testing ? 'Testing…' : 'Test connection'}
        </button>
        {testResult && (
          <span className={`test-out${testResult.ok ? ' ok' : ' bad'}`}>
            {testResult.ok ? '✓' : '✕'} {testResult.message} · {testResult.latencyMs}ms
          </span>
        )}
      </div>

      <Field label="Model" hint="whatever your server expects">
        <input
          value={draft.model}
          onChange={(e) => patch({ model: e.target.value })}
          placeholder="gpt-4o-mini · qwen2.5-coder:32b · llama3.1:70b"
          spellCheck={false}
        />
      </Field>

      <Field label="System prompt" hint={`${draft.systemPrompt.length} chars`}>
        <textarea
          value={draft.systemPrompt}
          onChange={(e) => patch({ systemPrompt: e.target.value })}
          rows={5}
          placeholder="You are a helpful agent that…"
        />
      </Field>
    </Modal>
  );
}
