import { defineConfig } from '@playwright/test';
import {
  E2E_API_PORT,
  E2E_CHAVES,
  E2E_DATABASE_URL,
  E2E_DEMO_API_PORT,
  E2E_DEMO_DATABASE_URL,
  E2E_DEMO_WEB_ORIGIN,
  E2E_DEMO_WEB_PORT,
  E2E_WEB_ORIGIN,
  E2E_WEB_PORT,
} from './e2e/env';

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
        ...E2E_CHAVES,
        DISABLE_JOBS: 'true',
        MAINTENANCE_MODE: 'false',
        WEB_ORIGIN: E2E_WEB_ORIGIN,
      },
    },
    {
      // `--force`: refaz o pré-bundle das dependências a cada execução. O cache
      // do Vite não percebe mudança no `dist` dos contratos (pacote do
      // workspace), e um pré-bundle velho quebra a tela em silêncio
      command: `pnpm --filter @veyra/web dev --force`,
      url: E2E_WEB_ORIGIN,
      reuseExistingServer: false,
      env: {
        VITE_PORT: String(E2E_WEB_PORT),
        VITE_API_PROXY_TARGET: `http://localhost:${E2E_API_PORT}`,
        VITE_CACHE_DIR: 'node_modules/.vite-e2e', // separado do dev (ver vite.config.ts)
      },
    },
    {
      /**
       * A PILHA DA DEMONSTRAÇÃO (ADR-048 adendo 12, item 3): o transporte e o
       * catálogo falsos, os jobs LIGADOS e um banco próprio. O comando prepara
       * o banco pelos procedimentos administrativos e só então sobe a API: os
       * servidores sobem antes do setup global, e o worker não pode nascer num
       * banco que será recriado. Nada sai para a Meta: com o transporte
       * simulado, só os falsos são instanciados.
       */
      command: 'apps/api/node_modules/.bin/tsx e2e/demo/preparar.ts && node apps/api/dist/main.js',
      url: `http://localhost:${E2E_DEMO_API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        // NÃO `test`: com ele o worker não sobe (jobs.service), e a pilha precisa
        // do despacho de verdade. O outbox roda a cada minuto, como em staging
        NODE_ENV: 'development',
        PORT: String(E2E_DEMO_API_PORT),
        DATABASE_URL: E2E_DEMO_DATABASE_URL,
        ...E2E_CHAVES,
        DISABLE_JOBS: 'false',
        MAINTENANCE_MODE: 'false',
        META_TRANSPORT_MODE: 'fake',
        VEYRA_ENV: 'staging',
        WEB_ORIGIN: E2E_DEMO_WEB_ORIGIN,
        // o Playwright soma o ambiente do shell: com os jobs ligados, nada de
        // chave de IA, de segredo da Meta nem de scanner herdado (vazio = ausente)
        ANTHROPIC_API_KEY: '',
        META_APP_SECRET: '',
        META_WEBHOOK_VERIFY_TOKEN: '',
        CLAMAV_HOST: '',
        STORAGE_ROOT: 'node_modules/.storage-e2e-demo',
      },
    },
    {
      command: `pnpm --filter @veyra/web dev --force`,
      url: E2E_DEMO_WEB_ORIGIN,
      reuseExistingServer: false,
      env: {
        VITE_PORT: String(E2E_DEMO_WEB_PORT),
        VITE_API_PROXY_TARGET: `http://localhost:${E2E_DEMO_API_PORT}`,
        VITE_CACHE_DIR: 'node_modules/.vite-e2e-demo',
      },
    },
  ],
});
