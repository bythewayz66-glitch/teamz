/**
 * ============================================================================
 *  Tool loop — propose → execute → observe, bounded.
 * ============================================================================
 *
 *  Two mem20 designs ported to TypeScript (shape, not code):
 *
 *  • mem20crewz `ToolLoop`: the model proposes one action at a time, tool
 *    results feed back as observations, errors become observations and never
 *    crash the loop, and a guard rejects a premature "final" when no tool
 *    step succeeded yet — the rejection is fed back so the loop continues
 *    with tools. Bounded by `maxIterations`.
 *
 *  • mem20agentz strict-JSON action contract: the model replies with ONLY a
 *    JSON object, `{"action":"tool","tool":...,"args":...}` or
 *    `{"action":"final","final":...}`. The client extracts the object (even
 *    when it is embedded in prose), executes, and feeds the observation
 *    back. That is the whole trick that makes tool use work with any
 *    chat-completions LLM — no provider function-calling needed.
 *
 *  The `propose` seam is injected by the caller (in `agents.ts` it is one
 *  LLM call per iteration). Tests drive the loop with a scripted propose
 *  function — that is the test seam, not the feature faked.
 */

import type { Agent } from '../types';
import { executeTool, inventoryText } from './tools';

/** The contract text sent to the model. Two shapes only — ported from mem20agentz. */
export const TOOL_ACTION_CONTRACT = [
  'You may use tools. Decide the NEXT action.',
  'Reply ONLY with a JSON object, one of two shapes:',
  '  {"action": "tool",   "tool": "<name>", "args": "<string argument>"}',
  '  {"action": "final",  "final": "<your reply to the user>"}',
  'Choose "final" when you can answer, even partially. Never invent tools: only the tools in the inventory below may be referenced. A "final" message should be written as a direct reply to the user.',
].join('\n');

/** How many tool iterations a single reply may take before the loop stops. */
export const MAX_TOOL_ITERATIONS = 5;

export type Action =
  | { action: 'tool'; tool: string; args: string }
  | { action: 'final'; final: string };

/**
 * Port of mem20agentz `_parse_action`: regex-extract the first `{...}`,
 * JSON-parse it, and fall back to treating the raw text as the final
 * answer. Prose is never an error and a JSON blob is never shown to the
 * user — the fallback IS the final answer.
 */
export function parseAction(raw: string): Action {
  const match = /\{.*\}/s.exec(raw);
  if (!match) return { action: 'final', final: raw.trim() };
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { action: 'final', final: raw.trim() };
  }
  const record = obj as Record<string, unknown>;
  const action = String(record.action ?? 'final').toLowerCase();
  if (action === 'tool') {
    const tool = record.tool;
    if (typeof tool === 'string' && tool.trim()) {
      return { action: 'tool', tool: tool.trim(), args: String(record.args ?? '') };
    }
  }
  if (action === 'final') {
    return { action: 'final', final: String(record.final ?? '').trim() };
  }
  return { action: 'final', final: raw.trim() };
}

export interface LoopStep {
  index: number;
  action: string;
  tool?: string;
  output: string;
  ok: boolean;
}

export interface LoopResult {
  /** The agent's real final text — never a JSON blob. */
  text: string;
  iterations: number;
  steps: LoopStep[];
  observations: string[];
}

/**
 * What the loop asks the model for each iteration. The caller owns the LLM
 * call; `observations` is every tool result so far (oldest first) and
 * `priorActions` is the raw JSON the model sent on earlier iterations, so
 * the caller can rebuild the transcript.
 */
export type ProposeFn = (observations: string[], priorActions: string[]) => Promise<string>;

export interface ToolLoopOptions {
  maxIterations?: number;
  /**
   * When true, a "final" with no successful tool step yet is rejected and
   * fed back as a guard observation so the loop continues with tools.
   * Defaults to false: in chat the model may answer from knowledge.
   */
  requireToolBeforeFinal?: boolean;
  /** Called after every step — the caller surfaces tool use in the UI. */
  onStep?: (step: LoopStep) => void;
  /** Abort between iterations. */
  signal?: AbortSignal;
}

const GUARD_MESSAGE =
  "[guard] 'final' rejected: exit requires at least one successful tool action first. Run a tool now, then final.";

/**
 * System prompt for a tool-using agent, assembled as labeled blocks in the
 * shape of mem20crewz `TaskContext.prompt()`: identity, skills, tools, and
 * the action contract.
 */
export function buildToolSystemPrompt(agent: Agent, toolNames: string[]): string {
  const blocks: string[] = [];
  const identity: string[] = [`- name: ${agent.name}`];
  if (agent.origin?.role) identity.push(`- role: ${agent.origin.role}`);
  if (agent.systemPrompt?.trim()) identity.push(`- instructions: ${agent.systemPrompt.trim()}`);
  blocks.push(`## Agent identity\n${identity.join('\n')}`);
  if (agent.skills?.length) {
    const top = agent.skills
      .slice()
      .sort((a, b) => b.level - a.level)
      .slice(0, 6)
      .map((s) => s.label);
    blocks.push(`## Skills\n${top.join(', ')}`);
  }
  blocks.push(`## Tools you may call\n${inventoryText(toolNames)}`);
  blocks.push(`## How to use tools\n${TOOL_ACTION_CONTRACT}`);
  return blocks.join('\n\n');
}

export async function runToolLoop(propose: ProposeFn, opts: ToolLoopOptions = {}): Promise<LoopResult> {
  const maxIterations = opts.maxIterations ?? MAX_TOOL_ITERATIONS;
  const requireToolBeforeFinal = opts.requireToolBeforeFinal ?? false;
  const observations: string[] = [];
  const priorActions: string[] = [];
  const steps: LoopStep[] = [];
  let final = '';

  const notify = (step: LoopStep) => {
    steps.push(step);
    try {
      opts.onStep?.(step);
    } catch {
      // A broken observer never breaks the loop.
    }
  };

  for (let i = 1; i <= maxIterations; i++) {
    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    let raw: string;
    try {
      raw = await propose(observations, priorActions);
    } catch (err) {
      // A failed propose on the first turn is a real transport error — let
      // the caller surface it as a failed reply. Later failures become
      // observations so the model can recover.
      if (i === 1) throw err;
      const message = err instanceof Error ? err.message : String(err);
      observations.push(`[brain error] ${message}`);
      notify({ index: i, action: 'unknown', output: `[brain error] ${message}`, ok: false });
      continue;
    }

    priorActions.push(raw);
    const action = parseAction(raw);

    if (action.action === 'final') {
      const toolSuccess = steps.some((s) => s.action === 'tool' && s.ok);
      if (requireToolBeforeFinal && !toolSuccess && i < maxIterations) {
        observations.push(GUARD_MESSAGE);
        notify({ index: i, action: 'final-rejected', output: GUARD_MESSAGE, ok: false });
        continue;
      }
      final = action.final || (observations.length ? observations[observations.length - 1] : '');
      notify({ index: i, action: 'final', output: final, ok: true });
      break;
    }

    // action === 'tool'
    const result = await executeTool(action.tool, action.args);
    const observation = `[tool ${action.tool}] ${result.output.slice(0, 1200)}`;
    observations.push(observation);
    notify({
      index: i,
      action: 'tool',
      tool: action.tool,
      output: result.output,
      ok: result.ok,
    });
  }

  if (!final) {
    final =
      '[reached the tool limit] ' +
      (observations.length ? observations[observations.length - 1] : 'no tool result was produced');
  }

  return { text: final, iterations: steps.length, steps, observations };
}
