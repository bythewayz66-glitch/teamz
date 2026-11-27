/**
 * teamz Slack poster — agent job updates to #mem20updates.
 *
 * Each time an agent finishes a unit of work (a product-job stage, a
 * cron run, a Reviewer decision), the runner hands the human-readable
 * line to `postJobUpdate`, which posts it to #mem20updates as one
 * short Slack message. Posting happens as the work completes — not
 * batched at the end of the tick — because a tick can run long and a
 * restart can kill it mid-flight; work already finished must still
 * reach the channel. Everything else (spacing, rescues, parks,
 * retries) stays in the runner log only.
 *
 * The webhook URL is NEVER hardcoded and NEVER logged. It is read at
 * runtime from, in order:
 *   1. process.env.SLACK_WEBHOOK_URL — injected by systemd via
 *      EnvironmentFile=/etc/teamz-slack.env (see
 *      deploy/teamz-runner.service.d/slack.conf, same pattern as the
 *      agent's pollinations.conf).
 *   2. /etc/teamz-slack.env directly (root:teamz 0640, so the runner's
 *      `teamz` user can read it).
 *
 * Posting is best-effort and never fatal: a missing URL, an unreachable
 * webhook, or a non-2xx response is logged and the tick continues.
 * Nothing here touches the governed push path or Reviewer governance.
 */

import { readFileSync } from 'node:fs';

export const SLACK_WEBHOOK_ENV_VAR = 'SLACK_WEBHOOK_URL';
export const SLACK_ENV_PATH = process.env.TEAMZ_SLACK_ENV_PATH ?? '/etc/teamz-slack.env';

/** Max characters per update line in a Slack message. */
export const MAX_LINE_LENGTH = 180;

/** How long to wait for Slack before giving up on a post (ms). */
export const POST_TIMEOUT_MS = 10_000;

// The webhook URL is stable for the life of the process; cache it after
// the first successful read so every tick does not re-read the file.
let cachedUrl: string | null | undefined;

/** Read the Slack webhook URL from the environment or the secrets file. */
export function readSlackWebhookUrl(): string | null {
  if (cachedUrl !== undefined) return cachedUrl;
  const fromEnv = (process.env[SLACK_WEBHOOK_ENV_VAR] ?? '').trim();
  if (fromEnv) {
    cachedUrl = fromEnv;
    return cachedUrl;
  }
  try {
    const text = readFileSync(SLACK_ENV_PATH, 'utf-8');
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*SLACK_WEBHOOK_URL\s*=\s*(.+?)\s*$/);
      if (match) {
        cachedUrl = match[1].replace(/^['"]|['"]$/g, '').trim();
        return cachedUrl;
      }
    }
  } catch {
    // Missing or unreadable file — the poster is a no-op, never fatal.
  }
  cachedUrl = null;
  return null;
}

/** Forget the cached URL (tests, and a future rotation hook). */
export function resetSlackWebhookUrlCache(): void {
  cachedUrl = undefined;
}

// A runner line is worth a Slack post when it reports a completed unit
// of agent work. These patterns match the strings processDue emits
// (see scripts/runner-lib.ts).
const POSTABLE_PATTERNS: RegExp[] = [
  /^trigger → /, // scheduled dispatch completed
  /^trigger → .*: FAILED /, // scheduled dispatch failed
  /^job .+ \/ .+ → /, // agent stage completed
  /^job .+ \/ .+: command (ok|failed|BLOCKED|REFUSED)/, // command stage result
  /^job .+ \/ .+: FAILED /, // agent stage failed
  /^job .+ \/ .+: (APPROVED|DENIED) by Reviewer/, // Reviewer decision
  /^job .+ \/ .+: unknown agent /, // agent missing, run failed
  /^cron .+ → /, // cron run completed
  /^cron .+: FAILED /, // cron run failed
];

/** True when a runner line reports completed job work worth posting. */
export function isSlackPostable(line: string): boolean {
  return POSTABLE_PATTERNS.some((pattern) => pattern.test(line));
}

function isFailure(line: string): boolean {
  return /FAILED|DENIED|command failed|BLOCKED|REFUSED|unknown agent/.test(line);
}

/** Collapse a runner line to one short, single-line Slack bullet. */
export function formatSlackLine(line: string): string {
  const oneLine = line.replace(/\s+/g, ' ').trim();
  const trimmed =
    oneLine.length > MAX_LINE_LENGTH
      ? `${oneLine.slice(0, MAX_LINE_LENGTH - 1)}…`
      : oneLine;
  return `${isFailure(line) ? '❌' : '✅'} ${trimmed}`;
}

type LogFn = (message: string) => void;

/**
 * Post `text` to the #mem20updates webhook. Returns true on a 2xx
 * response. Never logs the URL; never throws.
 */
export async function postToSlack(text: string, log: LogFn = () => {}): Promise<boolean> {
  const url = readSlackWebhookUrl();
  if (!url) {
    log('slack: no webhook URL configured (SLACK_WEBHOOK_URL / /etc/teamz-slack.env) — skipping post');
    return false;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    log(`slack: post failed — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!response.ok) {
    log(`slack: post failed — HTTP ${response.status}`);
    return false;
  }
  return true;
}

/**
 * The runner's per-completion hook: post one completed unit of agent
 * work to Slack as its own message. Best-effort — a non-postable line
 * is ignored, a missing URL or a failed post is logged, and the tick
 * continues. Never throws. Callers do not await this; the post runs
 * in the background while the tick moves on.
 */
export async function postJobUpdate(line: string, log: LogFn): Promise<void> {
  if (!isSlackPostable(line)) return;
  const message = `*Teamz update*\n${formatSlackLine(line)}`;
  try {
    const ok = await postToSlack(message, log);
    if (ok) {
      log('slack: posted job update to #mem20updates');
    }
  } catch (err) {
    log(`slack: post failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}
