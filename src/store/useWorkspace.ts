import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Conversation, Message, WorkspaceState } from '../types';
import { seedState, ACCENT_PALETTE, EMOJI_PALETTE } from '../data/mock';
import { sendToAgent } from '../api/agents';

const STORAGE_KEY = 'teamz:workspace:v1';

const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function loadState(): WorkspaceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(seedState);
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (!parsed?.agents?.length || !parsed?.conversations?.length) {
      return structuredClone(seedState);
    }
    return {
      agents: parsed.agents,
      conversations: parsed.conversations,
      messages: parsed.messages ?? {},
      activeConversationId:
        parsed.activeConversationId ?? parsed.conversations[0]?.id ?? null,
    };
  } catch {
    return structuredClone(seedState);
  }
}

export interface UseWorkspace {
  state: WorkspaceState;
  activeConversation: Conversation | null;
  activeMessages: Message[];
  agentsById: Map<string, Agent>;
  /** Conversation ids → agent ids currently "typing". */
  typing: Record<string, string[]>;
  canReply: boolean;
  setActiveConversation: (id: string) => void;
  sendMessage: (text: string) => Promise<void>;
  createAgent: (input: Omit<Agent, 'id' | 'createdAt' | 'status'>) => Agent;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  deleteAgent: (id: string) => void;
  createChannel: (name: string, agentIds: string[], topic?: string) => Conversation;
  updateChannelMembers: (id: string, agentIds: string[]) => void;
  renameConversation: (id: string, name: string) => void;
  deleteConversation: (id: string) => void;
  openDirectChat: (agentId: string) => void;
  resetWorkspace: () => void;
}

export function useWorkspace(): UseWorkspace {
  const [state, setState] = useState<WorkspaceState>(loadState);
  const [typing, setTyping] = useState<Record<string, string[]>>({});
  const aborters = useRef<Map<string, AbortController>>(new Map());

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage full / disabled — the UI still works in memory */
    }
  }, [state]);

  const agentsById = useMemo(
    () => new Map(state.agents.map((a) => [a.id, a])),
    [state.agents],
  );

  const activeConversation =
    state.conversations.find((c) => c.id === state.activeConversationId) ?? null;

  const activeMessages = activeConversation
    ? state.messages[activeConversation.id] ?? []
    : [];

  const setActiveConversation = useCallback((id: string) => {
    setState((s) => ({ ...s, activeConversationId: id }));
  }, []);

  const appendMessage = useCallback((message: Message) => {
    setState((s) => ({
      ...s,
      messages: {
        ...s.messages,
        [message.conversationId]: [...(s.messages[message.conversationId] ?? []), message],
      },
    }));
  }, []);

  const patchMessage = useCallback((conversationId: string, id: string, patch: Partial<Message>) => {
    setState((s) => ({
      ...s,
      messages: {
        ...s.messages,
        [conversationId]: (s.messages[conversationId] ?? []).map((m) =>
          m.id === id ? { ...m, ...patch } : m,
        ),
      },
    }));
  }, []);

  /**
   * Fan out one user message to every agent in the conversation.
   * In a channel each member answers — sequentially, so replies interleave
   * readably instead of landing in a random order.
   */
  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const conv = activeConversation;
      if (!trimmed || !conv) return;

      const userMessage: Message = {
        id: uid('m'),
        conversationId: conv.id,
        authorType: 'user',
        text: trimmed,
        createdAt: Date.now(),
        status: 'sent',
      };
      appendMessage(userMessage);

      const members = conv.agentIds
        .map((id) => agentsById.get(id))
        .filter((a): a is Agent => Boolean(a));

      if (members.length === 0) return;

      const history = [...activeMessages, userMessage];
      const others = members.map((a) => ({ id: a.id, name: a.name }));

      for (const agent of members) {
        const controller = new AbortController();
        aborters.current.set(`${conv.id}:${agent.id}`, controller);

        setTyping((t) => ({
          ...t,
          [conv.id]: [...(t[conv.id] ?? []), agent.id],
        }));

        const placeholderId = uid('m');
        appendMessage({
          id: placeholderId,
          conversationId: conv.id,
          authorType: 'agent',
          authorId: agent.id,
          text: '',
          createdAt: Date.now(),
          status: 'pending',
        });

        try {
          const reply = await sendToAgent(agent, history, agentsById, {
            conversationId: conv.id,
            conversationName: conv.name,
            otherAgents: others.filter((o) => o.id !== agent.id),
            signal: controller.signal,
          });
          patchMessage(conv.id, placeholderId, {
            text: reply,
            status: 'sent',
            createdAt: Date.now(),
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            patchMessage(conv.id, placeholderId, {
              text: '_Cancelled._',
              status: 'error',
              createdAt: Date.now(),
            });
          } else {
            const message = err instanceof Error ? err.message : 'Unknown error';
            patchMessage(conv.id, placeholderId, {
              text: `Couldn’t reach ${agent.name}.\n\n\`${message}\`\n\nCheck the endpoint URL in this agent’s settings.`,
              status: 'error',
              createdAt: Date.now(),
            });
          }
        } finally {
          aborters.current.delete(`${conv.id}:${agent.id}`);
          setTyping((t) => ({
            ...t,
            [conv.id]: (t[conv.id] ?? []).filter((id) => id !== agent.id),
          }));
        }
      }
    },
    [activeConversation, activeMessages, agentsById, appendMessage, patchMessage],
  );

  const createAgent = useCallback((input: Omit<Agent, 'id' | 'createdAt' | 'status'>) => {
    const index = Math.floor(Math.random() * ACCENT_PALETTE.length);
    const agent: Agent = {
      ...input,
      emoji: input.emoji || EMOJI_PALETTE[Math.floor(Math.random() * EMOJI_PALETTE.length)],
      accent: input.accent || ACCENT_PALETTE[index],
      id: uid('agent'),
      status: 'online',
      createdAt: Date.now(),
    };

    setState((s) => {
      const direct: Conversation = {
        id: uid('conv'),
        kind: 'direct',
        name: agent.name,
        agentIds: [agent.id],
        createdAt: Date.now(),
      };
      return {
        ...s,
        agents: [...s.agents, agent],
        conversations: [direct, ...s.conversations],
        messages: { ...s.messages, [direct.id]: [] },
        activeConversationId: direct.id,
      };
    });

    return agent;
  }, []);

  const updateAgent = useCallback((id: string, patch: Partial<Agent>) => {
    setState((s) => {
      const agents = s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a));
      // Keep direct-chat labels in sync with the agent's display name.
      const conversations = s.conversations.map((c) =>
        c.kind === 'direct' && c.agentIds[0] === id && patch.name
          ? { ...c, name: patch.name }
          : c,
      );
      return { ...s, agents, conversations };
    });
  }, []);

  const deleteAgent = useCallback((id: string) => {
    setState((s) => {
      const conversations = s.conversations
        .map((c) =>
          c.kind === 'direct' && c.agentIds[0] === id
            ? null
            : { ...c, agentIds: c.agentIds.filter((agentId) => agentId !== id) },
        )
        .filter((c): c is Conversation => Boolean(c))
        // A channel with nobody left in it is noise — drop it.
        .filter((c) => c.kind === 'direct' || c.agentIds.length > 0);

      const messages: Record<string, Message[]> = {};
      for (const c of conversations) messages[c.id] = s.messages[c.id] ?? [];

      return {
        ...s,
        agents: s.agents.filter((a) => a.id !== id),
        conversations,
        messages,
        activeConversationId: conversations.some((c) => c.id === s.activeConversationId)
          ? s.activeConversationId
          : conversations[0]?.id ?? null,
      };
    });
  }, []);

  const createChannel = useCallback((name: string, agentIds: string[], topic?: string) => {
    const channel: Conversation = {
      id: uid('conv'),
      kind: 'channel',
      name: name.trim() || 'New Channel',
      agentIds,
      topic: topic?.trim() || undefined,
      createdAt: Date.now(),
    };
    setState((s) => ({
      ...s,
      conversations: [channel, ...s.conversations],
      messages: { ...s.messages, [channel.id]: [] },
      activeConversationId: channel.id,
    }));
    return channel;
  }, []);

  const updateChannelMembers = useCallback((id: string, agentIds: string[]) => {
    setState((s) => ({
      ...s,
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, agentIds } : c)),
    }));
  }, []);

  const renameConversation = useCallback((id: string, name: string) => {
    setState((s) => ({
      ...s,
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, name } : c)),
    }));
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setState((s) => {
      const conversations = s.conversations.filter((c) => c.id !== id);
      const messages = { ...s.messages };
      delete messages[id];
      return {
        ...s,
        conversations,
        messages,
        activeConversationId:
          s.activeConversationId === id ? conversations[0]?.id ?? null : s.activeConversationId,
      };
    });
  }, []);

  const openDirectChat = useCallback((agentId: string) => {
    setState((s) => {
      const existing = s.conversations.find(
        (c) => c.kind === 'direct' && c.agentIds[0] === agentId,
      );
      if (existing) return { ...s, activeConversationId: existing.id };

      const agent = s.agents.find((a) => a.id === agentId);
      const direct: Conversation = {
        id: uid('conv'),
        kind: 'direct',
        name: agent?.name ?? 'New Chat',
        agentIds: [agentId],
        createdAt: Date.now(),
      };
      return {
        ...s,
        conversations: [direct, ...s.conversations],
        messages: { ...s.messages, [direct.id]: [] },
        activeConversationId: direct.id,
      };
    });
  }, []);

  const resetWorkspace = useCallback(() => {
    aborters.current.forEach((c) => c.abort());
    aborters.current.clear();
    setTyping({});
    setState(structuredClone(seedState));
  }, []);

  return {
    state,
    activeConversation,
    activeMessages,
    agentsById,
    typing,
    canReply: Boolean(activeConversation && activeConversation.agentIds.length > 0),
    setActiveConversation,
    sendMessage,
    createAgent,
    updateAgent,
    deleteAgent,
    createChannel,
    updateChannelMembers,
    renameConversation,
    deleteConversation,
    openDirectChat,
    resetWorkspace,
  };
}
