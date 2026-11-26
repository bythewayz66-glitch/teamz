/**
 * ============================================================================
 *  @mention chaining — the mention flow
 * ============================================================================
 *
 *  In a channel, a message fans out to agents and each agent's reply can
 *  itself @-mention other agents, who then reply in turn. That is a flow,
 *  not a loop: every agent reply is a state, and scanning it for @-mentions
 *  is the router that picks the next state(s).
 *
 *  The shape is ported from mem20crewz's Flow (`mem20crewz/flow.py`):
 *
 *    • states → handlers, registered with `start` / `listen` / `router`
 *    • a router handler's return value becomes the next state(s) dispatched
 *      onward — a routing decision, not an emission list
 *    • the run loop drains a pending-state queue, skips states already
 *      processed, and stops at a `maxStates` bound
 *
 *  Only the shape is ported. This is TypeScript written for this app: the
 *  handlers are async (they await a real agent reply), the queue is driven
 *  by the store's `send`, and the safety bounds below are part of the chain
 *  itself, not an afterthought.
 *
 *  Safety (non-negotiable — a chain must never loop forever):
 *
 *    • MAX_CHAIN_DEPTH — at most this many chained turns past the agents the
 *      user addressed directly. A reply at the cap routes nowhere.
 *    • MAX_AGENT_REPLIES — at most this many agent replies per user message,
 *      initial round included. The chain stops silently when it is reached.
 *    • Visited set — an agent that already answered in this chain never
 *      answers again, however many times it is @-mentioned afterwards.
 *    • Self-mention — an agent @-mentioning itself is ignored.
 *
 *  Hitting a cap stops the chain cleanly: no error, no message to the user,
 *  the replies already delivered stay delivered.
 */

import type { Agent } from '../types';
import { parseMentions } from './mentions';

/** Chained turns allowed past the agents the user addressed directly. */
export const MAX_CHAIN_DEPTH = 4;
/** Agent replies allowed per user message, initial round included. */
export const MAX_AGENT_REPLIES = 8;

/** The state the flow starts from, as in mem20crewz. */
export const START_STATE = '__start__';

/* ---------------------------------------------------------------------------
 * Flow — states → handlers, router return becomes the next state.
 * ------------------------------------------------------------------------- */

/** What a handler receives: shared mutable state plus `emit`. */
export interface FlowContext {
  state: Record<string, unknown>;
  emit: (...states: string[]) => void;
}

export type FlowHandler = (ctx: FlowContext, state: string) => unknown | Promise<unknown>;

interface HandlerEntry {
  fn: FlowHandler;
  on: string[];
  once: boolean;
  router: boolean;
}

export interface FlowRun {
  flow: string;
  inputs: Record<string, unknown>;
  emitted: string[];
  runs: { state: string; handler: string }[];
}

/**
 * Minimal port of the mem20crewz Flow run engine. One handler per state is
 * the normal case here, but a state may have several listeners exactly as in
 * the Python original, and a router's return replaces — never extends — what
 * is dispatched onward.
 */
export class Flow {
  readonly name: string;
  private handlers = new Map<string, HandlerEntry>();
  private onceFired = new Set<string>();
  state: Record<string, unknown> = {};

  constructor(name = 'Flow') {
    this.name = name;
  }

  register(
    name: string,
    fn: FlowHandler,
    states: string[],
    opts: { once?: boolean; router?: boolean } = {},
  ): void {
    // Handler names must be unique in the registry: several anonymous
    // handlers (every `flow.listen(...)(async () => ...)` in a loop) share
    // the empty name, and a later registration must never silently replace
    // an earlier one.
    let unique = name || 'handler';
    let suffix = 2;
    while (this.handlers.has(unique)) unique = `${name || 'handler'}-${suffix++}`;
    this.handlers.set(unique, {
      fn,
      on: states.length > 0 ? states : [START_STATE],
      once: opts.once ?? false,
      router: opts.router ?? false,
    });
  }

  /** Register `fn` as the start handler (runs first, on `__start__`). */
  start(fn: FlowHandler): FlowHandler {
    this.register(fn.name || 'start', fn, [START_STATE]);
    return fn;
  }

  /** Register `fn` to run whenever one of `states` is dispatched. */
  listen(...states: string[]) {
    return (fn: FlowHandler): FlowHandler => {
      this.register(fn.name || 'listen', fn, states);
      return fn;
    };
  }

  /**
   * Register `fn` as a router on `states`: its return value (a state name or
   * a list of them) becomes the *only* state dispatched onward.
   */
  router(...states: string[]) {
    return (fn: FlowHandler): FlowHandler => {
      this.register(fn.name || 'router', fn, states, { router: true });
      return fn;
    };
  }

  private listeners(state: string): string[] {
    return [...this.handlers.entries()]
      .filter(([, entry]) => entry.on.includes(state))
      .map(([name]) => name);
  }

  private async invoke(
    name: string,
    state: string,
    pending: string[],
  ): Promise<string[]> {
    const entry = this.handlers.get(name);
    if (!entry) return [];
    const ctx: FlowContext = {
      state: this.state,
      emit: (...states: string[]) => {
        for (const s of states) if (!pending.includes(s)) pending.push(s);
      },
    };
    const out = await entry.fn(ctx, state);
    const emitted = [...pending];
    if (typeof out === 'string') emitted.push(out);
    else if (Array.isArray(out)) {
      for (const s of out) if (typeof s === 'string') emitted.push(s);
    }
    // A router emits exactly ONE route decision, not every listener hit.
    return entry.router && emitted.length > 0 ? [emitted[0]] : emitted;
  }

  /**
   * Drain the pending-state queue. A state already processed is skipped, so
   * a state can never run twice in one flow, and the run ends when the queue
   * is empty or `maxStates` handler runs have happened.
   */
  async run(inputs: Record<string, unknown> = {}, maxStates = 20): Promise<FlowRun> {
    this.state = { ...inputs };
    const result: FlowRun = { flow: this.name, inputs, emitted: [], runs: [] };
    const processed = new Set<string>();
    const queue: string[] = [START_STATE];

    while (queue.length > 0 && result.runs.length < maxStates) {
      const state = queue.shift()!;
      if (processed.has(state)) continue;
      processed.add(state);
      for (const name of this.listeners(state)) {
        const entry = this.handlers.get(name)!;
        if (entry.once && this.onceFired.has(name)) continue;
        result.runs.push({ state, handler: name });
        const emitted = await this.invoke(name, state, []);
        const fresh = emitted.filter((s) => s && !queue.includes(s));
        result.emitted.push(...fresh);
        queue.push(...fresh);
        this.onceFired.add(name);
      }
    }
    return result;
  }
}

/* ---------------------------------------------------------------------------
 * The mention chain, built on the Flow above.
 * ------------------------------------------------------------------------- */

/** One delivered agent reply inside a chain. */
export interface ChainReply {
  agent: Agent;
  text: string;
  /** 0 = answered the user directly; each @-mention hop adds 1. */
  depth: number;
  /** True when the agent was @-mentioned (by the user or by another agent). */
  directed: boolean;
}

export interface MentionChainDeps {
  /** Every member of the channel (or the single DM member). */
  members: Agent[];
  /** Agents the user's message goes to first: @-mentioned, or all members. */
  initialTargets: Agent[];
  /** True when the user @-mentioned the initial targets (false = broadcast). */
  initialDirected: boolean;
  /**
   * Ask one agent for a reply. Returns the reply text, or null when no reply
   * was delivered (error, abort). A null reply routes nowhere — the chain
   * simply does not continue from an agent that did not answer.
   */
  send: (agent: Agent, directed: boolean, mentionedBy?: Agent) => Promise<string | null>;
}

export interface MentionChainOptions {
  maxChainDepth?: number;
  maxAgentReplies?: number;
}

export interface MentionChainResult {
  replies: ChainReply[];
  /** True when a cap stopped the chain while mentions were still unrouted. */
  stoppedAtCap: boolean;
}

/**
 * Run one user message's fan-out as a flow.
 *
 * States are `agent:<id>`; the start handler dispatches the initial targets
 * and each agent handler routes onward by returning the @-mentioned next
 * agents as states — the handler's return value becomes the next state(s),
 * exactly as a Flow router decides what runs next. (It is registered with
 * `listen`, not `router`, for one reason: a mem20crewz router returns a
 * single routing decision, while one reply can hand off to several agents at
 * once. A listen handler's returned list is dispatched in full.) The visited
 * set, the self-mention rule and both caps are enforced in the handler, so
 * no reply can ever route the chain into a loop.
 */
export async function runMentionChain(
  deps: MentionChainDeps,
  opts: MentionChainOptions = {},
): Promise<MentionChainResult> {
  const maxChainDepth = opts.maxChainDepth ?? MAX_CHAIN_DEPTH;
  const maxAgentReplies = opts.maxAgentReplies ?? MAX_AGENT_REPLIES;

  const byId = new Map(deps.members.map((a) => [a.id, a]));
  const replies: ChainReply[] = [];
  const visited = new Set<string>();
  const depthOf = new Map<string, number>();
  const mentionedBy = new Map<string, Agent>();
  let stoppedAtCap = false;

  for (const target of deps.initialTargets) depthOf.set(target.id, 0);

  const flow = new Flow('mention-chain');

  flow.start(() => deps.initialTargets.map((a) => `agent:${a.id}`));

  for (const member of deps.members) {
    const state = `agent:${member.id}`;
    flow.listen(state)(async () => {
      const agent = byId.get(member.id)!;
      if (visited.has(agent.id)) return [];
      if (replies.length >= maxAgentReplies) {
        // Routed here, but the reply budget was already spent.
        stoppedAtCap = true;
        return [];
      }
      visited.add(agent.id);

      const depth = depthOf.get(agent.id) ?? 0;
      const directed = depth === 0 ? deps.initialDirected : true;
      const text = await deps.send(agent, directed, mentionedBy.get(agent.id));
      if (text === null) return [];
      replies.push({ agent, text, depth, directed });

      // Who does this reply hand off to? Same parse as a user message:
      // longest name wins, order of first appearance. The speaker never
      // answers its own mention, and nobody answers twice in one chain.
      const candidates = parseMentions(text, deps.members).filter(
        (next) => next.id !== agent.id && !visited.has(next.id),
      );
      if (candidates.length === 0) return [];
      if (depth >= maxChainDepth || replies.length >= maxAgentReplies) {
        stoppedAtCap = true;
        return [];
      }
      for (const next of candidates) {
        if (!depthOf.has(next.id)) depthOf.set(next.id, depth + 1);
        if (!mentionedBy.has(next.id)) mentionedBy.set(next.id, agent);
      }
      return candidates.map((next) => `agent:${next.id}`);
    });
  }

  // One handler run per member at most, plus the start handler.
  await flow.run({}, deps.members.length + 1);
  return { replies, stoppedAtCap };
}
