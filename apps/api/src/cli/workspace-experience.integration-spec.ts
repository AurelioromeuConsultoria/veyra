import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../../test/integration/app';
import { createWorkspaceFixture, seedPermissionCatalog } from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { AuditService } from '../audit/audit.service';
import { ExperienceService } from '../extensions/experience';
import { composeRegistry } from '../extensions/registry';
import { PrismaService } from '../prisma/prisma.service';
import { RecusaDaTroca, trocarExperiencia } from './workspace-experience.core';

/**
 * A troca da experiência pela operação (ADR-055 adendo 1, item 6). Os casos da
 * porta (que falha, a troca no meio, a não selecionável) usam uma experiência
 * de teste, injetada no serviço. A `clinics` real, selecionável desde a E-3 e
 * só com o vertical ativo, é provada no spec do vertical (o Core não o importa).
 */
describe('CLI workspace-experience (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let workspaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    workspaceId = (await createWorkspaceFixture(prisma, 'acme')).workspaceId;
  });

  const real = () => ({
    prisma,
    audit: app.get(AuditService),
    experiencias: app.get(ExperienceService),
  });
  /** a composição de teste: uma extensão com experiência selecionável */
  const comTeste = (disponivel: () => Promise<boolean>) => ({
    prisma,
    audit: app.get(AuditService),
    experiencias: new ExperienceService(
      composeRegistry([{ name: 'teste', experience: { selectable: true } }]),
      [{ experience: 'teste', isAvailable: () => disponivel() }],
    ),
  });
  const experienciaAtual = async () =>
    (await prisma.raw.workspace.findFirst({ where: { id: workspaceId } }))?.experience;
  const trilha = () =>
    prisma.raw.auditLog.findMany({
      where: { workspaceId, action: 'workspace.experience_changed' },
    });

  it('todo workspace nasce em `crm`', async () => {
    expect(await experienciaAtual()).toBe('crm');
  });

  it('recusa a experiência que a composição não declara', async () => {
    await expect(
      trocarExperiencia(real(), { slug: 'acme', experiencia: 'inexistente' }),
    ).rejects.toThrow(/não existe na composição/);
    expect(await experienciaAtual()).toBe('crm');
    expect(await trilha()).toHaveLength(0);
  });

  it('a troca é condicional: se o workspace mudou no meio, ela é recusada sem trilha e sem desfazer a outra', async () => {
    // a porta, chamada entre a leitura e a gravação, faz a OUTRA troca chegar antes
    const deps = comTeste(async () => {
      await prisma.raw.workspace.update({
        where: { id: workspaceId },
        data: { experience: 'outra' },
      });
      return true;
    });
    await expect(trocarExperiencia(deps, { slug: 'acme', experiencia: 'teste' })).rejects.toThrow(
      /mudou durante a troca/,
    );
    expect(await experienciaAtual()).toBe('outra');
    expect(await trilha()).toHaveLength(0);
  });

  it('a experiência que a composição declara NÃO selecionável é recusada, mesmo disponível', async () => {
    const deps = {
      ...comTeste(async () => true),
      experiencias: new ExperienceService(
        composeRegistry([{ name: 'teste', experience: { selectable: false } }]),
        [{ experience: 'teste', isAvailable: async () => true }],
      ),
    };
    await expect(trocarExperiencia(deps, { slug: 'acme', experiencia: 'teste' })).rejects.toThrow(
      /ainda não é selecionável/,
    );
    expect(await experienciaAtual()).toBe('crm');
    expect(await trilha()).toHaveLength(0);
  });

  it('recusa o workspace que não existe e a troca sem efeito', async () => {
    await expect(trocarExperiencia(real(), { slug: 'nenhum', experiencia: 'crm' })).rejects.toThrow(
      /não existe/,
    );
    await expect(trocarExperiencia(real(), { slug: 'acme', experiencia: 'crm' })).rejects.toThrow(
      /já está na experiência "crm"; nada mudou/,
    );
    expect(await trilha()).toHaveLength(0);
  });

  it('recusa a experiência indisponível no workspace, e a porta que falha conta como indisponível', async () => {
    await expect(
      trocarExperiencia(
        comTeste(async () => false),
        { slug: 'acme', experiencia: 'teste' },
      ),
    ).rejects.toThrow(/não está disponível/);
    await expect(
      trocarExperiencia(
        comTeste(async () => {
          throw new Error('banco fora');
        }),
        { slug: 'acme', experiencia: 'teste' },
      ),
    ).rejects.toThrow(/não está disponível/);
    expect(await experienciaAtual()).toBe('crm');
    expect(await trilha()).toHaveLength(0);
  });

  it('a troca selecionável e disponível muda a experiência e fica na trilha, só com a chave', async () => {
    const r = await trocarExperiencia(
      comTeste(async () => true),
      { slug: 'acme', experiencia: 'teste' },
    );
    expect(r).toEqual({ workspaceId, antes: 'crm', depois: 'teste' });
    expect(await experienciaAtual()).toBe('teste');
    const registros = await trilha();
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({
      entityType: 'workspace',
      entityId: workspaceId,
      actorType: 'system',
      actorId: 'cli:workspace-experience',
      before: { experience: 'crm' },
      after: { experience: 'teste' },
    });
    // e volta pela mesma porta
    await trocarExperiencia(real(), { slug: 'acme', experiencia: 'crm' });
    expect(await experienciaAtual()).toBe('crm');
    expect(await trilha()).toHaveLength(2);
  });

  it('o banco recusa a chave fora do formato, mesmo por fora da CLI', async () => {
    await expect(
      prisma.raw.workspace.update({ where: { id: workspaceId }, data: { experience: 'Inválida' } }),
    ).rejects.toThrow(/Workspace_experience_formato/);
  });

  it('a recusa é do procedimento', async () => {
    const erro = await trocarExperiencia(real(), { slug: 'acme', experiencia: 'x1' }).catch(
      (e) => e,
    );
    expect(erro).toBeInstanceOf(RecusaDaTroca);
  });
});
