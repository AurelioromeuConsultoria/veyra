/**
 * Jest unit do apps/api (CommonJS + moduleResolution Node — ts-jest sem ESM).
 * `reflect-metadata` em setupFiles: decorators NestJS com emitDecoratorMetadata
 * precisam do polyfill antes de avaliar classes decoradas.
 * Testes de integração (*.integration-spec.ts) terão config própria na Entrega 1.
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '\\.integration-spec\\.ts$'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['reflect-metadata'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
};
