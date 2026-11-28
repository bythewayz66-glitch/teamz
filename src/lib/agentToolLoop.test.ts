import { describe, expect, it } from 'vitest';

// Kill-on-limit (Jesse, Nov 28, 2026): a run that hits the 25-iteration
// tool limit, or a hard provider quota wall (402/429), is killed
// immediately — fail fast, record the failure, free the slot. No
// multi-hour retries. These tests exercise runToolLoop directly (the
// shared loop inside scripts/agent-endpoint/agent.mjs); the /chat
// handler turns hitIterationLimit into a 502 kill and a quota-wall
// throw into a 429 + rate-limit event for rescue. No network, no live
// providers: propose is stubbed, and the only tool used is the
// built-in 'unknown tool' path (no repo, no state).
// agent.mjs ships no types; the dynamic import is untyped on purpose.
// @ts-ignore — no declaration file for the endpoint module
const { runToolLoop } = await import('../../scripts/agent-endpoint/agent.mjs');

const toolAction = (tool: string) => JSON.stringify({ action: 'tool', tool, args: 'x' });
const finalAction = (text: string) => JSON.stringify({ action: 'final', final: text });

describe('runToolLoop — kill-on-limit', () => {
  it('flags hitIterationLimit when the loop burns the whole budget without a final', async () => {
    const result = await runToolLoop(
      async () => toolAction('nope'),
      { maxIterations: 3, deadline: Date.now() + 60_000 },
    );
    expect(result.hitIterationLimit).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.text).toContain('[reached the tool limit]');
  });

  it('hitIterationLimit is false when the model answers before the budget runs out', async () => {
    let calls = 0;
    const result = await runToolLoop(
      async () => {
        calls += 1;
        return calls === 1 ? toolAction('nope') : finalAction('Done.');
      },
      { maxIterations: 3, deadline: Date.now() + 60_000 },
    );
    expect(result.hitIterationLimit).toBe(false);
    expect(result.text).toBe('Done.');
    expect(result.iterations).toBe(2);
  });

  it('a quota wall after turn 1 kills the run at once — it throws, it does not retry to the deadline', async () => {
    let calls = 0;
    await expect(
      runToolLoop(
        async () => {
          calls += 1;
          if (calls === 1) return toolAction('nope');
          throw new Error('gemini 429: You exceeded your current quota');
        },
        { maxIterations: 25, deadline: Date.now() + 60_000 },
      ),
    ).rejects.toThrow('429');
    // Killed on the second propose — not retried for the remaining 23
    // iterations (the Nov 27 pricing runs retried for ~1.5h and ~3h).
    expect(calls).toBe(2);
  });

  it('a non-quota propose failure after turn 1 still becomes an observation the model can recover from', async () => {
    let calls = 0;
    const result = await runToolLoop(
      async () => {
        calls += 1;
        if (calls === 1) return toolAction('nope');
        if (calls === 2) throw new Error('network blip, try again');
        return finalAction('Recovered.');
      },
      { maxIterations: 5, deadline: Date.now() + 60_000 },
    );
    expect(result.hitIterationLimit).toBe(false);
    expect(result.text).toBe('Recovered.');
    expect(calls).toBe(3);
  });

  it('a deadline stop is not an iteration-limit hit', async () => {
    const result = await runToolLoop(async () => toolAction('nope'), {
      maxIterations: 25,
      deadline: Date.now() - 1,
    });
    expect(result.hitIterationLimit).toBe(false);
    expect(result.iterations).toBe(0);
    expect(result.text).toBe('I could not produce an answer in the time available.');
  });
});
