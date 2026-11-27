/**
 * One-off smoke test for the Slack poster.
 *
 *   npm run build:slack-test   # esbuild scripts/slack-test.ts -> dist/slack-test.mjs
 *   node dist/slack-test.mjs   # posts ONE test message to #mem20updates
 *
 * Sends exactly one clearly-marked test message so Jesse can confirm the
 * channel is live. Not part of the runner; do not run it on a schedule.
 */
import { postToSlack } from './slack-poster';

const ok = await postToSlack(
  '🧪 TEST — Teamz Slack poster is wired up. This is the one test message; real agent job updates will land here as they complete. (Please ignore.)',
  (message) => console.log(`[slack-test] ${message}`),
);
console.log(ok ? '[slack-test] posted to #mem20updates' : '[slack-test] FAILED — see log above');
process.exit(ok ? 0 : 1);
