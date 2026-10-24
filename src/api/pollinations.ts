/**
 * ============================================================================
 *  Pollinations.ai transport — real LLM replies, straight from the browser.
 * ============================================================================
 *
 *  Two endpoints, both OpenAI Chat Completions compatible and CORS-open:
 *
 *    • No API key  → https://text.pollinations.ai/openai
 *                    Anonymous tier. No sign-up, rate-limited per IP, and only
 *                    the small free model (`openai-fast`, GPT-OSS 20B).
 *
 *    • With a key  → https://gen.pollinations.ai/v1/chat/completions
 *                    `Authorization: Bearer <key>`. Unlocks the full model
 *                    list at https://gen.pollinations.ai/v1/models, billed to
 *                    the key's Pollen balance. Get a key at
 *                    https://enter.pollinations.ai/keys.
 *
 *  The key, model and referrer live in the user's own `localStorage` only
 *  (see `settings.ts`). Nothing secret is ever bundled or committed.
 *
 *  Everything here is pure except `callPollinations`, so the request builder
 *  and the SSE parser are covered by unit tests.
 */

import type { Agent, Message } from '../types';
import type { LlmSettings } from './settings';

export const POLLINATIONS_ANON_URL = 'https://text.pollinations.ai/openai';
export const POLLINATIONS_KEYED_URL = 'https://gen.pollinations.ai/v1/chat/completions';
export const POLLINATIONS_ANON_MODELS_URL = 'https://text.pollinations.ai/models';
export const POLLINATIONS_KEYED_MODELS_URL = 'https://gen.pollinations.ai/v1/models';

/** The only model the anonymous tier serves. */
export const DEFAULT_ANON_MODEL = 'openai-fast';
/** Cheap, fast default once the user adds a key (alias of GPT-5.4 Nano). */
export const DEFAULT_KEYED_MODEL = 'openai';

/** How many earlier messages go into the prompt. Keeps requests small. */
export const HISTORY_LIMIT = 24;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  referrer?: string;
}

export interface PollinationsRequest {
  url: string;
  headers: Record<string, string>;
  body: ChatCompletionBody;
}

export interface PromptContext {
  conversationKind: 'direct' | 'channel';
  conversationName: string;
  topic?: string;
  /** The other agents in the room (not including `agent`). */
  otherAgents?: { id: string; name: string }[];
  /** True when the user @mentioned this agent. */
  directed?: boolean;
}

export function hasKey(settings: Pick<LlmSettings, 'apiKey'>): boolean {
  return Boolean(settings.apiKey?.trim());
}

/** The model actually sent: the user's choice, else the tier's default. */
export function resolveModel(settings: Pick<LlmSettings, 'apiKey' | 'model'>): string {
  const chosen = settings.model?.trim();
  if (chosen) return chosen;
  return hasKey(settings) ? DEFAULT_KEYED_MODEL : DEFAULT_ANON_MODEL;
}

/** The persona prompt: the agent's own instructions plus room context. */
export function buildSystemPrompt(agent: Agent, ctx: PromptContext): string {
  const parts: string[] = [];
  const persona = agent.systemPrompt?.trim();
  parts.push(persona || `You are ${agent.name}, a helpful AI agent.`);

  const facts: string[] = [`Your name is ${agent.name}.`];
  if (agent.origin?.role) facts.push(`Your role: ${agent.origin.role}.`);
  if (agent.skills?.length) {
    const top = agent.skills
      .slice()
      .sort((a, b) => b.level - a.level)
      .slice(0, 6)
      .map((s) => s.label);
    facts.push(`Your strongest skills: ${top.join(', ')}.`);
  }

  if (ctx.conversationKind === 'channel') {
    const others = (ctx.otherAgents ?? []).map((a) => a.name);
    facts.push(
      `You are in a group chat channel called "${ctx.conversationName}"` +
        (ctx.topic ? ` (topic: ${ctx.topic})` : '') +
        ` with the user` +
        (others.length ? ` and these other AI agents: ${others.join(', ')}` : '') +
        '.',
    );
    facts.push(
      'Messages from other participants are prefixed with their name in square brackets, e.g. "[User]: ..." or "[Atlas]: ...". ' +
        'Reply only as yourself, with no name prefix. Build on what others already said instead of repeating it.',
    );
    if (ctx.directed) {
      facts.push('The user addressed you directly with an @mention, so answer their latest message.');
    }
  } else {
    facts.push('You are in a private one-to-one chat with the user.');
  }
  facts.push('Keep replies concise and conversational. Markdown (bold, lists, `code`, fenced code blocks) is supported.');

  parts.push(facts.join('\n'));
  return parts.join('\n\n');
}

/**
 * Map the chat log onto OpenAI roles from `agent`'s point of view:
 *   • the agent's own earlier replies → `assistant`
 *   • the user and every other agent  → `user`, name-prefixed in channels
 * Pending (still streaming) and failed messages are skipped.
 */
export function buildChatMessages(
  agent: Agent,
  history: Message[],
  agentsById: Map<string, Agent>,
  ctx: PromptContext,
  limit = HISTORY_LIMIT,
): ChatMessage[] {
  const isChannel = ctx.conversationKind === 'channel';
  const usable = history.filter((m) => m.status === 'sent' && m.text.trim());
  const recent = usable.slice(-limit);

  const out: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(agent, ctx) }];
  for (const m of recent) {
    if (m.authorType === 'agent' && m.authorId === agent.id) {
      out.push({ role: 'assistant', content: m.text });
      continue;
    }
    const speaker =
      m.authorType === 'user' ? 'User' : agentsById.get(m.authorId ?? '')?.name ?? 'Another agent';
    out.push({
      role: 'user',
      content: isChannel || m.authorType === 'agent' ? `[${speaker}]: ${m.text}` : m.text,
    });
  }
  return out;
}

export function buildPollinationsRequest(
  agent: Agent,
  history: Message[],
  agentsById: Map<string, Agent>,
  ctx: PromptContext,
  settings: LlmSettings,
): PollinationsRequest {
  const keyed = hasKey(settings);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (keyed) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
  const body: ChatCompletionBody = {
    model: resolveModel(settings),
    messages: buildChatMessages(agent, history, agentsById, ctx),
    stream: settings.stream,
  };
  // `referrer` is an anonymous-tier field; keyed requests are identified by the key.
  const referrer = settings.referrer?.trim();
  if (referrer && !keyed) body.referrer = referrer;
  return { url: keyed ? POLLINATIONS_KEYED_URL : POLLINATIONS_ANON_URL, headers, body };
}

/**
 * Incremental SSE parser for OpenAI-style streams. Feed it raw text chunks;
 * it returns the content deltas found so far and keeps partial lines.
 * Reasoning deltas (`delta.reasoning`) are ignored on purpose.
 */
export function createSseParser() {
  let buffer = '';
  let done = false;
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      const deltas: string[] = [];
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') {
          done = true;
          continue;
        }
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json?.error) {
          const msg = typeof json.error === 'string' ? json.error : json.error.message;
          throw new Error(msg || 'Stream error');
        }
        const piece = json?.choices?.[0]?.delta?.content;
        if (typeof piece === 'string' && piece) deltas.push(piece);
      }
      return deltas;
    },
    get done() {
      return done;
    },
  };
}

/** Turn a non-2xx response into a readable message. */
export async function describeHttpError(res: Response): Promise<string> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : '') ?? '';
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  const hint = /turnstile/i.test(detail)
    ? ' The free anonymous tier rejects requests from localhost / dev origins. Use the deployed site, or add an API key in Workspace & API settings.'
    : res.status === 401 || res.status === 403
      ? ' Check the Pollinations API key in Workspace & API settings (or clear it to use the free anonymous tier).'
      : res.status === 402
        ? ' This model needs Pollen credit on your key — pick a free model or top up.'
        : res.status === 429
          ? ' Rate limited — the free anonymous tier allows only a few requests at a time. Wait a moment, or add an API key.'
          : '';
  return `Pollinations ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ''}.${hint}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

/** Send the request; stream deltas through `onDelta` when streaming. */
export async function callPollinations(
  request: PollinationsRequest,
  opts: { signal?: AbortSignal; onDelta?: (fullText: string) => void } = {},
): Promise<string> {
  let res: Response | null = null;
  // One polite retry on 429 — the anonymous tier queues per IP.
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: opts.signal,
    });
    if (res.status !== 429 || attempt === 1) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000, 10000), opts.signal);
  }
  if (!res) throw new Error('Pollinations request failed');
  if (!res.ok) throw new Error(await describeHttpError(res));

  const contentType = res.headers.get('content-type') ?? '';
  if (request.body.stream && contentType.includes('text/event-stream') && res.body) {
    const parser = createSseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const deltas = parser.push(decoder.decode(value, { stream: true }));
      if (deltas.length) {
        text += deltas.join('');
        opts.onDelta?.(text);
      }
    }
    parser.push(decoder.decode() + '\n');
    if (!text.trim()) throw new Error('Pollinations returned an empty reply. Try again or pick another model.');
    return text;
  }

  const payload = contentType.includes('application/json') ? await res.json() : await res.text();
  const content =
    typeof payload === 'string' ? payload : (payload as any)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Pollinations returned an empty reply. Try again or pick another model.');
  }
  return content;
}

export interface ModelOption {
  id: string;
  label: string;
}

/** Text models the current tier can use. Falls back to the default only. */
export async function listPollinationsModels(settings: LlmSettings): Promise<ModelOption[]> {
  try {
    if (hasKey(settings)) {
      const res = await fetch(POLLINATIONS_KEYED_MODELS_URL);
      const json = await res.json();
      return (json?.data ?? [])
        .filter((m: any) => m?.category === 'text' && !m?.community)
        .map((m: any) => ({
          id: m.id as string,
          label: `${m.title ?? m.id}${m.paid_only ? ' · paid' : ''}`,
        }));
    }
    const res = await fetch(POLLINATIONS_ANON_MODELS_URL);
    const json = await res.json();
    return (Array.isArray(json) ? json : [])
      .filter((m: any) => typeof m?.name === 'string')
      .map((m: any) => ({ id: m.name as string, label: `${m.name} — ${m.description ?? ''}`.trim() }));
  } catch {
    return [];
  }
}
