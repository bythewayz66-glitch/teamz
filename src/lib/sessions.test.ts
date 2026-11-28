import { describe, expect, it } from 'vitest';
import type { Conversation, Message, WorkspaceState } from '../types';
import { seedState } from '../data/mock';
import {
  adoptSessions,
  applyRetention,
  autoNameSession,
  BUILD_ROOM_ID,
  DEFAULT_SESSION_NAME,
  foldRoomIntoSessions,
  migrateToSessions,
  newChatSession,
  planResume,
  recoverInterrupted,
  sessionsForAgent,
  weekKey,
  workSessionId,
} from './sessions';

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const DAY = 86_400_000;

const msg = (id: string, conv: string, over: Partial<Message> = {}): Message => ({
  id,
  conversationId: conv,
  authorType: 'agent',
  authorId: 'agent-atlas',
  text: `text ${id}`,
  createdAt: NOW,
  status: 'sent',
  ...over,
});

function base(): WorkspaceState {
  return structuredClone(seedState);
}

describe('weekKey', () => {
  it('uses ISO weeks', () => {
    expect(weekKey(Date.UTC(2026, 10, 28))).toBe('2026-W48');
    expect(weekKey(Date.UTC(2026, 0, 1))).toBe('2026-W01');
    expect(weekKey(Date.UTC(2027, 0, 1))).toBe('2026-W53');
  });
});

describe('adoptSessions', () => {
  it('turns each DM into a chat session and the Build Room into the room session, keeping messages', () => {
    const s = base();
    const before = JSON.stringify(s.messages);
    const next = adoptSessions(s, NOW);
    const room = next.conversations.find((c) => c.id === BUILD_ROOM_ID)!;
    expect(room.session?.kind).toBe('room');
    expect(room.session?.retention).toEqual({ mode: 'forever' });
    for (const c of next.conversations.filter((c) => c.kind === 'direct')) {
      expect(c.session?.kind).toBe('chat');
      expect(c.session?.agentId).toBe(c.agentIds[0]);
    }
    expect(JSON.stringify(next.messages)).toBe(before);
  });

  it('is idempotent and returns the same object when nothing changes', () => {
    const once = adoptSessions(base(), NOW);
    expect(adoptSessions(once, NOW)).toBe(once);
  });
});

describe('foldRoomIntoSessions — the room becomes shared, not the only session', () => {
  const withRoom = (messages: Message[]): WorkspaceState => {
    const s = adoptSessions(base(), NOW);
    return { ...s, messages: { ...s.messages, [BUILD_ROOM_ID]: messages } };
  };

  it('copies each agent reply into that agent’s weekly work session and leaves the room intact', () => {
    const room = [
      msg('a1', BUILD_ROOM_ID, { authorId: 'agent-atlas', createdAt: NOW - 3 * DAY }),
      msg('a2', BUILD_ROOM_ID, { authorId: 'agent-scout', createdAt: NOW - 3 * DAY }),
      msg('a3', BUILD_ROOM_ID, { authorId: 'agent-atlas', createdAt: NOW - 1 * DAY }),
    ];
    const s = withRoom(room);
    const next = foldRoomIntoSessions(s, NOW);
    expect(next.messages[BUILD_ROOM_ID]).toEqual(room);
    const wk = workSessionId('agent-atlas', weekKey(NOW - 3 * DAY));
    const sess = next.conversations.find((c) => c.id === wk)!;
    expect(sess.session?.kind).toBe('work');
    expect(sess.kind).toBe('session');
    expect(next.messages[wk].map((m) => m.id)).toEqual(['a1', 'a3']);
    expect(next.messages[wk][0].conversationId).toBe(wk);
    expect(sessionsForAgent(next, 'agent-scout').some((c) => c.session.kind === 'work')).toBe(true);
  });

  it('includes the user message that @-mentioned the agent, so the session reads as a task', () => {
    const s = withRoom([
      msg('u1', BUILD_ROOM_ID, { authorType: 'user', authorId: undefined, mentions: ['agent-atlas'], directed: true, createdAt: NOW - 1000 }),
      msg('u2', BUILD_ROOM_ID, { authorType: 'user', authorId: undefined, createdAt: NOW - 900 }),
      msg('a1', BUILD_ROOM_ID, { createdAt: NOW }),
    ]);
    const next = foldRoomIntoSessions(s, NOW);
    const ids = next.messages[workSessionId('agent-atlas', weekKey(NOW))].map((m) => m.id);
    expect(ids).toEqual(['u1', 'a1']);
  });

  it('is idempotent and ignores unfinished replies', () => {
    const s = withRoom([msg('a1', BUILD_ROOM_ID), msg('p1', BUILD_ROOM_ID, { status: 'pending', text: '' })]);
    const once = foldRoomIntoSessions(s, NOW);
    expect(foldRoomIntoSessions(once, NOW)).toBe(once);
    expect(once.messages[workSessionId('agent-atlas', weekKey(NOW))].map((m) => m.id)).toEqual(['a1']);
  });

  it('does not resurrect messages older than the work retention window', () => {
    const s = withRoom([msg('old', BUILD_ROOM_ID, { createdAt: NOW - 120 * DAY })]);
    expect(foldRoomIntoSessions(s, NOW)).toBe(s);
  });
});

describe('interrupted work resumes with context intact', () => {
  function interruptedChat(): { state: WorkspaceState; convId: string } {
    const s0 = base();
    const conv: Conversation = newChatSession({ id: 'agent-atlas' }, 'sess-x', NOW - 2 * DAY, 'Plan the migration');
    const history: Message[] = [
      msg('u1', 'sess-x', { authorType: 'user', authorId: undefined, text: 'We are migrating the billing tables. Use the blue-green plan.', createdAt: NOW - 2 * DAY }),
      msg('a1', 'sess-x', { text: 'Understood: blue-green, billing tables first.', createdAt: NOW - 2 * DAY + 1000 }),
      msg('u2', 'sess-x', { authorType: 'user', authorId: undefined, text: 'Now draft the rollback steps.', createdAt: NOW - 2 * DAY + 2000 }),
      msg('p1', 'sess-x', { status: 'pending', text: 'Rollback step 1: freeze wri', createdAt: NOW - 2 * DAY + 3000 }),
    ];
    return {
      convId: 'sess-x',
      state: { ...s0, conversations: [conv, ...s0.conversations], messages: { ...s0.messages, 'sess-x': history } },
    };
  }

  it('a reply left pending when the tab closed becomes an interrupted message and flags the session', () => {
    const { state, convId } = interruptedChat();
    const next = recoverInterrupted(state, NOW);
    const m = next.messages[convId].find((x) => x.id === 'p1')!;
    expect(m.status).toBe('error');
    expect(m.interrupted).toBe(true);
    expect(m.text).toContain('Rollback step 1: freeze wri');
    expect(next.conversations.find((c) => c.id === convId)!.session?.status).toBe('interrupted');
    expect(recoverInterrupted(next, NOW)).toBe(next);
  });

  it('planResume keeps every earlier message as context and re-asks only the cut-off agent', () => {
    const { state, convId } = interruptedChat();
    const plan = planResume(recoverInterrupted(state, NOW), convId)!;
    expect(plan.targetAgentIds).toEqual(['agent-atlas']);
    expect(plan.userMessage.id).toBe('u2');
    expect(plan.history.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    expect(plan.history[0].text).toContain('blue-green');
    expect(plan.nextState.messages[convId].some((m) => m.interrupted)).toBe(false);
    expect(plan.nextState.conversations.find((c) => c.id === convId)!.session?.status).toBe('active');
  });

  it('survives a JSON round trip through localStorage', () => {
    const { state, convId } = interruptedChat();
    const stored = JSON.parse(JSON.stringify(recoverInterrupted(state, NOW))) as WorkspaceState;
    expect(planResume(stored, convId)?.history).toHaveLength(3);
  });

  it('returns null when nothing was interrupted', () => {
    const s = base();
    expect(planResume(s, BUILD_ROOM_ID)).toBeNull();
  });
});

describe('retention', () => {
  it('prunes a days policy and drops work sessions that empty out, never chats', () => {
    let s = adoptSessions(base(), NOW);
    const chat = newChatSession({ id: 'agent-atlas' }, 'sess-c', NOW - 100 * DAY);
    chat.session!.retention = { mode: 'days', days: 30 };
    const work = foldRoomIntoSessions(
      { ...s, messages: { ...s.messages, [BUILD_ROOM_ID]: [msg('w1', BUILD_ROOM_ID, { createdAt: NOW - 10 * DAY })] } },
      NOW,
    );
    s = {
      ...work,
      conversations: [chat, ...work.conversations],
      messages: { ...work.messages, 'sess-c': [msg('c1', 'sess-c', { createdAt: NOW - 60 * DAY }), msg('c2', 'sess-c', { createdAt: NOW - 1 * DAY })] },
    };
    const wid = workSessionId('agent-atlas', weekKey(NOW - 10 * DAY));
    const squeezed = applyRetention(
      { ...s, conversations: s.conversations.map((c) => (c.id === wid ? { ...c, session: { ...c.session!, retention: { mode: 'days' as const, days: 1 } } } : c)) },
      NOW,
    );
    expect(squeezed.messages['sess-c'].map((m) => m.id)).toEqual(['c2']);
    expect(squeezed.conversations.some((c) => c.id === wid)).toBe(false);
    expect(squeezed.conversations.some((c) => c.id === 'sess-c')).toBe(true);
  });

  it('keeps the last N messages for a messages policy', () => {
    const s = adoptSessions(base(), NOW);
    const room = s.conversations.find((c) => c.id === BUILD_ROOM_ID)!;
    room.session!.retention = { mode: 'messages', max: 2 };
    s.messages[BUILD_ROOM_ID] = [1, 2, 3, 4].map((i) => msg(`m${i}`, BUILD_ROOM_ID, { createdAt: NOW + i }));
    expect(applyRetention(s, NOW).messages[BUILD_ROOM_ID].map((m) => m.id)).toEqual(['m3', 'm4']);
  });

  it('the defaults never delete a chat or the room', () => {
    const s = adoptSessions(base(), NOW);
    expect(applyRetention(s, NOW + 5 * 365 * DAY)).toBe(s);
  });
});

describe('autoNameSession / migrateToSessions', () => {
  it('names a new session after the first thing asked', () => {
    const conv = newChatSession({ id: 'agent-atlas' }, 'sess-n', NOW);
    expect(conv.name).toBe(DEFAULT_SESSION_NAME);
    const s0 = base();
    const s = { ...s0, conversations: [conv, ...s0.conversations], messages: { ...s0.messages, 'sess-n': [msg('u', 'sess-n', { authorType: 'user', authorId: undefined, text: '  Review the   retry logic in the runner please ' })] } };
    const named = autoNameSession(s, 'sess-n');
    expect(named.conversations.find((c) => c.id === 'sess-n')!.name).toBe('Review the retry logic in the runner please');
    expect(autoNameSession(named, 'sess-n')).toBe(named);
  });

  it('migrates a pre-session workspace in one call and is stable on a second pass', () => {
    const once = migrateToSessions(base(), NOW);
    expect(migrateToSessions(once, NOW)).toBe(once);
  });
});
