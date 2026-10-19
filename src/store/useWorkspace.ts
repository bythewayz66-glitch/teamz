import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Agent,
  Conversation,
  Message,
  MessageFilter,
  Seniority,
  WorkspaceState,
} from '../types';
import { seedState, ACCENT_PALETTE, EMOJI_PALETTE } from '../data/mock';
import {
  getTemplateById,
  instantiateTemplate,
  type AgentTemplate,
} from '../data/templates';
import { parseMentions } from '../lib/mentions';
import { sendToAgent } from '../api/agents';

const STORAGE_KEY = 'teamz:workspace:v1';

const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * State written by an older build had no `skills` on agents. Normalise on read
 * so an upgrade never crashes, and so template-made agents keep their skills.
 */
function migrate(parsed: WorkspaceState): WorkspaceState {
  return {
    ...parsed,
    agents: parsed.agents.map((a) => ({ ...a, skills: a.skills ?? [] })),
    // Filters arrived after the first release; an old blob has none, and the
    // default (no filter) is exactly the old behaviour.
    filters: parsed.filters ?? {},
  };
}

function loadState(): WorkspaceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(seedState);
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (!parsed?.agents?.length || !parsed?.conversations?.length) {
      return structuredClone(seedState);
    }
    return migrate({
      agents: parsed.agents,
      conversations: parsed.conversations,
      messages: parsed.messages ?? {},
      filters: parsed.filters ?? {},
      activeConversationId:
        parsed.activeConversationId ?? parsed.conversations[0]?.id ?? null,
    });
  } catch {
    return structuredClone(seedState);
  }
}

/**
 * Build a ready-to-insert agent from a catalogue template.
 *
 * The heavy lifting (id, skills, provenance) lives in `instantiateTemplate`,
 * so the picker and the store can never drift apart. This wrapper only adds
 * the two things the store owns: a local-looking endpoint and a tint.
 */
export function agentFromTemplate(
  template: AgentTemplate,
  tint: { accent?: string; emoji?: string; name?: string; seniority?: Seniority } = {},
): Omit<Agent, 'id' | 'createdAt' | 'status'> {
  const built = instantiateTemplate(template.id, {
    name: tint.name,
    seniority: tint.seniority,
  });
  return {
    name: built.name,
    emoji: tint.emoji ?? built.emoji,
    accent: tint.accent ?? built.accent,
    endpointUrl: `http://localhost:${8100 + Math.floor(Math.random() * 800)}/chat`,
    model: built.model,
    systemPrompt: built.systemPrompt,
    skills: built.skills,
    origin: built.origin,
  };
}

export interface CreateAgentFromTemplateOptions {
  /** Override the display name (defaults to the template name). */
  name?: string;
  /** Create at a different level than the template's own. */
  seniority?: Seniority;
  /** Invite into this conversation. Defaults to the active conversation. */
  conversationId?: string | null;
  /** Also open (or create) the 1:1 DM with the new agent afterwards. */
  openDirect?: boolean;
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
  /** Send to the room. `@mentions` narrow delivery to the named agents. */
  sendMessage: (text: string) => Promise<void>;
  createAgent: (input: Omit<Agent, 'id' | 'createdAt' | 'status'>) => Agent;
  /** Instantiate a template agent and invite it straight into the room. */
  createAgentFromTemplate: (
    templateId: string,
    options?: CreateAgentFromTemplateOptions,
  ) => Agent | null;
  /** Add an existing agent to a channel. */
  inviteAgentToConversation: (conversationId: string, agentId: string) => void;
  /** The active conversation's message filter (defaults to "show everything"). */
  activeFilter: MessageFilter;
  /** Set the filter for one conversation; persisted with the rest of state. */
  setConversationFilter: (conversationId: string, filter: MessageFilter) => void;
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
   * Send one user message.
   *
   * Routing rules:
   *   • A channel with `@mentions` delivers only to the mentioned agents, and
   *     the stored message is marked `directed` with a `mentions` list.
   *   • A channel with no mention fans out to every member (the original
   *     behaviour) — that is the room's default.
   *   • A direct chat always goes to its single member, mention or not.
   *
   * Replies are interleaved sequentially so a multi-agent room reads in order
   * rather than landing at random.
   */
  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const conv = activeConversation;
      if (!trimmed || !conv) return;

      const members = conv.agentIds
        .map((id) => agentsById.get(id))
        .filter((a): a is Agent => Boolean(a));

      if (members.length === 0) return;

      // Who was addressed? In a DM there is only one candidate anyway.
      const mentioned = conv.kind === 'channel' ? parseMentions(trimmed, members) : [];
      const directed = mentioned.length > 0;
      const targets = directed ? mentioned : members;

      const userMessage: Message = {
        id: uid('m'),
        conversationId: conv.id,
        authorType: 'user',
        text: trimmed,
        createdAt: Date.now(),
        status: 'sent',
        ...(directed ? { mentions: mentioned.map((a) => a.id), directed: true } : {}),
      };
      appendMessage(userMessage);

      const history = [...activeMessages, userMessage];
      const others = members.map((a) => ({ id: a.id, name: a.name }));

      for (const agent of targets) {
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
            directed,
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
              text: `Couldn\u2019t reach ${agent.name}.\n\n\`${message}\`\n\nCheck the endpoint URL in this agent\u2019s settings.`,
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

  /** Insert an agent, plus its 1:1 thread, and optionally invite it into a room. */
  const insertAgent = useCallback(
    (
      input: Omit<Agent, 'id' | 'createdAt' | 'status'>,
      opts: { conversationId?: string | null; openDirect?: boolean },
    ): Agent => {
      const index = Math.floor(Math.random() * ACCENT_PALETTE.length);
      const agent: Agent = {
        ...input,
        emoji: input.emoji || EMOJI_PALETTE[Math.floor(Math.random() * EMOJI_PALETTE.length)],
        accent: input.accent || ACCENT_PALETTE[index],
        skills: input.skills ?? [],
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

        const targetId = opts.conversationId ?? null;

        // Invite into the room the user is looking at — this is the point of
        // picking a template: it joins the team you are already talking to.
        const conversations = s.conversations.map((c) => {
          if (c.id !== targetId || c.kind !== 'channel') return c;
          if (c.agentIds.includes(agent.id)) return c;
          return { ...c, agentIds: [...c.agentIds, agent.id] };
        });

        const joinedRoom = conversations.some(
          (c) => c.id === targetId && c.kind === 'channel' && c.agentIds.includes(agent.id),
        );

        return {
          ...s,
          agents: [...s.agents, agent],
          conversations: [direct, ...conversations],
          messages: { ...s.messages, [direct.id]: [] },
          // Stay in the room so the user sees the new member appear; only jump
          // to the DM when nothing was joined.
          activeConversationId:
            joinedRoom && !opts.openDirect ? targetId : direct.id,
        };
      });

      return agent;
    },
    [],
  );

  const createAgent = useCallback(
    (input: Omit<Agent, 'id' | 'createdAt' | 'status'>) => {
      // Hand-made agents join the current room too, matching the template flow.
      return insertAgent(input, {
        conversationId: state.activeConversationId,
        openDirect: false,
      });
    },
    [insertAgent, state.activeConversationId],
  );

  const createAgentFromTemplate = useCallback(
    (templateId: string, options: CreateAgentFromTemplateOptions = {}) => {
      const template = getTemplateById(templateId);
      if (!template) return null;

      const input = agentFromTemplate(template, {
        accent: ACCENT_PALETTE[Math.floor(Math.random() * ACCENT_PALETTE.length)],
        seniority: options.seniority,
      });

      const agent = insertAgent(
        { ...input, name: options.name?.trim() || input.name },
        {
          conversationId: options.conversationId ?? state.activeConversationId,
          openDirect: options.openDirect ?? false,
        },
      );

      return agent;
    },
    [insertAgent, state.activeConversationId],
  );

  const inviteAgentToConversation = useCallback((conversationId: string, agentId: string) => {
    setState((s) => ({
      ...s,
      conversations: s.conversations.map((c) =>
        c.id === conversationId && !c.agentIds.includes(agentId)
          ? { ...c, agentIds: [...c.agentIds, agentId] }
          : c,
      ),
    }));
  }, []);

  /**
   * Per-conversation message filter.
   *
   * Stored in the same persisted blob as everything else, keyed by
   * conversation id, so each channel remembers its own filter across a reload
   * and switching channels restores that channel's view rather than carrying
   * one global setting around.
   */
  const setConversationFilter = useCallback(
    (conversationId: string, filter: MessageFilter) => {
      setState((s) => {
        const filters = { ...s.filters };
        // "all" is the default, so storing it would only bloat the blob.
        if (filter.mode === 'all') delete filters[conversationId];
        else filters[conversationId] = filter;
        return { ...s, filters };
      });
    },
    [],
  );

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

  const activeFilter: MessageFilter =
    (state.activeConversationId ? state.filters[state.activeConversationId] : undefined) ?? {
      mode: 'all',
    };

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
    createAgentFromTemplate,
    inviteAgentToConversation,
    activeFilter,
    setConversationFilter,
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
