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
    dispatchPrompt: (agent, prompt, channelId) => dispatchPromptToAgent(agent, prompt, channelId),
    executeCommand: (job, argv) => executeAllowedCommand(job, argv),
    log: (message) => log(`  ${message}`),
    rateLimitEvents: async () => readRateLimitEvents(),
    acknowledgeRateLimitEvents: async (ids) => acknowledgeRateLimitEvents(ids),
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
    // 50s between dispatches (see RunnerDeps.minDispatchGapMs): on the
    // anonymous tier a second dispatch in the same tick would otherwise
    // burn ~50s of its 60s budget waiting for the endpoint's rate
    // window and then fail. The tick gets longer; the service skips
    // ticks while one is still running (tick guard in main()).
    minDispatchGapMs: 50_000,
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

  // A tick can now run long: with the 50s inter-dispatch gap, the
  // hourly batch drains over ~22 minutes. Ticks must never overlap —
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
