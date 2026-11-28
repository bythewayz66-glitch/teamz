/**
 * Runner telemetry — an append-only JSONL event log answering "is the
 * rhythm actually running?": dispatches, completions, stalls, and ticks
 * that were killed before their work was saved.
 *
 * One JSON object per line: { ts, event, ...fields }. Writing never
 * throws and never blocks a tick. The file is not rotated here; at the
 * current pace (about 3-4 dispatches an hour) it grows by well under a
 * megabyte a month.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Telemetry {
  emit(event: string, fields?: Record<string, unknown>): void;
}

export function makeTelemetry(path: string, onError?: (message: string) => void): Telemetry {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Emit still reports the failure below.
  }
  return {
    emit(event, fields = {}) {
      try {
        appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n', 'utf-8');
      } catch (err) {
        onError?.(`telemetry write failed (${path}): ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

export function readEventLines(path: string): string[] {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8').split('\n') : [];
  } catch {
    return [];
  }
}

export interface LostTick {
  tick: number;
  startedAt: string;
  /** Dispatches that finished ok inside the lost tick; their results never reached the state file. */
  completedDispatches: number;
  failedDispatches: number;
}

/**
 * A tick that wrote `tick_start` but never `tick_end` was killed (restart,
 * crash, deploy) before processDue returned — and the runner only saves
 * state when a tick ends, so everything that tick completed was lost.
 * Call this at boot, before writing the new `boot` event.
 */
export function findLostTick(lines: string[]): LostTick | null {
  let open: LostTick | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: { event?: string; tick?: number; ts?: string; ok?: boolean };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.event === 'tick_start' && typeof e.tick === 'number') {
      open = { tick: e.tick, startedAt: String(e.ts ?? ''), completedDispatches: 0, failedDispatches: 0 };
    } else if (e.event === 'tick_end') {
      open = null;
    } else if (e.event === 'dispatch_end' && open && e.tick === open.tick) {
      if (e.ok) open.completedDispatches += 1;
      else open.failedDispatches += 1;
    }
  }
  return open;
}

export interface StallSnapshot {
  nowMs: number;
  bootMs: number;
  inFlight: Array<{ agent: string; startedAtMs: number }>;
  tickStartedAtMs: number | null;
  lastCompletionMs: number | null;
}

export interface StallThresholds {
  /** A dispatch past its 330s endpoint timeout plus slack is hung. */
  dispatchOverrunMs: number;
  /** A single tick running this long is not draining. */
  tickMaxMs: number;
  /** Nothing has completed for this long, since boot or the last completion. */
  idleMs: number;
}

export const DEFAULT_STALL_THRESHOLDS: StallThresholds = {
  dispatchOverrunMs: 330_000 + 60_000,
  tickMaxMs: 2 * 60 * 60 * 1000,
  idleMs: 2 * 60 * 60 * 1000,
};

/** Stable reason keys for everything currently stalled; empty when healthy. */
export function stallReasons(s: StallSnapshot, t: StallThresholds = DEFAULT_STALL_THRESHOLDS): string[] {
  const reasons: string[] = [];
  for (const d of s.inFlight) {
    if (s.nowMs - d.startedAtMs > t.dispatchOverrunMs) reasons.push(`dispatch_overrun:${d.agent}`);
  }
  if (s.tickStartedAtMs !== null && s.nowMs - s.tickStartedAtMs > t.tickMaxMs) reasons.push('tick_too_long');
  const lastProgress = Math.max(s.lastCompletionMs ?? 0, s.bootMs);
  if (s.nowMs - lastProgress > t.idleMs) reasons.push('no_completion');
  return reasons;
}
