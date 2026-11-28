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
import { agentInputFromTemplate, currentVersion, firstSessionFor, type LibraryTemplate } from '../lib/library';
import { parseMentions } from '../lib/mentions';
import { runMentionChain } from '../lib/mentionFlow';
import { sendToAgent } from '../api/agents';
import { getSettings } from '../api/settings';
import { fetchRunnerState, type RunnerAgentSummary } from '../api/runnerState';
import {
  adoptSessions,
  applyRetention,
  autoNameSession,
  DEFAULT_SESSION_NAME,
  foldRoomIntoSessions,
  migrateToSessions,
  newChatSession,
  patchSession,
  planResume,
} from '../lib/sessions';
import type { RetentionPolicy } from '../types';

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
    if (!raw) return migrateToSessions(structuredClone(seedState), Date.now());
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (!parsed?.agents?.length || !parsed?.conversations?.length) {
      return migrateToSessions(structuredClone(seedState), Date.now());
    }
    return migrateToSessions(migrate({
      agents: parsed.agents,
      conversations: parsed.conversations,
      messages: parsed.messages ?? {},
      filters: parsed.filters ?? {},
      activeConversationId:
        parsed.activeConversationId ?? parsed.conversations[0]?.id ?? null,
    }), Date.now());
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
  /** Makes an agent and its first session from a Team Library template; refuses anything the Reviewer has not cleared. */
  createAgentFromLibrary: (
    template: LibraryTemplate,
    opts?: { name?: string },
  ) => { ok: true; agent: Agent; sessionId: string } | { ok: false; reason: string };
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
  /** Start a new named session with an agent and open it. */
  newSession: (agentId: string, name?: string) => string;
  /** Open any conversation or session by id. */
  openSession: (id: string) => void;
  renameSession: (id: string, name: string) => void;
  setSessionRetention: (id: string, retention: RetentionPolicy) => void;
  archiveSession: (id: string, archived: boolean) => void;
  /** Re-ask the agents whose replies were cut off; the whole conversation is the context. */
  resumeSession: (id: string) => Promise<void>;
  resetWorkspace: () => void;
}

/**
 * The runner's agents point at its own localhost agent endpoint
 * (http://127.0.0.1:8897/chat), which is unreachable from a browser on
 * another device. Rewrite a localhost/loopback host to the host this UI
 * was loaded from, so the agent is reachable from here. Any other host
 * is left alone.
 */
function browserEndpointUrl(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') {
      u.hostname = window.location.hostname || '127.0.0.1';
    }
    return u.toString();
  } catch {
    return serverUrl;
  }
}

/**
 * Merge the server runner's agents into the workspace, so the agents the
 * 24/7 runner actually runs are the ones this tab shows — and so a fix
 * on the server (a fake agent replaced with a real one, a provider
 * moved) reaches the UI without anyone having to reset demo data.
 * Server is the source of truth for the operational fields (name,
 * endpoint, model). Local-only fields (emoji, accent, status, prompt,
 * skills) are left alone, and agents that only exist locally are kept.
 */
export function mergeRunnerAgents(prev: WorkspaceState, serverAgents: RunnerAgentSummary[]): WorkspaceState {
  if (serverAgents.length === 0) return prev;
  let changed = false;
  const byId = new Map(prev.agents.map((a) => [a.id, a]));
  const agents = [...prev.agents];
  for (const s of serverAgents) {
    if (!s.id) continue;
    const endpointUrl = s.endpointUrl ? browserEndpointUrl(s.endpointUrl) : '';
    const existing = byId.get(s.id);
    if (existing) {
      const patch: Partial<Agent> = {};
      if (s.name && s.name !== existing.name) patch.name = s.name;
      if (endpointUrl && endpointUrl !== existing.endpointUrl) patch.endpointUrl = endpointUrl;
      if (s.model && s.model !== existing.model) patch.model = s.model;
      if (s.role && !existing.role && existing.skills.length === 0) patch.role = s.role;
      if (Object.keys(patch).length > 0) {
        const idx = agents.findIndex((a) => a.id === s.id);
        agents[idx] = { ...agents[idx], ...patch };
        changed = true;
      }
    } else {
      const index = Math.floor(Math.random() * ACCENT_PALETTE.length);
      agents.push({
        id: s.id,
        name: s.name || s.id,
        emoji: EMOJI_PALETTE[Math.floor(Math.random() * EMOJI_PALETTE.length)],
        accent: ACCENT_PALETTE[index],
        status: 'online',
        endpointUrl: endpointUrl || `http://${window.location.hostname || '127.0.0.1'}:8897/chat`,
        model: s.model || 'openai-fast',
        systemPrompt: `You are ${s.name || s.id}.`,
        ...(s.role ? { role: s.role } : {}),
        skills: [],
        createdAt: Date.now(),
      });
      changed = true;
    }
  }
  // The Build Room must hold the whole live fleet. The Orchestrator assigns
  // work there by @mention, and an agent that is not in the room never sees
  // the assignment in the UI. The seed only lists 35 agents; the runner
  // carries 106 — Jesse had to join them all by hand (Nov 28, 2026).
  // Bring the room up to the full fleet on every sync.
  const roomIdx = prev.conversations.findIndex(
    (c) => c.id === 'conv-build-room' && c.kind === 'channel',
  );
  let conversations = prev.conversations;
  if (roomIdx >= 0) {
    const room = prev.conversations[roomIdx];
    const missing = serverAgents
      .map((s) => s.id)
      .filter((id) => id && !room.agentIds.includes(id));
    if (missing.length > 0) {
      conversations = [...prev.conversations];
      conversations[roomIdx] = { ...room, agentIds: [...room.agentIds, ...missing] };
      changed = true;
    }
  }
  return changed ? { ...prev, agents, conversations } : prev;
}

export function useWorkspace(): UseWorkspace {
  const [state, setState] = useState<WorkspaceState>(loadState);
  const [typing, setTyping] = useState<Record<string, string[]>>({});
  const aborters = useRef<Map<string, AbortController>>(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;

  // Session upkeep. Every new DM becomes a session, and finished Build Room
  // replies are copied into the replying agent's own work session. Keyed on
  // counts so it does not re-run on every streamed token; every step returns
  // the same state object when there is nothing to change.
  const roomSentCount = (state.messages['conv-build-room'] ?? []).filter((m) => m.status === 'sent').length;
  useEffect(() => {
    setState((s) => foldRoomIntoSessions(adoptSessions(s, Date.now()), Date.now()));
  }, [state.conversations.length, roomSentCount]);

  // Retention is enforced on load (see migrateToSessions) and then hourly.
  useEffect(() => {
    const timer = setInterval(() => setState((s) => applyRetention(s, Date.now())), 3_600_000);
    return () => clearInterval(timer);
  }, []);

  // Abort every in-flight request if the component unmounts.
  useEffect(() => {
    return () => {
      aborters.current.forEach((c) => c.abort());
      aborters.current.clear();
    };
  }, []);

  // Persist on every change (debounced).
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (err) {
        // Surface quota failures instead of silently dropping the write.
        if (err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22)) {
          console.warn('[teamz] localStorage quota exceeded; workspace not saved.');
          window.dispatchEvent(new CustomEvent('teamz:storage-error', { detail: 'quota' }));
        }
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [state]);

  // Cross-tab sync: reload when another tab writes the workspace.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      try {
        const parsed = JSON.parse(e.newValue) as WorkspaceState;
        if (parsed?.agents?.length && parsed?.conversations?.length) {
          setState(foldRoomIntoSessions(adoptSessions(migrate(parsed), Date.now()), Date.now()));
        }
      } catch {
        /* ignore malformed */
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // Server runner sync: the headless runner on jnet1 is the source of
  // truth for the 24/7 agents, jobs and dispatches, but this tab's
  // workspace comes from localStorage/seed and never saw them — so the
  // Build Room only ever showed its seed messages, and a fake seed
  // agent stayed fake in the UI even after the server fixed it. On
  // mount and every 60s, merge the runner's recorded channel messages
  // (deduped by id) and its agent list (server wins for name, endpoint
  // and model; new server agents are added; local-only agents are
  // kept) into the workspace, so server fixes reach the UI with no
  // manual reset. Read-only fetch: if the runner is unreachable the
  // local workspace is untouched. Only conversations this workspace
  // already has receive messages — a stale workspace without the Build
  // Room is a separate problem (see the Jobs panel).
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      fetchRunnerState()
        .then((s) => {
          if (cancelled) return;
          setState((prev) => {
            let next = prev;
            if (s.channelMessages.length > 0) {
              let changed = false;
              const messages: Record<string, Message[]> = { ...next.messages };
              for (const m of s.channelMessages) {
                if (!next.conversations.some((c) => c.id === m.channelId)) continue;
                const existing = messages[m.channelId] ?? [];
                if (existing.some((x) => x.id === m.id)) continue;
                const incoming: Message = {
                  id: m.id,
                  conversationId: m.channelId,
                  authorType: 'agent',
                  authorId: m.agentId || undefined,
                  text: m.text,
                  createdAt: m.ts,
                  status: 'sent',
                };
                messages[m.channelId] = [...existing, incoming].sort(
                  (a, b) => a.createdAt - b.createdAt,
                );
                changed = true;
              }
              if (changed) next = { ...next, messages };
            }
            next = mergeRunnerAgents(next, s.agents);
            return next;
          });
        })
        .catch(() => {
          // Server runner unreachable — the local workspace is unaffected.
        });
    };
    sync();
    const timer = setInterval(sync, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

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
   * Deliver one turn: ask each target for a reply (plus any @-mention chain)
   * and write the replies into the conversation. Shared by `sendMessage` and
   * `resumeSession`, so a resumed reply behaves exactly like a fresh one.
   * `history` is the full context the agents see; it grows as they answer.
   */
  const deliverTurn = useCallback(
    async (opts: {
      conv: Conversation;
      members: Agent[];
      byId: Map<string, Agent>;
      history: Message[];
      targets: Agent[];
      directed: boolean;
    }) => {
      const { conv, members, byId, history, targets, directed } = opts;
      const others = members.map((a) => ({ id: a.id, name: a.name }));

      /**
       * Ask one agent for a reply and deliver it into the thread. Returns
       * the reply text, or null when no reply was delivered (error, abort)
       * — a null reply routes the chain nowhere.
       */
      const sendOne = async (
        agent: Agent,
        isDirected: boolean,
        mentionedBy?: Agent,
      ): Promise<string | null> => {
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
          const reply = await sendToAgent(agent, history, byId, {
            conversationId: conv.id,
            conversationName: conv.name,
            conversationKind: conv.kind === 'channel' ? 'channel' : 'direct',
            topic: conv.topic,
            otherAgents: others.filter((o) => o.id !== agent.id),
            directed: isDirected,
            mentionedBy: mentionedBy?.name,
            signal: controller.signal,
            // Stream tokens into the placeholder bubble as they arrive.
            onDelta: (partial) => patchMessage(conv.id, placeholderId, { text: partial }),
          });
          const createdAt = Date.now();
          patchMessage(conv.id, placeholderId, {
            text: reply,
            status: 'sent',
            createdAt,
          });
          history.push({
            id: placeholderId,
            conversationId: conv.id,
            authorType: 'agent',
            authorId: agent.id,
            text: reply,
            createdAt,
            status: 'sent',
          });
          return reply;
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
              text: `⚠️ Couldn’t get a reply from ${agent.name}.\n\n\`${message}\`\n\n${
                getSettings().provider === 'custom'
                  ? 'Check the endpoint URL in this agent’s settings.'
                  : 'Check Workspace & API settings (provider, model, API key) and try again.'
              }`,
              status: 'error',
              createdAt: Date.now(),
            });
          }
          return null;
        } finally {
          aborters.current.delete(`${conv.id}:${agent.id}`);
          setTyping((t) => ({
            ...t,
            [conv.id]: (t[conv.id] ?? []).filter((id) => id !== agent.id),
          }));
        }
      };

      // The mention flow drives the fan-out: the initial targets first, then
      // any agent a reply @-mentions, bounded by the chain's safety caps.
      await runMentionChain({
        members,
        initialTargets: targets,
        initialDirected: directed,
        send: sendOne,
      });
    },
    [appendMessage, patchMessage],
  );

  /**
   * Send one user message.
   *
   * Routing rules:
   *   • A channel with `@mentions` delivers only to the mentioned agents, and
   *     the stored message is marked `directed` with a `mentions` list.
   *   • A channel with no mention fans out to every member (the original
   *     behaviour) — that is the room's default.
   *   • A direct chat or session always goes to its single member, mention or not.
   *   • An agent's reply that @-mentions another agent in the same channel
   *     chains on to them: the reply is a state in the mention flow, and
   *     scanning it for @-mentions routes to the next agent(s). The chain
   *     is bounded (see `mentionFlow.ts`: depth cap, total-replies cap, a
   *     per-chain visited set, no self-mentions) so it always terminates,
   *     silently, with the replies already delivered left standing.
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
      setState((s) => autoNameSession(s, conv.id));

      // Grows as each agent answers, so later agents in a channel see what
      // earlier ones just said and can build on it instead of repeating it.
      const history: Message[] = [...activeMessages, userMessage];
      await deliverTurn({ conv, members, byId: agentsById, history, targets, directed });
    },
    [activeConversation, activeMessages, agentsById, appendMessage, deliverTurn],
  );

  const resumeSession = useCallback(
    async (id: string) => {
      const plan = planResume(stateRef.current, id);
      if (!plan) return;
      setState(plan.nextState);
      const byId = new Map(plan.nextState.agents.map((a) => [a.id, a]));
      const members = plan.conversation.agentIds
        .map((a) => byId.get(a))
        .filter((a): a is Agent => Boolean(a));
      const targets = plan.targetAgentIds
        .map((a) => byId.get(a))
        .filter((a): a is Agent => Boolean(a));
      if (targets.length === 0) return;
      await deliverTurn({
        conv: plan.conversation,
        members,
        byId,
        history: [...plan.history],
        targets,
        directed: Boolean(plan.userMessage.directed),
      });
    },
    [deliverTurn],
  );

  const newSession = useCallback((agentId: string, name?: string): string => {
    const id = uid('sess');
    setState((s) => {
      if (!s.agents.some((a) => a.id === agentId)) return s;
      const conv = newChatSession({ id: agentId }, id, Date.now(), name?.trim() || DEFAULT_SESSION_NAME);
      return {
        ...s,
        conversations: [conv, ...s.conversations],
        messages: { ...s.messages, [id]: [] },
        activeConversationId: id,
      };
    });
    return id;
  }, []);

  const openSession = useCallback((id: string) => {
    setState((s) => (s.conversations.some((c) => c.id === id) ? { ...s, activeConversationId: id } : s));
  }, []);

  const renameSession = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((s) => patchSession(s, id, {}, trimmed));
  }, []);

  const setSessionRetention = useCallback((id: string, retention: RetentionPolicy) => {
    setState((s) => applyRetention(patchSession(s, id, { retention }), Date.now()));
  }, []);

  const archiveSession = useCallback((id: string, archived: boolean) => {
    setState((s) => patchSession(s, id, { status: archived ? 'archived' : 'active' }));
  }, []);

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

  const createAgentFromLibrary = useCallback(
    (template: LibraryTemplate, opts: { name?: string } = {}) => {
      let input: Omit<Agent, 'id' | 'createdAt' | 'status'>;
      try {
        input = agentInputFromTemplate(template, { name: opts.name });
      } catch (e) {
        return { ok: false as const, reason: e instanceof Error ? e.message : 'This template cannot be used.' };
      }
      const agent = insertAgent(input, { conversationId: null, openDirect: true });
      const sessionId = uid('sess');
      const session = firstSessionFor(template, currentVersion(template), agent.id, sessionId, Date.now());
      setState((s) => ({
        ...s,
        conversations: [session, ...s.conversations],
        messages: { ...s.messages, [sessionId]: [] },
        activeConversationId: sessionId,
      }));
      return { ok: true as const, agent, sessionId };
    },
    [insertAgent],
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
          (c.kind === 'direct' || c.kind === 'session') && c.agentIds[0] === id
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
    setState(migrateToSessions(structuredClone(seedState), Date.now()));
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
    createAgentFromLibrary,
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
    newSession,
    openSession,
    renameSession,
    setSessionRetention,
    archiveSession,
    resumeSession,
    resetWorkspace,
  };
}
