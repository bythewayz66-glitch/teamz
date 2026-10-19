import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import { Modal, Field } from './Modal';
import { AgentAvatar } from './Avatar';
import { CheckIcon, HashIcon, UsersIcon } from './Icons';

interface ChannelDialogProps {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  /** When editing an existing channel, pass it in. */
  editing?: { id: string; name: string; topic?: string; agentIds: string[] } | null;
  onCreate?: (name: string, agentIds: string[], topic?: string) => void;
  onUpdateMembers?: (id: string, agentIds: string[]) => void;
  onRename?: (id: string, name: string) => void;
  mode?: 'create' | 'members';
}

export function ChannelDialog({
  open,
  onClose,
  agents,
  editing,
  onCreate,
  onUpdateMembers,
  onRename,
  mode = 'create',
}: ChannelDialogProps) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setTopic(editing?.topic ?? '');
    setSelected(editing?.agentIds ?? agents.slice(0, 2).map((a) => a.id));
  }, [open, editing, agents]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = () => {
    if (mode === 'members' && editing) {
      onUpdateMembers?.(editing.id, selected);
      if (name.trim() && name.trim() !== editing.name) onRename?.(editing.id, name.trim());
    } else {
      onCreate?.(name.trim() || 'New Channel', selected, topic.trim() || undefined);
    }
    onClose();
  };

  const isMembersMode = mode === 'members';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isMembersMode ? `Members of #${editing?.name ?? ''}` : 'New channel'}
      subtitle={
        isMembersMode
          ? 'Add or remove agents. Every message you send goes to all of them.'
          : 'A channel is a room with several agents in it. Your message fans out to all members.'
      }
      width={540}
      footer={
        <>
          <div className="foot-left">
            <span className="picker-count">{selected.length} selected</span>
          </div>
          <div className="foot-right">
            <button className="btn ghost sm" onClick={onClose}>Cancel</button>
            <button className="btn primary sm" onClick={submit} disabled={selected.length === 0}>
              <CheckIcon size={14} />
              {isMembersMode ? 'Save members' : 'Create channel'}
            </button>
          </div>
        </>
      }
    >
      <div className="field-grid">
        <Field label="Channel name">
          <div className="input-with-icon">
            <HashIcon size={14} />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="design-review"
              autoFocus={!isMembersMode}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        </Field>
      </div>

      <Field label="Topic" hint="optional">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="What this room is for"
        />
      </Field>

      <div className="field">
        <span className="field-label">
          Member agents
          <em>
            <UsersIcon size={12} /> pick at least one
          </em>
        </span>
        <ul className="member-picker">
          {agents.map((a) => {
            const on = selected.includes(a.id);
            return (
              <li key={a.id}>
                <button className={`member-opt${on ? ' is-on' : ''}`} onClick={() => toggle(a.id)}>
                  <AgentAvatar agent={a} size={30} showStatus={a.status} />
                  <span className="mo-text">
                    <span className="mo-name">{a.name}</span>
                    <span className="mo-model">{a.model}</span>
                  </span>
                  <span className={`checkbox${on ? ' is-on' : ''}`}>{on && <CheckIcon size={12} />}</span>
                </button>
              </li>
            );
          })}
          {agents.length === 0 && <li className="rail-empty">Create an agent first.</li>}
        </ul>
      </div>
    </Modal>
  );
}
