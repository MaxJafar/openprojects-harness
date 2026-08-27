import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Optional examples own their dependency graphs and test runners. Keep the
    // lightweight root corpus stable and run each example through its own CI
    // job instead of auto-discovering nested `*.test.ts` files.
    include: ['tests/**/*.test.ts'],
  },
});
