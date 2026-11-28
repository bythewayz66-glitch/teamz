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
 *   GET  /usage         -> today's token totals (prompt/completion/
 *                           total, calls) overall and by provider and
 *                           by agent, from /var/lib/teamz-agent/
 *                           usage-daily.json. Read-only, CORS enabled.
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
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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
// Daily token-usage aggregate (see the usage-tracking section): one
// JSON object keyed by UTC date, written atomically, best-effort only.
const USAGE_FILE_PATH =
  process.env.USAGE_FILE_PATH ?? '/var/lib/teamz-agent/usage-daily.json';
// The mem20 checkout the runner works on, and the patch staging area.
// repo_read reads files under MEM20_ROOT; stage_patch writes patch JSON
// (never repo files) under PATCH_DIR. The privileged push script
// (root, via sudo) is the only thing that applies a patch to the repo.
const MEM20_ROOT = resolve(process.env.MEM20_ROOT ?? '/opt/mem20');
const PATCH_DIR = process.env.PATCH_DIR ?? '/var/lib/teamz-runner/patches';
// The mem20 toolchest bridge (toolchest.py): the only way Teamz agents
// reach the mem20 tool catalog (527 tools). It spawns the mem20 MCP
// server over stdio on this host. TOOLCHEST_PYTHON is the venv python
// that has the `mcp` package.
const TOOLCHEST_BRIDGE = process.env.TOOLCHEST_BRIDGE ?? '/opt/teamz-agent/toolchest.py';
const TOOLCHEST_PYTHON = process.env.TOOLCHEST_PYTHON ?? '/root/.venv/bin/python';
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
 * Read the Build Room (conv-build-room) from the runner state: the items
 * needing assignment, the recent deliveries, and the agents available.
 * This is the Orchestrator's triage tool — it had no way to see the room
 * (its replies said so for 35 straight runs), so it could never @mention
 * a real agent. The output is kept compact (under ~1050 chars) because
 * tool observations are truncated at 1200 chars in the loop.
 *
 * Args JSON (all optional): {"what": "unassigned" | "room" | "agents",
 * "role": "<keyword to match agent names>"}.
 * - "unassigned" (default): triage items (denied work to reassign),
 *   gate items (assignments that did not reach the room), and the most
 *   recent room messages — the work that needs assigning.
 * - "room": the most recent Build Room messages.
 * - "agents": agents matching `role` (name/id substring,
 *   case-insensitive), one line each: Name (@agent-id) [provider].
 *   Without a role, a provider breakdown and a hint to pass a role.
 */
export function runRoomRead(args) {
  let input = {};
  if (typeof args === 'string' && args.trim()) {
    try {
      input = JSON.parse(args);
    } catch {
      throw new Error('room_read needs a JSON object like {"what": "unassigned"} or {"what": "agents", "role": "backend"}');
    }
  }
  let state;
  try {
    state = loadRunnerStateJson();
  } catch (err) {
    throw new Error(`room_read: cannot read runner state — ${err instanceof Error ? err.message : String(err)}`);
  }
  const what = typeof input.what === 'string' ? input.what : 'unassigned';
  const role = typeof input.role === 'string' ? input.role.trim().toLowerCase() : '';
  const messages = Array.isArray(state.channelMessages) ? state.channelMessages : [];
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const excerpt = (text, n = 140) => {
    const line = oneLine(text);
    return line.length > n ? `${line.slice(0, n)}…` : line;
  };
  const roomMessages = messages.filter((m) => m.channelId === 'conv-build-room');
  if (what === 'agents') {
    if (!role) {
      const counts = {};
      for (const a of agents) counts[a.provider ?? 'none'] = (counts[a.provider ?? 'none'] ?? 0) + 1;
      const breakdown = Object.entries(counts)
        .sort((x, y) => y[1] - x[1])
        .map(([p, n]) => `${p} ${n}`)
        .join(', ');
      return `${agents.length} agents: ${breakdown}. Pass a role keyword, e.g. {"what":"agents","role":"backend"}, to list matching agents with their @handles.`;
    }
    const matched = agents.filter((a) => `${a.name ?? ''} ${a.id ?? ''}`.toLowerCase().includes(role));
    if (matched.length === 0) {
      return `no agents match role ${JSON.stringify(input.role)} — try another keyword, e.g. "backend", "qa", "writer".`;
    }
    const lines = matched
      .slice(0, 12)
      .map((a) => `${a.name} (@${a.id}) [${a.provider ?? 'default'}]`);
    return `${matched.length} agent(s) matching ${JSON.stringify(input.role)}:\n${lines.join('\n')}${matched.length > 12 ? `\n…${matched.length - 12} more` : ''}`;
  }
  if (what === 'room') {
    const recent = roomMessages.slice(-8);
    if (recent.length === 0) return 'The Build Room is empty — no messages recorded yet.';
    return recent.map((m) => `[${m.kind}] ${m.agentName}: ${excerpt(m.text, 130)}`).join('\n');
  }
  // Default: "unassigned" — the work that needs assigning, most urgent
  // first. Lines are added only while the total stays compact.
  const lines = [];
  let total = 0;
  const add = (line) => {
    if (total + line.length + 1 > 1050) return;
    lines.push(line);
    total += line.length + 1;
  };
  for (const m of roomMessages.filter((m) => m.kind === 'triage').slice(-4)) {
    add(`TRIAGE (needs reassigning): ${excerpt(m.text, 160)}`);
  }
  for (const m of roomMessages.filter((m) => m.kind === 'gate').slice(-3)) {
    add(`GATE (did not reach the room): ${excerpt(m.text, 160)}`);
  }
  for (const m of roomMessages.slice(-5)) {
    add(`[${m.kind}] ${m.agentName}: ${excerpt(m.text, 120)}`);
  }
  if (lines.length === 0) return 'No unassigned work in the Build Room right now — nothing to assign.';
  return lines.join('\n');
}

/* --- mem20 toolchest gateway (Jesse, Nov 28, 2026) ---------------------- */
/*
 * The agents only had wikipedia/weather/calculator — three tools each,
 * the same three for everyone — while mem20 has a 527-tool catalog (the
 * toolchest) the agents could not reach: the mem20 MCP was never
 * connected to Teamz. The gateway is two tools backed by
 * /opt/teamz-agent/toolchest.py, a Python bridge that spawns the mem20
 * MCP server over stdio and speaks JSON-RPC via the MCP SDK:
 *   • toolchest_search — search the catalog by keyword and/or domain.
 *   • toolchest_call   — invoke one mem20 tool by name with JSON args.
 * The bridge caches the catalog (1h TTL) so a search is fast after the
 * first call; a call always spawns the server (up to ~40s startup).
 * Destructive actions are refused on both sides of the bridge (the
 * endpoint checks first, the bridge re-checks): delete/remove/destroy/
 * spend/publish/release/sell/charge/refund, plus named external-publish
 * tools (social post, outbound messages, direct git commits/PRs).
 * Tool observations are truncated at 1200 chars in the loop, so search
 * results are kept to one short line per tool (10 max).
 */

const TOOLCHEST_DESTRUCTIVE_WORDS = ['delete', 'remove', 'destroy', 'spend', 'publish', 'release', 'sell', 'charge', 'refund'];
const TOOLCHEST_READONLY_MARKERS = ['audit', 'status', 'doctor', 'list', 'get', 'read', 'search', 'verify', 'check'];
// Named tools that publish or send to the outside world, beyond the word
// list above: posting to social media, sending email/chat/SMS, and
// committing or opening a PR on GitHub (which would bypass the governed
// push path — repo changes go through stage_patch, never a direct commit).
const TOOLCHEST_BLOCKED_TOOLS = new Set([
  'mkt_social_post',
  'comm_send_email', 'comm_slack_message', 'comm_sms_send',
  'comm_telegram_message', 'comm_discord_message', 'comm_push_notify',
  'vcs_git_commit', 'vcs_github_pr',
]);

export function isDestructiveTool(name) {
  const low = String(name ?? '').toLowerCase();
  if (TOOLCHEST_BLOCKED_TOOLS.has(low)) return true;
  if (!TOOLCHEST_DESTRUCTIVE_WORDS.some((w) => low.includes(w))) return false;
  // A read-only tool that merely mentions a destructive word is not
  // destructive (e.g. vcs_asset_release_audit audits releases).
  return !TOOLCHEST_READONLY_MARKERS.some((m) => low.includes(m));
}

const TOOLCHEST_TIMEOUT_MS = 240_000;

function runBridge(argv, stdinText) {
  // spawn, not execFile: execFile's `input` option does not deliver stdin
  // to the child in this environment (the bridge's stdin.read() hangs
  // forever), while spawn with an explicit stdin.write + stdin.end works.
  return new Promise((resolve) => {
    const child = spawn(TOOLCHEST_PYTHON, [TOOLCHEST_BRIDGE, ...argv]);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      resolve({ code: 1, stdout, stderr: `${stderr}toolchest bridge timed out after ${TOOLCHEST_TIMEOUT_MS}ms`, timedOut: true });
    }, TOOLCHEST_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > 1024 * 1024) {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}${err instanceof Error ? err.message : String(err)}`, timedOut: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut: false });
    });
    try {
      if (stdinText) child.stdin.write(stdinText);
      child.stdin.end();
    } catch {
      // stdin already closed; the bridge reads an empty object then.
    }
  });
}

export async function runToolchestSearch(args) {
  let input;
  try {
    input = JSON.parse(args);
  } catch {
    throw new Error('toolchest_search needs a JSON object like {"query": "memory", "domain": "memory"}');
  }
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const domain = typeof input.domain === 'string' ? input.domain.trim() : '';
  if (!query && !domain) {
    throw new Error('toolchest_search needs a JSON object like {"query": "memory"} — pass a keyword, a domain, or both');
  }
  const res = await runBridge(['search', query, domain], '');
  if (res.code !== 0) {
    throw new Error(`toolchest_search failed: ${res.stderr.trim().slice(0, 400) || 'bridge exited non-zero'}`);
  }
  let payload;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    throw new Error('toolchest_search failed: the bridge returned non-JSON output');
  }
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (tools.length === 0) {
    return `No mem20 tools match ${JSON.stringify(query || domain)} (${payload.total ?? '?'} tools in the catalog). Try a different keyword or domain.`;
  }
  const lines = tools.map((t) => {
    const desc = String(t.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const argList = Array.isArray(t.args) && t.args.length ? ` [args: ${t.args.join(', ')}]` : '';
    return `- ${t.name} (${t.domain})${argList}: ${desc}`;
  });
  return `${tools.length} of ${payload.total ?? '?'} mem20 tools matching ${JSON.stringify(query || domain)}:\n${lines.join('\n')}`;
}

export async function runToolchestCall(args) {
  let input;
  try {
    input = JSON.parse(args);
  } catch {
    throw new Error('toolchest_call needs a JSON object like {"tool": "memory_status", "arguments": {}}');
  }
  const tool = typeof input.tool === 'string' ? input.tool.trim() : '';
  if (!tool) {
    throw new Error('toolchest_call needs a JSON object like {"tool": "memory_status", "arguments": {}}');
  }
  if (!/^[A-Za-z0-9_]+$/.test(tool)) {
    throw new Error(`toolchest_call refused: bad tool name ${JSON.stringify(tool)} — tool names are letters, digits, and underscores only`);
  }
  if (isDestructiveTool(tool)) {
    throw new Error(`toolchest_call refused: ${tool} is a destructive action (delete, remove, destroy, spend, publish, release, sell, charge, refund) or publishes outside mem20 — not available through the toolchest`);
  }
  const toolArgs = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments) ? input.arguments : {};
  const res = await runBridge(['call', tool], JSON.stringify(toolArgs));
  if (res.code === 2) {
    // The bridge refused it (its own destructive check).
    throw new Error(`toolchest_call refused: ${res.stderr.trim().slice(0, 400)}`);
  }
  if (res.code !== 0) {
    throw new Error(`toolchest_call failed: ${res.stderr.trim().slice(0, 400) || 'bridge exited non-zero'}`);
  }
  let payload;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    throw new Error('toolchest_call failed: the bridge returned non-JSON output');
  }
  const result = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload);
  return `${tool}:\n${result}`;
}

/**
 * Fetch a public URL and return its text — the Website Currency Agent's
 * way to read the LIVE site. It had no fetch tool: it could only read
 * the repo's docs/ copy via repo_read and guess at what the site shows,
 * so a stale or broken live page was invisible to it. HTML is stripped
 * to text; other text types come back raw. Returns at most ~8000 chars.
 *
 * SSRF guard: public http(s) only. localhost and private / loopback /
 * link-local addresses are refused, the hostname is resolved and every
 * address checked, and the check re-runs on every redirect hop (max 3
 * hops, redirects followed manually). 10s per fetch, 2 MB body cap.
 * `FETCH_URL_ALLOW_LOCAL=1` skips the address check — tests only, for a
 * local fixture server; never set on the live service.
 */
const FETCH_URL_TIMEOUT_MS = 10_000;
const FETCH_URL_MAX_CHARS = 8000;
const FETCH_URL_MAX_REDIRECTS = 3;
const FETCH_URL_MAX_BYTES = 2_000_000;

function isPrivateIp(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    return false;
  }
  return true; // not an IP at all — treat as unsafe
}

async function assertPublicUrl(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`fetch_url refused: only http(s) URLs, got ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('fetch_url refused: localhost is not a public URL');
  }
  if (process.env.FETCH_URL_ALLOW_LOCAL === '1') return; // tests only
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`fetch_url refused: ${host} is not a public address`);
    return;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(`fetch_url refused: cannot resolve ${host}`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error(`fetch_url refused: ${host} resolves to a non-public address`);
  }
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function runFetchUrl(args) {
  let input;
  try {
    input = JSON.parse(args);
  } catch {
    throw new Error('fetch_url needs a JSON object like {"url": "https://mem20.com/"}');
  }
  const raw = typeof input.url === 'string' ? input.url.trim() : '';
  if (!raw) throw new Error('fetch_url needs a JSON object like {"url": "https://mem20.com/"}');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`fetch_url refused: not a URL: ${JSON.stringify(raw)}`);
  }
  let current = url;
  let res;
  for (let hop = 0; hop <= FETCH_URL_MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    try {
      res = await fetch(current, {
        headers: { 'User-Agent': 'Teamz fetch_url (mem20 agent)' },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`fetch_url: ${current} unreachable (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`fetch_url refused: redirect without a Location at ${current}`);
      if (hop === FETCH_URL_MAX_REDIRECTS) throw new Error(`fetch_url refused: redirect limit reached at ${current}`);
      current = new URL(location, current);
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`fetch_url: ${current} returned HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > FETCH_URL_MAX_BYTES) throw new Error(`fetch_url refused: ${current} is too large (${length} bytes)`);
  const body = await res.text();
  if (body.length > FETCH_URL_MAX_BYTES) throw new Error(`fetch_url refused: ${current} is too large`);
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const text = type.includes('text/html') ? htmlToText(body) : body;
  const out = text.slice(0, FETCH_URL_MAX_CHARS);
  return `${current} (HTTP ${res.status}, ${body.length} chars total):\n${out}${text.length > FETCH_URL_MAX_CHARS ? '\n…[truncated]' : ''}`;
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

/* --- Web search: Linkup first, Bing then DuckDuckGo as the fallback,
 * DDG instant answers last. Real results, never faked: Linkup returns
 * ranked sources with content snippets; the scrapers return plain HTML
 * with result links. The parser pulls the top results out and the tool
 * reports exactly what came back (or that nothing came back). This is
 * what the Provider Researcher uses to find candidate providers.
 *
 * Linkup (Jesse, Nov 26, 2026): POST https://api.linkup.so/v1/search
 * with Authorization: Bearer <LINKUP_API_KEY>, body {q, depth: "fast",
 * outputType: "searchResults", maxResults: 5}. "fast" is Linkup's
 * recommended default for agentic use (~1s, $0.005/call on the $20
 * starting credit). If the key is unset, or Linkup fails / returns
 * nothing / is out of credits (429), fall back to the scrapers —
 * never crash, never log the key.
 *
 * Honest limits, found live Nov 26, 2026:
 *  - DDG Lite uses SINGLE-quoted attributes (class='result-link');
 *    the first version of this parser only matched double quotes and
 *    returned nothing. Fixed.
 *  - DDG serves results only intermittently from this server IP: it
 *    answered once, then returned zero result links on 8 consecutive
 *    tries (Lite and HTML alike). Bing answered 17-19 results on every
 *    probe from the same IP, so Bing is the scraping primary and DDG
 *    the fallback. Bing's title links are bing.com/ck/a redirects;
 *    they still land on the destination when followed, so they are
 *    returned as-is.
 *  - No Exa key exists (EXA_API_KEY is not set), so Exa is not wired. --- */

const LINKUP_SEARCH = 'https://api.linkup.so/v1/search';

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

function parseLinkup(data) {
  // Linkup searchResults: { results: [{ name, url, content, type }] }.
  // Text results carry a content snippet; image results have no content
  // and are skipped. Keep at most 5, same as the scrapers.
  const results = [];
  for (const r of data?.results ?? []) {
    if (results.length >= 5) break;
    if (!r || r.type === 'image') continue;
    if (!r.url || !r.name) continue;
    if (!/^https?:\/\//.test(r.url)) continue;
    const snippet = typeof r.content === 'string' ? r.content.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    results.push({ title: r.name, href: r.url, snippet });
  }
  return results;
}

async function searchLinkup(query) {
  // Returns the parsed results, or null when Linkup is unavailable for
  // any reason (no key, HTTP error, empty results, out of credits) so
  // the caller falls through to the scrapers. Never throws, never logs
  // the key. The key is read here, not at load, so a restart picks up
  // a newly added key and tests can toggle it.
  const key = (process.env.LINKUP_API_KEY ?? '').trim();
  if (!key) return null;
  try {
    const res = await fetchWithTimeout(LINKUP_SEARCH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ q: query, depth: 'fast', outputType: 'searchResults', maxResults: 5 }),
    });
    if (!res.ok) {
      log(`web_search (linkup): HTTP ${res.status}, trying next source`);
      return null;
    }
    return parseLinkup(await res.json());
  } catch (err) {
    log(`web_search (linkup) failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function formatSearchResults(results) {
  // One numbered line per result: title, URL, and — when the source
  // provides one (Linkup) — a short content snippet. Scraped results
  // have no snippet, so they keep the old two-line shape.
  return results
    .map((r, i) => {
      const line = `${i + 1}. ${r.title}\n   ${r.href}`;
      return r.snippet ? `${line}\n   ${r.snippet}` : line;
    })
    .join('\n');
}

async function runWebSearch(args) {
  const query = args.trim();
  if (!query) throw new Error('web_search needs a query, e.g. "keyless free LLM API no api key"');
  // Linkup first (real search API, sourced results) when a key is set.
  const linkup = await searchLinkup(query);
  if (linkup && linkup.length > 0) return formatSearchResults(linkup);
  const ddgHeaders = { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) teamz-agent/1.0' };
  const bingHeaders = { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0' };
  // Bing first among the scrapers (it answers reliably from this server
  // IP), DuckDuckGo Lite and HTML as the fallback, DDG instant answers
  // last. DDG Lite is retried once: it serves results intermittently
  // from this IP and a second attempt often lands in a good phase.
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
          return formatSearchResults(results);
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
        return formatSearchResults(results);
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
    description: 'Search the web (Linkup first, Bing/DuckDuckGo fallback) and return real result titles and links.',
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
  {
    name: 'fetch_url',
    description:
      'Fetch a public URL and return its text (HTML stripped to text, ~8000 chars). ' +
      'Use it to read the LIVE site — e.g. mem20.com — instead of guessing from the repo copy. ' +
      'Public http(s) only: localhost and private addresses are refused, as are redirects to them. ' +
      'Args must be a JSON object: {"url"}.',
    usage: 'a JSON object, e.g. {"url": "https://mem20.com/"}',
    run: async (args) => runFetchUrl(args),
  },
  {
    name: 'room_read',
    description:
      'Read the Build Room (conv-build-room) from the runner state: the work that needs assigning and the agents available. ' +
      'The Orchestrator\'s triage tool — call it first on every triage run. ' +
      'Args must be a JSON object (all optional): {"what": "unassigned" (default: triage + gate items and recent messages), "room" (recent messages), "agents" (agents matching "role")}. ' +
      'For "agents", pass {"role": "<keyword>"} to list matching agents with their @handles, e.g. {"what": "agents", "role": "backend"}.',
    usage: 'a JSON object, e.g. {"what": "unassigned"} or {"what": "agents", "role": "backend"}',
    run: async (args) => runRoomRead(args),
  },
  {
    name: 'toolchest_search',
    description:
      'Search the mem20 tool catalog (527 tools) by keyword and/or domain — the gateway that gives Teamz agents the mem20 toolchest. ' +
      'Args must be a JSON object: {"query" (keyword, e.g. "memory"), "domain" (optional, e.g. "memory")}. ' +
      'Returns up to 10 matching tools with name, domain, a one-line description, and argument names.',
    usage: 'a JSON object, e.g. {"query": "memory"} or {"query": "status", "domain": "memory"}',
    run: async (args) => runToolchestSearch(args),
  },
  {
    name: 'toolchest_call',
    description:
      'Invoke one mem20 tool by name with JSON arguments, through the toolchest bridge (spawns the mem20 MCP server over stdio). ' +
      'Args must be a JSON object: {"tool" (exact mem20 tool name), "arguments" (object, may be empty)}. ' +
      'Returns the real result. Destructive actions and anything that publishes outside mem20 are refused.',
    usage: 'a JSON object, e.g. {"tool": "memory_status", "arguments": {}}',
    run: async (args) => runToolchestCall(args),
  },
];

export const TOOL_NAMES = TOOL_DEFS.map((d) => d.name);

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
  roomread: 'room_read',
  readroom: 'room_read',
  fetchurl: 'fetch_url',
  fetch: 'fetch_url',
  toolchestsearch: 'toolchest_search',
  searchtools: 'toolchest_search',
  toolchestcall: 'toolchest_call',
  calltool: 'toolchest_call',
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
        // Args are a string per the contract, but a model may emit an
        // object instead — stringify it so repo_read et al. still get
        // their JSON object instead of "[object Object]".
        const rawArgs = obj.args ?? '';
        const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
        return { action: 'tool', tool: tool.trim(), args };
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
 * the runner. If the loop ends without a final because the DEADLINE was
 * reached, the last successful tool observation IS the reply — the tool
 * result always reaches the caller, never an error and never a claim
 * that tools are unavailable. But a loop that ends because it burned
 * the whole iteration budget, or because propose hit a hard provider
 * quota wall (402/429), is KILLED, not answered: see hitIterationLimit
 * and the quota-wall throw below (Jesse, Nov 28, 2026 — fail fast, no
 * multi-hour retries jamming the dispatch slot).
 */
export async function runToolLoop(propose, opts = {}) {
  const maxIterations = opts.maxIterations ?? MAX_TOOL_ITERATIONS;
  const deadline = opts.deadline ?? Date.now() + DISPATCH_DEADLINE_MS;
  const observations = [];
  const priorActions = [];
  const steps = [];
  let final = '';
  let lastToolObservation = '';
  let stoppedForDeadline = false;

  for (let i = 1; i <= maxIterations; i++) {
    // Enough time left for a useful propose call plus flushing the reply?
    // 9s reserve: a short model reply is typically 2–8s.
    if (Date.now() > deadline - 9000) {
      log(`tool loop: deadline near at iteration ${i}, stopping with ${steps.length} step(s)`);
      stoppedForDeadline = true;
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
      // Kill-on-limit (Jesse, Nov 28, 2026): a hard provider quota wall
      // (402/429) is not recoverable inside this run — the provider is
      // exhausted, and re-proposing just burns the dispatch budget
      // against it (Nov 27: the pricing job's design runs spent ~1.5h
      // and ~3h failing on Gemini 429s). Throw at once so the /chat
      // handler records a rate-limit event — rescue moves the agent to
      // a live provider — and the run fails fast instead of retrying
      // to the deadline. Non-quota propose failures still become
      // observations below: the model may recover from those.
      if (/402|429|rate|limit|FREE_LIMIT/i.test(message)) {
        log(`tool loop: quota wall at iteration ${i} — killing the run: ${message}`);
        throw err;
      }
      observations.push(`[brain error] ${message}`);
      steps.push({ index: i, action: 'unknown', output: `[brain error] ${message}`, ok: false });
      log(`tool loop: propose failed at iteration ${i}: ${message}`);
      if (Date.now() > deadline - 9000) {
        stoppedForDeadline = true;
        break;
      }
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

  // Kill-on-limit (Jesse, Nov 28, 2026): the loop ending with no final
  // because it burned the whole iteration budget is a kill, not a
  // partial success — the caller (/chat) turns it into a failed reply
  // instead of handing the last tool observation back as an answer.
  // A deadline stop is not a limit hit: the budget, not the iteration
  // cap, ended the run. Computed here, before the fallback below
  // assigns `final` (so `!final` still means "no final was produced").
  const hitIterationLimit = !final && !stoppedForDeadline;

  if (!final) {
    final = lastToolObservation
      ? `[reached the tool limit] ${lastToolObservation}`
      : observations.length
        ? `[reached the tool limit] ${observations[observations.length - 1]}`
        : 'I could not produce an answer in the time available.';
  }

  return { text: final, iterations: steps.length, steps, observations, hitIterationLimit };
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
 * Pollinations (and some other upstreams) answer HTTP 200 with the
 * quota/credit refusal as the model's content when the keyed account
 * is out of credits — no 402 status, no usage, just the error text
 * (Nov 27, 2026: "The account behind this API key doesn't have
 * enough credits. Please top up …"). Handing that text back as the
 * agent's answer silently poisons the fleet: the runner records it
 * as completed work and Slack posts it. Detect the refusal so the
 * callers can throw it as the 402 it is, which the /chat handler
 * records as a rate-limit event for the runner's rescue.
 */
export function isUpstreamErrorReply(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const t = text.trim();
  return (
    /^the account behind this api key doesn'?t have enough credits/i.test(t) ||
    /enter\.pollinations\.ai\/top-up/i.test(t)
  );
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
      return JSON.stringify({ action: 'tool', tool: name, args: extractToolArgs(fn.arguments, name) });
    }
  }
  const content = message.content;
  if (typeof content === 'string' && content.trim()) return content;
  return '';
}

/**
 * Tools whose args are a JSON object (repo_read, stage_patch, room_read,
 * create_automation, add_provider, reassign_agent, fetch_url): their run
 * functions JSON.parse the args, so a native tool call must hand them the
 * raw arguments JSON, not a single extracted string. Everything else
 * (wikipedia, weather, calculator, web_search) takes one plain string.
 */
const OBJECT_ARG_TOOLS = new Set([
  'repo_read',
  'stage_patch',
  'room_read',
  'create_automation',
  'add_provider',
  'reassign_agent',
  'fetch_url',
]);

/**
 * A native tool call's arguments are a JSON string whose keys the model
 * invents ({"expression": "17 * 23"}, {"query": "..."}). For a
 * single-string tool, pull out the one string the tool needs: a known
 * key first, else the first string value, else the raw JSON. For an
 * object-arg tool, return the raw arguments JSON — except for the one
 * wrapping the declared schema adds: when the model follows the schema
 * and passes {"args": "<inner JSON string>"}, the inner JSON is the
 * args (see extractToolArgs; Nov 28, 2026 room_read "what" bug).
 * Reducing object args to one string breaks the tool (Nov 27, 2026:
 * nemotron's native repo_read call {"file": "comics/the-z-corps/",
 * "find": "README"} was reduced to the string "comics/the-z-corps/",
 * repo_read threw "needs a JSON object", and the Triage agent rambled
 * itself to the iteration limit instead of reassigning).
 */
export function extractToolArgs(argsRaw, toolName) {
  if (typeof argsRaw !== 'string' || !argsRaw.trim()) return '';
  if (OBJECT_ARG_TOOLS.has(toolName)) {
    // Unwrap the declared `args` parameter (Nov 28, 2026 — the
    // room_read "what" bug): the native tool schema declares ONE
    // parameter, `args` (a JSON string), so a model that follows the
    // schema calls room_read with
    //   {"args": "{\"what\":\"agents\",\"role\":\"backend\"}"}
    // and the run functions read `what` at the TOP level — so the
    // wrapped form always fell through to the default ('unassigned'
    // for room_read) and the Orchestrator got the same TRIAGE output
    // for every `what`, burning iterations retrying. Unwrap one level
    // here, for every object-arg tool at once: an `args` string that
    // parses as JSON becomes the args; an `args` object is
    // stringified; anything else — a direct {"what": ...} call, a
    // non-JSON `args` value, unparseable input — passes through
    // unchanged, so the direct-call path keeps working exactly as
    // before (see the Nov 27 nemotron repo_read case above).
    try {
      const parsed = JSON.parse(argsRaw.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'args' in parsed) {
        const inner = parsed.args;
        if (typeof inner === 'string') {
          try {
            JSON.parse(inner);
            return inner;
          } catch {
            return argsRaw.trim();
          }
        }
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          return JSON.stringify(inner);
        }
      }
    } catch {
      // Not JSON at all — fall through to the raw string.
    }
    return argsRaw.trim();
  }
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

/* ===========================================================================
 * Token usage tracking — exact daily totals instead of estimates.
 * (Jesse, Nov 26, 2026: the fleet logged reply chars and ms but never
 * token counts, so a day's usage could only be guessed from call counts.)
 *
 * Every provider chat-completions response carries a `usage` object
 * ({prompt_tokens, completion_tokens, total_tokens}); extractUsage pulls
 * it out defensively — a provider that omits it, or sends garbage,
 * yields zeros and never crashes the dispatch. Each upstream call is
 * recorded into a daily aggregate (UTC date) persisted at
 * USAGE_FILE_PATH: totals overall plus by provider and by agent.
 * The aggregate is read from disk on every record, so a restart can
 * never lose or double-count a day; the write is atomic (tmp +
 * rename) and fully best-effort — any failure is swallowed, never
 * thrown, so usage can never break or delay a dispatch. GET /usage
 * serves the current day's aggregate.
 * ========================================================================= */

/**
 * Pull { prompt, completion, total } token counts out of a
 * chat-completions payload. Missing, non-numeric, or negative fields
 * count as zero; total falls back to prompt + completion when the
 * provider does not report it.
 */
export function extractUsage(payload) {
  const u = payload?.usage;
  if (!u || typeof u !== 'object' || Array.isArray(u)) {
    return { prompt: 0, completion: 0, total: 0 };
  }
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const prompt = n(u.prompt_tokens);
  const completion = n(u.completion_tokens);
  const total = n(u.total_tokens) || prompt + completion;
  return { prompt, completion, total };
}

function utcDayString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function emptyUsageBucket() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function emptyUsageDay(date) {
  return {
    date,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    byProvider: {},
    byAgent: {},
  };
}

function normalizeUsageBucket(bucket) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    calls: n(bucket?.calls),
    promptTokens: n(bucket?.promptTokens),
    completionTokens: n(bucket?.completionTokens),
    totalTokens: n(bucket?.totalTokens),
  };
}

function normalizeUsageDay(raw) {
  const day = emptyUsageDay(typeof raw?.date === 'string' ? raw.date : utcDayString());
  Object.assign(day, normalizeUsageBucket(raw));
  for (const [key, value] of Object.entries(raw?.byProvider ?? {})) {
    if (typeof key === 'string') day.byProvider[key] = normalizeUsageBucket(value);
  }
  for (const [key, value] of Object.entries(raw?.byAgent ?? {})) {
    if (typeof key === 'string') day.byAgent[key] = normalizeUsageBucket(value);
  }
  return day;
}

/**
 * Load today's aggregate from disk. A missing, corrupt, or
 * yesterday-dated file starts a fresh day — the previous day's totals
 * are simply not carried over (each day stands on its own).
 */
export function getUsageDay() {
  const today = utcDayString();
  try {
    if (existsSync(USAGE_FILE_PATH)) {
      const raw = JSON.parse(readFileSync(USAGE_FILE_PATH, 'utf-8'));
      if (raw && raw.date === today) return normalizeUsageDay(raw);
    }
  } catch {
    // Corrupt file: start fresh below; the next save overwrites it.
  }
  return emptyUsageDay(today);
}

function saveUsageDay(day) {
  mkdirSync(dirname(USAGE_FILE_PATH), { recursive: true });
  const tmp = `${USAGE_FILE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(day, null, 2) + '\n', 'utf-8');
  renameSync(tmp, USAGE_FILE_PATH);
}

/**
 * Add one upstream call's usage to today's aggregate (overall, by
 * provider, by agent) and persist it atomically. Best-effort: returns
 * the updated day aggregate, or null when anything fails — never
 * throws, so a usage write can never break or delay a dispatch.
 */
export function recordUsage({ provider, agentId, usage }) {
  try {
    const day = getUsageDay();
    const u = {
      prompt: Number.isFinite(usage?.prompt) && usage.prompt > 0 ? Math.floor(usage.prompt) : 0,
      completion: Number.isFinite(usage?.completion) && usage.completion > 0 ? Math.floor(usage.completion) : 0,
      total: Number.isFinite(usage?.total) && usage.total > 0 ? Math.floor(usage.total) : 0,
    };
    const add = (bucket) => {
      bucket.calls += 1;
      bucket.promptTokens += u.prompt;
      bucket.completionTokens += u.completion;
      bucket.totalTokens += u.total;
    };
    add(day);
    if (typeof provider === 'string' && provider) {
      day.byProvider[provider] ??= emptyUsageBucket();
      add(day.byProvider[provider]);
    }
    if (typeof agentId === 'string' && agentId) {
      day.byAgent[agentId] ??= emptyUsageBucket();
      add(day.byAgent[agentId]);
    }
    saveUsageDay(day);
    return day;
  } catch {
    return null;
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
export const OPENAI_TOOLS = [
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
      description: 'Search the web (Linkup first, Bing/DuckDuckGo fallback) and return real result titles and links.',
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
  {
    type: 'function',
    function: {
      name: 'repo_read',
      description:
        'Read a file in the mem20 repo (/opt/mem20) — or the excerpt around a search string in it. Returns at most ~1000 chars. Never reads secrets or git internals. Args is a JSON object with file (repo-relative path) and optional find (sentence to centre the excerpt on).',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'The JSON object for the read' },
        },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stage_patch',
      description:
        'Stage ONE small patch for your job\'s implement stage: the smallest verified correction to one repo file. Args is a JSON object with jobId (from the runner context in your prompt), file (repo-relative path), oldText (exact text, must occur exactly once), newText, message (one-line commit message). Stages the patch for the governed push — it does NOT edit the repo. Refused for workflow files, requirements.txt, and secrets, and unless your job is on its implement stage.',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'The JSON object for the patch' },
        },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Fetch a public URL and return its text (HTML stripped to text, ~8000 chars). Use it to read the LIVE site — e.g. mem20.com — instead of guessing from the repo copy. Public http(s) only. Args is a JSON object with url.',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'The JSON object for the fetch' },
        },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'room_read',
      description:
        'Read the Build Room (conv-build-room) from the runner state: the work that needs assigning and the agents available. The Orchestrator\'s triage tool — call it first on every triage run. Args is a JSON object (all optional) with what ("unassigned" by default: triage + gate items and recent messages; "room": recent messages; "agents": agents matching "role") and, for "agents", role (a keyword, e.g. "backend").',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'The JSON object for the room read' },
        },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'toolchest_search',
      description:
        'Search the mem20 tool catalog (527 tools) by keyword and/or domain. Returns up to 10 matching tools with name, domain, description, and argument names. Args is a JSON object with query (keyword) and optional domain.',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'The JSON object for the search' },
        },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'toolchest_call',
      description:
        'Invoke one mem20 tool by name with JSON arguments, through the toolchest bridge. Returns the real result. Destructive actions (delete, remove, destroy, spend, publish, release, sell, charge, refund) and anything that publishes outside mem20 are refused. Args is a JSON object with tool (name) and arguments (object).',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'The JSON object for the call' },
        },
        required: ['args'],
      },
    },
  },
];

// Free Pollinations Classic API prompt cap (Jesse, Nov 28, 2026): the
// free tier rejects prompts over 16,000 characters (messages + tools)
// with a 413, and a 413 kills the whole dispatch — which the runner then
// retries, burning a full set of calls for nothing. That is a large part
// of why the fleet has been burning calls for two days. Enforce a
// 10,000-character cap so a long room_read dump can never 413. The
// system prompt and the most recent message are always kept; older middle
// messages are dropped (oldest first) and any single over-long message is
// truncated in place with a marker.
const FREE_PROMPT_CHAR_LIMIT = 10_000;
export { FREE_PROMPT_CHAR_LIMIT };

export function truncateForFreeTier(messages) {
  const toolsChars = JSON.stringify(OPENAI_TOOLS).length;
  const budget = FREE_PROMPT_CHAR_LIMIT - toolsChars;
  // Measure the prompt the way the API and the tests do: the JSON of the
  // whole messages array (brackets + commas included). Summing the
  // individual message JSONs undercounts by (n - 1) commas + 2 brackets,
  // which is how a fitted prompt once came out 4 chars over the cap.
  const sizeOf = (arr) => JSON.stringify(arr).length;
  const before = sizeOf(messages) + toolsChars;
  if (before <= FREE_PROMPT_CHAR_LIMIT) return messages;
  const kept = messages.map((m) => ({ ...m }));
  // A single message whose content alone busts the budget gets cut down.
  for (const m of kept) {
    if (typeof m.content === 'string' && JSON.stringify(m).length > budget) {
      m.content = m.content.slice(0, Math.max(0, budget - 200)) + '\n…[truncated to fit the free-API 10k prompt cap]';
    }
  }
  // Drop the oldest middle messages (system first + last message stay)
  // until the whole prompt fits.
  let out = kept;
  while (out.length > 2 && sizeOf(out) > budget) {
    out = [out[0], ...out.slice(2)];
  }
  // If system + last alone still bust it, cut the last message's content.
  let size = sizeOf(out);
  if (size > budget && out.length > 1 && typeof out[out.length - 1].content === 'string') {
    const last = out[out.length - 1];
    last.content = last.content.slice(0, Math.max(0, last.content.length - (size - budget) - 200)) + '\n…[truncated to fit the free-API 10k prompt cap]';
    size = sizeOf(out);
  }
  log(`free-API prompt cap: ${before} chars over the 10k limit — truncated to ${size + toolsChars} chars (system prompt + latest kept)`);
  return out;
}

/**
 * One chat-completions call. `deadline` is the absolute timestamp the
 * reply must be ready by; retries only happen when the wait still fits
 * inside it, and the per-call timeout is the time left to it (capped at
 * UPSTREAM_TIMEOUT_MS). Throws on failure — the loop decides what that
 * means (first turn: real failure; later: observation + fallback).
 */
async function callPollinations(openAiMessages, deadline) {
  // Enforce the free-API prompt cap before any attempt: a 413 wastes the
  // whole dispatch and the runner retries it, burning calls for nothing.
  openAiMessages = truncateForFreeTier(openAiMessages);
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
        if (reply && isUpstreamErrorReply(reply)) {
          // 200 with the credit refusal as content: throw it as the
          // 402 it is (see isUpstreamErrorReply). Thrown via lastError
          // so the catch below re-throws it immediately, without a
          // pointless retry against an exhausted account.
          lastError = new Error(`Pollinations 402: ${reply.slice(0, 240)}`);
          log(`pollinations attempt ${attempt} failed: ${lastError.message}`);
          throw lastError;
        }
        if (reply) return { text: reply, usage: extractUsage(payload) };
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
      if (reply && isUpstreamErrorReply(reply)) {
        // Same 200-with-error-content refusal as Pollinations: throw
        // it as a 402 so the /chat handler records a rate-limit event
        // instead of handing the error text back as an answer.
        throw new Error(`${provider.id} 402: ${reply.slice(0, 240)}`);
      }
      if (reply) return { text: reply, usage: extractUsage(payload) };
      throw new Error(`${provider.id} returned an empty reply`);
    }
    // Include the URL in the error: a 404 here usually means the registry's
    // baseUrl is wrong (DeepInfra was registered as the API root
    // https://api.deepinfra.com/v1 instead of .../v1/chat/completions,
    // Nov 28, 2026 — every agent 404'd and the failure looked transient
    // because direct tests used the right URL). Naming the URL makes that
    // visible immediately instead of looking like a provider outage.
    throw new Error(`${provider.id} ${res.status} at ${provider.baseUrl}: ${text.slice(0, 240)}`);
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
 * Returns { text, usage } — the reply plus the call's token counts
 * (zeros when the provider omits usage).
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
  if (req.method === 'GET' && url.pathname === '/usage') {
    // Today's token totals (UTC date), overall and by provider and by
    // agent. Read-only; CORS enabled like /runner-state so the UI can
    // fetch it cross-port. A missing file means no calls yet today.
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(getUsageDay()));
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
    // hardcoded to Pollinations. Each call's token usage is recorded
    // into the daily aggregate (best-effort; a failed record never
    // breaks the dispatch) and summed here for the reply log line.
    // The loop itself still only sees the reply text.
    const dispatchUsage = { prompt: 0, completion: 0, total: 0, calls: 0 };
    const propose = async (observations, priorActions) => {
      const msgs = [{ role: 'system', content: toolSystemPrompt }];
      for (const m of baseMessages.slice(1)) msgs.push(m);
      for (let i = 0; i < priorActions.length; i++) {
        msgs.push({ role: 'assistant', content: priorActions[i] });
        if (i < observations.length) msgs.push({ role: 'user', content: observations[i] });
      }
      const result = await callUpstream(providerId, msgs, deadline);
      if (typeof result === 'string') return result;
      dispatchUsage.prompt += result.usage.prompt;
      dispatchUsage.completion += result.usage.completion;
      dispatchUsage.total += result.usage.total;
      dispatchUsage.calls += 1;
      recordUsage({ provider: providerId, agentId: agent?.id ?? '', usage: result.usage });
      return result.text;
    };

    // Per-agent iteration budget (Jesse, Nov 28, 2026): the Orchestrator
    // runs at 50 because the 25 default kept cutting its triage runs off
    // mid-room-read. Every other agent keeps the 25 default.
    const effectiveMaxIterations = agent?.maxIterations ?? MAX_TOOL_ITERATIONS;
    const result = await runToolLoop(propose, { maxIterations: effectiveMaxIterations, deadline });
    if (result.hitIterationLimit) {
      // Kill-on-limit (Jesse, Nov 28, 2026): the loop burned the whole
      // iteration budget without finishing, so this is a failed
      // reply, not a partial success — the truncated tool observation
      // is never handed back as an answer, and the runner records the
      // run failed (the job retries on a later tick; the slot is freed
      // at once). No rate-limit event is recorded: this is not a
      // provider quota wall, so rescue must not move the agent.
      const killMessage = `agent hit the ${effectiveMaxIterations}-iteration tool limit without finishing — run killed, no partial output kept`;
      log(
        `reply KILLED agent=${agent?.name ?? '?'} iterations=${result.iterations} ms=${Date.now() - startedAt}: ${killMessage}`,
      );
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: killMessage }));
      return;
    }
    const ms = Date.now() - startedAt;
    const toolSteps = result.steps.filter((s) => s.action === 'tool').map((s) => s.tool).join(',') || 'none';
    log(`reply ok agent=${agent?.name ?? '?'} chars=${result.text.length} iterations=${result.iterations} tools=${toolSteps} tokens=${dispatchUsage.total} in=${dispatchUsage.prompt} out=${dispatchUsage.completion} calls=${dispatchUsage.calls} ms=${ms}`);
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
