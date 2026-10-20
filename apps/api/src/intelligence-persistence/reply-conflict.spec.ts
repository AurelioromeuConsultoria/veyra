import { Prisma } from '../generated/prisma/client';
import { isPendingReplyConflict, isPromptVersionConflict } from './ai.repositories';

/**
 * A FORMA do erro é do provedor, e mudou entre versões: no Prisma 7 com driver
 * adapter, a constraint violada não vem em `meta.target` — vem aninhada em
 * `meta.driverAdapterError.cause.constraint.fields`. A condição que olhava só
 * `target` nunca casava, e a corrida de duas gerações simultâneas vazava como
 * 409 "Registro duplicado" para quem só pediu uma sugestão. Este spec fixa o
 * formato real observado contra o Postgres.
 */
describe('isPendingReplyConflict', () => {
  const p2002 = (meta: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '7.9.1',
      meta,
    });

  it('reconhece o unique do rascunho pendente na forma do driver adapter', () => {
    expect(
      isPendingReplyConflict(
        p2002({
          modelName: 'AiProposal',
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
              originalCode: '23505',
              kind: 'UniqueConstraintViolation',
              constraint: { fields: ['"workspaceId"', '"conversationId"', '"pendingReplyMark"'] },
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it('reconhece também a forma antiga, com `target`', () => {
    expect(
      isPendingReplyConflict(
        p2002({ target: ['workspaceId', 'conversationId', 'pendingReplyMark'] }),
      ),
    ).toBe(true);
  });

  it('NÃO engole outro unique da mesma tabela', () => {
    expect(isPendingReplyConflict(p2002({ target: ['workspaceId', 'id'] }))).toBe(false);
    expect(
      isPendingReplyConflict(
        p2002({
          modelName: 'AiProposal',
          driverAdapterError: {
            cause: { kind: 'UniqueConstraintViolation', constraint: { fields: ['"id"'] } },
          },
        }),
      ),
    ).toBe(false);
  });

  it('NÃO engole outro código de erro nem erro comum', () => {
    const p2003 = new Prisma.PrismaClientKnownRequestError('FK', {
      code: 'P2003',
      clientVersion: '7.9.1',
      meta: { target: ['pendingReplyMark'] },
    });
    expect(isPendingReplyConflict(p2003)).toBe(false);
    expect(isPendingReplyConflict(new Error('pendingReplyMark'))).toBe(false);
    expect(isPendingReplyConflict(null)).toBe(false);
  });
});

/** A mesma lição para o unique `(capability, version)` de `PromptVersion`. */
describe('isPromptVersionConflict', () => {
  const p2002 = (meta: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '7.9.1',
      meta,
    });

  it('reconhece o unique da versão de prompt na forma do driver adapter e na antiga', () => {
    expect(
      isPromptVersionConflict(
        p2002({
          modelName: 'PromptVersion',
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
              originalCode: '23505',
              kind: 'UniqueConstraintViolation',
              constraint: { fields: ['"capability"', '"version"'] },
            },
          },
        }),
      ),
    ).toBe(true);
    expect(isPromptVersionConflict(p2002({ target: ['capability', 'version'] }))).toBe(true);
  });

  it('NÃO engole outro unique, outro código nem erro comum', () => {
    expect(isPromptVersionConflict(p2002({ target: ['id'] }))).toBe(false);
    const p2003 = new Prisma.PrismaClientKnownRequestError('FK', {
      code: 'P2003',
      clientVersion: '7.9.1',
      meta: { target: ['capability', 'version'] },
    });
    expect(isPromptVersionConflict(p2003)).toBe(false);
    expect(isPromptVersionConflict(new Error('capability version'))).toBe(false);
    expect(isPromptVersionConflict(null)).toBe(false);
  });
});
