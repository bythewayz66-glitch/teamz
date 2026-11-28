/**
 * Vitest setup: tell React this is an act()-enabled test environment.
 *
 * Without `IS_REACT_ACT_ENVIRONMENT`, React 18's `act()` only warns
 * ("The current testing environment is not configured to support act(...)")
 * and state updates made outside `act()` are not flushed deterministically
 * — which is exactly how the useAutonomy hook tests (fake timers + effects
 * that dispatch through the workspace) go flaky or fail in a fresh
 * environment even though they pass on a warm checkout. Setting the flag
 * here makes `act()` real for every jsdom test file; node-environment
 * tests are unaffected.
 */
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * No test may reach a live provider. Loopback stays real (the endpoint tests
 * serve themselves); a test that needs an upstream call replaces fetch with
 * vi.stubGlobal, which bypasses this guard. Anything else fails loudly instead
 * of spending provider credits or passing/failing on a provider's balance.
 */
const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;
const realFetch = globalThis.fetch;
if (typeof realFetch === 'function') {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/^https?:\/\//i.test(url) && !loopback.test(url)) {
      return Promise.reject(new Error(`live network call blocked in tests: ${url} (stub fetch with vi.stubGlobal)`));
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
