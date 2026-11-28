import type { Agent, AgentStatus } from '../types';
import { shapeDef } from '../data/avatars';

const STATUS_LABEL: Record<AgentStatus, string> = {
  online: 'Online',
  busy: 'Busy',
  offline: 'Offline',
};

const STATUS_COLOR: Record<AgentStatus, string> = {
  online: '#3ddc97',
  busy: '#f5b544',
  offline: '#5b6272',
};

export function StatusDot({ status, size = 9 }: { status: AgentStatus; size?: number }) {
  return (
    <span
      className={`status-dot${status === 'online' ? ' is-live' : ''}`}
      style={{ width: size, height: size, background: STATUS_COLOR[status] }}
      title={STATUS_LABEL[status]}
      aria-label={STATUS_LABEL[status]}
    />
  );
}

interface AvatarProps {
  agent: Pick<Agent, 'emoji' | 'name' | 'accent' | 'avatarShape'>;
  size?: number;
  showStatus?: AgentStatus;
  ring?: boolean;
  title?: string;
}

export function AgentAvatar({ agent, size = 38, showStatus, ring = true, title }: AvatarProps) {
  const shape = shapeDef(agent.avatarShape);
  const face = `radial-gradient(120% 120% at 30% 20%, ${agent.accent}33, #141922 70%)`;
  if (shape.clip) {
    return (
      <span
        className={`avatar${ring ? ' has-ring' : ''}`}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.48) }}
        title={title ?? agent.name}
        aria-hidden="true"
      >
        <span
          className="avatar-face"
          style={{ background: ring ? `linear-gradient(${agent.accent}80, ${agent.accent}80)` : face, clipPath: shape.clip }}
        >
          <span className="avatar-face-inner" style={{ background: face, clipPath: shape.clip }} />
        </span>
        <span className="avatar-emoji">{agent.emoji}</span>
        {showStatus && <span className="avatar-status" style={{ background: STATUS_COLOR[showStatus] }} />}
      </span>
    );
  }
  return (
    <span
      className={`avatar${ring ? ' has-ring' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.48),
        borderRadius: shape.radius,
        background: face,
        boxShadow: ring ? `inset 0 0 0 1px ${agent.accent}59` : undefined,
      }}
      title={title ?? agent.name}
      aria-hidden="true"
    >
      <span className="avatar-emoji">{agent.emoji}</span>
      {showStatus && (
        <span className="avatar-status" style={{ background: STATUS_COLOR[showStatus] }} />
      )}
    </span>
  );
}

/** Overlapping stack of avatars, used for channel member previews. */
export function AvatarStack({
  agents,
  max = 3,
  size = 22,
}: {
  agents: Pick<Agent, 'emoji' | 'name' | 'accent' | 'avatarShape'>[];
  max?: number;
  size?: number;
}) {
  const shown = agents.slice(0, max);
  const extra = agents.length - shown.length;
  return (
    <span className="avatar-stack" aria-label={`${agents.length} agents`}>
      {shown.map((a, i) => (
        <span key={`${a.name}-${i}`} style={{ marginLeft: i === 0 ? 0 : -size * 0.32, zIndex: 10 - i }}>
          <AgentAvatar agent={a} size={size} ring />
        </span>
      ))}
      {extra > 0 && (
        <span
          className="avatar avatar-more"
          style={{ width: size, height: size, marginLeft: -size * 0.32, fontSize: size * 0.42 }}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
