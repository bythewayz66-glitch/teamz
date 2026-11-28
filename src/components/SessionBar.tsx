import { useEffect, useState } from 'react';
import type { Conversation, RetentionPolicy } from '../types';
import { RETENTION_PRESETS, describeRetention, retentionKey } from '../lib/sessions';

interface Props {
  conversation: Conversation;
  agentName?: string;
  onRename: (name: string) => void;
  onRetention: (policy: RetentionPolicy) => void;
  onArchive: (archived: boolean) => void;
  onStar: (starred: boolean) => void;
  onResume: () => void;
  onOpenHome?: () => void;
}

const KIND: Record<string, string> = {
  chat: 'Chat session',
  work: 'Work session — what this agent did in the Build Room',
  room: 'Shared room — every agent, watched live',
};

/** Slim bar above a session: name, status, retention, and Resume when work was cut off. */
export function SessionBar({ conversation, agentName, onRename, onRetention, onArchive, onStar, onResume, onOpenHome }: Props) {
  const session = conversation.session;
  const [name, setName] = useState(conversation.name);
  useEffect(() => setName(conversation.name), [conversation.id, conversation.name]);
  if (!session) return null;

  const canRename = session.kind !== 'room';
  const commit = () => {
    const t = name.trim();
    if (t && t !== conversation.name) onRename(t);
    else setName(conversation.name);
  };
  const current = retentionKey(session.retention);
  const presets = RETENTION_PRESETS.some((p) => retentionKey(p.policy) === current)
    ? RETENTION_PRESETS
    : [...RETENTION_PRESETS, { label: describeRetention(session.retention), policy: session.retention }];

  return (
    <div className="session-bar" role="group" aria-label="Session">
      <div className="session-bar-main">
        {canRename ? (
          <input
            className="session-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setName(conversation.name);
            }}
            aria-label="Session name"
          />
        ) : (
          <strong className="session-name-static">{conversation.name}</strong>
        )}
        <span className="session-kind">{KIND[session.kind]}</span>
        {session.kind !== 'room' && (
          <button
            className={`star-btn${session.starred ? ' is-on' : ''}`}
            onClick={() => onStar(!session.starred)}
            aria-pressed={Boolean(session.starred)}
            title={session.starred ? 'Starred: never auto-deleted. Click to unstar.' : 'Star to keep this session even if retention would prune it'}
          >
            {session.starred ? '★' : '☆'}
          </button>
        )}
        {session.status === 'interrupted' && <span className="kind-chip kind-warn">Interrupted</span>}
        {session.status === 'archived' && <span className="kind-chip">Archived</span>}
      </div>
      <div className="session-bar-actions">
        {session.status === 'interrupted' && (
          <button className="btn primary sm" onClick={onResume}>
            Resume
          </button>
        )}
        <label className="session-retention">
          <span>Retention</span>
          <select
            value={current}
            onChange={(e) => {
              const p = presets.find((x) => retentionKey(x.policy) === e.target.value);
              if (p) onRetention(p.policy);
            }}
            aria-label="Retention policy"
          >
            {presets.map((p) => (
              <option key={retentionKey(p.policy)} value={retentionKey(p.policy)}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {session.kind !== 'room' && (
          <button className="btn ghost sm" onClick={() => onArchive(session.status !== 'archived')}>
            {session.status === 'archived' ? 'Unarchive' : 'Archive'}
          </button>
        )}
        {onOpenHome && (
          <button className="btn ghost sm" onClick={onOpenHome}>
            {agentName ? `${agentName}’s home` : 'Agent home'}
          </button>
        )}
      </div>
    </div>
  );
}
