import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import { Modal, Field } from './Modal';
import { AgentAvatar } from './Avatar';
import { PlusIcon } from './Icons';
import { ACCENT_PALETTE, EMOJI_PALETTE } from '../data/mock';

interface NewAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: Omit<Agent, 'id' | 'createdAt' | 'status'>) => void;
}

export function NewAgentDialog({ open, onClose, onCreate }: NewAgentDialogProps) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(EMOJI_PALETTE[4]);
  const [accent, setAccent] = useState(ACCENT_PALETTE[0]);
  const [endpointUrl, setEndpointUrl] = useState('http://localhost:8005/chat');
  const [model, setModel] = useState('gpt-4o-mini');
  const [systemPrompt, setSystemPrompt] = useState('');

  useEffect(() => {
    if (!open) return;
    setName('');
    setEmoji(EMOJI_PALETTE[Math.floor(Math.random() * EMOJI_PALETTE.length)]);
    setAccent(ACCENT_PALETTE[Math.floor(Math.random() * ACCENT_PALETTE.length)]);
    setEndpointUrl('http://localhost:8005/chat');
    setModel('gpt-4o-mini');
    setSystemPrompt('');
  }, [open]);

  const create = () => {
    onCreate({
      name: name.trim() || 'New Agent',
      emoji,
      accent,
      endpointUrl: endpointUrl.trim(),
      model: model.trim(),
      systemPrompt,
    });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New agent"
      subtitle="An agent is just a name, an endpoint and a prompt. Nothing else is required."
      width={540}
      footer={
        <>
          <div className="foot-left" />
          <div className="foot-right">
            <button className="btn ghost sm" onClick={onClose}>Cancel</button>
            <button className="btn primary sm" onClick={create}>
              <PlusIcon size={14} /> Create agent
            </button>
          </div>
        </>
      }
    >
      <div className="settings-preview">
        <AgentAvatar agent={{ name, emoji, accent }} size={52} />
        <div>
          <strong>{name.trim() || 'New Agent'}</strong>
          <span>{model || 'no model set'} · {endpointUrl || 'no endpoint yet'}</span>
        </div>
      </div>

      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Reviewer"
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && create()}
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
    </Modal>
  );
}
