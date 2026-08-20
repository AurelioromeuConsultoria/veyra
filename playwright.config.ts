import { defineConfig } from '@playwright/test';
import { E2E_API_PORT, E2E_DATABASE_URL, E2E_WEB_ORIGIN, E2E_WEB_PORT } from './e2e/env';

/**
 * E2E contra o app REAL (API buildada + web dev server), em portas e banco
 * próprios (nunca colide com o dev em 3001/5175). Rodar: pnpm test:e2e
 * (o script builda antes — a API sobe de dist/).
 */
export default defineConfig({
  testDir: './e2e/tests',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1, // specs compartilham o banco semeado
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: E2E_WEB_ORIGIN,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node apps/api/dist/main.js',
      url: `http://localhost:${E2E_API_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test', // throttler off: os specs fazem vários logins
        PORT: String(E2E_API_PORT),
        DATABASE_URL: E2E_DATABASE_URL,
        JWT_SECRET: 'jwt-secret-de-e2e-nunca-em-producao-32ch',
        WEB_ORIGIN: E2E_WEB_ORIGIN,
      },
    },
    {
      command: `pnpm --filter @veyra/web dev`,
      url: E2E_WEB_ORIGIN,
      reuseExistingServer: false,
      env: {
        VITE_PORT: String(E2E_WEB_PORT),
        VITE_API_PROXY_TARGET: `http://localhost:${E2E_API_PORT}`,
      },
    },
  ],
});
