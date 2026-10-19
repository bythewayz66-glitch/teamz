import { defineConfig } from 'vitest/config';

/**
 * Test config, kept separate from `vite.config.ts` on purpose.
 *
 * The app config carries `base: '/teamz/'` for GitHub Pages, which is
 * meaningless to the test runner, and keeping the two apart means the app's
 * `tsconfig.json` never has to know about Vitest's types.
 *
 * The environment is `node`: everything under test is pure logic (mention
 * parsing, the template catalogue, the store's reducers). Nothing here needs
 * a DOM, so we skip jsdom and keep the run fast.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: 'default',
  },
});
