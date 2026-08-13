import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],

    // Config is read from the environment at import time, so these must be set
    // before any application module loads.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://webstore:webstore@localhost:5432/webstore_test?schema=public',
      JWT_ACCESS_SECRET: 'test-access-secret-for-integration-tests',
      JWT_REFRESH_SECRET: 'test-refresh-secret-for-integration-tests',
      ACCESS_TOKEN_TTL: '15m',
      COOKIE_SECURE: 'false',
      CORS_ORIGINS: 'http://localhost:5173',
      SHIPPING_FLAT_CENTS: '599',
      FREE_SHIPPING_THRESHOLD_CENTS: '5000',
      TAX_RATE_BASIS_POINTS: '875',
    },

    // Integration tests share one Postgres database and truncate between
    // cases, so they must not run concurrently.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
