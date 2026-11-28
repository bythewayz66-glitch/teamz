/**
 * Sessions — the durable unit of work.
 *
 * A session is a conversation that carries `SessionMeta`: a name, an owning
 * agent, a status and an explicit retention policy. Everything here is pure
 * (no DOM, no timers, no network) so the store, the runner sync and the tests
 * share one implementation. Every reducer returns its input unchanged (same
 * reference) when there is nothing to do, so callers can use it in setState
 * without causing re-renders.
 *
 * Three kinds:
 *  - chat: a conversation with one agent. The agent's existing 1:1 DM is
 *    adopted as its first chat session; more can be started from its home.
 *  - work: what an agent did in the Build Room (runner jobs, assignments),
 *    gathered into one rolling session per agent per ISO week.
 *  - room: the shared Build Room itself. It is untouched; it just gains
 *    session metadata so it is searchable and has a retention policy.
 */

import type {
  Agent,
  Conversation,
  Message,
  RetentionPolicy,
  SessionKind,
  SessionMeta,
  WorkspaceState,
} from '../types';

export const BUILD_ROOM_ID = 'conv-build-room';

const DAY_MS = 86_400_000;

export const DEFAULT_RETENTION: Record<SessionKind, RetentionPolicy> = {
  chat: { mode: 'forever' },
  work: { mode: 'days', days: 90 },
  room: { mode: 'forever' },
};

/** An agent's own default retention for new sessions, else the built-in default for the kind. */
export function retentionFor(
  agent: Pick<Agent, 'sessionRetention'> | undefined,
  kind: SessionKind,
): RetentionPolicy {
  return agent?.sessionRetention ?? DEFAULT_RETENTION[kind];
}

export const RETENTION_PRESETS: Array<{ label: string; policy: RetentionPolicy }> = [
  { label: 'Keep forever', policy: { mode: 'forever' } },
  { label: 'Keep 30 days', policy: { mode: 'days', days: 30 } },
  { label: 'Keep 90 days', policy: { mode: 'days', days: 90 } },
  { label: 'Keep last 500 messages', policy: { mode: 'messages', max: 500 } },
];

export function retentionKey(p: RetentionPolicy): string {
  return p.mode === 'forever' ? 'forever' : p.mode === 'days' ? `days:${p.days}` : `messages:${p.max}`;
}

export function describeRetention(p: RetentionPolicy): string {
  if (p.mode === 'forever') return 'kept forever';
  if (p.mode === 'days') return `kept for ${p.days} days, then pruned`;
  return `last ${p.max} messages kept`;
}

/** Oldest timestamp a policy still keeps, or null when age does not limit it. */
export function retentionCutoff(p: RetentionPolicy, now: number): number | null {
  return p.mode === 'days' ? now - p.days * DAY_MS : null;
}

/** ISO-8601 week key (UTC), e.g. `2026-W48`. */
export function weekKey(ts: number): string {
  const d = new Date(ts);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** "week of 23 Nov" for the Monday that starts the ISO week containing ts. */
export function weekLabel(ts: number): string {
  const d = new Date(ts);
  const dow = d.getUTCDay() || 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (dow - 1)));
  return `week of ${monday.getUTCDate()} ${monday.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}

export function isSession(c: Conversation): c is Conversation & { session: SessionMeta } {
  return Boolean(c.session);
}

/** Newest activity: the last message, or the session's own timestamp. */
export function lastActivity(c: Conversation, messages: Message[] | undefined): number {
  const last = messages && messages.length > 0 ? messages[messages.length - 1].createdAt : 0;
  return Math.max(last, c.session?.updatedAt ?? 0, c.createdAt);
}

/** An agent's sessions, newest first. Archived ones are hidden unless asked for. */
export function sessionsForAgent(
  state: Pick<WorkspaceState, 'conversations' | 'messages'>,
  agentId: string,
  opts: { includeArchived?: boolean; nonEmptyOnly?: boolean } = {},
): Array<Conversation & { session: SessionMeta }> {
  return state.conversations
    .filter(isSession)
    .filter((c) => c.session.agentId === agentId)
    .filter((c) => opts.includeArchived || c.session.status !== 'archived')
    .filter((c) => !opts.nonEmptyOnly || (state.messages[c.id]?.length ?? 0) > 0)
    .sort((a, b) => lastActivity(b, state.messages[b.id]) - lastActivity(a, state.messages[a.id]));
}

/** Short, plain name taken from the first thing the user asked. */
export function deriveSessionName(text: string): string {
  const oneLine = text.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'New session';
  return oneLine.length > 48 ? `${oneLine.slice(0, 47).trimEnd()}…` : oneLine;
}

export const DEFAULT_SESSION_NAME = 'New session';

export function newChatSession(
  agent: Pick<Agent, 'id' | 'sessionRetention'>,
  id: string,
  now: number,
  name: string = DEFAULT_SESSION_NAME,
): Conversation {
  return {
    id,
    kind: 'session',
    name,
    agentIds: [agent.id],
    createdAt: now,
    session: {
      kind: 'chat',
      agentId: agent.id,
      status: 'active',
      retention: retentionFor(agent, 'chat'),
      updatedAt: now,
    },
  };
}

/** Name a fresh "New session" after the first user message sent in it. */
export function autoNameSession(state: WorkspaceState, convId: string): WorkspaceState {
  const conv = state.conversations.find((c) => c.id === convId);
  if (!conv?.session || conv.session.kind !== 'chat' || conv.name !== DEFAULT_SESSION_NAME) {
    return state;
  }
  const first = (state.messages[convId] ?? []).find((m) => m.authorType === 'user');
  if (!first) return state;
  const name = deriveSessionName(first.text);
  if (name === DEFAULT_SESSION_NAME) return state;
  return patchSession(state, convId, {}, name);
}

export function patchSession(
  state: WorkspaceState,
  convId: string,
  patch: Partial<SessionMeta>,
  convName?: string,
): WorkspaceState {
  let changed = false;
  const conversations = state.conversations.map((c) => {
    if (c.id !== convId || !c.session) return c;
    changed = true;
    return {
      ...c,
      ...(convName !== undefined ? { name: convName } : {}),
      session: { ...c.session, ...patch },
    };
  });
  return changed ? { ...state, conversations } : state;
}

/**
 * Give every pre-session conversation its session metadata: each agent's DM
 * becomes its first chat session, and the Build Room becomes the shared room
 * session. Idempotent, and it never moves or edits a message.
 */
export function adoptSessions(state: WorkspaceState, now: number): WorkspaceState {
  let changed = false;
  const conversations = state.conversations.map((c) => {
    if (c.session) return c;
    if (c.kind === 'direct' && c.agentIds[0]) {
      changed = true;
      return {
        ...c,
        session: {
          kind: 'chat' as const,
          agentId: c.agentIds[0],
          status: 'active' as const,
          retention: retentionFor(state.agents.find((a) => a.id === c.agentIds[0]), 'chat'),
          updatedAt: lastActivity(c, state.messages[c.id]) || now,
        },
      };
    }
    if (c.id === BUILD_ROOM_ID && c.kind === 'channel') {
      changed = true;
      return {
        ...c,
        session: {
          kind: 'room' as const,
          status: 'active' as const,
          retention: DEFAULT_RETENTION.room,
          updatedAt: lastActivity(c, state.messages[c.id]) || now,
        },
      };
    }
    return c;
  });
  return changed ? { ...state, conversations } : state;
}

export function workSessionId(agentId: string, key: string): string {
  return `sess-work-${agentId}-${key}`;
}

/**
 * Migrate Build Room work into per-agent sessions without touching the room.
 *
 * Every finished agent reply in the room, plus every user message addressed to
 * that agent by @mention, is copied (same message id) into that agent's work
 * session for the week it happened in. The room keeps all of its messages; the
 * agent now also has its own record of what it did. Re-running adds only
 * messages not already present, so it is safe to call on every sync.
 */
export function foldRoomIntoSessions(
  state: WorkspaceState,
  now: number,
  roomId: string = BUILD_ROOM_ID,
): WorkspaceState {
  const room = state.conversations.find((c) => c.id === roomId);
  if (!room) return state;
  const roomMessages = state.messages[roomId] ?? [];
  if (roomMessages.length === 0) return state;

  const agentsById = new Map(state.agents.map((a) => [a.id, a]));
  const known = new Set(agentsById.keys());

  const incoming = new Map<string, { agentId: string; key: string; msgs: Message[] }>();
  const push = (agentId: string, m: Message) => {
    const cutoff = retentionCutoff(retentionFor(agentsById.get(agentId), 'work'), now);
    if (cutoff !== null && m.createdAt < cutoff) return;
    const key = weekKey(m.createdAt);
    const id = workSessionId(agentId, key);
    let bucket = incoming.get(id);
    if (!bucket) incoming.set(id, (bucket = { agentId, key, msgs: [] }));
    bucket.msgs.push(m);
  };
  for (const m of roomMessages) {
    if (m.status !== 'sent') continue;
    if (m.authorType === 'agent' && m.authorId && known.has(m.authorId)) {
      push(m.authorId, m);
    } else if (m.authorType === 'user' && m.mentions) {
      for (const id of new Set(m.mentions)) if (known.has(id)) push(id, m);
    }
  }
  if (incoming.size === 0) return state;

  let conversations = state.conversations;
  let messages = state.messages;
  let changed = false;

  for (const [sessId, { agentId, key, msgs }] of incoming) {
    const existing = messages[sessId] ?? [];
    const have = new Set(existing.map((m) => m.id));
    const fresh = msgs
      .filter((m) => !have.has(m.id))
      .map((m) => ({ ...m, conversationId: sessId }));
    if (fresh.length === 0) continue;
    if (!changed) {
      conversations = [...conversations];
      messages = { ...messages };
      changed = true;
    }
    messages[sessId] = [...existing, ...fresh].sort((a, b) => a.createdAt - b.createdAt);
    if (!conversations.some((c) => c.id === sessId)) {
      const first = fresh[0].createdAt;
      const name = `Build Room work · ${weekLabel(first)}`;
      conversations.push({
        id: sessId,
        kind: 'session',
        name,
        agentIds: [agentId],
        createdAt: first,
        session: {
          kind: 'work',
          agentId,
          status: 'active',
          retention: retentionFor(agentsById.get(agentId), 'work'),
          updatedAt: first,
          weekKey: key,
        },
      });
    }
  }
  return changed ? { ...state, conversations, messages } : state;
}

/**
 * A reply that was in flight when the tab closed stays `pending` in storage
 * forever. Find those, turn them into a visible "interrupted" message that
 * keeps whatever had streamed in, and flag the session so it can be resumed.
 * The conversation's other messages are not touched — that is the context.
 */
export function recoverInterrupted(state: WorkspaceState, now: number): WorkspaceState {
  let changed = false;
  const messages: Record<string, Message[]> = {};
  const hit = new Set<string>();
  for (const [convId, list] of Object.entries(state.messages)) {
    if (!list.some((m) => m.status === 'pending')) {
      messages[convId] = list;
      continue;
    }
    changed = true;
    hit.add(convId);
    messages[convId] = list.map((m) =>
      m.status === 'pending'
        ? {
            ...m,
            status: 'error' as const,
            interrupted: true,
            text: m.text
              ? `${m.text}\n\n_Interrupted — resume to continue._`
              : '_Interrupted before a reply arrived — resume to continue._',
          }
        : m,
    );
  }
  if (!changed) return state;
  const conversations = state.conversations.map((c) =>
    hit.has(c.id) && c.session
      ? { ...c, session: { ...c.session, status: 'interrupted' as const, interruptedAt: now } }
      : c,
  );
  return { ...state, conversations, messages };
}

export interface ResumePlan {
  conversation: Conversation;
  /** The user message the interrupted replies were answering. */
  userMessage: Message;
  /** Full conversation context, interrupted placeholders removed. */
  history: Message[];
  /** Agents whose replies were cut off, in the order they were speaking. */
  targetAgentIds: string[];
  /** State with placeholders removed and the session back to active. */
  nextState: WorkspaceState;
}

/**
 * Work out how to resume an interrupted session. The whole prior conversation
 * is the context (nothing is summarised or dropped); only the dead
 * placeholders are removed, and the agents that were mid-reply are asked again.
 * Returns null when nothing was interrupted.
 */
export function planResume(state: WorkspaceState, convId: string): ResumePlan | null {
  const conversation = state.conversations.find((c) => c.id === convId);
  if (!conversation) return null;
  const list = state.messages[convId] ?? [];
  const dead = list.filter((m) => m.interrupted && m.authorType === 'agent' && m.authorId);
  if (dead.length === 0) return null;
  const deadIds = new Set(dead.map((m) => m.id));
  const history = list.filter((m) => !deadIds.has(m.id));
  const firstDeadAt = Math.min(...dead.map((m) => m.createdAt));
  const lastUser =
    [...history].reverse().find((m) => m.authorType === 'user' && m.createdAt <= firstDeadAt) ??
    [...history].reverse().find((m) => m.authorType === 'user');
  if (!lastUser) return null;
  const targetAgentIds = [...new Set(dead.map((m) => m.authorId as string))];
  let nextState: WorkspaceState = {
    ...state,
    messages: { ...state.messages, [convId]: history },
  };
  nextState = patchSession(nextState, convId, { status: 'active', interruptedAt: undefined });
  return { conversation, userMessage: lastUser, history, targetAgentIds, nextState };
}

/** Prune every session to its retention policy. Starred sessions are kept; empty work sessions are dropped. */
export function applyRetention(state: WorkspaceState, now: number): WorkspaceState {
  let changed = false;
  const messages = { ...state.messages };
  const drop = new Set<string>();
  for (const c of state.conversations) {
    if (!c.session || c.session.starred) continue;
    const list = messages[c.id] ?? [];
    const p = c.session.retention;
    let kept = list;
    if (p.mode === 'days') {
      const cutoff = now - p.days * DAY_MS;
      kept = list.filter((m) => m.createdAt >= cutoff || m.status === 'pending');
    } else if (p.mode === 'messages' && list.length > p.max) {
      kept = list.slice(list.length - p.max);
    }
    if (kept.length !== list.length) {
      changed = true;
      messages[c.id] = kept;
    }
    if (c.session.kind === 'work' && kept.length === 0 && list.length > 0) drop.add(c.id);
  }
  if (!changed) return state;
  let conversations = state.conversations;
  let activeConversationId = state.activeConversationId;
  if (drop.size > 0) {
    conversations = conversations.filter((c) => !drop.has(c.id));
    for (const id of drop) delete messages[id];
    if (activeConversationId && drop.has(activeConversationId)) {
      activeConversationId = conversations[0]?.id ?? null;
    }
  }
  return { ...state, conversations, messages, activeConversationId };
}

/** The one-call migration used on load: adopt, recover, fold, prune. */
export function migrateToSessions(state: WorkspaceState, now: number): WorkspaceState {
  let s = adoptSessions(state, now);
  s = recoverInterrupted(s, now);
  s = foldRoomIntoSessions(s, now);
  s = applyRetention(s, now);
  return s;
}
