/** Core domain types for the teamz workspace. */

import type { Skill } from './data/templates/catalog';

export type AgentStatus = 'online' | 'busy' | 'offline';

/** Which agent template an agent was instantiated from, if any. */
export interface AgentOrigin {
  /** Template id, e.g. `frontend-engineer:senior`. */
  templateId: string;
  /** Role family slug, e.g. `frontend-engineer`. */
  familySlug: string;
  /** Human role label at creation time, e.g. "Frontend Engineer". */
  role: string;
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
  skills: Skill[];
  /** Provenance — absent for hand-made agents. */
  origin?: AgentOrigin;
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
  activeConversationId: string | null;
}
