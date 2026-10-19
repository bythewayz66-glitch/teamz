import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Conversation, Message } from '../types';
import { AgentAvatar, StatusDot } from './Avatar';
import { RichText } from './RichText';
import { HashIcon, SendIcon, SettingsIcon, TrashIcon, UsersIcon, CloseIcon } from './Icons';
import { formatDayLabel, formatTime, isNewDay } from '../lib/format';

interface ChatPaneProps {
  conversation: Conversation | null;
  messages: Message[];
  agentsById: Map<string, Agent>;
  typingAgentIds: string[];
  canReply: boolean;
  onSend: (text: string) => void;
  onOpenAgentSettings: (agentId: string) => void;
  onManageMembers: () => void;
  onDeleteConversation: () => void;
  apiMode: string;
}

export function ChatPane({
  conversation,
  messages,
  agentsById,
  typingAgentIds,
  canReply,
  onSend,
  onOpenAgentSettings,
  onManageMembers,
  onDeleteConversation,
  apiMode,
}: ChatPaneProps) {
  const [draft, setDraft] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const members = useMemo(
    () =>
      (conversation?.agentIds ?? [])
        .map((id) => agentsById.get(id))
        .filter((a): a is Agent => Boolean(a)),
    [conversation, agentsById],
  );

  // Keep the newest message in view — including while replies stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, conversation?.id, typingAgentIds.length]);

  // Reset the draft when switching conversations.
  useEffect(() => {
    setDraft('');
    setShowMembers(false);
  }, [conversation?.id]);

  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || !canReply) return;
    onSend(text);
    setDraft('');
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    });
  };

  if (!conversation) {
    return (
      <main className="chat-pane empty-pane">
        <div className="empty-card">
          <div className="empty-glyph">🛰️</div>
          <h2>No conversation selected</h2>
          <p>Pick an agent on the left, or start a channel to put several of them in one room.</p>
        </div>
      </main>
    );
  }

  const isChannel = conversation.kind === 'channel';
  const soloAgent = !isChannel ? members[0] : undefined;

  return (
    <main className="chat-pane">
      <header className="chat-head">
        <div className="chat-head-id">
          <div className={`chat-head-badge${isChannel ? ' is-channel' : ''}`}>
            {isChannel ? <HashIcon size={17} /> : soloAgent ? <AgentAvatar agent={soloAgent} size={34} showStatus={soloAgent.status} /> : '?'}
          </div>
          <div className="chat-head-text">
            <h1>{conversation.name}</h1>
            <p>
              {isChannel ? (
                <>
                  <UsersIcon size={12} />
                  {members.length} agent{members.length === 1 ? '' : 's'}
                  {conversation.topic ? <span className="dot-sep">·</span> : null}
                  {conversation.topic && <span className="topic">{conversation.topic}</span>}
                </>
              ) : soloAgent ? (
                <>
                  <StatusDot status={soloAgent.status} size={6} />
                  {soloAgent.status}
                  <span className="dot-sep">·</span>
                  <span className="mono">{soloAgent.model}</span>
                </>
              ) : (
                'No agent attached'
              )}
            </p>
          </div>
        </div>

        <div className="chat-head-actions">
          <button
            className={`member-stack-btn${showMembers ? ' is-open' : ''}`}
            onClick={() => setShowMembers((v) => !v)}
            title="Channel members"
          >
            <span className="member-faces">
              {members.slice(0, 4).map((a) => (
                <AgentAvatar key={a.id} agent={a} size={20} />
              ))}
            </span>
            <span className="member-count">{members.length}</span>
          </button>

          {isChannel && (
            <button className="icon-btn ghost" onClick={onManageMembers} title="Manage members">
              <UsersIcon size={16} />
            </button>
          )}

          {soloAgent && (
            <button
              className="icon-btn ghost"
              onClick={() => onOpenAgentSettings(soloAgent.id)}
              title="Agent settings"
            >
              <SettingsIcon size={16} />
            </button>
          )}

          <button
            className="icon-btn ghost danger-hover"
            onClick={onDeleteConversation}
            title={isChannel ? 'Delete channel' : 'Delete chat'}
          >
            <TrashIcon size={15} />
          </button>
        </div>
      </header>

      {showMembers && (
        <div className="members-pop">
          <div className="members-pop-head">
            <strong>In this {isChannel ? 'channel' : 'chat'}</strong>
            <button className="icon-btn ghost" onClick={() => setShowMembers(false)} aria-label="Close">
              <CloseIcon size={14} />
            </button>
          </div>
          <ul>
            {members.map((a) => (
              <li key={a.id}>
                <AgentAvatar agent={a} size={28} showStatus={a.status} />
                <span className="mp-text">
                  <span className="mp-name">{a.name}</span>
                  <span className="mp-model">{a.model}</span>
                </span>
                <button
                  className="icon-btn ghost"
                  onClick={() => onOpenAgentSettings(a.id)}
                  title={`${a.name} settings`}
                >
                  <SettingsIcon size={13} />
                </button>
              </li>
            ))}
            {members.length === 0 && <li className="rail-empty">Nobody here yet.</li>}
          </ul>
          {isChannel && (
            <button className="ghost-wide" onClick={onManageMembers}>
              <UsersIcon size={14} /> Manage members
            </button>
          )}
        </div>
      )}

      <div className="message-scroll" ref={scrollRef}>
        <div className="message-list">
          <div className="thread-intro">
            <div className="thread-intro-glyph">{isChannel ? <HashIcon size={22} /> : '💬'}</div>
            <h2>{isChannel ? `#${conversation.name}` : conversation.name}</h2>
            <p>
              {isChannel
                ? `Every message you send here goes to all ${members.length} agents. Each answers in turn.`
                : 'This chat is wired to a single agent on your server.'}
            </p>
          </div>

          {messages.length === 0 && (
            <div className="empty-thread">
              <p>No messages yet — say hello to start the thread.</p>
              <div className="suggestion-row">
                {['What are you working on right now?', 'Summarise our last decision', 'Draft a plan for today'].map(
                  (s) => (
                    <button key={s} className="suggestion" onClick={() => onSend(s)}>
                      {s}
                    </button>
                  ),
                )}
              </div>
            </div>
          )}

          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const agent = m.authorId ? agentsById.get(m.authorId) : undefined;
            const showDay = isNewDay(prev?.createdAt, m.createdAt);
            const groupedWithPrev =
              prev &&
              prev.authorType === m.authorType &&
              prev.authorId === m.authorId &&
              m.createdAt - prev.createdAt < 3 * 60_000 &&
              !showDay;

            return (
              <div key={m.id}>
                {showDay && (
                  <div className="day-divider">
                    <span>{formatDayLabel(m.createdAt)}</span>
                  </div>
                )}
                <MessageRow
                  message={m}
                  agent={agent}
                  isChannel={isChannel}
                  grouped={Boolean(groupedWithPrev)}
                  onOpenAgentSettings={onOpenAgentSettings}
                />
              </div>
            );
          })}

          {typingAgentIds.length > 0 && (
            <div className="typing-row">
              {typingAgentIds.map((id) => {
                const a = agentsById.get(id);
                if (!a) return null;
                return (
                  <div className="typing-inline" key={id}>
                    <AgentAvatar agent={a} size={22} />
                    <span className="dots" aria-label={`${a.name} is typing`}>
                      <i /> <i /> <i />
                    </span>
                    <span className="typing-label">{a.name} is thinking…</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className={`composer${canReply ? '' : ' is-disabled'}`}>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              autoGrow();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={canReply ? `Message ${conversation.name}…` : 'Add an agent to start talking'}
            rows={1}
            disabled={!canReply}
            aria-label="Message composer"
          />
          <button className="send-btn" onClick={submit} disabled={!draft.trim() || !canReply} aria-label="Send">
            <SendIcon size={17} />
          </button>
        </div>
        <div className="composer-foot">
          <span>
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
          </span>
          <span className={`mode-pill${apiMode === 'live' ? ' is-live' : ''}`}>
            {apiMode === 'live' ? 'live endpoints' : 'mock mode'}
          </span>
        </div>
      </div>
    </main>
  );
}

function MessageRow({
  message,
  agent,
  isChannel,
  grouped,
  onOpenAgentSettings,
}: {
  message: Message;
  agent?: Agent;
  isChannel: boolean;
  grouped: boolean;
  onOpenAgentSettings: (agentId: string) => void;
}) {
  const isUser = message.authorType === 'user';
  const isPending = message.status === 'pending';
  const isError = message.status === 'error';
  const accent = agent?.accent ?? '#7c9cff';

  return (
    <div className={`msg-row ${isUser ? 'is-user' : 'is-agent'}${grouped ? ' is-grouped' : ''}`}>
      <div className="msg-gutter">
        {!isUser && agent && !grouped ? (
          <AgentAvatar agent={agent} size={30} />
        ) : !isUser && agent ? (
          <span className="gutter-time">{formatTime(message.createdAt)}</span>
        ) : null}
      </div>

      <div className="msg-body">
        {!grouped && (
          <div className="msg-head">
            <span
              className="msg-author"
              style={{ color: isUser ? undefined : accent }}
              onClick={() => !isUser && agent && onOpenAgentSettings(agent.id)}
              role={!isUser && agent ? 'button' : undefined}
            >
              {isUser ? 'You' : agent?.name ?? 'Agent'}
            </span>
            {!isUser && isChannel && agent && (
              <span className="msg-badge" style={{ color: accent, borderColor: `${accent}40` }}>
                agent
              </span>
            )}
            <span className="msg-time">{formatTime(message.createdAt)}</span>
          </div>
        )}

        <div
          className={`bubble${isUser ? ' bubble-user' : ' bubble-agent'}${isPending ? ' is-pending' : ''}${isError ? ' is-error' : ''}`}
          style={
            !isUser && agent
              ? { borderColor: `${accent}33`, background: `linear-gradient(180deg, ${accent}0f, #151a23 60%)` }
              : undefined
          }
        >
          {isPending && !message.text ? (
            <span className="bubble-typing">
              <i /> <i /> <i />
            </span>
          ) : (
            <RichText text={message.text} />
          )}
        </div>
      </div>
    </div>
  );
}
