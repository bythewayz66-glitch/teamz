import { describe, expect, it } from 'vitest';
import {
  formatSlackLine,
  formatTickMessage,
  slackLinesForTick,
} from '../../scripts/slack-poster';

describe('slack poster — tick filtering', () => {
  it('posts agent stage completions and cron runs, skips the noise', () => {
    const fired = [
      'spacing: waiting 50s before dispatch to Frontend Developer',
      'job Fix sys.path store import / implement → Frontend Developer: done, see patch',
      'job Fix sys.path store import / implement: command ok (exit 0)',
      'job Audit HTTP transport / verify: FAILED upstream timed out',
      'job Audit HTTP transport / release: DENIED by Reviewer — no evidence',
      'job Audit HTTP transport / release: APPROVED by Reviewer — small doc fix',
      'cron Hourly: Mem20 Assistant → Mem20 Assistant: all clear',
      'cron Hourly: Mem20 Assistant: FAILED rate limited',
      'orchestrator → @Backend Architect: here is your assignment',
      'orchestrator: no @mentions in reply — nothing assigned this run',
      'rate-limit rescue: backing off for provider "pollinations" — next attempt 2026-11-27T00:00:00.000Z (1 consecutive failures)',
      'job Fix sys.path store import / implement: still awaiting approval',
      'job Fix sys.path store import / implement: stage not started — needs approval',
      'trigger → Frontend Developer in conv-build-room: hello',
    ];
    const lines = slackLinesForTick(fired);
    expect(lines).toHaveLength(7);
    expect(lines[0]).toMatch(/^✅ job Fix sys\.path store import \/ implement → Frontend Developer:/);
    expect(lines[1]).toMatch(/^✅ job Fix sys\.path store import \/ implement: command ok/);
    expect(lines[2]).toMatch(/^❌ job Audit HTTP transport \/ verify: FAILED/);
    expect(lines[3]).toMatch(/^❌ job Audit HTTP transport \/ release: DENIED by Reviewer/);
    expect(lines[4]).toMatch(/^✅ job Audit HTTP transport \/ release: APPROVED by Reviewer/);
    expect(lines[5]).toMatch(/^✅ cron Hourly: Mem20 Assistant → Mem20 Assistant:/);
    expect(lines[6]).toMatch(/^❌ cron Hourly: Mem20 Assistant: FAILED/);
  });

  it('returns nothing when the tick only has noise', () => {
    expect(
      slackLinesForTick([
        'spacing: waiting 50s before dispatch to X',
        'tick still running, skipping this interval',
        'job X / implement: still awaiting approval',
      ]),
    ).toEqual([]);
    expect(formatTickMessage(['spacing: waiting 50s before dispatch to X'])).toBeNull();
  });

  it('formats one update with a singular header, many with a count', () => {
    expect(formatTickMessage(['cron Hourly: Mem20 Assistant → Mem20 Assistant: ok'])).toBe(
      '*Teamz update*\n✅ cron Hourly: Mem20 Assistant → Mem20 Assistant: ok',
    );
    expect(
      formatTickMessage([
        'cron A → Agent A: ok',
        'cron B → Agent B: ok',
      ]),
    ).toBe('*Teamz — 2 updates*\n✅ cron A → Agent A: ok\n✅ cron B → Agent B: ok');
  });

  it('collapses newlines and truncates long lines', () => {
    const long = `job X / implement → Agent: ${'a'.repeat(300)}`;
    const line = formatSlackLine(long);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThanOrEqual(182); // ✅ + space + 180
    expect(line.endsWith('…')).toBe(true);
    expect(formatSlackLine('job X / implement → Agent: line1\nline2\ttab')).toBe(
      '✅ job X / implement → Agent: line1 line2 tab',
    );
  });
});
