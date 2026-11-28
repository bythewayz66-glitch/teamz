/** Core domain types for the teamz workspace. */

export type AgentStatus = 'online' | 'busy' | 'offline';

/**
 * The seniority axis. Declared here rather than in `data/templates/seniority`
 * so the domain types stay the single source of truth and the template layer
 * can import it without a cycle.
 */
export type Seniority = 'junior' | 'mid' | 'senior' | 'lead' | 'principal';

/** Which agent template an agent was instantiated from, if any. */
export interface AgentOrigin {
  /** Template id, e.g. `engineering.senior-frontend-engineer`. */
  templateId: string;
  /** Category / role family the template belongs to, e.g. `engineering`. */
  familySlug: string;
  /** Human role label at creation time, e.g. "Senior Frontend Engineer". */
  role: string;
  /**
   * Level the agent was created at. Absent on agents made before the
   * seniority axis existed, and on hand-made agents.
   */
  seniority?: Seniority;
}

/**
 * A capability as it appears on an *agent*, i.e. after a template has been
 * instantiated. `level` (1 = knows it, 5 = specialist depth) drives chip order
 * and the in-character intro the mock API writes.
 */
export interface AgentSkill {
  /** Stable machine key, e.g. `react`. */
  key: string;
  /** Human label shown on the agent card. */
  label: string;
  /** 1 = knows it, 5 = specialist depth. */
  level: number;
}

/** A single AI agent the user runs on their own infrastructure. */
export interface Agent {
  id: string;
  /** Display name, e.g. "Scout". */
  name: string;
  /** Single emoji used as the avatar. */
  emoji: string;
  /** Accent colour (hex) used for the avatar ring and name label. */
  accent: string;
  status: AgentStatus;
  /** Base URL of the agent's HTTP endpoint, e.g. http://localhost:8001/chat */
  endpointUrl: string;
  /** Model identifier — whatever your server expects (gpt-4o, llama3.1:70b, ...). */
  model: string;
  /** System prompt / operating instructions for this agent. */
  systemPrompt: string;
  /** Skills derived from the template this agent came from. */
  skills: AgentSkill[];
  /**
   * Tool ids this agent may use, e.g. `['wikipedia', 'weather']` (see
   * `src/lib/tools.ts`). Absent or empty means no tools: the agent answers
   * from the model alone, exactly as before.
   */
  enabledTools?: string[];
  /** Provenance — absent for hand-made agents. */
  origin?: AgentOrigin;
  /**
   * Self-model, in the mem20crewz Agent shape (role → goal → backstory →
   * capabilities → values). Stored so the system prompt can be re-composed
   * from the identity instead of only ever edited as raw text. Absent on
   * agents made before the guided creation flow existed.
   */
  role?: string;
  goal?: string;
  backstory?: string;
  /** Free-form capability lines, e.g. "review pull requests for blast radius". */
  capabilities?: string[];
  /** Working principles, e.g. "cite the source, never the summary". */
  values?: string[];
  /**
   * Per-agent execution budgets, same knobs as mem20crewz Agent
   * (`max_iter` / `max_execution_time`). Absent means the workspace default.
   */
  maxIterations?: number;
  /** Hard deadline in seconds; absent (or 0) means unlimited. */
  maxExecutionTimeSeconds?: number;
  /** Last reachability check result (persisted). */
  lastPingAt?: number;
  lastPingOk?: boolean;
  lastPingMessage?: string;
  /** Default retention for this agent's new sessions (Gamut's per-agent "Session Auto-Delete"). */
  sessionRetention?: RetentionPolicy;
  createdAt: number;
}

/**
 * `session` is a named, per-agent conversation beyond the agent's one
 * pinned DM: extra chats and the runner-work sessions. The sidebar only lists
 * `direct` and `channel`, so sessions never crowd the rail; they are reached
 * from an agent's home or from search.
 */
export type ConversationKind = 'direct' | 'channel' | 'session';

/** chat = a conversation with one agent; work = what an agent did in the room
 * (runner jobs, assignments); room = the shared channel Jesse watches. */
export type SessionKind = 'chat' | 'work' | 'room';

/** interrupted = a reply was in flight when the tab/runner stopped; resumable. */
export type SessionStatus = 'active' | 'interrupted' | 'archived';

/** How long a session's messages are kept. Always explicit, never implied. */
export type RetentionPolicy =
  | { mode: 'forever' }
  | { mode: 'days'; days: number }
  | { mode: 'messages'; max: number };

/** Durable-work metadata a conversation carries when it is a session. */
export interface SessionMeta {
  kind: SessionKind;
  /** Owning agent. Absent only for the shared room. */
  agentId?: string;
  status: SessionStatus;
  retention: RetentionPolicy;
  /** Starred sessions are never pruned by retention. */
  starred?: boolean;
  updatedAt: number;
  /** Set when a reply was cut off; cleared on resume. */
  interruptedAt?: number;
  /** For `work` sessions: the week they cover, e.g. `2026-W48`. */
  weekKey?: string;
}

/**
 * A conversation is either a 1:1 chat with a single agent (`direct`)
 * or a multi-agent room (`channel`) holding several agents at once.
 */
export interface Conversation {
  id: string;
  kind: ConversationKind;
  name: string;
  /** Members. Exactly one for a direct chat, 1..n for a channel. */
  agentIds: string[];
  topic?: string;
  createdAt: number;
  /** Present when this conversation is a session (see SessionMeta). */
  session?: SessionMeta;
}

export type MessageStatus = 'sent' | 'pending' | 'error';

/**
 * Per-conversation message filter.
 *
 * `all` is the default and means "show everything" — the view a user who
 * never touches the control always gets. `directed` narrows to messages that
 * were addressed to somebody via `@mention`. `agent` narrows to messages
 * addressed to one specific agent, which is how a single @mention thread is
 * read on its own.
 */
export interface MessageFilter {
  mode: 'all' | 'directed' | 'agent';
  /** Set only when `mode === 'agent'`. */
  agentId?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  authorType: 'user' | 'agent';
  /** Present when authorType === 'agent'. */
  authorId?: string;
  text: string;
  createdAt: number;
  status: MessageStatus;
  /**
   * Agent ids this message was addressed to via `@mention`.
   * Present (and non-empty) only on user messages that contain mentions —
   * that is what makes the message "directed" rather than a broadcast.
   */
  mentions?: string[];
  /** True when a user message in a channel is a DM-style aside to one agent. */
  directed?: boolean;
  /** A reply cut off mid-flight (tab closed, network lost); resumable. */
  interrupted?: boolean;
}

export interface WorkspaceState {
  agents: Agent[];
  conversations: Conversation[];
  /** Messages keyed by conversation id, oldest first. */
  messages: Record<string, Message[]>;
  /**
   * Message filter per conversation id. A conversation with no entry is
   * unfiltered, so this map stays empty for anyone who never uses the control.
   */
  filters: Record<string, MessageFilter>;
  activeConversationId: string | null;
}

/* ---------------------------------------------------------------------------
 * Template catalogue
 *
 * A template is inert data: nothing here runs until the user picks one and
 * `instantiateTemplate()` turns it into a real Agent in the workspace.
 * ------------------------------------------------------------------------- */

/** The broad domains templates are grouped into — one tab each in the picker. */
export type TemplateCategory =
  | 'engineering'
  | 'design'
  | 'product'
  | 'data'
  | 'research'
  | 'marketing'
  | 'sales'
  | 'support'
  | 'finance'
  | 'legal'
  | 'people'
  | 'operations'
  | 'education'
  | 'health'
  | 'creative';

/**
 * A capability as the *catalogue* declares it — described once in `skills.ts`
 * and referenced by templates by id, so 500 entries never repeat skill prose.
 */
export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  /** Domain the skill belongs to; usually the template's own category. */
  category: TemplateCategory;
  /** Extra search terms, not shown in the UI. */
  tags?: string[];
}

/**
 * A skill bundle — a named group of skills picked in one click, in the
 * mem20agentz SkillsStore bundle shape (a bundle names skills; expanding it
 * resolves them against the live skill registry).
 *
 * `skillKeys` are registry keys of the form `category.id`, e.g.
 * `engineering.code-review`, so a bundle can mix categories.
 */
export interface SkillBundle {
  /** Stable machine key, e.g. `code-review`. */
  id: string;
  /** Human label shown in the picker, e.g. "Code Review". */
  name: string;
  /** One line shown under the name in the picker. */
  description: string;
  /** Registry keys of the member skills, in the order they are applied. */
  skillKeys: string[];
}
