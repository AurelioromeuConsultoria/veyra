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
  // qualquer arquivo com "integration" no caminho fica fora do runner unit —
  // um typo no sufixo (.integration.spec.ts) não pode cair aqui sem o setup
  // de banco de teste (o resetDb tem guarda própria, defesa em profundidade)
  testPathIgnorePatterns: ['/node_modules/', 'integration'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // pg-boss é ESM puro; o worker não roda em teste (ver test/pg-boss.stub.ts)
  moduleNameMapper: { '^pg-boss$': '<rootDir>/../test/pg-boss.stub.ts' },
  setupFiles: ['reflect-metadata'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
};
