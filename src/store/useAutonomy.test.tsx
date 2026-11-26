// @vitest-environment jsdom
/**
 * In-tab runner hook test — the wiring the unit tests cannot see.
 *
 * Renders `useAutonomy` against a fake workspace (same shape as the real
 * `useWorkspace` return, but with a recording `sendMessage`) and drives it
 * with fake timers: a due trigger must be delivered through `sendMessage`
 * with an @mention after the runner switches to the trigger's channel, and
 * a product job's stage must complete from the agent's reply landing in
 * the channel, advancing the job and recording the output.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { useAutonomy, AUTONOMY_STORAGE_KEY, type UseAutonomy } from './useAutonomy';
import type { Agent, Conversation, Message, WorkspaceState } from '../types';
import type { UseWorkspace } from './useWorkspace';

const SCOUT: Agent = {
  id: 'agent-scout',
  name: 'Scout',
  emoji: '🔭',
  accent: '#7c9cff',
  status: 'online',
  endpointUrl: 'http://localhost:8001/chat',
  model: 'gpt-4o-mini',
  systemPrompt: '',
  skills: [],
  createdAt: 0,
};

const BUILD_ROOM: Conversation = {
  id: 'conv-build-room',
  kind: 'channel',
  name: 'Build Room',
  agentIds: ['agent-scout'],
  createdAt: 0,
};

const SCOUT_DM: Conversation = {
  id: 'conv-scout',
  kind: 'direct',
  name: 'Scout',
  agentIds: ['agent-scout'],
  createdAt: 0,
};

interface FakeWs {
  state: WorkspaceState;
  sendCalls: string[];
  setActiveCalls: string[];
  build: () => UseWorkspace;
  setActiveConversation: (id: string) => void;
  addMessage: (message: Message) => void;
}

function makeFakeWs(activeId: string): FakeWs {
  const state: WorkspaceState = {
    agents: [SCOUT],
    conversations: [BUILD_ROOM, SCOUT_DM],
    messages: { 'conv-build-room': [], 'conv-scout': [] },
    filters: {},
    activeConversationId: activeId,
  };
  const sendCalls: string[] = [];
  const setActiveCalls: string[] = [];
  const fake: FakeWs = {
    state,
    sendCalls,
    setActiveCalls,
    build: () =>
      ({
        state,
        activeConversation:
          state.conversations.find((c) => c.id === state.activeConversationId) ?? null,
        activeMessages: state.messages[state.activeConversationId ?? ''] ?? [],
        agentsById: new Map(state.agents.map((a) => [a.id, a])),
        typing: {},
        canReply: true,
        setActiveConversation: fake.setActiveConversation,
        sendMessage: async (text: string) => {
          sendCalls.push(text);
          const convId = state.activeConversationId ?? '';
          // Replace the record (like the real store's setState) so
          // effects depending on `state.messages` re-run.
          state.messages = {
            ...state.messages,
            [convId]: [
              ...(state.messages[convId] ?? []),
              {
                id: `m-${sendCalls.length}`,
                conversationId: convId,
                authorType: 'user',
                text,
                createdAt: Date.now(),
                status: 'sent',
              },
            ],
          };
        },
      }) as unknown as UseWorkspace,
    setActiveConversation: (id: string) => {
      setActiveCalls.push(id);
      state.activeConversationId = id;
    },
    addMessage: (message: Message) => {
      state.messages = {
        ...state.messages,
        [message.conversationId]: [...(state.messages[message.conversationId] ?? []), message],
      };
    },
  };
  return fake;
}

let latest: UseAutonomy | null = null;
function Probe({ ws }: { ws: UseWorkspace }) {
  latest = useAutonomy(ws);
  return null;
}

describe('useAutonomy — in-tab runner wiring', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    if (container) container.remove();
    root = null;
    container = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function renderWs(fake: FakeWs) {
    await act(async () => {
      root!.render(React.createElement(Probe, { ws: fake.build() }));
    });
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('fires a due trigger through sendMessage with an @mention', async () => {
    localStorage.setItem(
      AUTONOMY_STORAGE_KEY,
      JSON.stringify({
        jobs: [],
        approvals: [],
        cronJobs: [],
        triggers: [
          {
            id: 'trg-smoke',
            channelId: 'conv-build-room',
            agentId: 'agent-scout',
            prompt: 'Smoke test ping.',
            everyMs: 60000,
            lastRunAt: null,
            enabled: true,
          },
        ],
      }),
    );
    const fake = makeFakeWs('conv-scout');
    await renderWs(fake);
    expect(latest?.triggers).toHaveLength(1);

    // The first tick fires 1s after mount.
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    await flush();
    // The dispatcher switches to the trigger's channel first.
    expect(fake.setActiveCalls).toContain('conv-build-room');
    await renderWs(fake);
    await flush();
    // ...then sends the prompt, directed at Scout.
    expect(fake.sendCalls).toHaveLength(1);
    expect(fake.sendCalls[0]).toContain('@Scout');
    expect(fake.sendCalls[0]).toContain('Smoke test ping.');
    // The trigger is marked as run, so the next tick does not refire it.
    expect(latest?.triggers[0].lastRunAt).not.toBeNull();
  });

  it('advances a job stage when the agent reply lands in the channel', async () => {
    localStorage.setItem(
      AUTONOMY_STORAGE_KEY,
      JSON.stringify({
        approvals: [],
        cronJobs: [],
        triggers: [],
        jobs: [
          {
            id: 'job-test',
            name: 'Test job',
            description: '',
            channelId: 'conv-build-room',
            managerAgentId: null,
            stages: [
              {
                stage: 'design',
                agentId: 'agent-scout',
                prompt: 'Design it.',
                expectedOutput: 'A design.',
                contextStages: [],
                humanInput: false,
              },
              {
                stage: 'build',
                agentId: 'agent-scout',
                prompt: 'Build it.',
                expectedOutput: 'A build.',
                contextStages: ['design'],
                humanInput: false,
              },
            ],
            currentStageIndex: 0,
            status: 'active',
            schedule: { kind: 'interval', everyMs: 1000 },
            enabled: true,
            lastRunAt: null,
            runs: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      }),
    );
    const fake = makeFakeWs('conv-build-room');
    await renderWs(fake);

    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    await flush();
    expect(fake.sendCalls).toHaveLength(1);
    expect(fake.sendCalls[0]).toContain('Design it.');
    const job = latest?.jobs[0];
    expect(job?.runs).toHaveLength(1);
    expect(job?.runs[0].status).toBe('dispatched');

    // The agent's reply arrives in the channel; the watcher completes the run.
    fake.addMessage({
      id: 'm-reply-1',
      conversationId: 'conv-build-room',
      authorType: 'agent',
      authorId: 'agent-scout',
      text: 'The design: three modules.',
      createdAt: Date.now() + 5000,
      status: 'sent',
    });
    await renderWs(fake);
    await flush();
    const done = latest?.jobs[0];
    expect(done?.runs[0].status).toBe('ok');
    expect(done?.runs[0].output).toBe('The design: three modules.');
    expect(done?.runs[0].messageId).toBe('m-reply-1');
    expect(done?.currentStageIndex).toBe(1);
  });

  it('parks a gated stage and files an approval instead of sending', async () => {
    localStorage.setItem(
      AUTONOMY_STORAGE_KEY,
      JSON.stringify({
        approvals: [],
        cronJobs: [],
        triggers: [],
        jobs: [
          {
            id: 'job-gated',
            name: 'Gated job',
            description: '',
            channelId: 'conv-build-room',
            managerAgentId: null,
            stages: [
              {
                stage: 'release',
                agentId: 'agent-scout',
                prompt: 'Release it.',
                expectedOutput: 'Release notes.',
                contextStages: [],
                humanInput: true,
              },
            ],
            currentStageIndex: 0,
            status: 'active',
            schedule: { kind: 'interval', everyMs: 1000 },
            enabled: true,
            lastRunAt: null,
            runs: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      }),
    );
    const fake = makeFakeWs('conv-build-room');
    await renderWs(fake);
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    await flush();
    // Nothing was sent to any agent.
    expect(fake.sendCalls).toHaveLength(0);
    // The job parked and an approval request exists.
    expect(latest?.jobs[0].status).toBe('awaiting_approval');
    expect(latest?.approvals).toHaveLength(1);
    expect(latest?.approvals[0].stage).toBe('release');
    expect(latest?.approvals[0].status).toBe('pending');
  });
});
