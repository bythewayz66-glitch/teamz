/** Core domain types for the teamz workspace. */

export type AgentStatus = 'online' | 'busy' | 'offline';

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
  /** Capabilities copied over from the template this agent was created from. */
  skills?: AgentSkill[];
  /** Id of the catalog template this agent was instantiated from, if any. */
  templateId?: string;
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

export interface Message {
  id: string;
  conversationId: string;
  authorType: 'user' | 'agent';
  /** Present when authorType === 'agent'. */
  authorId?: string;
  text: string;
  createdAt: number;
  status: MessageStatus;
}

export interface WorkspaceState {
  agents: Agent[];
  conversations: Conversation[];
  /** Messages keyed by conversation id, oldest first. */
  messages: Record<string, Message[]>;
  activeConversationId: string | null;
}

/* ---------------------------------------------------------------------------
 * Template catalog — a library of pre-seeded agent definitions.
 *
 * Templates are inert data: nothing here runs until the user picks one and
 * `instantiateTemplate()` turns it into a real Agent in the workspace.
 * ------------------------------------------------------------------------- */

/** The broad domains templates are grouped into. */
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
 * One named capability a template ships with.
 *
 * Skills are descriptive for now — they tell the user (and the request body in
 * `src/api/agents.ts`) what this agent is equipped to do. Wiring them to actual
 * tools is a server-side concern.
 */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  /** Domain the skill belongs to; usually the template's own category. */
  category: TemplateCategory;
  /** Extra search terms, not shown in the UI. */
  tags?: string[];
}
