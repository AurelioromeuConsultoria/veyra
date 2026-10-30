import { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { createTestApp } from '../../../test/integration/app';
import {
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  TEST_PASSWORD,
} from '../../../test/integration/fixtures';
import { resetDb } from '../../../test/integration/harness';
import { AuditService } from '../../audit/audit.service';
import { trocarExperiencia } from '../../cli/workspace-experience.core';
import { ExperienceService } from '../../extensions/experience';
import { PrismaService } from '../../prisma/prisma.service';
import { ClinicsActivationService } from './clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

/**
 * A experiência `clinics` (ADR-055 adendo 1): pronta só com o vertical ATIVO
 * no workspace; desativado, `unavailable` — e a sessão diz isso, sem cair no
 * CRM. Ativar o Clinics NÃO muda a experiência do workspace. Dados fictícios.
 */
describe('Clinics — a disponibilidade da experiência (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let workspaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    const fixture = await createWorkspaceFixture(prisma, 'acme');
    workspaceId = fixture.workspaceId;
    const ownerId = await createUserFixture(prisma, 'owner@veyra.test');
    await createMembershipFixture(prisma, workspaceId, ownerId, fixture.roles.owner);
  });

  const experiencias = () => app.get(ExperienceService);
  const sessao = async () => {
    const entrada = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'owner@veyra.test', password: TEST_PASSWORD })
      .expect(201);
    return ((entrada.headers['set-cookie'] as unknown as string[]) ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
  };

  it('a CLI põe a `clinics` (selecionável desde a E-3) só com o vertical ATIVO, e audita', async () => {
    const deps = { prisma, audit: app.get(AuditService), experiencias: experiencias() };
    const atual = async () =>
      (await prisma.raw.workspace.findFirst({ where: { id: workspaceId } }))?.experience;
    await expect(trocarExperiencia(deps, { slug: 'acme', experiencia: 'clinics' })).rejects.toThrow(
      /não está disponível/,
    );
    expect(await atual()).toBe('crm');
    await app.get(ClinicsActivationService).enable('acme');
    expect(await trocarExperiencia(deps, { slug: 'acme', experiencia: 'clinics' })).toEqual({
      workspaceId,
      antes: 'crm',
      depois: 'clinics',
    });
    expect(await atual()).toBe('clinics');
    const trilha = await prisma.raw.auditLog.findMany({
      where: { workspaceId, action: 'workspace.experience_changed' },
    });
    expect(trilha).toHaveLength(1);
  });

  it('sem o vertical, a `clinics` está indisponível; ativo, pronta; desativado, indisponível de novo', async () => {
    expect(await experiencias().status(workspaceId, 'clinics')).toBe('unavailable');
    await app.get(ClinicsActivationService).enable('acme');
    expect(await experiencias().status(workspaceId, 'clinics')).toBe('ready');
    await app.get(ClinicsActivationService).disable('acme');
    expect(await experiencias().status(workspaceId, 'clinics')).toBe('unavailable');
  });

  it('dois workspaces: a porta responde pelo workspace PEDIDO, de dentro do contexto do outro, inclusive quando falha', async () => {
    const beta = (await createWorkspaceFixture(prisma, 'beta')).workspaceId;
    await app.get(ClinicsActivationService).enable('acme');
    const cls = app.get(ClsService);
    // o contexto de uma requisição no workspace A (acme), com a identidade dela
    await cls.run(async () => {
      cls.set('workspaceId', workspaceId);
      cls.set('userId', 'u-do-acme');
      cls.set('membershipId', 'm-do-acme');
      // B (beta) não tem o vertical: indisponível, mesmo pedido de dentro de A
      expect(await experiencias().status(beta, 'clinics')).toBe('unavailable');
      // e A, que tem, continua pronto
      expect(await experiencias().status(workspaceId, 'clinics')).toBe('ready');
      // a porta que falha (um id que o client filtrado recusa) é indisponível
      expect(await experiencias().status('nao-e-um-uuid', 'clinics')).toBe('unavailable');
      // o contexto de quem chamou continua o de A, depois de tudo
      expect(cls.get('workspaceId')).toBe(workspaceId);
      expect(cls.get('userId')).toBe('u-do-acme');
      expect(cls.get('membershipId')).toBe('m-do-acme');
    });
    // o inverso: só B ativo
    await app.get(ClinicsActivationService).disable('acme');
    await app.get(ClinicsActivationService).enable('beta');
    await cls.run(async () => {
      cls.set('workspaceId', workspaceId);
      expect(await experiencias().status(beta, 'clinics')).toBe('ready');
      expect(await experiencias().status(workspaceId, 'clinics')).toBe('unavailable');
      expect(cls.get('workspaceId')).toBe(workspaceId);
    });
  });

  it('ativar o Clinics NÃO muda a experiência do workspace', async () => {
    await app.get(ClinicsActivationService).enable('acme');
    const ws = await prisma.raw.workspace.findFirst({ where: { id: workspaceId } });
    expect(ws?.experience).toBe('crm');
  });

  it('a sessão diz a experiência e o estado dela, sem trocar por outra', async () => {
    // a experiência posta por fora (a CLI ainda a recusa, de propósito)
    await prisma.raw.workspace.update({
      where: { id: workspaceId },
      data: { experience: 'clinics' },
    });
    const indisponivel = await request(http)
      .get('/api/auth/me')
      .set('Cookie', await sessao())
      .expect(200);
    expect(indisponivel.body.experience).toEqual({ key: 'clinics', status: 'unavailable' });

    await app.get(ClinicsActivationService).enable('acme');
    const pronta = await request(http)
      .get('/api/auth/me')
      .set('Cookie', await sessao())
      .expect(200);
    expect(pronta.body.experience).toEqual({ key: 'clinics', status: 'ready' });
    expect(pronta.body.activeMembership.experience).toBe('clinics');
  });
});
