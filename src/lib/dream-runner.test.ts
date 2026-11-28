import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRunnerState } from '../../scripts/runner-lib';
import { isCronJobDue } from './scheduler';
import { DREAM_CRON, DREAM_ENROLLABLE, parseDreamReply, runnerDreamJobId } from './dream';

const ROOT = process.cwd();
const BUILD = join(ROOT, 'scripts/build-runner-state.mjs');

function build(dir: string, name: string, inPath: string, flags: string[]): string {
  const out = join(dir, name);
  execFileSync('node', [BUILD, '--agents', join(ROOT, 'runner-agents.json'), '--in', inPath, '--out', out, ...flags], { encoding: 'utf-8' });
  return out;
}
const WC = ['--extra-agents', join(ROOT, 'new-agents-1-website-currency.json')];

describe('build-runner-state --dream', () => {
  it('without --dream, no Dream job exists (the fleet is not enrolled by default)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamz-dr0-'));
    try {
      writeFileSync(join(dir, 'e.json'), '{}');
      const loaded = loadRunnerState(build(dir, 'o.json', join(dir, 'e.json'), WC));
      expect(loaded.state.cronJobs.filter((j) => j.id.startsWith('cron-dream-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds exactly the three starter Dream jobs; the state loads with zero warnings and each is due on its first slot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamz-dr1-'));
    try {
      writeFileSync(join(dir, 'e.json'), '{}');
      const loaded = loadRunnerState(build(dir, 'o.json', join(dir, 'e.json'), [...WC, '--dream']));
      expect(loaded.warnings).toEqual([]);
      const dreams = loaded.state.cronJobs.filter((j) => j.id.startsWith('cron-dream-'));
      expect(dreams.map((j) => j.agentId).sort()).toEqual([...DREAM_ENROLLABLE].sort());
      for (const j of dreams) {
        expect(j.id).toBe(runnerDreamJobId(j.agentId!));
        expect(j).toMatchObject({ schedule: DREAM_CRON, type: 'prompt', enabled: true, channelId: 'conv-build-room', lastRunAt: null, runs: [] });
        expect(j.target).toContain('ONLY one JSON object');
        expect(isCronJobDue(j, new Date(2026, 10, 28, 12, 0, 0))).toBe(true);
        expect(isCronJobDue(j, new Date(2026, 10, 28, 12, 30, 0))).toBe(false);
      }
      expect(loaded.state.agents.map((a) => a.id)).toEqual(expect.arrayContaining([...DREAM_ENROLLABLE]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent and keeps an existing Dream job’s run history across a rebuild', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamz-dr2-'));
    try {
      writeFileSync(join(dir, 'e.json'), '{}');
      const o1 = build(dir, 'o1.json', join(dir, 'e.json'), [...WC, '--dream']);
      const s1 = JSON.parse(readFileSync(o1, 'utf-8'));
      const orch = s1.cronJobs.find((j: { id: string }) => j.id === 'cron-dream-orchestrator');
      orch.lastRunAt = 1_700_000_000_000;
      orch.runs = [{ ts: 1_700_000_000_000, ok: true, detail: 'ran' }];
      writeFileSync(o1, JSON.stringify(s1));
      const o2 = build(dir, 'o2.json', o1, [...WC, '--dream']);
      const s2 = JSON.parse(readFileSync(o2, 'utf-8'));
      expect(s2.cronJobs.filter((j: { id: string }) => j.id.startsWith('cron-dream-'))).toHaveLength(3);
      const kept = s2.cronJobs.find((j: { id: string }) => j.id === 'cron-dream-orchestrator');
      expect(kept.runs).toEqual([{ ts: 1_700_000_000_000, ok: true, detail: 'ran' }]);
      expect(kept.lastRunAt).toBe(1_700_000_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses --dream without the Website Currency Agent in the roster rather than silently skipping it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamz-dr3-'));
    try {
      writeFileSync(join(dir, 'e.json'), '{}');
      expect(() => build(dir, 'o.json', join(dir, 'e.json'), ['--dream'])).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the runner prompt’s own shape is a report the UI parser accepts', () => {
    const shape = '{"changed": false, "summary": "Nothing to change.", "findings": [], "proposals": []}';
    expect(parseDreamReply(shape)).toMatchObject({ ok: true });
  });
});
