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
 * so approvals and jobs added to the file (by Jesse, or by a future status
 * page) take effect on the next tick. A gated stage with no approval is
 * never executed — the runner files an approval request in the state file
 * and parks the job until Jesse approves it there.
 *
 * This service never installs anything, never touches credentials, and
 * never runs a command that is not on a job's explicit allowlist.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  dispatchPromptToAgent,
  executeAllowedCommand,
  loadRunnerState,
  processDue,
  saveRunnerState,
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

  const timer = setInterval(() => {
    void runOneTick(opts.statePath, log).catch((err) => {
      log(`ERROR in tick: ${err instanceof Error ? err.message : String(err)}`);
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
