import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_STALL_THRESHOLDS,
  findLostTick,
  makeTelemetry,
  stallReasons,
} from '../../scripts/runner-telemetry';
import { loadRunnerState } from '../../scripts/runner-lib';
import { deserializeJob, isJobDue } from './jobs';

const ROOT = process.cwd();

describe('findLostTick', () => {
  const line = (o: object) => JSON.stringify(o);

  it('is null when every tick that started also ended', () => {
    expect(
      findLostTick([
        line({ event: 'tick_start', tick: 1, ts: 'a' }),
        line({ event: 'dispatch_end', tick: 1, ok: true }),
        line({ event: 'tick_end', tick: 1 }),
      ]),
    ).toBeNull();
  });

  it('reports a tick killed before tick_end, with the dispatches it lost', () => {
    const lost = findLostTick([
      line({ event: 'tick_start', tick: 1, ts: 't1' }),
      line({ event: 'tick_end', tick: 1 }),
      line({ event: 'tick_start', tick: 2, ts: 't2' }),
      line({ event: 'dispatch_end', tick: 2, ok: true }),
      line({ event: 'dispatch_end', tick: 2, ok: true }),
      line({ event: 'dispatch_end', tick: 2, ok: false }),
      'not json',
    ]);
    expect(lost).toEqual({ tick: 2, startedAt: 't2', completedDispatches: 2, failedDispatches: 1 });
  });
});

describe('stallReasons', () => {
  const base = { nowMs: 10_000_000, bootMs: 10_000_000 - 60_000, inFlight: [], tickStartedAtMs: null, lastCompletionMs: null };

  it('is healthy shortly after boot', () => {
    expect(stallReasons(base)).toEqual([]);
  });

  it('flags a dispatch past its timeout, a long tick, and no completions', () => {
    const t = DEFAULT_STALL_THRESHOLDS;
    const reasons = stallReasons({
      nowMs: 100_000_000,
      bootMs: 0,
      inFlight: [{ agent: 'agent-x', startedAtMs: 100_000_000 - t.dispatchOverrunMs - 1 }],
      tickStartedAtMs: 100_000_000 - t.tickMaxMs - 1,
      lastCompletionMs: 100_000_000 - t.idleMs - 1,
    });
    expect(reasons.sort()).toEqual(['dispatch_overrun:agent-x', 'no_completion', 'tick_too_long']);
  });

  it('a recent completion clears no_completion', () => {
    expect(stallReasons({ ...base, nowMs: 100_000_000, bootMs: 0, lastCompletionMs: 99_999_000 })).toEqual([]);
  });
});

describe('makeTelemetry', () => {
  it('appends one JSON object per event and never throws on a bad path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamz-tel-'));
    try {
      const path = join(dir, 'sub', 'events.jsonl');
      const t = makeTelemetry(path);
      t.emit('boot', { a: 1 });
      t.emit('dispatch_start', { agent: 'x' });
      const rows = readFileSync(path, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows.map((r) => r.event)).toEqual(['boot', 'dispatch_start']);
      expect(rows[0].a).toBe(1);
      const errors: string[] = [];
      writeFileSync(join(dir, 'blocker'), 'x');
      makeTelemetry(join(dir, 'blocker', 'x', 'events.jsonl'), (m) => errors.push(m)).emit('boot');
      expect(errors).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Website Currency Agent job', () => {
  it('the legacy batch-builder job shape is dropped by the runner (why it never ran)', () => {
    const legacy = {
      id: 'job-website-currency-agent',
      title: 'Keep mem20.com current',
      agentId: 'agent-website-currency-agent',
      type: 'job',
      status: 'active',
      currentStage: 'draft',
      stages: [{ name: 'draft', prompt: 'p' }],
      everyMs: 3600000,
      lastRunAt: 0,
    };
    expect(() => deserializeJob(legacy)).toThrow(/unknown stage/);
  });

  it('--extra-agents adds the agent and a loadable, due, recurring job', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamz-wc-'));
    try {
      const outPath = join(dir, 'out.json');
      execFileSync(
        'node',
        [
          join(ROOT, 'scripts/build-runner-state.mjs'),
          '--agents', join(ROOT, 'runner-agents.json'),
          '--extra-agents', join(ROOT, 'new-agents-1-website-currency.json'),
          '--in', join(dir, 'missing.json'),
          '--out', outPath,
        ],
        { encoding: 'utf-8' },
      );
      const loaded = loadRunnerState(outPath);
      expect(loaded.warnings).toEqual([]);
      expect(loaded.state.agents.map((a) => a.id)).toContain('agent-website-currency-agent');
      const job = loaded.state.jobs.find((j) => j.id === 'job-website-currency-agent');
      expect(job).toBeDefined();
      expect(job!.stages.map((s) => s.stage)).toEqual(['design']);
      expect(isJobDue(job!, new Date())).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a rebuild over its own output keeps one job', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamz-wc2-'));
    try {
      const out1 = join(dir, 'o1.json');
      const out2 = join(dir, 'o2.json');
      const args = (inp: string, out: string) => [
        join(ROOT, 'scripts/build-runner-state.mjs'),
        '--agents', join(ROOT, 'runner-agents.json'),
        '--extra-agents', join(ROOT, 'new-agents-1-website-currency.json'),
        '--in', inp, '--out', out,
      ];
      writeFileSync(join(dir, 'empty.json'), '{}');
      execFileSync('node', args(join(dir, 'empty.json'), out1));
      execFileSync('node', args(out1, out2));
      const jobs = JSON.parse(readFileSync(out2, 'utf-8')).jobs;
      expect(jobs.filter((j: { id: string }) => j.id === 'job-website-currency-agent')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
