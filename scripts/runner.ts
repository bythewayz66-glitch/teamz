/**
 * teamz-runner — the 24/7 headless autonomy runner.
 *
 * Runs on jnet1 under systemd (see deploy/teamz-runner.service). It shares
 * the scheduler / jobs / governance core with the in-tab runner and drives
 * it from a JSON state file instead of the browser:
 *
 *   node scripts/runner.ts --state /var/lib/teamz-runner/state.json \
 *     --log /var/log/teamz-runner/runner.log
 *
 * Flags:
 *   --state <path>     state file (default: ./runner-state.json)
 *   --log <path>       log file, in addition to stdout (default: ./runner.log)
 *   --interval <sec>   seconds between ticks (default: 30)
 *   --once             run a single tick and exit (smoke tests, cron use)
 *
 * The loop reloads the state file before every tick and saves it after,
 * so approvals and jobs added to the file (by a future status page) take
 * effect on the next tick. A gated stage with no approval is never
 * executed — the runner files an approval request in the state file and
 * parks the job until the Reviewer approves it there.
 *
 * This service never installs anything, never touches credentials, and
 * never runs a command that is not on a job's explicit allowlist.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  dispatchPromptToAgent,
  executeAllowedCommand,
  loadRunnerState,
  processDue,
  saveRunnerState,
  type RateLimitEvent,
  type RunnerState,
} from './runner-lib';
import { postJobUpdate } from './slack-poster';

interface CliOptions {
  statePath: string;
  logPath: string;
  intervalMs: number;
  once: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    statePath: './runner-state.json',
    logPath: './runner.log',
    intervalMs: 30_000,
    once: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--state' && next) {
      opts.statePath = next;
      i++;
    } else if (arg === '--log' && next) {
      opts.logPath = next;
      i++;
    } else if (arg === '--interval' && next) {
      const secs = Number(next);
      if (!Number.isFinite(secs) || secs < 5) {
        throw new Error('--interval must be at least 5 seconds');
      }
      opts.intervalMs = Math.floor(secs * 1000);
      i++;
    } else if (arg === '--once') {
      opts.once = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/runner.ts [--state <path>] [--log <path>] [--interval <sec>] [--once]',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function makeLogger(logPath: string): (message: string) => void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    // Logging to stdout still works when the log directory cannot be made.
  }
  return (message: string) => {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    try {
      appendFileSync(logPath, line + '\n', 'utf-8');
    } catch (err) {
      console.error(`[teamz-runner] could not write to log file ${logPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

async function runOneTick(statePath: string, log: (message: string) => void): Promise<RunnerState | null> {
  let loaded;
  try {
    loaded = loadRunnerState(statePath);
  } catch (err) {
    log(`ERROR loading state file ${statePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  for (const warning of loaded.warnings) log(`WARN ${warning}`);
  const { state, fired } = await processDue(loaded.state, new Date(), {
    // Provider ids from the agent endpoint's registry, for the
    // stranded-agent sweep (an agent whose provider is not in the
    // registry cannot run, even though it never rate-limits). Missing
    // or unreadable registry: the sweep still catches agents with no
    // provider at all.
    providerIds: loadProviderIds(),
    dispatchPrompt: (agent, prompt, channelId) => dispatchPromptToAgent(agent, prompt, channelId),
    executeCommand: (job, argv) => executeAllowedCommand(job, argv),
    log: (message) => log(`  ${message}`),
    rateLimitEvents: async () => readRateLimitEvents(),
    acknowledgeRateLimitEvents: async (ids) => acknowledgeRateLimitEvents(ids),
    // Playto suggestions (advisory only): the founder's Chief of Staff
    // appends suggestions to the inbox file (see
    // /usr/local/bin/suggest-to-reviewer); pending ones ride along on
    // Reviewer dispatches, framed as suggestions, and are marked
    // delivered once carried. A suggestion never decides anything.
    playtoSuggestions: async () => readPlaytoSuggestions(),
    acknowledgePlaytoSuggestions: async (keys) => acknowledgePlaytoSuggestions(keys),
    // Before a gated command stage runs, persist the state (with the live
    // approval) so the governed push script can verify the approval on
    // disk. The tick's normal save-after still happens.
    onBeforeCommand: async (s) => {
      saveRunnerState(statePath, s);
      log('  state persisted before gated command stage (approval on disk for the push script)');
    },
    reloadAgents: async () => {
      try {
        return loadRunnerState(statePath).state.agents;
      } catch {
        return loaded.state.agents;
      }
    },
    // 15 minutes between dispatches on the same slot (see
    // RunnerDeps.minDispatchGapMs): the fleet slowdown Jesse ordered
    // Nov 27, 2026 — "slow them down a lot, don't stop them." The gap
    // is the master throttle and applies PER SLOT across ticks; the
    // fleet runs 1 slot normally (~1 dispatch per 16 minutes, ~770
    // model calls/day at ~10 calls per dispatch), and a second slot
    // opens only while a backlog of 2+ product jobs is due (Nov 28,
    // 2026 — Jesse: "go back to 1, with a second during heavy hours";
    // 3 slots were rejected the same day — they would have tripled
    // call volume toward ~2,400/day). Every agent and job — Reviewer,
    // triage, rescue included — flows through the same dispatch and
    // slows at the same pace; nothing is exempt, nothing is stopped.
    // (The gap's original job still holds: waiting BETWEEN dispatches
    // keeps every dispatch's model call inside its 330s budget.) The
    // tick gets longer; the service skips ticks while one is still
    // running (tick guard in main()).
    minDispatchGapMs: 900_000,
    // Post each completed unit of agent work to #mem20updates as it
    // finishes (see scripts/slack-poster.ts). Fire-and-forget: the
    // poster never throws and a failed post never breaks the tick, and
    // posting per completion (not batched at end of tick) means a tick
    // killed mid-flight by a restart still reports the work it did.
    onJobUpdate: (line) => {
      void postJobUpdate(line, log);
    },
  });
  if (fired.length > 0) {
    try {
      saveRunnerState(statePath, state);
    } catch (err) {
      log(`ERROR saving state file ${statePath}: ${err instanceof Error ? err.message : String(err)}`);
      return state;
    }
  }
  return state;
}

/* ---------------------------------------------------------------------------
 * Provider registry — the agent endpoint's providers.json, read for the
 * stranded-agent sweep. The file is `{ providers: [{ id, ... }] }`.
 * ------------------------------------------------------------------------- */

/** Provider ids from the agent endpoint's registry, or undefined when it cannot be read. */
function loadProviderIds(): string[] | undefined {
  const path = process.env.PROVIDERS_JSON_PATH ?? '/var/lib/teamz-agent/providers.json';
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const list = (raw as { providers?: unknown }).providers;
    if (!Array.isArray(list)) return undefined;
    const ids = list
      .map((p) => (p as { id?: unknown }).id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

/* ---------------------------------------------------------------------------
 * Rate-limit events — the endpoint appends one JSON line per refused
 * upstream call (see scripts/agent-endpoint/agent.mjs). The runner reads
 * them on its own tick (never a tight loop) and hands them to processDue,
 * which wakes the Provider Researcher and resends the retained request.
 * Handled ids live in a separate file so the event log stays append-only.
 * ------------------------------------------------------------------------- */

const RATE_LIMIT_EVENTS_PATH =
  process.env.RATE_LIMIT_EVENTS_PATH ?? '/var/lib/teamz-agent/rate-limit-events.jsonl';
const RATE_LIMIT_HANDLED_PATH =
  process.env.RATE_LIMIT_HANDLED_PATH ?? '/var/lib/teamz-agent/rate-limit-handled.json';

function readHandledEventIds(): Set<string> {
  try {
    if (!existsSync(RATE_LIMIT_HANDLED_PATH)) return new Set();
    const parsed: unknown = JSON.parse(readFileSync(RATE_LIMIT_HANDLED_PATH, 'utf-8'));
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function readRateLimitEvents(): RateLimitEvent[] {
  try {
    if (!existsSync(RATE_LIMIT_EVENTS_PATH)) return [];
    const handled = readHandledEventIds();
    const events: RateLimitEvent[] = [];
    for (const line of readFileSync(RATE_LIMIT_EVENTS_PATH, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Partial<RateLimitEvent>;
        if (typeof e.id === 'string' && typeof e.agentId === 'string' && typeof e.prompt === 'string' && !handled.has(e.id)) {
          events.push(e as RateLimitEvent);
        }
      } catch {
        // A corrupt line is skipped, never fatal to the tick.
      }
    }
    return events;
  } catch {
    return [];
  }
}

function acknowledgeRateLimitEvents(ids: string[]): void {
  const handled = readHandledEventIds();
  for (const id of ids) handled.add(id);
  try {
    mkdirSync(dirname(RATE_LIMIT_HANDLED_PATH), { recursive: true });
    const tmp = `${RATE_LIMIT_HANDLED_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify([...handled], null, 2) + '\n', 'utf-8');
    renameSync(tmp, RATE_LIMIT_HANDLED_PATH);
  } catch {
    // A failed ack only means the event may be seen again; processDue
    // de-dupes by its rescue records, so this is safe.
  }
}

/* ---------------------------------------------------------------------------
 * Playto suggestions — the inbox file Playto appends to, and the runner
 * reads. One JSON object per line: {ts, topic, text, status}. A
 * suggestion is 'pending' until the runner has included it in a
 * Reviewer dispatch, then 'delivered'. Suggestions are advisory only:
 * the Reviewer may accept, reject, or ignore each on its merits, and a
 * suggestion never approves, denies, or changes anything by itself.
 * ------------------------------------------------------------------------- */

const PLAYTO_SUGGESTIONS_PATH =
  process.env.PLAYTO_SUGGESTIONS_PATH ?? '/var/lib/teamz-runner/playto-suggestions.jsonl';

interface PlaytoSuggestionLine {
  ts: number;
  topic: string;
  text: string;
  status: string;
}

function readPlaytoSuggestions(): PlaytoSuggestionLine[] {
  try {
    if (!existsSync(PLAYTO_SUGGESTIONS_PATH)) return [];
    const out: PlaytoSuggestionLine[] = [];
    for (const line of readFileSync(PLAYTO_SUGGESTIONS_PATH, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as Partial<PlaytoSuggestionLine>;
        if (typeof s.ts === 'number' && typeof s.topic === 'string' && typeof s.text === 'string') {
          out.push({ ts: s.ts, topic: s.topic, text: s.text, status: typeof s.status === 'string' ? s.status : 'pending' });
        }
      } catch {
        // A corrupt line is skipped, never fatal to the tick.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function acknowledgePlaytoSuggestions(keys: number[]): void {
  try {
    if (!existsSync(PLAYTO_SUGGESTIONS_PATH)) return;
    const lines = readFileSync(PLAYTO_SUGGESTIONS_PATH, 'utf-8').split('\n');
    const wanted = new Set(keys);
    let changed = false;
    const next = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const s = JSON.parse(line) as Partial<PlaytoSuggestionLine>;
        if (typeof s.ts === 'number' && wanted.has(s.ts) && s.status !== 'delivered') {
          changed = true;
          return JSON.stringify({ ...s, status: 'delivered' });
        }
      } catch {
        // Corrupt lines pass through untouched.
      }
      return line;
    });
    if (!changed) return;
    const tmp = `${PLAYTO_SUGGESTIONS_PATH}.tmp`;
    writeFileSync(tmp, next.join('\n'), 'utf-8');
    renameSync(tmp, PLAYTO_SUGGESTIONS_PATH);
  } catch {
    // A failed ack only means the suggestion stays pending and will be
    // re-included on a later Reviewer dispatch; it is never fatal.
  }
}

async function main(): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[teamz-runner] ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const log = makeLogger(opts.logPath);
  log(
    `teamz-runner starting (state=${opts.statePath}, interval=${opts.intervalMs / 1000}s, once=${opts.once})`,
  );

  const first = await runOneTick(opts.statePath, log);
  if (first === null) {
    log('first tick could not load state; will retry on the next tick');
    if (opts.once) return 1;
  } else {
    log(
      `state loaded: ${first.agents.length} agents, ${first.jobs.length} jobs, ${first.cronJobs.length} cron jobs, ${first.triggers.length} triggers, ${first.approvals.filter((a) => a.status === 'pending').length} pending approvals`,
    );
  }
  if (opts.once) return 0;

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('teamz-runner stopping (signal received)');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // A tick can now run long: with the 15-minute inter-dispatch gap
  // (Nov 27, 2026 fleet slowdown), the hourly batch drains over
  // hours, not minutes. Ticks must never overlap —
  // a second tick loading the same state file while the first is still
  // dispatching could fire the same jobs twice — so a tick that finds
  // one already running just skips and logs it. Cron dedupe (lastRunAt
  // per minute) is the backstop, not the mechanism.
  let tickInFlight = false;
  const timer = setInterval(() => {
    if (tickInFlight) {
      log('tick still running, skipping this interval');
      return;
    }
    tickInFlight = true;
    void runOneTick(opts.statePath, log)
      .catch((err) => {
        log(`ERROR in tick: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, opts.intervalMs);
  // The interval keeps the process alive; the signal handlers below resolve
  // the wait, which clears it and lets main() return.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });
  clearInterval(timer);
  log('teamz-runner stopped');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`[teamz-runner] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
