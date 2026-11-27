/**
 * teamz-agent — a real agent endpoint for the headless Teamz runner,
 * WITH tools.
 *
 * The runner (scripts/runner.ts, runner-lib.ts) POSTs the Teamz wire format
 * to an agent's endpointUrl:
 *
 *   POST /chat
 *   { agent: { id, name, model, systemPrompt },
 *     messages: [{ role: 'user'|'assistant', content, authorName? }],
 *     channel: { id, name, members: [] },
 *     directed?: true }
 *
 * and accepts any of {reply}/{text}/{message}/{content}/{output}, an
 * OpenAI choices[0].message.content body, or plain text (see
 * parseAgentReply in runner-lib.ts). This service answers with
 * `{ "reply": "<text>" }`.
 *
 * ---------------------------------------------------------------------------
 * Tools — the fix for "I don't have the ability to invoke external tools".
 * ---------------------------------------------------------------------------
 *
 * The first version of this endpoint was a single-shot chat call: it
 * forwarded agent.systemPrompt verbatim to Pollinations and returned the
 * raw reply, so the model truthfully said it could not invoke tools.
 *
 * This version ports the Teamz UI's tool loop (src/lib/toolLoop.ts +
 * src/lib/tools.ts) to Node, as plain JavaScript — no TypeScript imports
 * from the UI. Same design, same contract:
 *
 *   • The system prompt is rebuilt as identity + tool inventory +
 *     strict-JSON action contract (mem20agentz shape):
 *       {"action": "tool", "tool": "<name>", "args": "<string>"}
 *       {"action": "final", "final": "<reply to the user>"}
 *   • parseAction regex-extracts the first {...}, JSON-parses it, and
 *     falls back to treating raw text as the final answer — prose is
 *     never an error and a JSON blob is never shown to the user.
 *   • executeTool runs the tool (never throws: unknown tools and
 *     failures come back as observations), the observation is fed back,
 *     and the loop continues, bounded by MAX_TOOL_ITERATIONS (25) and
 *     by the dispatch deadline below.
 *   • Tools: calculator (local recursive-descent parser, never eval),
 *     wikipedia (REST summary + OpenSearch fallback), weather
 *     (Open-Meteo geocoding + forecast), web_search (keyless Bing
 *     first, DuckDuckGo fallback — real results, never faked), create_automation (governed
 *     POST /automations), add_provider (validate-then-add, keyless or
 *     keyed via keyEnv), reassign_agent (LLM-field-only reassignment,
 *     recorded). Same core tools as the UI, plus the provider/automation
 *     tools the runner's Orchestrator and Provider Researcher need.
 *   • Two model behaviours the first live tests exposed, both handled:
 *     (a) GPT-OSS emits NATIVE tool_calls (finish_reason
 *     "tool_calls", empty content) whenever it feels like it, even
 *     with no `tools` array sent — so the request now sends proper
 *     OpenAI function definitions (OPENAI_TOOLS), which pins native
 *     calls to the exact names, and extractReplyText converts a
 *     native call into the same strict-JSON action the loop parses.
 *     (b) In its text replies the model shortens tool names ("wiki"
 *     for "wikipedia") despite the contract — so executeTool accepts
 *     the predictable aliases (TOOL_ALIASES) instead of failing the
 *     turn. The UI (src/api/pollinations.ts) has neither of these
 *     two guards yet: its content-only reader reports "empty reply"
 *     on a native tool call, and its registry has no aliases.
 *   • Spacing is measured from the last ACTUAL upstream request,
 *     retries included: the anonymous tier counts every request
 *     against its per-IP window, so a retry at the end of call 1
 *     must push call 2's 50s gap out, or call 2 eats a 402.
 *
 * The runner sends only { id, name, model, systemPrompt } for the agent —
 * no enabledTools list — so this endpoint enables the full built-in
 * toolset for every dispatch. That is deliberate: the runner agent is a
 * single-purpose worker, and the tools are read-only / local (nothing
 * here writes, deletes, or spends).
 *
 * ---------------------------------------------------------------------------
 * The anonymous-tier limit — read this before expecting multi-tool turns.
 * ---------------------------------------------------------------------------
 *
 * Upstream LLM: Pollinations.ai. Two tiers:
 *
 *   • No API key (default): https://text.pollinations.ai/openai, model
 *     openai-fast (GPT-OSS 20B). Anonymous tier allows ~1 reply per 45s
 *     per IP, so this service serialises upstream calls and enforces a
 *     50s gap between them (MIN_GAP_MS). The runner aborts a dispatch
 *     after 330s, so the loop has a hard deadline of 320s from the
 *     request's arrival (DISPATCH_DEADLINE_MS) and every upstream call
 *     is capped by the time left to that deadline.
 *
 *     Consequence, stated honestly: on the anonymous tier a dispatch
 *     fits AT MOST ONE tool iteration plus a final answer — propose
 *     (call 1) → run the tool → wait out the 50s gap → propose again
 *     (call 2, ~7s left) → final. If call 2 cannot fit or fails, the
 *     loop does NOT error and does NOT claim it cannot use tools: it
 *     returns the tool's own result as the reply (the UI loop's
 *     "[reached the tool limit]" fallback). The tool result always
 *     reaches the runner. A second, third, or fifth tool call in one
 *     dispatch is impossible on this tier — the gap alone forbids it.
 *
 *   • With a key: set POLLINATIONS_API_KEY (get one at
 *     https://enter.pollinations.ai/keys). The service switches to the
 *     keyed endpoint https://gen.pollinations.ai/v1/chat/completions
 *     with `Authorization: Bearer <key>`, model `openai` (or
 *     POLLINATIONS_MODEL), and drops the 50s gap entirely — keyed
 *     requests are billed to the key's Pollen balance, not subject to
 *     the anonymous per-IP window. The full loop (up to 25 tool
 *     iterations + final) then fits comfortably inside the 320s
 *     deadline. No key is stored in this file or in the repo; it
 *     arrives only as an environment variable on the service unit.
 *
 * If Pollinations is still rate-limited after retries, the service
 * answers 502/429 honestly — the runner records the stage as failed
 * and retries it on the next due tick, instead of recording a canned
 * or tiny-model reply as a success. There is deliberately NO fallback
 * to the local Ollama models (qwen2.5-coder:0.5b / gemma3:1b): a
 * failed stage retries; a bad reply would be filed as done.
 *
 * Runs on jnet1 as systemd unit teamz-agent.service (port 8897).
 * It binds 0.0.0.0: jnet1 has no public IP (tailnet-only), and the
 * Teamz UI on Jesse's phone must reach GET /runner-state on the
 * tailnet address. The runner itself still calls 127.0.0.1:8897/chat
 * from the same host. Logs to stdout (journal) and
 * /var/log/teamz-agent/agent.log. Each tool step is logged, so a
 * tool-using exchange is visible in the log.
 *
 *   GET  /health        -> { ok: true, mode, model, tools, ... }
 *   GET  /runner-state  -> read-only summary of the headless runner's
 *                           jobs, schedules, stages and runs, from
 *                           /var/lib/teamz-runner/state.json. CORS
 *                           enabled so the UI (port 8895) can fetch it
 *                           cross-port. Never accepts writes.
 *   POST /chat          -> { reply: "..." }
 *   POST /automations   -> localhost-only: validate a proposed automation
 *                           and append it to the runner state (see
 *                           docs/ORCHESTRATOR.md). Refuses anything that
 *                           spends, publishes, releases, or deletes.
 *
 * Providers — the endpoint no longer hardcodes Pollinations for every
 * agent. A provider registry (/var/lib/teamz-agent/providers.json) holds
 * the validated providers; each agent's request carries its
 * provider assignment (agent.provider, from the runner state) and the
 * endpoint routes that agent's calls to its assigned provider. Providers
 * are validated with a live test call before adding — see
 * docs/PROVIDER_RESEARCHER.md. A provider is either keyless
 * ("keyless": true) or keyed: it names "keyEnv", the env var holding its
 * API key (e.g. "GEMINI_API_KEY"), and the key itself lives only in the
 * service env (/etc/teamz-agent.env), never in the registry or this
 * file. Pollinations anonymous (openai-fast) is the default and the
 * only provider validated live as of Nov 26, 2026: Hack Club AI 404s,
 * DuckDuckGo AI is bot-challenged (418), and DeepInfra / Together /
 * OpenRouter / Hugging Face all require an API key, so none of them is
 * in the registry until its key is configured.
 *
 * Rate limits — when an upstream call is refused (402/429), the endpoint
 * appends an event (with the failed request retained) to
 * /var/lib/teamz-agent/rate-limit-events.jsonl. The runner's tick picks
 * it up, wakes the Provider Researcher, and resends the original
 * request — the failed request is never silently dropped.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8897);
// 0.0.0.0: jnet1 is tailnet-only (no public IP), and the Teamz UI on
// Jesse's phone fetches GET /runner-state on the tailnet address.
// The runner itself still calls 127.0.0.1:8897/chat from the same host.
const HOST = process.env.HOST ?? '0.0.0.0';
const LOG_PATH = process.env.LOG_PATH ?? '/var/log/teamz-agent/agent.log';
// Headless runner state, read-only. The UI's in-tab runner cannot see
// it, so /runner-state exposes it to the UI.
const RUNNER_STATE_PATH =
  process.env.RUNNER_STATE_PATH ?? '/var/lib/teamz-runner/state.json';
// Provider registry, reassignments, and rate-limit events (all local).
const PROVIDER_REGISTRY_PATH =
  process.env.PROVIDER_REGISTRY_PATH ?? '/var/lib/teamz-agent/providers.json';
const REASSIGNMENTS_PATH =
  process.env.REASSIGNMENTS_PATH ?? '/var/lib/teamz-agent/reassignments.json';
const RATE_LIMIT_EVENTS_PATH =
  process.env.RATE_LIMIT_EVENTS_PATH ?? '/var/lib/teamz-agent/rate-limit-events.jsonl';
// The mem20 checkout the runner works on, and the patch staging area.
// repo_read reads files under MEM20_ROOT; stage_patch writes patch JSON
// (never repo files) under PATCH_DIR. The privileged push script
// (root, via sudo) is the only thing that applies a patch to the repo.
const MEM20_ROOT = resolve(process.env.MEM20_ROOT ?? '/opt/mem20');
const PATCH_DIR = process.env.PATCH_DIR ?? '/var/lib/teamz-runner/patches';
// The UI is served from port 8895, this service from 8897, so the
// browser treats the UI's fetch as cross-origin. Read-only + no auth
// on a tailnet-only service, so a wildcard origin is acceptable.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

/* --- Upstream: anonymous by default, keyed when a key is present. --- */
const POLLINATIONS_API_KEY = (process.env.POLLINATIONS_API_KEY ?? '').trim();
const KEYED = Boolean(POLLINATIONS_API_KEY);
const POLLINATIONS_URL = KEYED
  ? 'https://gen.pollinations.ai/v1/chat/completions'
  : 'https://text.pollinations.ai/openai';
const MODEL =
  process.env.POLLINATIONS_MODEL?.trim() || (KEYED ? 'openai' : 'openai-fast');
// Anonymous tier: ~1 reply / 45s per IP. Keep a safety margin. Keyed
// requests are billed, not subject to the anonymous per-IP window.
const MIN_GAP_MS = KEYED ? 0 : 50_000;
// The runner aborts a dispatch after 330s; the loop must be done and the
// HTTP response flushed before that. 320s leaves ~10s of margin.
export const DISPATCH_DEADLINE_MS = 320_000;
// Cap on any single upstream call. The loop tightens this per call to
// whatever time is left to the deadline.
const UPSTREAM_TIMEOUT_MS = 45_000;
/** How many tool iterations a single reply may take before the loop stops. */
const MAX_TOOL_ITERATIONS = 25;

/* ===========================================================================
 * Provider registry — validated providers, keyless or keyed, added only
 * after a live test call.
 *
 * Shape of providers.json:
 *   { providers: [{ id, name, baseUrl, model, keyless: true,
 *                    validatedAt, lastValidated, notes }],
 *     validationLog: [{ ts, candidate, ok, reason }] }
 * A keyed provider carries "keyEnv" instead of keyless: true, e.g.
 *   { id: "gemini", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
 *     model: "gemini-3-flash", keyEnv: "GEMINI_API_KEY", ... }
 * The key itself is never in the registry: keyEnv only names the env var
 * that holds it (set on the service unit via /etc/teamz-agent.env). A
 * keyed provider whose env var is unset is refused at provision time
 * and never assigned to an agent.
 * Anything gets in only through `provisionProvider` below, which makes
 * a real test call first and refuses anything that asks for a card or
 * payment, or a key it does not have. A provider that fails validation
 * is recorded in validationLog and NOT added — the log is the honest
 * record of what was tried.
 * ========================================================================= */

const POLLINATIONS_PROVIDER = {
  id: 'pollinations',
  name: 'Pollinations (anonymous tier)',
  baseUrl: 'https://text.pollinations.ai/openai',
  model: 'openai-fast',
  keyless: true,
  validatedAt: '2026-11-26T08:14:00Z',
  lastValidated: '2026-11-26T08:14:00Z',
  notes: 'Validated live Nov 26, 2026: test prompt returned exactly "PING". Anonymous tier: ~1 reply/45s per IP, 50s spacing enforced.',
};

function defaultRegistry() {
  return { providers: [POLLINATIONS_PROVIDER], validationLog: [] };
}

function loadRegistry() {
  try {
    if (!existsSync(PROVIDER_REGISTRY_PATH)) return defaultRegistry();
    const parsed = JSON.parse(readFileSync(PROVIDER_REGISTRY_PATH, 'utf-8'));
    if (!parsed || !Array.isArray(parsed.providers)) return defaultRegistry();
    return { providers: parsed.providers, validationLog: Array.isArray(parsed.validationLog) ? parsed.validationLog : [] };
  } catch {
    return defaultRegistry();
  }
}

function saveRegistry(registry) {
  mkdirSync(dirname(PROVIDER_REGISTRY_PATH), { recursive: true });
  const tmp = `${PROVIDER_REGISTRY_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  renameSync(tmp, PROVIDER_REGISTRY_PATH);
}

function recordValidation(registry, candidate, ok, reason) {
  registry.validationLog = [
    ...(registry.validationLog ?? []),
    { ts: new Date().toISOString(), candidate, ok, reason: String(reason).slice(0, 500) },
  ].slice(-100);
}

/**
 * Validate a candidate provider with a real test call: POST a PING prompt
 * to its OpenAI-compatible chat endpoint and require a real, non-empty
 * reply. Returns { ok, reason }. Never adds anything itself. A keyed
 * candidate (keyEnv set) sends its key as a Bearer token — the key comes
 * from the named env var only, never from the candidate, and is never
 * logged. A keyed candidate whose env var is unset fails validation.
 */
async function validateProviderCandidate(candidate) {
  const { id, name, baseUrl, model } = candidate;
  if (!id || !baseUrl || !model) return { ok: false, reason: 'candidate needs id, baseUrl, and model' };
  if (!/^https:\/\//.test(baseUrl)) return { ok: false, reason: 'baseUrl must be https' };
  const headers = { 'Content-Type': 'application/json' };
  if (candidate.keyEnv) {
    const key = (process.env[candidate.keyEnv] ?? '').trim();
    if (!key) return { ok: false, reason: `provider needs API key in env var "${candidate.keyEnv}" — not set` };
    headers.Authorization = `Bearer ${key}`;
  }
  try {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly the word PING.' }], stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const keyHint = /api key|authorization|unauthorized|401|403/i.test(text) ? ' (looks like it needs an API key — not keyless)' : '';
      return { ok: false, reason: `test call returned ${res.status}${keyHint}: ${text.slice(0, 200)}` };
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'test call returned non-JSON on success' };
    }
    const reply = extractReplyText(payload);
    if (!reply.trim()) return { ok: false, reason: 'test call returned an empty reply' };
    return { ok: true, reason: `test call returned a real reply: ${JSON.stringify(reply.slice(0, 80))}` };
  } catch (err) {
    return { ok: false, reason: `test call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Provision a provider: validate first, add only on success. Returns the
 * outcome; a failure is recorded in validationLog and the registry is
 * left unchanged. Keyed providers are allowed when they name their key's
 * env var (keyEnv) and that env var is set — the key itself is never
 * stored in the registry. A provider that needs a key but names no
 * keyEnv, or whose keyEnv is unset, is refused.
 */
async function provisionProvider(candidate) {
  const registry = loadRegistry();
  if (registry.providers.some((p) => p.id === candidate.id)) {
    return { ok: false, reason: `provider "${candidate.id}" is already in the registry` };
  }
  const keyEnv = typeof candidate.keyEnv === 'string' ? candidate.keyEnv.trim() : '';
  const keyed = keyEnv.length > 0;
  if (keyed) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) {
      recordValidation(registry, candidate.id, false, `refused: keyEnv "${keyEnv}" is not a valid env var name`);
      saveRegistry(registry);
      return { ok: false, reason: `refused: keyEnv "${keyEnv}" is not a valid env var name` };
    }
    if (!(process.env[keyEnv] ?? '').trim()) {
      recordValidation(registry, candidate.id, false, `refused: keyed provider needs env var "${keyEnv}" — not set`);
      saveRegistry(registry);
      return { ok: false, reason: `refused: keyed provider "${candidate.id}" needs API key in env var "${keyEnv}" — not set` };
    }
  } else if (candidate.keyless !== true) {
    recordValidation(registry, candidate.id, false, 'refused: keyless must be true, or name keyEnv for a keyed provider');
    saveRegistry(registry);
    return { ok: false, reason: 'refused: only keyless providers, or keyed providers with keyEnv, may be added' };
  }
  const check = await validateProviderCandidate(candidate);
  recordValidation(registry, candidate.id, check.ok, check.reason);
  if (!check.ok) {
    saveRegistry(registry);
    return { ok: false, reason: `validation failed: ${check.reason}` };
  }
  const now = new Date().toISOString();
  registry.providers.push({
    id: candidate.id,
    name: candidate.name ?? candidate.id,
    baseUrl: candidate.baseUrl,
    model: candidate.model,
    keyless: !keyed,
    ...(keyed ? { keyEnv } : {}),
    validatedAt: now,
    lastValidated: now,
    notes: candidate.notes ?? '',
  });
  saveRegistry(registry);
  log(`provider provisioned: ${candidate.id} (${candidate.model}) — ${check.reason}`);
  return { ok: true, reason: `provider "${candidate.id}" validated and added — ${check.reason}` };
}

/* --- Runner state, written only through the controlled paths below. --- */

function loadRunnerStateJson() {
  return JSON.parse(readFileSync(RUNNER_STATE_PATH, 'utf-8'));
}

function saveRunnerStateJson(state) {
  const tmp = `${RUNNER_STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  renameSync(tmp, RUNNER_STATE_PATH);
}

function loadReassignments() {
  try {
    if (!existsSync(REASSIGNMENTS_PATH)) return [];
    const parsed = JSON.parse(readFileSync(REASSIGNMENTS_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveReassignments(list) {
  mkdirSync(dirname(REASSIGNMENTS_PATH), { recursive: true });
  const tmp = `${REASSIGNMENTS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf-8');
  renameSync(tmp, REASSIGNMENTS_PATH);
}

/**
 * Reassign one agent's LLM assignment (provider + model) in the runner
 * state, LLM fields ONLY. Refuses unknown agents, unknown providers, and
 * any attempt to touch anything else. A provider is assignable when it is
 * keyless, or when it is keyed and its key is configured — a keyed
 * provider with no key configured is never assigned, so an agent is
 * never pointed at a provider that cannot answer. Every change is
 * recorded with from/to/when/why.
 */
function reassignAgentLlm(agentId, providerId, model, reason) {
  const registry = loadRegistry();
  const provider = registry.providers.find((p) => p.id === providerId);
  if (!provider) return { ok: false, reason: `unknown provider "${providerId}" — not in the registry` };
  if (provider.keyless !== true && !provider.keyEnv) {
    return { ok: false, reason: `provider "${providerId}" is neither keyless nor keyed (no keyEnv)` };
  }
  if (provider.keyEnv && !(process.env[provider.keyEnv] ?? '').trim()) {
    return { ok: false, reason: `provider "${providerId}" needs API key in env var "${provider.keyEnv}" — not set` };
  }
  if (model && model !== provider.model) {
    return { ok: false, reason: `model "${model}" does not match provider "${providerId}" (model "${provider.model}")` };
  }
  let state;
  try {
    state = loadRunnerStateJson();
  } catch (err) {
    return { ok: false, reason: `cannot read runner state: ${err instanceof Error ? err.message : String(err)}` };
  }
  const agent = (state.agents ?? []).find((a) => a.id === agentId);
  if (!agent) return { ok: false, reason: `unknown agent "${agentId}"` };
  const from = { provider: agent.provider ?? 'pollinations', model: agent.model ?? '' };
  // Refuse only a true no-op: the agent already EXPLICITLY carries this
  // provider + model. Pinning an agent that has no provider field yet is
  // a real change (the record gains the assignment), not a no-op.
  if (agent.provider === providerId && agent.model === provider.model) {
    return { ok: false, reason: `${agent.name} is already on ${providerId}/${provider.model} — nothing to change` };
  }
  agent.provider = providerId;
  agent.model = provider.model;
  const entry = {
    agentId,
    agentName: agent.name,
    from,
    to: { provider: providerId, model: provider.model },
    reason: String(reason ?? '').slice(0, 500),
    ts: new Date().toISOString(),
  };
  saveReassignments([...loadReassignments(), entry]);
  saveRunnerStateJson(state);
  log(`reassigned ${agentId}: ${from.provider}/${from.model} -> ${providerId}/${provider.model} (${entry.reason})`);
  return { ok: true, reason: `reassigned ${agent.name} from ${from.provider}/${from.model} to ${providerId}/${provider.model}`, entry };
}

/** Append a rate-limit event (failed request retained) for the runner tick.
 * Returns true when the event was actually written — the caller must not
 * claim it was recorded when the append failed (EACCES on a root-owned
 * events file hid a real 402 event on Nov 26, 2026). */
function recordRateLimitEvent(event) {
  try {
    mkdirSync(dirname(RATE_LIMIT_EVENTS_PATH), { recursive: true });
    appendFileSync(RATE_LIMIT_EVENTS_PATH, JSON.stringify(event) + '\n', 'utf-8');
    return true;
  } catch (err) {
    log(`rate-limit event NOT recorded: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/* ===========================================================================
 * Repo tools — the governed push path's read/stage half (docs/PUSH_PATH.md).
 *
 * The agents work on the mem20 checkout at MEM20_ROOT, but they never
 * write to it directly: repo_read reads files, stage_patch stages ONE
 * small patch as JSON under PATCH_DIR. The privileged push script
 * (root, via sudo) is the only thing that applies a patch to the repo,
 * and only after the Reviewer approved the push stage.
 *
 * Both tools treat their inputs as untrusted: paths must stay inside
 * the repo, blocked paths are refused, and stage_patch verifies the job
 * is really sitting on its implement stage (the patch-producing stage)
 * before it stages anything.
 * ========================================================================= */

// Paths a staged patch may never touch: workflow files (the token has no
// `workflow` scope and Jesse applies those himself), the starlette cap in
// requirements.txt, and anything secret.
const PATCH_BLOCKED_PREFIXES = ['.github/', '.git/'];
const PATCH_BLOCKED_NAMES = new Set(['requirements.txt']);
const PATCH_BLOCKED_SEGMENTS = new Set(['secrets', '.git']);
const PATCH_BLOCKED_SUFFIXES = ['.env'];
// Reads are harmless, so repo_read blocks only secrets and git internals.
const READ_BLOCKED_SEGMENTS = new Set(['secrets', '.git']);
const READ_BLOCKED_SUFFIXES = ['.env'];

const JOB_ID_RE = /^job-[a-z0-9][a-z0-9-]*$/;
const MAX_READ_CHARS = 1000;
const MAX_OLD_TEXT_CHARS = 2000;
const MAX_NEW_TEXT_CHARS = 5000;
const MAX_MESSAGE_CHARS = 200;

/** Resolve `rel` under MEM20_ROOT, or null when it escapes / is malformed. */
function resolveRepoPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\')) return null;
  if (rel.startsWith('/')) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p === '..' || p === '')) return null;
  const abs = resolve(MEM20_ROOT, rel);
  if (abs !== MEM20_ROOT && !abs.startsWith(`${MEM20_ROOT}/`)) return null;
  return { rel: parts.join('/'), abs };
}

function pathBlocked(rel, { segments, prefixes, names, suffixes }) {
  const parts = rel.split('/');
  if (parts.some((p) => segments.has(p))) return true;
  if (prefixes.some((pre) => rel.startsWith(pre))) return true;
  if (names.has(parts[parts.length - 1])) return true;
  if (suffixes.some((suf) => rel.endsWith(suf))) return true;
  return false;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

/**
 * Read a file (or the excerpt around a search string) under MEM20_ROOT.
 * Args JSON: {"file", "find"?}. Returns at most ~1000 chars — the tool
 * loop truncates observations at 1200, so a longer return would be cut
 * mid-sentence. `find` is how the agent reaches a sentence deep in a
 * file: the excerpt is centred on the first match.
 */
export function runRepoRead(args) {
  let input;
  try {
    input = JSON.parse(args);
  } catch {
    throw new Error('repo_read needs a JSON object like {"file": "docs/README.md", "find": "some sentence"}');
  }
  const resolved = resolveRepoPath(input.file);
  if (!resolved) {
    throw new Error(`repo_read refused: bad path ${JSON.stringify(input.file)} — relative paths inside the repo only`);
  }
  if (
    pathBlocked(resolved.rel, {
      segments: READ_BLOCKED_SEGMENTS,
      prefixes: [],
      names: new Set(),
      suffixes: READ_BLOCKED_SUFFIXES,
    })
  ) {
    throw new Error(`repo_read refused: ${resolved.rel} is not readable through this tool`);
  }
  let text;
  try {
    text = readFileSync(resolved.abs, 'utf-8');
  } catch {
    throw new Error(`repo_read: cannot read ${resolved.rel} — no such file in the repo`);
  }
  const find = typeof input.find === 'string' && input.find ? input.find : null;
  if (!find) {
    const head = text.slice(0, MAX_READ_CHARS);
    return `${resolved.rel} (${text.length} chars total):\n${head}${text.length > MAX_READ_CHARS ? '\n…[truncated]' : ''}`;
  }
  const idx = text.indexOf(find);
  if (idx === -1) return `no match for ${JSON.stringify(find)} in ${resolved.rel} (${text.length} chars total)`;
  const start = Math.max(0, idx - 400);
  const end = Math.min(text.length, idx + find.length + 400);
  let excerpt = text.slice(start, end);
  if (excerpt.length > MAX_READ_CHARS) excerpt = excerpt.slice(0, MAX_READ_CHARS);
  return `${resolved.rel} — match for ${JSON.stringify(find)} at char ${idx} of ${text.length}:\n${start > 0 ? '…' : ''}${excerpt}${end < text.length ? '…' : ''}`;
}

/**
 * Stage ONE small patch for a job's implement stage. Args JSON:
 * {"jobId", "file", "oldText", "newText", "message"}. Writes a patch
 * JSON under PATCH_DIR — it never touches the repo. The push script
 * applies it only after Reviewer approval. Refuses unless the job
 * exists in the runner state AND is currently sitting on its implement
 * stage, so a patch can only be staged for the job that is actually
 * producing a change right now.
 */
export function runStagePatch(args) {
  let input;
  try {
    input = JSON.parse(args);
  } catch {
    throw new Error(
      'stage_patch needs a JSON object like {"jobId": "job-...", "file": "docs/x.md", "oldText": "...", "newText": "...", "message": "docs: fix ..."}',
    );
  }
  const { jobId, file, oldText, newText, message } = input ?? {};
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new Error('stage_patch refused: jobId must look like "job-..." (see the runner context in your prompt)');
  }
  if (typeof oldText !== 'string' || !oldText || oldText.length > MAX_OLD_TEXT_CHARS) {
    throw new Error(`stage_patch refused: oldText must be 1–${MAX_OLD_TEXT_CHARS} chars`);
  }
  if (typeof newText !== 'string' || !newText || newText.length > MAX_NEW_TEXT_CHARS) {
    throw new Error(`stage_patch refused: newText must be 1–${MAX_NEW_TEXT_CHARS} chars`);
  }
  if (
    typeof message !== 'string' ||
    !message.trim() ||
    message.trim().length > MAX_MESSAGE_CHARS ||
    /\n/.test(message)
  ) {
    throw new Error(`stage_patch refused: message must be one line, 1–${MAX_MESSAGE_CHARS} chars`);
  }
  const resolved = resolveRepoPath(file);
  if (!resolved) {
    throw new Error(`stage_patch refused: bad path ${JSON.stringify(file)} — relative paths inside the repo only`);
  }
  if (
    pathBlocked(resolved.rel, {
      segments: PATCH_BLOCKED_SEGMENTS,
      prefixes: PATCH_BLOCKED_PREFIXES,
      names: PATCH_BLOCKED_NAMES,
      suffixes: PATCH_BLOCKED_SUFFIXES,
    })
  ) {
    throw new Error(
      `stage_patch refused: ${resolved.rel} is blocked — workflow files, requirements.txt, and secrets are never pushed by this path`,
    );
  }
  let state;
  try {
    state = loadRunnerStateJson();
  } catch (err) {
    throw new Error(
      `stage_patch refused: cannot read runner state — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const job = (state.jobs ?? []).find((j) => j.id === jobId);
  if (!job) throw new Error(`stage_patch refused: unknown job "${jobId}"`);
  const current = job.stages?.[job.currentStageIndex];
  if (!current || current.stage !== 'implement') {
    throw new Error(
      `stage_patch refused: job "${jobId}" is not on its implement stage (current: ${current?.stage ?? 'done'})`,
    );
  }
  let text;
  try {
    text = readFileSync(resolved.abs, 'utf-8');
  } catch {
    throw new Error(`stage_patch: cannot read ${resolved.rel} — no such file in the repo`);
  }
  const occurrences = countOccurrences(text, oldText);
  if (occurrences !== 1) {
    throw new Error(
      `stage_patch refused: oldText occurs ${occurrences} times in ${resolved.rel} — it must occur exactly once (re-read the file and copy the exact text)`,
    );
  }
  const patch = {
    jobId,
    file: resolved.rel,
    oldText,
    newText,
    message: message.trim(),
    stagedAt: new Date().toISOString(),
  };
  mkdirSync(PATCH_DIR, { recursive: true });
  const path = `${PATCH_DIR}/${jobId}.json`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(patch, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
  const added = newText.split('\n').length;
  const removed = oldText.split('\n').length;
  log(`patch staged: job=${jobId} file=${resolved.rel} (${removed}→${added} lines)`);
  return `patch staged for job ${jobId}: ${resolved.rel} (${removed} line(s) → ${added} line(s)). It is NOT in the repo yet — the governed push step commits and pushes it only after the Reviewer approves the push. Reply with a one-paragraph summary of the change for the record.`;
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, line + '\n', 'utf-8');
  } catch {
    // Journal still has it.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===========================================================================
 * Tools — ported from src/lib/tools.ts (plain JavaScript, no TS imports).
 * executeTool never throws: unknown tools, network failures and tool-side
 * errors all come back as { ok: false, output } so the loop can feed the
 * failure to the model as an observation and let it recover.
 * ========================================================================= */

const TOOL_TIMEOUT_MS = 10_000;

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
}

/* --- Calculator: local, no network. Small recursive-descent parser:
 * numbers, + - * / % ^, parentheses, unary minus, sqrt/abs/min/max and the
 * constants pi/e. Anything it cannot parse is an error, never a guess.
 * Never eval(). ----------------------------------------------------------- */

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let num = '';
      while (i < input.length && ((input[i] >= '0' && input[i] <= '9') || input[i] === '.')) {
        num += input[i++];
      }
      const value = Number(num);
      if (!Number.isFinite(value)) throw new Error(`not a number: ${num}`);
      tokens.push({ kind: 'num', value });
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      let ident = '';
      while (i < input.length && /[a-zA-Z]/.test(input[i])) ident += input[i++];
      tokens.push({ kind: 'ident', value: ident.toLowerCase() });
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' || ch === '^') {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' });
      i++;
      continue;
    }
    throw new Error(`unexpected character: ${ch}`);
  }
  return tokens;
}

const CALC_FUNCTIONS = {
  sqrt: (x) => {
    if (x < 0) throw new Error('sqrt of a negative number');
    return Math.sqrt(x);
  },
  abs: (x) => Math.abs(x),
  min: (...xs) => Math.min(...xs),
  max: (...xs) => Math.max(...xs),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  round: (x) => Math.round(x),
};

const CALC_CONSTANTS = { pi: Math.PI, e: Math.E };

/** Parse and evaluate a math expression. Throws on anything invalid. */
export function evaluateExpression(input) {
  const expr = input.trim();
  if (!expr) throw new Error('empty expression');
  const tokens = tokenize(expr);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr() {
    let value = parseTerm();
    for (;;) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '+' || t.value === '-')) {
        next();
        const rhs = parseTerm();
        value = t.value === '+' ? value + rhs : value - rhs;
      } else {
        return value;
      }
    }
  }

  function parseTerm() {
    let value = parseFactor();
    for (;;) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        next();
        const rhs = parseFactor();
        if (t.value === '*') value *= rhs;
        else if (t.value === '/') {
          if (rhs === 0) throw new Error('division by zero');
          value /= rhs;
        } else {
          if (rhs === 0) throw new Error('modulo by zero');
          value %= rhs;
        }
      } else {
        return value;
      }
    }
  }

  // ^ is right-associative: 2^3^2 = 2^(3^2).
  function parseFactor() {
    const base = parseUnary();
    const t = peek();
    if (t?.kind === 'op' && t.value === '^') {
      next();
      return Math.pow(base, parseFactor());
    }
    return base;
  }

  function parseUnary() {
    const t = peek();
    if (t?.kind === 'op' && t.value === '-') {
      next();
      return -parseUnary();
    }
    if (t?.kind === 'op' && t.value === '+') {
      next();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = next();
    if (!t) throw new Error('unexpected end of expression');
    if (t.kind === 'num') return t.value;
    if (t.kind === 'lparen') {
      const value = parseExpr();
      const close = next();
      if (!close || close.kind !== 'rparen') throw new Error('missing closing parenthesis');
      return value;
    }
    if (t.kind === 'ident') {
      if (t.value in CALC_CONSTANTS && peek()?.kind !== 'lparen') return CALC_CONSTANTS[t.value];
      const fn = CALC_FUNCTIONS[t.value];
      if (!fn) throw new Error(`unknown function or constant: ${t.value}`);
      const open = next();
      if (!open || open.kind !== 'lparen') throw new Error(`expected ( after ${t.value}`);
      const args = [];
      if (peek()?.kind !== 'rparen') {
        args.push(parseExpr());
        while (peek()?.kind === 'comma') {
          next();
          args.push(parseExpr());
        }
      }
      const close = next();
      if (!close || close.kind !== 'rparen') throw new Error(`missing ) after ${t.value}(`);
      return fn(...args);
    }
    throw new Error(`unexpected token: ${t.kind}`);
  }

  const value = parseExpr();
  if (pos < tokens.length) throw new Error('trailing characters after expression');
  if (!Number.isFinite(value)) throw new Error('result is not a finite number');
  return value;
}

async function runCalculator(args) {
  const value = evaluateExpression(args);
  const shown = Number.isInteger(value) ? String(value) : String(Math.round(value * 1e10) / 1e10);
  return `${args.trim()} = ${shown}`;
}

/* --- Wikipedia: keyless REST summary API. Tries the query as a page title
 * first; on a miss, falls back to the OpenSearch API to find the
 * best-matching title, then summarises that. ------------------------------ */

const WIKI_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const WIKI_SEARCH = 'https://en.wikipedia.org/w/api.php';
const WIKI_UA = { Accept: 'application/json', 'User-Agent': 'teamz-agent/1.0 (https://mem20.com)' };

async function fetchWikiSummary(title) {
  const res = await fetchWithTimeout(`${WIKI_SUMMARY}${encodeURIComponent(title)}`, {
    headers: WIKI_UA,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wikipedia returned ${res.status}`);
  return await res.json();
}

async function runWikipedia(args) {
  const query = args.trim();
  if (!query) throw new Error('wikipedia needs a search term, e.g. "Ada Lovelace"');
  let summary = await fetchWikiSummary(query);
  if (!summary) {
    const searchUrl =
      `${WIKI_SEARCH}?action=opensearch&search=${encodeURIComponent(query)}` +
      '&limit=1&namespace=0&format=json';
    const res = await fetchWithTimeout(searchUrl, { headers: WIKI_UA });
    if (!res.ok) throw new Error(`Wikipedia search returned ${res.status}`);
    const data = await res.json();
    const titles = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
    const best = titles.find((t) => typeof t === 'string');
    if (!best) return `No Wikipedia article found for "${query}".`;
    summary = await fetchWikiSummary(best);
    if (!summary) return `No Wikipedia article found for "${query}".`;
  }
  const extract = (summary.extract ?? '').trim();
  const url = summary.content_urls?.desktop?.page ?? '';
  const head = summary.title ? `${summary.title}` : query;
  const body = extract ? extract.slice(0, 1200) : 'No summary available for this article.';
  return url ? `${head}\n${body}\nRead more: ${url}` : `${head}\n${body}`;
}

/* --- Weather: keyless Open-Meteo. Geocoding API turns a place name into
 * coordinates, then the forecast API returns current conditions plus a
 * 3-day outlook. ------------------------------------------------------------ */

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const WMO_CODE = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'moderate drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'dense freezing drizzle',
  61: 'slight rain',
  63: 'moderate rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'heavy freezing rain',
  71: 'slight snow',
  73: 'moderate snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'slight rain showers',
  81: 'moderate rain showers',
  82: 'violent rain showers',
  85: 'slight snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with slight hail',
  99: 'thunderstorm with heavy hail',
};

function describeWeather(code) {
  return WMO_CODE[code] ?? `weather code ${code}`;
}

async function runWeather(args) {
  const place = args.trim();
  if (!place) throw new Error('weather needs a place name, e.g. "Denver"');
  const geoUrl = `${GEOCODE_URL}?name=${encodeURIComponent(place)}&count=1&language=en&format=json`;
  const geoRes = await fetchWithTimeout(geoUrl, { headers: { Accept: 'application/json' } });
  if (!geoRes.ok) throw new Error(`Open-Meteo geocoding returned ${geoRes.status}`);
  const geo = await geoRes.json();
  const hit = geo.results?.[0];
  if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') {
    return `Could not find a place called "${place}".`;
  }
  const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
  const fcUrl =
    `${FORECAST_URL}?latitude=${hit.latitude}&longitude=${hit.longitude}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&timezone=auto&forecast_days=3';
  const fcRes = await fetchWithTimeout(fcUrl, { headers: { Accept: 'application/json' } });
  if (!fcRes.ok) throw new Error(`Open-Meteo forecast returned ${fcRes.status}`);
  const fc = await fcRes.json();
  const cur = fc.current ?? {};
  const lines = [`Weather in ${label}:`];
  const now = [];
  if (typeof cur.temperature_2m === 'number') {
    now.push(
      typeof cur.apparent_temperature === 'number'
        ? `${cur.temperature_2m}°C (feels like ${cur.apparent_temperature}°C)`
        : `${cur.temperature_2m}°C`,
    );
  }
  if (typeof cur.weather_code === 'number') now.push(describeWeather(cur.weather_code));
  if (typeof cur.relative_humidity_2m === 'number') now.push(`humidity ${cur.relative_humidity_2m}%`);
  if (typeof cur.wind_speed_10m === 'number') now.push(`wind ${cur.wind_speed_10m} km/h`);
  lines.push(now.length ? `Now: ${now.join(', ')}.` : 'Current conditions unavailable.');
  const daily = fc.daily;
  const days = daily?.time ?? [];
  for (let i = 0; i < Math.min(days.length, 3); i++) {
    const hi = daily?.temperature_2m_max?.[i];
    const lo = daily?.temperature_2m_min?.[i];
    const pop = daily?.precipitation_probability_max?.[i];
    const parts = [];
    if (typeof hi === 'number' && typeof lo === 'number') parts.push(`${lo}°C – ${hi}°C`);
    if (typeof pop === 'number') parts.push(`${pop}% chance of precipitation`);
    if (parts.length) lines.push(`${days[i]}: ${parts.join(', ')}.`);
  }
  return lines.join('\n');
}

/* --- Web search: keyless Bing first, DuckDuckGo as the fallback,
 * DDG instant answers last. Real results, never faked: the endpoints
 * return plain HTML with result links; the parser pulls the top results
 * out and the tool reports exactly what came back (or that nothing
 * came back). This is what the Provider Researcher uses to find
 * candidate providers.
 *
 * Honest limits, found live Nov 26, 2026:
 *  - DDG Lite uses SINGLE-quoted attributes (class='result-link');
 *    the first version of this parser only matched double quotes and
 *    returned nothing. Fixed.
 *  - DDG serves results only intermittently from this server IP: it
 *    answered once, then returned zero result links on 8 consecutive
 *    tries (Lite and HTML alike). Bing answered 17-19 results on every
 *    probe from the same IP, so Bing is the primary (Jesse, Nov 26,
 *    2026: "make Bing first") and DDG is the fallback. Bing's title
 *    links are bing.com/ck/a redirects; they still land on the
 *    destination when followed, so they are returned as-is.
 *  - No Exa key exists (EXA_API_KEY is not set), so Exa is not wired;
 *    if one is ever added it can become the primary ahead of Bing. --- */

const DDG_LITE = 'https://lite.duckduckgo.com/lite/?q=';
const DDG_HTML = 'https://html.duckduckgo.com/html/?q=';
const DDG_JSON = 'https://api.duckduckgo.com/?format=json&no_html=1&q=';
const BING = 'https://www.bing.com/search?q=';

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function resolveDdgHref(rawHref) {
  let href = decodeEntities(rawHref);
  // DDG wraps destinations as //duckduckgo.com/l/?uddg=<url-encoded>.
  try {
    const u = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) href = uddg;
  } catch {
    // Keep the raw href; the https check below drops it if unusable.
  }
  return href;
}

function parseDdgLite(html) {
  const results = [];
  // DDG Lite anchors look like:
  //   <a rel="nofollow" href="//duckduckgo.com/l/?uddg=…&amp;rut=…" class='result-link'>Title</a>
  // Attributes come in either order and quotes vary, so match the whole
  // anchor first, then pull the href out of its attributes.
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 5) {
    const attrs = m[1];
    if (!/class=["']result-link["']/.test(attrs)) continue;
    const hrefMatch = /href=["']([^"']+)["']/.exec(attrs);
    if (!hrefMatch) continue;
    const href = resolveDdgHref(hrefMatch[1]);
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim());
    if (!title || !/^https?:\/\//.test(href)) continue;
    results.push({ title, href });
  }
  return results;
}

function parseDdgHtml(html) {
  const results = [];
  const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 5) {
    const href = resolveDdgHref(m[1]);
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim());
    if (!title) continue;
    if (!/^https?:\/\//.test(href)) continue;
    results.push({ title, href });
  }
  return results;
}

function parseBing(html) {
  const results = [];
  // Bing results are <li class="b_algo"> blocks; the title link is the
  // <h2><a href="...">Title</a></h2> inside. The href is a Bing redirect
  // (bing.com/ck/a?...); it still lands on the destination when followed,
  // so it is returned as-is.
  const re = /<li class="b_algo"[\s\S]*?<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 5) {
    const href = decodeEntities(m[1]);
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim());
    if (!title || !/^https?:\/\//.test(href)) continue;
    results.push({ title, href });
  }
  return results;
}

function parseDdgJson(data) {
  const results = [];
  // api.duckduckgo.com instant answers: an Abstract and RelatedTopics.
  // Only useful for encyclopedic queries; repo-specific queries come
  // back empty, so this is a last resort, never a primary.
  if (data?.AbstractURL && data?.AbstractText) {
    results.push({ title: data.AbstractText.slice(0, 200), href: data.AbstractURL });
  }
  for (const t of data?.RelatedTopics ?? []) {
    if (results.length >= 5) break;
    if (t?.FirstURL && t?.Text) results.push({ title: t.Text.slice(0, 200), href: t.FirstURL });
  }
  return results;
}

async function runWebSearch(args) {
  const query = args.trim();
  if (!query) throw new Error('web_search needs a query, e.g. "keyless free LLM API no api key"');
  const ddgHeaders = { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) teamz-agent/1.0' };
  const bingHeaders = { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0' };
  // Bing first (it answers reliably from this server IP), DuckDuckGo
  // Lite and HTML as the fallback, DDG instant answers last.
  // DDG Lite is retried once: it serves results intermittently from this
  // IP and a second attempt often lands in a good phase.
  const sources = [
    ['bing', `${BING}${encodeURIComponent(query)}`, parseBing, bingHeaders, false],
    ['lite', `${DDG_LITE}${encodeURIComponent(query)}`, parseDdgLite, ddgHeaders, true],
    ['html', `${DDG_HTML}${encodeURIComponent(query)}`, parseDdgHtml, ddgHeaders, false],
  ];
  for (const [label, url, parse, headers, retry] of sources) {
    for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
      try {
        const res = await fetchWithTimeout(url, { headers });
        if (!res.ok) {
          log(`web_search (${label}): HTTP ${res.status}, trying next source`);
          break;
        }
        const results = parse(await res.text());
        if (results.length > 0) {
          return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.href}`).join('\n');
        }
        log(`web_search (${label}): no results parsed, trying next source`);
        if (attempt === 0 && retry) await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        log(`web_search (${label}) failed: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
  }
  // Last resort: DDG instant answers (encyclopedic queries only).
  try {
    const res = await fetchWithTimeout(`${DDG_JSON}${encodeURIComponent(query)}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const results = parseDdgJson(await res.json());
      if (results.length > 0) {
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.href}`).join('\n');
      }
    }
  } catch (err) {
    log(`web_search (ddg-json) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return `No web results found for "${query}".`;
}

/* --- Registry: the tools the endpoint offers. ---------------------------- */

const TOOL_DEFS = [
  {
    name: 'wikipedia',
    description: 'Look up a topic on Wikipedia and return a short summary.',
    usage: 'a search term, e.g. "Ada Lovelace"',
    run: runWikipedia,
  },
  {
    name: 'weather',
    description: 'Current weather and a 3-day outlook for any place on Earth.',
    usage: 'a place name, e.g. "Denver"',
    run: runWeather,
  },
  {
    name: 'calculator',
    description: 'Evaluate a math expression (no network, runs locally).',
    usage: 'a math expression, e.g. "2 + 3 * 4"',
    run: runCalculator,
  },
  {
    name: 'web_search',
    description: 'Search the web (Bing first, DuckDuckGo fallback) and return real result titles and links.',
    usage: 'a search query, e.g. "keyless free LLM API no api key"',
    run: runWebSearch,
  },
  {
    name: 'create_automation',
    description:
      'Create a new scheduled prompt automation in the runner (hourly-style cron job in conv-build-room). ' +
      'Args must be a JSON object: {"name", "schedule" (cron, e.g. "0 * * * *"), "agentId", "channelId": "conv-build-room", "target" (the prompt)}. ' +
      'Refused when it would spend money, publish publicly, release, or delete — those need the Reviewer.',
    usage: 'a JSON object, e.g. {"name": "Hourly: QA Tester", "schedule": "0 * * * *", "agentId": "agent-qa-tester", "channelId": "conv-build-room", "target": "..."}',
    run: async (args) => {
      let input;
      try {
        input = JSON.parse(args);
      } catch {
        throw new Error('create_automation needs a JSON object like {"name": "...", "schedule": "0 * * * *", "agentId": "agent-x", "channelId": "conv-build-room", "target": "..."}');
      }
      const res = await fetch('http://127.0.0.1:8897/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (!res.ok) return `create_automation refused (${res.status}): ${text.slice(0, 500)}`;
      return `create_automation ok: ${text.slice(0, 500)}`;
    },
  },
  {
    name: 'add_provider',
    description:
      'Add a new LLM provider to the registry. Validates it FIRST with a live test call — a provider that fails validation is NOT added. ' +
      'Keyless providers pass {"keyless": true}; keyed providers pass {"keyEnv": "<ENV_VAR>"} instead, and the key must already be set in that env var on the service — keys are never passed in args and never stored in the registry. ' +
      'Args must be a JSON object: {"id", "name", "baseUrl" (https OpenAI-compatible chat endpoint), "model", "keyless": true} or {"id", "name", "baseUrl", "model", "keyEnv": "GEMINI_API_KEY"}.',
    usage: 'a JSON object, e.g. {"id": "example", "name": "Example", "baseUrl": "https://example.com/v1/chat/completions", "model": "some-model", "keyless": true} or with "keyEnv": "SOME_API_KEY" instead of "keyless" for a keyed provider',
    run: async (args) => {
      let input;
      try {
        input = JSON.parse(args);
      } catch {
        throw new Error('add_provider needs a JSON object like {"id": "...", "name": "...", "baseUrl": "https://...", "model": "...", "keyless": true} (or "keyEnv": "ENV_VAR" for a keyed provider)');
      }
      const result = await provisionProvider(input);
      return result.ok ? result.reason : `add_provider FAILED: ${result.reason}`;
    },
  },
  {
    name: 'reassign_agent',
    description:
      'Change one agent\'s LLM assignment (provider + model) in the runner state, LLM fields ONLY — never system prompts, skills, or anything else — and only to a validated provider (keyless, or keyed with its key configured). ' +
      'Every change is recorded with from/to/when/why. Args must be a JSON object: {"agentId", "provider", "reason"}.',
    usage: 'a JSON object, e.g. {"agentId": "agent-qa-tester", "provider": "pollinations", "reason": "rate limit on previous provider"}',
    run: async (args) => {
      let input;
      try {
        input = JSON.parse(args);
      } catch {
        throw new Error('reassign_agent needs a JSON object like {"agentId": "agent-qa-tester", "provider": "pollinations", "reason": "why"}');
      }
      const result = reassignAgentLlm(input.agentId, input.provider, input.model, input.reason);
      return result.ok ? result.reason : `reassign_agent FAILED: ${result.reason}`;
    },
  },
  {
    name: 'repo_read',
    description:
      'Read a file in the mem20 repo (/opt/mem20) — or the excerpt around a search string in it. ' +
      'Args must be a JSON object: {"file" (repo-relative path), "find" (optional sentence to centre the excerpt on)}. ' +
      'Returns at most ~1000 chars. Never reads secrets or git internals.',
    usage: 'a JSON object, e.g. {"file": "docs/series/cartoon/index.html", "find": "no episode has been produced yet"}',
    run: async (args) => runRepoRead(args),
  },
  {
    name: 'stage_patch',
    description:
      'Stage ONE small patch for your job\'s implement stage: the smallest verified correction to one repo file. ' +
      'Args must be a JSON object: {"jobId" (from the runner context in your prompt), "file" (repo-relative path), "oldText" (exact text, must occur exactly once), "newText", "message" (one-line commit message)}. ' +
      'Stages the patch for the governed push — it does NOT edit the repo. Refused for workflow files, requirements.txt, and secrets, and unless your job is on its implement stage.',
    usage: 'a JSON object, e.g. {"jobId": "job-...", "file": "docs/x.md", "oldText": "...", "newText": "...", "message": "docs: fix ..."}',
    run: async (args) => runStagePatch(args),
  },
];

const TOOL_NAMES = TOOL_DEFS.map((d) => d.name);

/**
 * Aliases for the names the model invents. GPT-OSS shortens tool names
 * in its text replies ("wiki" for "wikipedia") and no prompt wording
 * stops it reliably, so the registry accepts the predictable variants
 * instead of failing the turn. A name with no alias is still unknown —
 * the loop feeds that back as an observation and the model can recover.
 */
const TOOL_ALIASES = {
  wiki: 'wikipedia',
  calc: 'calculator',
  calculation: 'calculator',
  math: 'calculator',
  forecast: 'weather',
  temperature: 'weather',
  search: 'web_search',
  websearch: 'web_search',
  duckduckgo: 'web_search',
  googlesearch: 'web_search',
  createautomation: 'create_automation',
  addprovider: 'add_provider',
  reassignagent: 'reassign_agent',
  reassign: 'reassign_agent',
  reporead: 'repo_read',
  readrepo: 'repo_read',
  stagepatch: 'stage_patch',
};

function resolveToolName(name) {
  const key = String(name ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const exact = TOOL_DEFS.find((d) => d.name.replace(/[\s_-]+/g, '') === key);
  if (exact) return exact;
  const aliased = TOOL_ALIASES[key];
  if (aliased) return TOOL_DEFS.find((d) => d.name === aliased);
  return undefined;
}

/** One-line-per-tool inventory, in the shape the model sees in its system prompt. */
export function inventoryText() {
  return TOOL_DEFS.map((d) => `- ${d.name}: ${d.description} Args: ${d.usage}`).join('\n');
}

/**
 * Run one tool. Never throws: an unknown tool, a network failure, or a
 * tool-side error all come back as { ok: false, output } so the loop can
 * feed the failure to the model as an observation.
 */
export async function executeTool(name, args) {
  const def = resolveToolName(name);
  if (!def) {
    return {
      ok: false,
      output: `unknown tool: ${name}. Available tools: ${TOOL_NAMES.join(', ')}.`,
      tool: name,
    };
  }
  if (def.name !== name) {
    log(`tool alias: "${name}" resolved to "${def.name}"`);
  }
  try {
    const output = await def.run(args);
    return { ok: true, output, tool: def.name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `${def.name} failed: ${message}`, tool: def.name };
  }
}

/* ===========================================================================
 * Tool loop — ported from src/lib/toolLoop.ts (shape, not code).
 *
 * Two mem20 designs, via the UI:
 *  • mem20crewz `ToolLoop`: propose one action at a time, tool results feed
 *    back as observations, errors become observations and never crash the
 *    loop. Bounded by maxIterations and by the dispatch deadline.
 *  • mem20agentz strict-JSON action contract: the model replies with ONLY
 *    a JSON object, {"action":"tool",...} or {"action":"final",...}.
 * ========================================================================= */

/** The contract text sent to the model. Two shapes only. */
export const TOOL_ACTION_CONTRACT = [
  'You may use tools. Decide the NEXT action.',
  'Reply ONLY with a JSON object, one of two shapes:',
  '  {"action": "tool",   "tool": "<name>", "args": "<string argument>"}',
  '  {"action": "final",  "final": "<your reply to the user>"}',
  'Choose "final" when you can answer, even partially. Never invent tools: only the tools in the inventory below may be referenced. Use the exact tool name from the inventory — do not shorten or invent names ("wiki" is not a tool; "wikipedia" is). A "final" message should be written as a direct reply to the user.',
].join('\n');

/**
 * Port of mem20agentz `_parse_action`: regex-extract the first {...},
 * JSON-parse it, and fall back to treating the raw text as the final
 * answer. Prose is never an error and a JSON blob is never shown to the
 * user — the fallback IS the final answer.
 *
 * One live failure (Nov 26, 2026): the model emitted a TRUNCATED JSON
 * action blob — `{"action":"final","final":"# Test Plan…` with no
 * closing brace at all — so the regex found no {...} and the raw blob
 * was shown to the user verbatim. The lenient salvage below pulls the
 * "final" text out of a truncated or malformed blob instead.
 */
export function parseAction(raw) {
  const text = raw.trim();
  const match = /\{.*\}/s.exec(text);
  let obj = null;
  if (match) {
    try {
      obj = JSON.parse(match[0]);
    } catch {
      obj = null;
    }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const action = String(obj.action ?? 'final').toLowerCase();
    if (action === 'tool') {
      const tool = obj.tool;
      if (typeof tool === 'string' && tool.trim()) {
        return { action: 'tool', tool: tool.trim(), args: String(obj.args ?? '') };
      }
    }
    if (action === 'final') {
      return { action: 'final', final: String(obj.final ?? '').trim() };
    }
  }
  const salvaged = salvageFinalText(text);
  if (salvaged) return { action: 'final', final: salvaged };
  return { action: 'final', final: text };
}

/**
 * Pull the "final" text out of a truncated or malformed JSON action
 * blob (`{"action":"final","final":"...` with no closing brace, or a
 * blob whose JSON does not parse). Unescapes the JSON string escapes
 * the model did emit. Returns null when there is no "final" field to
 * salvage — plain prose is left alone.
 */
export function salvageFinalText(text) {
  const m = /"final"\s*:\s*"([\s\S]*)$/.exec(text);
  if (!m) return null;
  let s = m[1];
  // Drop a trailing close quote / brace left by the truncation.
  s = s.replace(/"\s*\}?\s*$/, '');
  s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const out = s.trim();
  return out || null;
}

/**
 * System prompt for a tool-using agent, assembled as labeled blocks in the
 * shape of mem20crewz `TaskContext.prompt()`: identity, tools, and the
 * action contract. The runner's agent object is minimal (id, name, model,
 * systemPrompt) — role/skills are included only when present.
 */
export function buildToolSystemPrompt(agent) {
  const blocks = [];
  const identity = [`- name: ${agent?.name ?? 'Atlas'}`];
  if (agent?.origin?.role) identity.push(`- role: ${agent.origin.role}`);
  if (agent?.systemPrompt?.trim()) identity.push(`- instructions: ${agent.systemPrompt.trim()}`);
  blocks.push(`## Agent identity\n${identity.join('\n')}`);
  if (Array.isArray(agent?.skills) && agent.skills.length) {
    const top = agent.skills
      .slice()
      .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
      .slice(0, 6)
      .map((s) => s.label ?? s.key)
      .filter(Boolean);
    if (top.length) blocks.push(`## Skills\n${top.join(', ')}`);
  }
  blocks.push(`## Tools you may call\n${inventoryText()}`);
  blocks.push(`## How to use tools\n${TOOL_ACTION_CONTRACT}`);
  return blocks.join('\n\n');
}

/**
 * Run the propose → execute → observe loop.
 *
 * `propose(observations, priorActions)` is one LLM call; it must throw on
 * transport failure. `deadline` is the absolute timestamp the reply must
 * be ready by (the runner aborts at 330s; the deadline is 320s). Before
 * each propose the loop checks there is enough time left for a useful
 * call — on the anonymous tier the second call only gets the ~7s after
 * the 50s gap, so a slow propose is cut short rather than overrunning
 * the runner. If the loop ends without a final (limit reached, deadline
 * reached, or a propose failed after a tool succeeded), the last
 * successful tool observation IS the reply — the tool result always
 * reaches the caller, never an error and never a claim that tools are
 * unavailable.
 */
export async function runToolLoop(propose, opts = {}) {
  const maxIterations = opts.maxIterations ?? MAX_TOOL_ITERATIONS;
  const deadline = opts.deadline ?? Date.now() + DISPATCH_DEADLINE_MS;
  const observations = [];
  const priorActions = [];
  const steps = [];
  let final = '';
  let lastToolObservation = '';

  for (let i = 1; i <= maxIterations; i++) {
    // Enough time left for a useful propose call plus flushing the reply?
    // 9s reserve: a short model reply is typically 2–8s.
    if (Date.now() > deadline - 9000) {
      log(`tool loop: deadline near at iteration ${i}, stopping with ${steps.length} step(s)`);
      break;
    }

    let raw;
    try {
      raw = await propose(observations, priorActions);
    } catch (err) {
      // A failed propose on the first turn is a real transport error — let
      // the caller surface it as a failed reply. Later failures become
      // observations so the model can recover; if the deadline is near
      // the loop stops and the tool observation is the reply.
      if (i === 1) throw err;
      const message = err instanceof Error ? err.message : String(err);
      observations.push(`[brain error] ${message}`);
      steps.push({ index: i, action: 'unknown', output: `[brain error] ${message}`, ok: false });
      log(`tool loop: propose failed at iteration ${i}: ${message}`);
      if (Date.now() > deadline - 9000) break;
      continue;
    }

    priorActions.push(raw);
    const action = parseAction(raw);

    if (action.action === 'final') {
      final = action.final || lastToolObservation || (observations.length ? observations[observations.length - 1] : '');
      steps.push({ index: i, action: 'final', output: final, ok: true });
      break;
    }

    // action === 'tool'
    const result = await executeTool(action.tool, action.args);
    const observation = `[tool ${action.tool}] ${result.output.slice(0, 1200)}`;
    observations.push(observation);
    if (result.ok) lastToolObservation = observation;
    steps.push({ index: i, action: 'tool', tool: action.tool, output: result.output, ok: result.ok });
    log(
      `tool loop: iteration ${i} tool=${action.tool} args="${String(action.args).slice(0, 80)}" ok=${result.ok} out="${result.output.slice(0, 160).replace(/\n/g, ' ')}"`,
    );
  }

  if (!final) {
    final = lastToolObservation
      ? `[reached the tool limit] ${lastToolObservation}`
      : observations.length
        ? `[reached the tool limit] ${observations[observations.length - 1]}`
        : 'I could not produce an answer in the time available.';
  }

  return { text: final, iterations: steps.length, steps, observations };
}

/* ===========================================================================
 * Pollinations client — serialised upstream calls, anonymous-tier gap,
 * retries inside the dispatch deadline.
 * ========================================================================= */

/** Serialise upstream calls + enforce the anonymous-tier gap (0 when keyed). */
const upstreamStarts = new Map();
const upstreamQueues = new Map();

function providerGapMs(providerId) {
  if (providerId === 'pollinations') return MIN_GAP_MS;
  if (providerId === 'ovh') return 30_000; // OVH anonymous lane: 2 req/min per IP.
  return 5000; // Other providers: a small courtesy gap, not a limit we know.
}

function callWithSpacing(providerId, fn) {
  const prev = upstreamQueues.get(providerId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const gap = providerGapMs(providerId);
    const last = upstreamStarts.get(providerId) ?? 0;
    const wait = gap - (Date.now() - last);
    if (wait > 0) {
      log(`spacing (${providerId}): waiting ${Math.ceil(wait / 1000)}s for rate window`);
      await sleep(wait);
    }
    upstreamStarts.set(providerId, Date.now());
    return fn();
  });
  // Keep the chain alive even if this call fails.
  upstreamQueues.set(providerId, run.catch(() => undefined));
  return run;
}

function parseRetryAfterSeconds(res, bodyText) {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header;
  const m = /retry after (\d+)s/i.exec(bodyText ?? '');
  if (m) return Number(m[1]);
  return 30;
}

/**
 * Pull the model's reply out of a chat-completions payload.
 *
 * GPT-OSS (openai-fast) also emits NATIVE tool calls: when the system
 * prompt describes tools, the model may answer with
 * message.tool_calls (finish_reason "tool_calls") and an EMPTY content
 * string — it does this even though no `tools` array was sent in the
 * request. A content-only reader reports "empty reply" and the loop
 * never runs, which is exactly the failure this endpoint first hit.
 * Convert the first native tool call into the same strict-JSON action
 * text the loop already parses, so both shapes feed the same loop.
 * The model's `reasoning` field is deliberately NOT used as a reply:
 * it holds chain-of-thought ("We need to use calculator."), not an
 * answer, and surfacing it would read as a claim instead of a result.
 */
export function extractReplyText(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') return '';
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (calls.length > 0) {
    const fn = calls[0]?.function ?? {};
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (name) {
      return JSON.stringify({ action: 'tool', tool: name, args: extractToolArgs(fn.arguments) });
    }
  }
  const content = message.content;
  if (typeof content === 'string' && content.trim()) return content;
  return '';
}

/**
 * A native tool call's arguments are a JSON string whose keys the model
 * invents ({"expression": "17 * 23"}, {"query": "..."}). Pull out the
 * one string the tool needs: a known key first, else the first string
 * value, else the raw JSON.
 */
export function extractToolArgs(argsRaw) {
  if (typeof argsRaw !== 'string' || !argsRaw.trim()) return '';
  try {
    const parsed = JSON.parse(argsRaw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of [
        'expression',
        'args',
        'arg',
        'query',
        'term',
        'place',
        'location',
        'input',
        'text',
        'question',
        'search',
      ]) {
        if (typeof parsed[key] === 'string' && parsed[key].trim()) return parsed[key];
      }
      for (const value of Object.values(parsed)) {
        if (typeof value === 'string' && value.trim()) return value;
      }
      return JSON.stringify(parsed);
    }
    return argsRaw;
  } catch {
    return argsRaw;
  }
}

/**
 * The same three tools as OpenAI function definitions, sent with every
 * chat-completions request. GPT-OSS uses native tool_calls whenever it
 * feels like it (it did so on the very first live test, with no `tools`
 * array sent at all) — and with no definitions to constrain it, it
 * invents names ("wiki"). Sending the definitions pins native calls to
 * the exact names, and the arguments arrive under the parameter names
 * below, which extractToolArgs already reads. The strict-JSON text
 * contract stays as the fallback: the model sometimes answers in prose
 * with a JSON blob instead, and the loop parses that the same way.
 */
const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'wikipedia',
      description: 'Look up a topic on Wikipedia and return a short summary.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The topic to look up, e.g. "Ada Lovelace"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'weather',
      description: 'Current weather and a 3-day outlook for any place on Earth.',
      parameters: {
        type: 'object',
        properties: {
          place: { type: 'string', description: 'A place name, e.g. "Denver"' },
        },
        required: ['place'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Evaluate a math expression (no network, runs locally).',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'A math expression, e.g. "2 + 3 * 4"' },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web (Bing first, DuckDuckGo fallback) and return real result titles and links.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A search query, e.g. "keyless free LLM API no api key"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_automation',
      description:
        'Create a new scheduled prompt automation in the runner. Args is a JSON object with name, schedule (cron), agentId, channelId "conv-build-room", target (the prompt). Refused when it would spend, publish, release, or delete.',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'The JSON object for the automation' },
        },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_provider',
      description:
        'Add a new LLM provider to the registry (validated with a live test call first; keyless providers pass keyless true, keyed providers pass keyEnv naming the env var holding the key). Args is a JSON object with id, name, baseUrl, model, and keyless true or keyEnv.',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'The JSON object for the provider' },
        },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reassign_agent',
      description:
        'Change one agent\'s LLM assignment (provider + model) in the runner state, LLM fields only, to a validated provider (keyless, or keyed with its key configured). Args is a JSON object with agentId, provider, reason.',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'The JSON object for the reassignment' },
        },
        required: ['args'],
      },
    },
  },
];

/**
 * One chat-completions call. `deadline` is the absolute timestamp the
 * reply must be ready by; retries only happen when the wait still fits
 * inside it, and the per-call timeout is the time left to it (capped at
 * UPSTREAM_TIMEOUT_MS). Throws on failure — the loop decides what that
 * means (first turn: real failure; later: observation + fallback).
 */
async function callPollinations(openAiMessages, deadline) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 2000) throw new Error('no time left in dispatch budget');
    const timeoutMs = Math.min(UPSTREAM_TIMEOUT_MS, remaining);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (KEYED) headers.Authorization = `Bearer ${POLLINATIONS_API_KEY}`;
      // The anonymous tier counts EVERY request against its per-IP
      // window, retries included. Move the spacing marker to each
      // attempt, not just the first: the next propose call must wait
      // 50s from the last actual request, or it eats a 402. (The
      // weather test proved this: a retry at the end of call 1 left
      // call 2 only ~11s after the last request, and it 402'd.)
      upstreamStarts.set('pollinations', Date.now());
      const res = await fetch(POLLINATIONS_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: MODEL, messages: openAiMessages, tools: OPENAI_TOOLS, stream: false }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.ok) {
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error('Pollinations returned non-JSON on success');
        }
        const reply = extractReplyText(payload);
        if (reply) return reply;
        throw new Error('Pollinations returned an empty reply');
      }
      lastError = new Error(`Pollinations ${res.status}: ${text.slice(0, 240)}`);
      log(`pollinations attempt ${attempt} failed: ${lastError.message}`);
      if ((res.status === 402 || res.status === 429) && attempt < 3) {
        const waitMs = Math.min(parseRetryAfterSeconds(res, text) * 1000, 25_000);
        if (Date.now() + waitMs < deadline - 2000) {
          log(`rate-limited, retrying in ${Math.ceil(waitMs / 1000)}s`);
          await sleep(waitMs);
          continue;
        }
        log('rate-limited and not enough budget left to retry');
      }
      throw lastError;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('Pollinations did not respond in the time left');
      }
      if (err === lastError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      // Network error: one quick retry if budget allows. startedAt is
      // reconstructed from the deadline (deadline = startedAt + budget).
      const elapsed = Date.now() - (deadline - DISPATCH_DEADLINE_MS);
      if (attempt < 3 && elapsed < DISPATCH_DEADLINE_MS - 15_000) {
        log(`network error, retrying: ${lastError.message}`);
        await sleep(2000);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('Pollinations request failed');
}

/**
 * One chat-completions call to a non-Pollinations provider from the
 * registry (OpenAI-compatible). Same shape as callPollinations minus the
 * Pollinations-specific retry logic: a 402/429 throws with the status in
 * the message so the /chat handler records a rate-limit event honestly
 * instead of inventing a reply. A keyed provider (keyEnv set) sends its
 * key as a Bearer token, read from the named env var at call time — the
 * key is never logged. A keyed provider whose env var is unset throws
 * naming the provider and the missing env var.
 */
async function callGenericProvider(provider, openAiMessages, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 2000) throw new Error('no time left in dispatch budget');
  const timeoutMs = Math.min(UPSTREAM_TIMEOUT_MS, remaining);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    upstreamStarts.set(provider.id, Date.now());
    const headers = { 'Content-Type': 'application/json' };
    if (provider.keyEnv) {
      const key = (process.env[provider.keyEnv] ?? '').trim();
      if (!key) throw new Error(`provider "${provider.id}" needs API key in env var "${provider.keyEnv}" — not set`);
      headers.Authorization = `Bearer ${key}`;
    }
    const res = await fetch(provider.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: provider.model, messages: openAiMessages, tools: OPENAI_TOOLS, stream: false }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.ok) {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`${provider.id} returned non-JSON on success`);
      }
      const reply = extractReplyText(payload);
      if (reply) return reply;
      throw new Error(`${provider.id} returned an empty reply`);
    }
    throw new Error(`${provider.id} ${res.status}: ${text.slice(0, 240)}`);
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`${provider.id} did not respond in the time left`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Route one upstream call by the agent's assigned provider (from the
 * registry; 'pollinations' when unassigned). Pollinations keeps its own
 * client above; every other provider goes through the generic
 * OpenAI-compatible client. Per-provider spacing is enforced by
 * callWithSpacing, so one provider's limit never throttles another.
 */
async function callUpstream(providerId, openAiMessages, deadline) {
  const registry = loadRegistry();
  const provider = registry.providers.find((p) => p.id === providerId) ??
    registry.providers.find((p) => p.id === 'pollinations');
  if (!provider) throw new Error(`no provider available (asked for "${providerId}")`);
  if (provider.id === 'pollinations') {
    return callWithSpacing('pollinations', () => callPollinations(openAiMessages, deadline));
  }
  return callWithSpacing(provider.id, () => callGenericProvider(provider, openAiMessages, deadline));
}

function toOpenAiMessages(agent, messages) {
  const system =
    agent?.systemPrompt?.trim() ||
    `You are ${agent?.name ?? 'Atlas'}, a helpful AI agent.`;
  const out = [{ role: 'system', content: system }];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (typeof m?.content !== 'string' || !m.content.trim()) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content =
      m.authorName && role === 'user' ? `[${m.authorName}]: ${m.content}` : m.content;
    out.push({ role, content });
  }
  return out;
}

/**
 * Read-only summary of the headless runner's state.
 *
 * The runner keeps its jobs in /var/lib/teamz-runner/state.json; the
 * Teamz UI's in-tab runner cannot see them, so /runner-state exposes
 * the jobs (and only the jobs) to the UI. Curated, never invented:
 * every field below comes straight from state.json. No writes.
 */
function readRunnerState() {
  const raw = readFileSync(RUNNER_STATE_PATH, 'utf-8');
  const state = JSON.parse(raw);
  const pickJob = (j) => ({
    id: j?.id ?? '',
    name: j?.name ?? '',
    description: j?.description ?? '',
    schedule: j?.schedule ?? { kind: 'manual' },
    enabled: j?.enabled === true,
    status: j?.status ?? '',
    currentStageIndex: Number.isFinite(j?.currentStageIndex) ? j.currentStageIndex : 0,
    stages: Array.isArray(j?.stages)
      ? j.stages.map((s) => ({
          stage: s?.stage ?? '',
          agentId: s?.agentId ?? '',
          humanInput: s?.humanInput === true,
        }))
      : [],
    runs: Array.isArray(j?.runs)
      ? j.runs.slice(-10).map((r) => ({
          id: r?.id ?? '',
          stage: r?.stage ?? '',
          status: r?.status ?? '',
          startedAt: r?.startedAt ?? null,
          output: typeof r?.output === 'string' ? r.output.slice(0, 500) : '',
        }))
      : [],
    lastRunAt: j?.lastRunAt ?? null,
    workdir: j?.workdir ?? '',
    channelId: j?.channelId ?? '',
  });
  return {
    jobs: Array.isArray(state?.jobs) ? state.jobs.map(pickJob) : [],
    triggers: Array.isArray(state?.triggers) ? state.triggers : [],
    cronJobs: Array.isArray(state?.cronJobs) ? state.cronJobs : [],
    approvals: Array.isArray(state?.approvals) ? state.approvals : [],
    agents: Array.isArray(state?.agents)
      ? state.agents.map((a) => ({
          id: a?.id ?? '',
          name: a?.name ?? '',
          model: a?.model ?? '',
          provider: a?.provider ?? 'pollinations',
          endpointUrl: a?.endpointUrl ?? '',
        }))
      : [],
    channelMessages: Array.isArray(state?.channelMessages)
      ? state.channelMessages.slice(-20).map((m) => ({
          id: m?.id ?? '',
          channelId: m?.channelId ?? '',
          agentId: m?.agentId ?? '',
          agentName: m?.agentName ?? '',
          kind: m?.kind ?? '',
          text: typeof m?.text === 'string' ? m.text.slice(0, 2000) : '',
          ts: m?.ts ?? null,
        }))
      : [],
    rateLimitRescues: Array.isArray(state?.rateLimitRescues) ? state.rateLimitRescues.slice(-20) : [],
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/* --- POST /automations: the Orchestrator's governed job-creation path.
 * Localhost-only (the runner and the agent tools on this host). Validates
 * the proposal the same way runner-lib's validateAutomationProposal does
 * — same rules, kept in sync — then appends the cron job to state.json
 * with an atomic write. Refusals return 403 with the reason; carve-outs
 * (spend / publish / release / delete) are refused, never auto-approved,
 * and the response says to route them to the Reviewer. ----------------------- */

const AUTOMATION_CARVE_OUT =
  /\b(spend|spending|pay|payment|purchase|buy|charge|publish|public|release|deploy|delete|destroy|remove|wipe|drop)\b/i;

function isValidCronField(field, lo, hi) {
  if (typeof field !== 'string' || !field.trim()) return false;
  for (const token of field.split(',')) {
    const t = token.trim();
    if (!t) return false;
    const slash = t.indexOf('/');
    let base = t;
    if (slash !== -1) {
      const step = Number(t.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) return false;
      base = t.slice(0, slash);
    }
    if (base === '*') continue;
    if (base.includes('-')) {
      const [a, b] = base.split('-', 2).map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) return false;
    } else {
      const v = Number(base);
      if (!Number.isInteger(v) || v < lo || v > hi) return false;
    }
  }
  return true;
}

function isValidCronExpr(expr) {
  if (typeof expr !== 'string') return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return parts.every((p, i) => isValidCronField(p, ranges[i][0], ranges[i][1]));
}

function validateAutomation(input, state) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) return { ok: false, reason: 'an automation needs a name', carveOut: false };
  if (!isValidCronExpr(input?.schedule)) {
    return { ok: false, reason: `invalid cron schedule: ${JSON.stringify(input?.schedule)}`, carveOut: false };
  }
  if (!Array.isArray(state.agents) || !state.agents.some((a) => a.id === input.agentId)) {
    return { ok: false, reason: `unknown agent ${input?.agentId}`, carveOut: false };
  }
  if (input.channelId !== 'conv-build-room') {
    return { ok: false, reason: 'automations run only in conv-build-room', carveOut: false };
  }
  const target = typeof input?.target === 'string' ? input.target.trim() : '';
  if (!target) return { ok: false, reason: 'an automation needs a target prompt', carveOut: false };
  if (target.length > 2000) {
    return { ok: false, reason: 'target prompt is too long (max 2000 chars)', carveOut: false };
  }
  if (AUTOMATION_CARVE_OUT.test(`${name} ${target}`)) {
    return {
      ok: false,
      reason: 'refused: the proposal spends money, publishes publicly, releases, or deletes — that needs the Reviewer, not an automation',
      carveOut: true,
    };
  }
  return { ok: true };
}

function isLocalhost(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'teamz-agent',
        upstream: KEYED ? 'pollinations keyed (gen.pollinations.ai)' : 'pollinations anonymous (openai-fast)',
        model: MODEL,
        providers: loadRegistry().providers.map((p) => ({
          id: p.id,
          name: p.name,
          model: p.model,
          keyless: p.keyless,
          keyEnv: p.keyEnv ?? null,
          validatedAt: p.validatedAt,
          lastValidated: p.lastValidated,
        })),
        tools: TOOL_NAMES,
        maxToolIterations: MAX_TOOL_ITERATIONS,
        anonymousTierNote: KEYED
          ? 'keyed: no per-IP spacing, full tool loop available'
          : 'anonymous: 50s gap between upstream calls, at most 1 tool iteration per dispatch',
        time: new Date().toISOString(),
      }),
    );
    return;
  }
  if (req.method === 'POST' && url.pathname === '/automations') {
    if (!isLocalhost(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'automations may only be created from localhost' }));
      return;
    }
    try {
      const raw = await readBody(req);
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
        return;
      }
      let state;
      try {
        state = loadRunnerStateJson();
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `cannot read runner state: ${err instanceof Error ? err.message : String(err)}` }));
        return;
      }
      const check = validateAutomation(input, state);
      if (!check.ok) {
        log(`automations: refused — ${check.reason}`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: check.reason, carveOut: check.carveOut, routeTo: check.carveOut ? 'reviewer' : 'fix-and-retry' }));
        return;
      }
      const job = {
        id: `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: input.name.trim(),
        schedule: input.schedule.trim().replace(/\s+/g, ' '),
        type: 'prompt',
        target: input.target.trim(),
        enabled: true,
        agentId: input.agentId,
        channelId: input.channelId,
        lastRunAt: null,
        runs: [],
      };
      state.cronJobs = [...(state.cronJobs ?? []), job];
      saveRunnerStateJson(state);
      log(`automations: created ${job.id} "${job.name}" (${job.schedule}, agent ${job.agentId})`);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`automations FAILED: ${message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }
  if (req.method === 'OPTIONS' && url.pathname === '/runner-state') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/runner-state') {
    try {
      const runner = readRunnerState();
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'teamz-agent',
          runner,
          time: new Date().toISOString(),
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`runner-state FAILED: ${message}`);
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: `could not read runner state: ${message}` }));
    }
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/chat') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found; POST /chat' }));
    return;
  }
  const startedAt = Date.now();
  const deadline = startedAt + DISPATCH_DEADLINE_MS;
  // Retained across the try/catch so a rate-limited failure can record
  // the original request for the runner's rescue resend.
  let agent = {};
  let channelId = '?';
  let retainedPrompt = '';
  let providerId = 'pollinations';
  try {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }
    agent = body?.agent ?? {};
    channelId = body?.channel?.id ?? '?';
    providerId = typeof agent?.provider === 'string' && agent.provider ? agent.provider : 'pollinations';
    retainedPrompt = (body?.messages ?? []).map((m) => m?.content ?? '').join('\n').slice(0, 4000);
    const prompt = retainedPrompt.slice(0, 120);
    log(`POST /chat agent=${agent?.name ?? '?'} provider=${providerId} channel=${channelId} prompt="${prompt}"`);
    const baseMessages = toOpenAiMessages(agent, body?.messages);
    if (baseMessages.length < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no user message in request' }));
      return;
    }
    const toolSystemPrompt = buildToolSystemPrompt(agent);

    // One propose call = one upstream LLM call. The loop transcript
    // (earlier JSON actions as assistant turns, tool observations as
    // user turns) is rebuilt on top of the original conversation.
    // Routed by the agent's assigned provider (callUpstream), not
    // hardcoded to Pollinations.
    const propose = async (observations, priorActions) => {
      const msgs = [{ role: 'system', content: toolSystemPrompt }];
      for (const m of baseMessages.slice(1)) msgs.push(m);
      for (let i = 0; i < priorActions.length; i++) {
        msgs.push({ role: 'assistant', content: priorActions[i] });
        if (i < observations.length) msgs.push({ role: 'user', content: observations[i] });
      }
      return callUpstream(providerId, msgs, deadline);
    };

    const result = await runToolLoop(propose, { maxIterations: MAX_TOOL_ITERATIONS, deadline });
    const ms = Date.now() - startedAt;
    const toolSteps = result.steps.filter((s) => s.action === 'tool').map((s) => s.tool).join(',') || 'none';
    log(`reply ok agent=${agent?.name ?? '?'} chars=${result.text.length} iterations=${result.iterations} tools=${toolSteps} ms=${ms}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reply: result.text }));
  } catch (err) {
    const ms = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    log(`reply FAILED ms=${ms}: ${message}`);
    const rateLimited = /402|429|rate|limit|FREE_LIMIT/i.test(message);
    if (rateLimited && retainedPrompt) {
      // Record the event with the failed request retained, so the
      // runner's tick can wake the Provider Researcher and resend it.
      // Only claim it was recorded when the append actually succeeded.
      const recorded = recordRateLimitEvent({
        id: `rl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        agentId: agent?.id ?? '',
        agentName: agent?.name ?? '?',
        channelId,
        prompt: retainedPrompt,
        provider: providerId,
        error: message.slice(0, 500),
      });
      if (recorded) {
        log(`rate-limit event recorded for agent=${agent?.name ?? '?'} provider=${providerId}`);
      }
    }
    res.writeHead(rateLimited ? 429 : 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
});

// Only listen when run directly (`node agent.mjs`). Importing the module
// (for tests) does not start the server.
const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, HOST, () => {
    log(
      `teamz-agent listening on http://${HOST}:${PORT} (upstream: Pollinations ${KEYED ? 'keyed' : 'anonymous'}, model ${MODEL}, tools: ${TOOL_NAMES.join(', ')})`,
    );
  });
}

export { server };
