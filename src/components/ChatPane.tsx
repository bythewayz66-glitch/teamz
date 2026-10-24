import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Conversation, Message, MessageFilter } from '../types';
import { AgentAvatar, StatusDot } from './Avatar';
import { RichText } from './RichText';
import { MentionAutocomplete } from './MentionAutocomplete';
import {
  ChatIcon,
  CloseIcon,
  HashIcon,
  PlusIcon,
  SendIcon,
  SettingsIcon,
  TrashIcon,
  UsersIcon,
} from './Icons';
import { formatDayLabel, formatTime, isNewDay } from '../lib/format';
import { activeQuery, applyMention, parseMentions, rankMentions } from '../lib/mentions';

interface ChatPaneProps {
  conversation: Conversation | null;
  messages: Message[];
  agentsById: Map<string, Agent>;
  /** Every agent in the workspace — the pool the invite picker offers. */
  allAgents: Agent[];
  typingAgentIds: string[];
  canReply: boolean;
  /** This conversation's message filter (persisted per channel). */
  filter: MessageFilter;
  onSetFilter: (filter: MessageFilter) => void;
  onSend: (text: string) => void;
  onOpenAgentSettings: (agentId: string) => void;
  onManageMembers: () => void;
  onDeleteConversation: () => void;
  /** Jump to the 1:1 DM with an agent (sidebar members list, mention chips). */
  onOpenDirectChat: (agentId: string) => void;
  /** Add an agent that already exists to this channel. */
  onInviteAgent: (agentId: string) => void;
  apiMode: string;
  /** Human label for the composer pill, e.g. "Pollinations · openai-fast". */
  modeLabel?: string;
  /** Open the provider settings. */
  onOpenSettings?: () => void;
}

export function ChatPane({
  conversation,
  messages,
  agentsById,
  allAgents,
  typingAgentIds,
  canReply,
  filter,
  onSetFilter,
  onSend,
  onOpenAgentSettings,
  onManageMembers,
  onDeleteConversation,
  onOpenDirectChat,
  onInviteAgent,
  apiMode,
  modeLabel,
  onOpenSettings,
}: ChatPaneProps) {
  const [draft, setDraft] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** The `@…` token being typed, or null when the popover is closed. */
  const [mentionToken, setMentionToken] = useState<{
    query: string;
    start: number;
    end: number;
  } | null>(null);

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
    setShowInvite(false);
    setMentionToken(null);
  }, [conversation?.id]);

  /* ---------------------------- @mention state ---------------------------- */

  const mentions = useMemo(
    () => (mentionToken ? rankMentions(mentionToken.query, members) : []),
    [mentionToken, members],
  );

  // A stale highlight would point past the end of a shrinking list.
  useEffect(() => {
    if (mentionIndex >= mentions.length) setMentionIndex(0);
  }, [mentions.length, mentionIndex]);

  /** Recompute the token from the caret. Called on every keystroke and caret move. */
  const syncMention = (value: string, caret: number) => {
    const token = activeQuery(value, caret);
    setMentionToken(token);
    if (!token) setMentionIndex(0);
  };

  const commitMention = (agent: Agent) => {
    const el = textareaRef.current;
    const token = mentionToken ?? (el ? activeQuery(draft, el.selectionStart ?? draft.length) : null);
    if (!token) return;

    const { text, caret } = applyMention(draft, token, agent.name);
    setDraft(text);
    setMentionToken(null);
    setMentionIndex(0);

    // Restore the caret after the committed mention, next frame so the value
    // has already been applied to the textarea.
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  };

  /**
   * Returns true when the key was consumed by the popover, so the caller knows
   * not to also send the message.
   */
  const handleMentionKeys = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!mentionToken || mentions.length === 0) {
      // Esc closes an open popover even when the list is empty.
      if (e.key === 'Escape' && mentionToken) {
        setMentionToken(null);
        return true;
      }
      return false;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMentionIndex((i) => (i + 1) % mentions.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMentionIndex((i) => (i - 1 + mentions.length) % mentions.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      commitMention(mentions[mentionIndex] ?? mentions[0]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setMentionToken(null);
      return true;
    }
    return false;
  };

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
    setMentionToken(null);
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    });
  };

  /** Who the current draft will reach — mirrors the store's routing rule. */
  const addressed = useMemo(() => {
    if (!conversation || conversation.kind !== 'channel') return [];
    return parseMentions(draft, members);
  }, [draft, conversation, members]);

  /**
   * The messages actually rendered, after the channel's filter.
   *
   * `directed` keeps only messages that were addressed to somebody. `agent`
   * keeps the thread with one agent: the messages addressed to it *and* its
   * own replies, because a list of questions with no answers is not a thread.
   * A direct chat is never filtered — there is only one recipient anyway.
   */
  const visibleMessages = useMemo(() => {
    if (!conversation || conversation.kind !== 'channel') return messages;
    if (filter.mode === 'all') return messages;

    if (filter.mode === 'directed') {
      return messages.filter((m) => m.directed || (m.mentions?.length ?? 0) > 0);
    }

    const target = filter.agentId;
    if (!target) return messages;
    return messages.filter(
      (m) => m.mentions?.includes(target) || (m.authorType === 'agent' && m.authorId === target),
    );
  }, [messages, filter, conversation]);

  /** Agents in the workspace that are not in this channel yet. */
  const invitable = useMemo(() => {
    if (!conversation) return [];
    const inRoom = new Set(conversation.agentIds);
    return allAgents.filter((a) => !inRoom.has(a.id));
  }, [allAgents, conversation]);

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

          {isChannel && (
            <button
              className={`icon-btn ghost${showInvite ? ' is-open' : ''}`}
              onClick={() => setShowInvite((v) => !v)}
              title="Invite an existing agent"
              aria-label="Invite an existing agent"
            >
              <PlusIcon size={16} />
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
                  <span className="mp-model">{a.origin?.role ?? a.model}</span>
                </span>
                <button
                  className="icon-btn ghost"
                  onClick={() => onOpenDirectChat(a.id)}
                  title={`Message ${a.name} directly`}
                  aria-label={`Message ${a.name} directly`}
                >
                  <ChatIcon size={13} />
                </button>
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

      {/*
        Invite an agent that already exists.

        Deliberately separate from "Add an agent" (which creates one from a
        template): this adds a member to the room without creating anything,
        so the two actions never look like the same button.
      */}
      {showInvite && isChannel && (
        <div className="invite-pop">
          <div className="members-pop-head">
            <strong>Invite an existing agent</strong>
            <button className="icon-btn ghost" onClick={() => setShowInvite(false)} aria-label="Close">
              <CloseIcon size={14} />
            </button>
          </div>
          <p className="invite-note">
            Adds an agent you already have to <strong>#{conversation.name}</strong>. Nothing new is
            created — to make a new one, use <em>Add an agent</em>.
          </p>
          <ul>
            {invitable.map((a) => (
              <li key={a.id}>
                <AgentAvatar agent={a} size={28} showStatus={a.status} />
                <span className="mp-text">
                  <span className="mp-name">{a.name}</span>
                  <span className="mp-model">{a.origin?.role ?? a.model}</span>
                </span>
                <button
                  className="btn primary sm"
                  onClick={() => {
                    onInviteAgent(a.id);
                    setShowInvite(false);
                  }}
                >
                  <PlusIcon size={12} /> Invite
                </button>
              </li>
            ))}
            {invitable.length === 0 && (
              <li className="rail-empty">Every agent in the workspace is already here.</li>
            )}
          </ul>
        </div>
      )}

      {isChannel && (
        <div className="filter-bar">
          <span className="filter-label">Show</span>
          <button
            className={`filter-chip${filter.mode === 'all' ? ' is-on' : ''}`}
            onClick={() => onSetFilter({ mode: 'all' })}
            aria-pressed={filter.mode === 'all'}
          >
            Everything
          </button>
          <button
            className={`filter-chip${filter.mode === 'directed' ? ' is-on' : ''}`}
            onClick={() => onSetFilter({ mode: 'directed' })}
            aria-pressed={filter.mode === 'directed'}
            title="Only messages addressed to an agent with @"
          >
            Directed only
          </button>
          {members.map((a) => (
            <button
              key={a.id}
              className={`filter-chip is-agent${
                filter.mode === 'agent' && filter.agentId === a.id ? ' is-on' : ''
              }`}
              style={{ borderColor: `${a.accent}59`, color: a.accent }}
              onClick={() => onSetFilter({ mode: 'agent', agentId: a.id })}
              aria-pressed={filter.mode === 'agent' && filter.agentId === a.id}
              title={`Only the thread addressed to ${a.name}`}
            >
              {a.emoji} {a.name}
            </button>
          ))}
          {filter.mode !== 'all' && (
            <span className="filter-count">
              {visibleMessages.length} of {messages.length}
            </span>
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

          {visibleMessages.length === 0 && messages.length > 0 && (
            <div className="empty-thread">
              <p>
                No messages match this filter. Switch back to <strong>Everything</strong> to see
                the whole channel.
              </p>
            </div>
          )}

          {visibleMessages.map((m, i) => {
            const prev = visibleMessages[i - 1];
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
                  mentioned={
                    m.mentions
                      ? m.mentions
                          .map((id) => agentsById.get(id))
                          .filter((a): a is Agent => Boolean(a))
                      : []
                  }
                  isChannel={isChannel}
                  grouped={Boolean(groupedWithPrev)}
                  onOpenAgentSettings={onOpenAgentSettings}
                  onOpenDirectChat={onOpenDirectChat}
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
        {mentionToken && mentions.length > 0 && (
          <MentionAutocomplete
            agents={mentions}
            activeIndex={mentionIndex}
            onHover={setMentionIndex}
            onPick={commitMention}
            top={0}
            left={12}
          />
        )}

        {addressed.length > 0 && (
          <div className="addressed-row">
            <span className="addressed-label">Directed to</span>
            {addressed.map((a) => (
              <button
                key={a.id}
                className="addressed-chip"
                style={{ borderColor: `${a.accent}59`, color: a.accent }}
                onClick={() => onOpenDirectChat(a.id)}
                title={`Open the DM with ${a.name}`}
              >
                {a.emoji} {a.name}
              </button>
            ))}
            <span className="addressed-hint">only these answer</span>
          </div>
        )}

        <div className={`composer${canReply ? '' : ' is-disabled'}`}>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
              autoGrow();
            }}
            onKeyDown={(e) => {
              // The popover gets first refusal on arrows / Enter / Esc.
              if (handleMentionKeys(e)) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onClick={(e) =>
              syncMention(draft, (e.target as HTMLTextAreaElement).selectionStart ?? 0)
            }
            onBlur={() => {
              // Let a mousedown-selection land before closing.
              setTimeout(() => setMentionToken(null), 120);
            }}
            placeholder={
              canReply
                ? `Message ${conversation.name}… type @ to address one agent`
                : 'Add an agent to start talking'
            }
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
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line ·{' '}
            <kbd>@</kbd> to address an agent
          </span>
          <button
            type="button"
            className={`mode-pill${apiMode === 'live' ? ' is-live' : ''}`}
            onClick={onOpenSettings}
            title="AI provider settings"
            style={{ cursor: onOpenSettings ? 'pointer' : undefined }}
          >
            {modeLabel ?? (apiMode === 'live' ? 'live endpoints' : 'mock mode')}
          </button>
        </div>
      </div>
    </main>
  );
}

function MessageRow({
  message,
  agent,
  mentioned,
  isChannel,
  grouped,
  onOpenAgentSettings,
  onOpenDirectChat,
}: {
  message: Message;
  agent?: Agent;
  mentioned: Agent[];
  isChannel: boolean;
  grouped: boolean;
  onOpenAgentSettings: (agentId: string) => void;
  onOpenDirectChat: (agentId: string) => void;
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
            {isUser && mentioned.length > 0 && (
              <span className="msg-badge is-directed">directed</span>
            )}
            <span className="msg-time">{formatTime(message.createdAt)}</span>
          </div>
        )}

        {isUser && mentioned.length > 0 && (
          <div className="msg-mentions">
            {mentioned.map((a) => (
              <button
                key={a.id}
                className="msg-mention-chip"
                style={{ borderColor: `${a.accent}4d`, color: a.accent }}
                onClick={() => onOpenDirectChat(a.id)}
                title={`Open the DM with ${a.name}`}
              >
                @{a.name}
              </button>
            ))}
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
