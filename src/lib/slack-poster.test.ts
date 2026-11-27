import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatSlackLine,
  isSlackPostable,
  postJobUpdate,
  resetSlackWebhookUrlCache,
} from '../../scripts/slack-poster';

describe('slack poster — line filtering', () => {
  it('posts completed job work, skips the noise', () => {
    const postable = [
      'trigger → Frontend Developer in conv-build-room: hello',
      'trigger → Frontend Developer: FAILED boom',
      'job Fix sys.path store import / implement → Frontend Developer: done, see patch',
      'job Fix sys.path store import / implement: command ok (exit 0)',
      'job Fix sys.path store import / implement: command failed (exit 1)',
      'job Audit HTTP transport / verify: FAILED upstream timed out',
      'job Audit HTTP transport / release: DENIED by Reviewer — no evidence',
      'job Audit HTTP transport / release: APPROVED by Reviewer — small doc fix',
      'job Audit HTTP transport / implement: unknown agent agent-nope, run failed',
      'cron Hourly: Mem20 Assistant → Mem20 Assistant: all clear',
      'cron Hourly: Mem20 Assistant: FAILED rate limited',
    ];
    for (const line of postable) expect(isSlackPostable(line)).toBe(true);

    const noise = [
      'spacing: waiting 50s before dispatch to Frontend Developer',
      'trigger trigger-1: unknown agent agent-nope, skipped',
      'cron Hourly: Mem20 Assistant: command refused (no allowlist)',
      'cron Hourly: Mem20 Assistant: no agent/channel, skipped',
      'orchestrator → @Backend Architect: here is your assignment',
      'orchestrator: no @mentions in reply — nothing assigned this run',
      'rate-limit rescue: backing off for provider "pollinations" — next attempt 2026-11-27T00:00:00.000Z (1 consecutive failures)',
      'rate-limit rescue: resent @X request on kilo — completed',
      'job Fix sys.path store import / implement: still awaiting approval',
      'job Fix sys.path store import / implement: stage not started — needs approval',
      'job Fix sys.path store import / implement: still blocked after Reviewer approval — nope',
    ];
    for (const line of noise) expect(isSlackPostable(line)).toBe(false);
  });

  it('formats failures with ❌, successes with ✅, and truncates long lines', () => {
    expect(formatSlackLine('job X / implement → Agent: done')).toBe(
      '✅ job X / implement → Agent: done',
    );
    expect(formatSlackLine('job X / verify: FAILED boom')).toBe('❌ job X / verify: FAILED boom');
    expect(formatSlackLine('job X / release: DENIED by Reviewer — nope')).toBe(
      '❌ job X / release: DENIED by Reviewer — nope',
    );
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

describe('slack poster — postJobUpdate', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T/TEST/secret';
    resetSlackWebhookUrlCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SLACK_WEBHOOK_URL;
    resetSlackWebhookUrlCache();
  });

  it('posts one Slack message per completed job line, and nothing for noise', async () => {
    const log = vi.fn();
    await postJobUpdate('job Fix it / implement → Dev: done', log);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.com/services/T/TEST/secret');
    expect(JSON.parse(String(init.body)).text).toBe(
      '*Teamz update*\n✅ job Fix it / implement → Dev: done',
    );
    expect(log).toHaveBeenCalledWith('slack: posted job update to #mem20updates');

    fetchMock.mockClear();
    await postJobUpdate('spacing: waiting 50s before dispatch to Dev', log);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the webhook is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const log = vi.fn();
    await expect(
      postJobUpdate('cron Hourly: X → X: done', log),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('slack: post failed'));
  });
});
