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
  /** Provenance — absent for hand-made agents. */
  origin?: AgentOrigin;
  /** Last reachability check result (persisted). */
  lastPingAt?: number;
  lastPingOk?: boolean;
  lastPingMessage?: string;
  createdAt: number;
}

export type ConversationKind = 'direct' | 'channel';

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

/* ---------------------------------------------------------------------------
 * Orchestration layer
 *
 * Everything below was added for the agent-workspace feature set: sessions,
 * triggers, connected accounts, the policy engine, the audit trail, approval
 * requests, widgets and workspace membership. All of it is plain data that
 * lives in the same persisted workspace blob as the rest, so a reload restores
 * exactly what the user was looking at.
 * ------------------------------------------------------------------------- */

/** How much reasoning budget an agent gets. Shapes the request, not the UI. */
export type Effort = 'low' | 'medium' | 'high';
/** Latency/cost trade-off. `fast` prefers the small model. */
export type Speed = 'normal' | 'fast';

/** Per-agent model configuration, mirroring the model pill in the header. */
export interface ModelConfig {
  /** Model id, e.g. `openai`, `openai-fast`, `claude-sonnet-4`. */
  model: string;
  effort: Effort;
  speed: Speed;
}

/**
 * A session is one conversation thread with one agent, the way a chat app
 * groups messages. An agent can have many; the newest is the default.
 */
export interface Session {
  id: string;
  agentId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Pinned sessions sort first and are never auto-pruned. */
  pinned?: boolean;
}

/** A capability an agent has been given, with usage tracking. */
export interface SkillDef {
  id: string;
  /** Machine key, e.g. `forecast-stockouts`. */
  key: string;
  name: string;
  /** One line describing what the skill does; injected into the prompt. */
  description: string;
  /** Where it came from: a template, the catalogue, or the user. */
  source: 'template' | 'catalogue' | 'custom';
  addedAt: number;
  lastUsedAt?: number;
  /** How many times the agent has actually applied it. */
  uses: number;
}

/** A connected third-party account an agent may act through. */
export interface Connection {
  id: string;
  /** Connector slug, e.g. `gmail`, `slack`, `shopify`. */
  service: string;
  /** Human label of the account, e.g. `mira@alderandoak.com` or `#growth`. */
  account: string;
  /** OAuth scopes granted. Drives what the policy engine can allow. */
  scopes: string[];
  connectedAt: number;
  lastUsedAt?: number;
  /** `connected` after a successful link; `error` when the token expired. */
  status: 'connected' | 'error' | 'revoked';
  /** Set when status is `error`, shown inline. */
  error?: string;
}

/** What a policy rule does when it matches. */
export type PolicyDecision = 'allow' | 'review' | 'block';

/**
 * One rule in an agent's policy. Rules are evaluated most-specific-first:
 * a rule naming both a service and an action beats a service-wide rule, which
 * beats the agent default. This is the "scoped by software rules, not prompts"
 * guarantee — the model cannot talk its way past it.
 */
export interface PolicyRule {
  id: string;
  /** Connector slug, or `*` for every service. */
  service: string;
  /** Action pattern, e.g. `orders.list`, `products.delete`, `*`. */
  action: string;
  decision: PolicyDecision;
  /** Optional human note shown in the policy editor. */
  note?: string;
}

/** A single tool call an agent asked to make, before policy is applied. */
export interface AgentAction {
  service: string;
  action: string;
  /** Free-form arguments the agent supplied. */
  args: Record<string, unknown>;
  /** One-line human summary, e.g. "Send 3 emails with Gmail". */
  summary: string;
}

/** The outcome of evaluating one action against the policy. */
export interface PolicyVerdict {
  decision: PolicyDecision;
  /** The rule that decided it, or null when the agent default applied. */
  ruleId: string | null;
  /** Human explanation, shown in the approval card and the audit log. */
  reason: string;
}

/** A queued action waiting for a human decision. */
export interface Approval {
  id: string;
  agentId: string;
  sessionId: string;
  action: AgentAction;
  verdict: PolicyVerdict;
  createdAt: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decidedAt?: number;
  /** Who decided it — a member id, or `you`. */
  decidedBy?: string;
}

/** One line in the audit trail. Append-only. */
export interface AuditEntry {
  id: string;
  at: number;
  agentId?: string;
  sessionId?: string;
  /** Dotted action name, e.g. `gmail.send` or `fs.read`. */
  action: string;
  /** What the policy said. */
  decision: PolicyDecision | 'info';
  /** Short human detail, e.g. "3 emails to Linen & Co". */
  detail: string;
  /** Rule that produced the decision, when there was one. */
  ruleId?: string;
  /** Set when the action was actually executed after approval. */
  executed?: boolean;
}

/** A widget an agent published into its workspace. */
export type WidgetKind = 'metric' | 'bars' | 'table' | 'list' | 'progress';

export interface WidgetMetric {
  label: string;
  value: string;
  /** Optional delta, e.g. "+12%". */
  delta?: string;
  tone?: 'good' | 'warn' | 'bad';
}

export interface WidgetBar {
  label: string;
  value: number;
  /** Optional caption under the bar, e.g. "9d · Oct 14". */
  caption?: string;
  tone?: 'good' | 'warn' | 'bad';
}

export interface WidgetRow {
  cells: string[];
  tone?: 'good' | 'warn' | 'bad';
}

export interface Widget {
  id: string;
  agentId: string;
  title: string;
  kind: WidgetKind;
  /** Column headers for `table`. */
  columns?: string[];
  metrics?: WidgetMetric[];
  bars?: WidgetBar[];
  rows?: WidgetRow[];
  /** 0..1 for `progress`. */
  progress?: number;
  /** Caption under the title, e.g. "412 SKUs · forecast updated 7:02 AM". */
  caption?: string;
  updatedAt: number;
}

/** A scheduled or event-driven run. */
export type TriggerKind = 'cron' | 'webhook';

export interface Trigger {
  id: string;
  agentId: string;
  name: string;
  kind: TriggerKind;
  /** Standard 5-field cron, e.g. `0 7 * * 1-5`. Only for `cron`. */
  cron?: string;
  /** Opaque token used in the webhook URL. Only for `webhook`. */
  token?: string;
  /** The prompt the trigger sends to the agent. */
  prompt: string;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
  /** How many times it has fired since creation. */
  fireCount: number;
  /** Last error, if the last run failed. */
  lastError?: string;
}

/** One recorded execution of a trigger. */
export interface TriggerRun {
  id: string;
  triggerId: string;
  agentId: string;
  at: number;
  status: 'ok' | 'error';
  /** Short result summary, e.g. "412 SKUs checked". */
  summary: string;
}

/** A human with access to the workspace. */
export interface Member {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'editor' | 'viewer';
  /** `you` marks the signed-in account. */
  isYou?: boolean;
  joinedAt: number;
  /** Two-letter monogram used by the avatar. */
  initials: string;
}

/** A notification in the bell menu. */
export interface Notification {
  id: string;
  at: number;
  kind: 'approval' | 'trigger' | 'error' | 'info';
  title: string;
  body: string;
  read: boolean;
  /** Where clicking it should go. */
  agentId?: string;
  sessionId?: string;
}

/** Per-agent, per-day token accounting. */
export interface UsageEntry {
  /** `YYYY-MM-DD` in local time. */
  day: string;
  agentId: string;
  promptTokens: number;
  completionTokens: number;
  runs: number;
}
