/**
 * useOperations — what the runner is doing and what it has cost, for agent
 * homes. Polls the endpoint's read-only `/runner-state` and `/usage` every
 * 60s, keeps the last good answer in localStorage so a home still opens (and
 * says how old its data is) when the runner is unreachable, and folds each
 * day's token totals into the usage ledger. It never writes to the runner.
 */

import { useCallback, useEffect, useState } from 'react';
import { fetchRunnerState, fetchUsageDay } from '../api/runnerState';
import type { RunnerSnapshot } from '../lib/agentHome';
import {
  EMPTY_LEDGER,
  parseLedger,
  parseRate,
  recordUsageDay,
  type CostRate,
  type UsageLedger,
} from '../lib/usageLedger';

const SNAPSHOT_KEY = 'teamz:runner-snapshot:v1';
const LEDGER_KEY = 'teamz:usage-ledger:v1';
const RATE_KEY = 'teamz:cost-rate:v1';
const POLL_MS = 60_000;

function loadSnapshot(): RunnerSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<RunnerSnapshot>;
    if (!p || typeof p.fetchedAt !== 'number') return null;
    return {
      jobs: Array.isArray(p.jobs) ? p.jobs : [],
      triggers: Array.isArray(p.triggers) ? p.triggers : [],
      cronJobs: Array.isArray(p.cronJobs) ? p.cronJobs : [],
      agents: Array.isArray(p.agents) ? p.agents : [],
      channelMessages: Array.isArray(p.channelMessages) ? p.channelMessages : [],
      fetchedAt: p.fetchedAt,
    };
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota — the in-memory copy still serves this tab */
  }
}

export interface Operations {
  runner: RunnerSnapshot | null;
  /** True when the last poll failed and `runner` is a saved copy. */
  stale: boolean;
  ledger: UsageLedger;
  rate: CostRate | null;
  setRate: (rate: CostRate | null) => void;
}

export function useOperations(): Operations {
  const [runner, setRunner] = useState<RunnerSnapshot | null>(loadSnapshot);
  const [stale, setStale] = useState(true);
  const [ledger, setLedger] = useState<UsageLedger>(() => {
    try {
      return parseLedger(localStorage.getItem(LEDGER_KEY));
    } catch {
      return EMPTY_LEDGER;
    }
  });
  const [rate, setRateState] = useState<CostRate | null>(() => {
    try {
      return parseRate(localStorage.getItem(RATE_KEY));
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetchRunnerState()
        .then((s) => {
          if (cancelled) return;
          const snap: RunnerSnapshot = {
            jobs: s.jobs,
            triggers: s.triggers,
            cronJobs: s.cronJobs,
            agents: s.agents,
            channelMessages: s.channelMessages,
            fetchedAt: s.fetchedAt,
          };
          setRunner(snap);
          setStale(false);
          save(SNAPSHOT_KEY, snap);
        })
        .catch(() => {
          if (!cancelled) setStale(true);
        });
      fetchUsageDay()
        .then((day) => {
          if (cancelled || !day) return;
          setLedger((prev) => {
            const next = recordUsageDay(prev, day);
            if (next !== prev) save(LEDGER_KEY, next);
            return next;
          });
        })
        .catch(() => {
          /* usage unreachable — the ledger keeps what it has */
        });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const setRate = useCallback((next: CostRate | null) => {
    setRateState(next);
    try {
      if (next) localStorage.setItem(RATE_KEY, JSON.stringify(next));
      else localStorage.removeItem(RATE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return { runner, stale, ledger, rate, setRate };
}
