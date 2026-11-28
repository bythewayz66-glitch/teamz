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
