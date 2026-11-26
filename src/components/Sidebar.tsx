import { useEffect, useRef, useState } from 'react';
import type { Agent, Conversation } from '../types';
import { AgentAvatar, AvatarStack, StatusDot } from './Avatar';
import { ChatIcon, CloseIcon, HashIcon, PlusIcon, SearchIcon, SettingsIcon, SparkIcon } from './Icons';
import { formatRelative } from '../lib/format';

interface SidebarProps {
  /** True while the sidebar is an open overlay drawer (small screens). */
  open: boolean;
  /** Close the drawer — wired to the in-drawer close button. */
  onClose: () => void;
  agents: Agent[];
  conversations: Conversation[];
  agentsById: Map<string, Agent>;
  activeConversationId: string | null;
  lastMessageAt: Record<string, number>;
  typing: Record<string, string[]>;
  onSelectConversation: (id: string) => void;
  onNewAgent: () => void;
  onNewChannel: () => void;
  onOpenAgentSettings: (agentId: string) => void;
  onOpenAgentChat: (agentId: string) => void;
  onOpenWorkspaceInfo: () => void;
}

export function Sidebar({
  open,
  onClose,
  agents,
  conversations,
  agentsById,
  activeConversationId,
  lastMessageAt,
  typing,
  onSelectConversation,
  onNewAgent,
  onNewChannel,
  onOpenAgentSettings,
  onOpenAgentChat,
  onOpenWorkspaceInfo,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // When the drawer opens on a small screen, put focus inside it so keyboard
  // and screen-reader users land in the navigation, not behind the scrim.
  // (Desktop: the sidebar is always visible, so this never fires there.)
  // The drawer slides in over 0.22s and the close button is not focusable
  // until the slide — and its visibility transition — finishes, so the
  // focus waits the transition out instead of firing into the void.
  useEffect(() => {
    if (!open || !window.matchMedia('(max-width: 860px)').matches) return;
    const t = window.setTimeout(() => closeBtnRef.current?.focus(), 250);
    return () => window.clearTimeout(t);
  }, [open ]);

  const q = query.trim().toLowerCase();
  const visibleAgents = q
    ? agents.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.model.toLowerCase().includes(q) ||
          (a.origin?.role.toLowerCase().includes(q) ?? false) ||
          a.skills.some((s) => s.label.toLowerCase().includes(q)),
      )
    : agents;

  const channels = conversations.filter((c) => c.kind === 'channel');
  const directs = conversations.filter((c) => c.kind === 'direct');

  const onlineCount = agents.filter((a) => a.status !== 'offline').length;

  return (
    <aside className="sidebar" id="teamz-sidebar" aria-label="Agents and conversations">
      <header className="sidebar-brand">
        <div className="brand-mark" aria-hidden="true">
          <SparkIcon size={17} />
        </div>
        <div className="brand-copy">
          <strong>teamz</strong>
          <span>{agents.length} agents · {onlineCount} live</span>
        </div>
        <button
          ref={closeBtnRef}
          className="icon-btn ghost sidebar-close"
          onClick={onClose}
          aria-label="Close navigation menu"
        >
          <CloseIcon size={16} />
        </button>
        <button className="icon-btn ghost" onClick={onOpenWorkspaceInfo} title="Workspace & API settings">
          <SettingsIcon size={16} />
        </button>
      </header>

      <div className="sidebar-search">
        <SearchIcon size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents…"
          aria-label="Search agents"
        />
      </div>

      <div className="sidebar-scroll">
        <section className="rail-section">
          <div className="rail-heading">
            <span>Agents</span>
            <button className="mini-btn" onClick={onNewAgent} title="Create a new agent">
              <PlusIcon size={13} />
              New Agent
            </button>
          </div>

          <ul className="agent-list">
            {visibleAgents.map((agent) => {
              const direct = directs.find((c) => c.agentIds[0] === agent.id);
              const isActive = direct && direct.id === activeConversationId;
              const isTyping = Object.values(typing).some((ids) => ids.includes(agent.id));

              return (
                <li key={agent.id}>
                  <div className={`agent-row${isActive ? ' is-active' : ''}`}>
                    <button
                      className="agent-row-main"
                      onClick={() => onOpenAgentChat(agent.id)}
                      title={`Open chat with ${agent.name}`}
                    >
                      <AgentAvatar agent={agent} size={34} showStatus={agent.status} />
                      <span className="agent-row-text">
                        <span className="agent-name">
                          {agent.name}
                          {isTyping && <span className="typing-chip">typing…</span>}
                        </span>
                        <span className="agent-meta">
                          <StatusDot status={agent.status} size={6} />
                          {agent.status === 'online' ? 'Online' : agent.status === 'busy' ? 'Busy' : 'Offline'}
                          <span className="dot-sep">·</span>
                          <span className="agent-model">
                            {agent.origin?.role ?? agent.model}
                          </span>
                        </span>
                        {agent.skills.length > 0 && (
                          <span className="agent-skills">
                            {agent.skills.slice(0, 3).map((s) => (
                              <span key={s.key} className="agent-skill">
                                {s.label}
                              </span>
                            ))}
                            {agent.skills.length > 3 && (
                              <span className="agent-skill is-more">
                                +{agent.skills.length - 3}
                              </span>
                            )}
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      className="agent-row-action"
                      onClick={() => onOpenAgentChat(agent.id)}
                      title={`Message ${agent.name}`}
                      aria-label={`Message ${agent.name}`}
                    >
                      <ChatIcon size={14} />
                    </button>
                    <button
                      className="agent-row-action"
                      onClick={() => onOpenAgentSettings(agent.id)}
                      title={`${agent.name} settings`}
                      aria-label={`${agent.name} settings`}
                    >
                      <SettingsIcon size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
            {visibleAgents.length === 0 && (
              <li className="rail-empty">No agents match “{query}”.</li>
            )}
          </ul>
        </section>

        <section className="rail-section">
          <div className="rail-heading">
            <span>Channels</span>
            <button className="mini-btn" onClick={onNewChannel} title="Create a multi-agent channel">
              <PlusIcon size={13} />
              New
            </button>
          </div>

          <ul className="conv-list">
            {channels.map((conv) => {
              const members = conv.agentIds
                .map((id) => agentsById.get(id))
                .filter((a): a is Agent => Boolean(a));
              const isActive = conv.id === activeConversationId;
              const isTyping = (typing[conv.id] ?? []).length > 0;
              const last = lastMessageAt[conv.id];

              return (
                <li key={conv.id}>
                  <button
                    className={`conv-row${isActive ? ' is-active' : ''}`}
                    onClick={() => onSelectConversation(conv.id)}
                  >
                    <span className="conv-icon">
                      <HashIcon size={14} />
                    </span>
                    <span className="conv-text">
                      <span className="conv-name">{conv.name}</span>
                      <span className="conv-meta">
                        {isTyping ? (
                          <em className="typing-text">responding…</em>
                        ) : (
                          <>
                            <AvatarStack agents={members} size={16} max={3} />
                            <span>{members.length} agents</span>
                          </>
                        )}
                      </span>
                    </span>
                    {last && <span className="conv-time">{formatRelative(last)}</span>}
                  </button>
                </li>
              );
            })}
            {channels.length === 0 && <li className="rail-empty">No channels yet.</li>}
          </ul>
        </section>

        <section className="rail-section">
          <div className="rail-heading">
            <span>Direct</span>
          </div>
          <ul className="conv-list">
            {directs.map((conv) => {
              const agent = agentsById.get(conv.agentIds[0]);
              if (!agent) return null;
              const isActive = conv.id === activeConversationId;
              const last = lastMessageAt[conv.id];
              return (
                <li key={conv.id}>
                  <button
                    className={`conv-row${isActive ? ' is-active' : ''}`}
                    onClick={() => onSelectConversation(conv.id)}
                  >
                    <AgentAvatar agent={agent} size={24} showStatus={agent.status} />
                    <span className="conv-text">
                      <span className="conv-name single">{agent.name}</span>
                    </span>
                    {last && <span className="conv-time">{formatRelative(last)}</span>}
                  </button>
                </li>
              );
            })}
            {directs.length === 0 && <li className="rail-empty">No direct chats.</li>}
          </ul>
        </section>
      </div>

      <footer className="sidebar-foot">
        <button className="foot-btn" onClick={onNewAgent}>
          <span className="foot-avatar">
            <PlusIcon size={14} />
          </span>
          <span>
            <strong>Add an agent</strong>
            <small>Point it at your server</small>
          </span>
        </button>
      </footer>
    </aside>
  );
}
