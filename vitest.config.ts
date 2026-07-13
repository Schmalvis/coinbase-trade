import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Nit4: force any test file that doesn't mock config/db onto an ephemeral DATA_DIR before
    // its own imports run, so the real dev/bot SQLite DB is never touched. See tests/setup-env.ts.
    setupFiles: ['./tests/setup-env.ts'],
  },
});
