/**
 * Vitest configuration for apps/server integration tests.
 *
 * These tests start a real Postgres container and a real Bun server.
 * They must be run with `bun --bun vitest run` to have access to Bun APIs
 * (Bun.spawn, Bun.sleep, etc).
 *
 * Coverage is intentionally excluded here; coverage must be collected
 * without --bun due to a Bun limitation (see vitest.config.ts for details).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts', 'src/api/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
