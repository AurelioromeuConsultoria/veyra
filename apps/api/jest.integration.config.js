/**
 * Jest de INTEGRAÇÃO: testes contra Postgres real (banco `veyra_test`, isolado
 * do dev). maxWorkers: 1 — as suites compartilham o banco e truncam entre
 * casos. Rodar com `pnpm --filter @veyra/api test:integration`.
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.integration-spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['reflect-metadata', '<rootDir>/test/integration/env.ts'],
  globalSetup: '<rootDir>/test/integration/global-setup.ts',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  testTimeout: 30000,
  maxWorkers: 1,
};
