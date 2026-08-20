// ESLint 9 (flat config) + typescript-eslint. Regras estritas de tipo ficam
// para quando houver projeto de referência por pacote; começamos com o
// recommended para manter o CI honesto sem fricção artificial.
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/src/generated/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    // NestJS injeta dependência pelo TIPO do parâmetro do construtor
    // (emitDecoratorMetadata): `import type` apagaria a classe em runtime e
    // quebraria o DI — a regra não se aplica ao código da API.
    files: ['apps/api/src/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // BARREIRA do ADR-027: o módulo `intelligence` não alcança o banco. As
    // portas são interfaces e os adaptadores Prisma vivem em
    // `src/intelligence-persistence/`. Sem exceção aqui dentro — o teste
    // `intelligence/boundary.spec.ts` cobre o mesmo, caso esta regra caia.
    files: ['apps/api/src/intelligence/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/prisma/prisma.service', '**/prisma/*', '**/generated/prisma*'],
              message:
                'ADR-027: intelligence não importa Prisma. Use uma porta (ports/repositories.ts) e implemente o adaptador em src/intelligence-persistence/.',
            },
            {
              group: ['@prisma/client'],
              message: 'ADR-027: intelligence não importa Prisma.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
