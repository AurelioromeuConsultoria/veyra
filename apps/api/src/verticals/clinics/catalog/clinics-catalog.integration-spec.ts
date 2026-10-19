import { randomUUID } from 'node:crypto';
import { Body, Controller, type INestApplication, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import request from 'supertest';
import { AuthenticatedOnly } from '../../../common/decorators';
import { PrismaService } from '../../../prisma/prisma.service';
import { createTestApp } from '../../../../test/integration/app';
import { TEST_DATABASE_URL } from '../../../../test/integration/db-url';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../../test/integration/fixtures';
import { resetDb } from '../../../../test/integration/harness';
import { esperarBloqueadosPor } from '../../../../test/integration/locks';
import { ClinicsActivationService } from '../clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

/**
 * Rota de TESTE que grava horários sobrepostos CONTORNANDO o contrato (que já
 * recusaria com 400): prova de ponta a ponta que a última linha — o EXCLUDE do
 * banco, 23P01 — responde 409 pelo filtro global, nunca 500, e sem vazar o
 * `detail` do Postgres (ids e valores).
 */
@Controller('_test/clinics')
class OverlapProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @AuthenticatedOnly()
  @Post('overlap')
  async overlap(@Body() body: { professionalId: string; unitId: string }): Promise<{ ok: true }> {
    const base = { professionalId: body.professionalId, unitId: body.unitId, weekday: 2 };
    await this.prisma.db.clinicsWorkingHours.createMany({
      data: [
        { ...base, startMinute: 480, endMinute: 720 },
        { ...base, startMinute: 600, endMinute: 660 },
      ],
    } as never);
    return { ok: true };
  }
}

interface Session {
  cookieHeader: string;
  csrf: string;
}

describe('Clinics — catálogo da clínica (integração, F1.c entrega 1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp([OverlapProbeController]);
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let owner: Session;
  let unitA: string;

  const loginAs = async (email: string): Promise<Session> => {
    const res = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: TEST_PASSWORD })
      .expect(201);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
    return { cookieHeader, csrf: /veyra_csrf=([^;]+)/.exec(cookieHeader)?.[1] ?? '' };
  };
  const send = (method: 'post' | 'patch' | 'put', path: string, s: Session, body?: unknown) =>
    request(http)
      [method](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send((body ?? {}) as object);
  const post = (path: string, s: Session, body?: unknown) => send('post', path, s, body);
  const patch = (path: string, s: Session, body?: unknown) => send('patch', path, s, body);
  const put = (path: string, s: Session, body?: unknown) => send('put', path, s, body);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

  const novoServico = (s: Session = owner, body: Record<string, unknown> = {}) =>
    post('/api/clinics/services', s, { name: 'Limpeza de pele', durationMin: 60, ...body });
  const novoProfissional = (s: Session = owner, name = 'Ana Souza') =>
    post('/api/clinics/professionals', s, { name });
  const semana = (unitId: string, ...faixas: [number, number, number][]) => ({
    intervals: faixas.map(([weekday, startMinute, endMinute]) => ({
      unitId,
      weekday,
      startMinute,
      endMinute,
    })),
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    for (const systemKey of ['owner', 'admin', 'member', 'guest']) {
      const user = await createUserFixture(prisma, `${systemKey}-a@veyra.test`);
      await createMembershipFixture(prisma, wsA.workspaceId, user, wsA.roles[systemKey]);
    }
    const ownerB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, ownerB, wsB.roles.owner);
    await app.get(ClinicsActivationService).enable('acme');
    owner = await loginAs('owner-a@veyra.test');
    unitA = (await prisma.raw.clinicsUnit.findFirst({ where: { workspaceId: wsA.workspaceId } }))!
      .id;
  });

  // ── RBAC ──────────────────────────────────────────────────────────────────

  describe('permissões', () => {
    it('workspace SEM o Clinics: 403 em toda rota do catálogo (o guard de permissão vem antes)', async () => {
      const donoB = await loginAs('owner-b@veyra.test');
      await get('/api/clinics/units', donoB).expect(403);
      await get('/api/clinics/services', donoB).expect(403);
      await get('/api/clinics/professionals', donoB).expect(403);
      await novoServico(donoB).expect(403);
    });

    it('Member (recepção) e Profissional leem, inclusive o preço, mas não escrevem; Guest nem lê', async () => {
      await novoServico(owner, { priceCents: 15000 }).expect(201);
      const profissional = await prisma.raw.role.findFirst({
        where: { workspaceId: wsA.workspaceId, systemKey: 'clinics:professional' },
      });
      const userProf = await createUserFixture(prisma, 'prof-a@veyra.test');
      await createMembershipFixture(prisma, wsA.workspaceId, userProf, profissional!.id);

      const servico = (await get('/api/clinics/services', owner).expect(200)).body[0].id as string;
      const prof = (await novoProfissional(owner).expect(201)).body.id as string;
      // TODA rota de escrita do catálogo, com corpo válido: o 403 tem de vir da
      // permissão, não de validação
      const escritas: [string, () => request.Test][] = [];
      const escrever = (s: Session) => {
        escritas.length = 0;
        escritas.push(
          ['POST services', () => novoServico(s)],
          ['PATCH services', () => patch(`/api/clinics/services/${servico}`, s, { name: 'X' })],
          ['archive service', () => post(`/api/clinics/services/${servico}/archive`, s)],
          ['unarchive service', () => post(`/api/clinics/services/${servico}/unarchive`, s)],
          ['PATCH unit', () => patch(`/api/clinics/units/${unitA}`, s, { name: 'X' })],
          ['POST professionals', () => novoProfissional(s)],
          [
            'PATCH professional',
            () => patch(`/api/clinics/professionals/${prof}`, s, { name: 'X' }),
          ],
          ['archive professional', () => post(`/api/clinics/professionals/${prof}/archive`, s)],
          ['unarchive professional', () => post(`/api/clinics/professionals/${prof}/unarchive`, s)],
          [
            'PUT account',
            () => put(`/api/clinics/professionals/${prof}/account`, s, { membershipId: null }),
          ],
          [
            'PUT services',
            () => put(`/api/clinics/professionals/${prof}/services`, s, { serviceIds: [] }),
          ],
          [
            'PUT hours',
            () => put(`/api/clinics/professionals/${prof}/working-hours`, s, { intervals: [] }),
          ],
        );
        return escritas;
      };

      for (const email of ['member-a@veyra.test', 'prof-a@veyra.test']) {
        const s = await loginAs(email);
        const lista = await get('/api/clinics/services', s).expect(200);
        expect(lista.body[0]).toMatchObject({ priceCents: 15000 });
        await get('/api/clinics/professionals', s).expect(200);
        await get('/api/clinics/units', s).expect(200);
        for (const [rota, chamar] of escrever(s)) {
          expect([rota, (await chamar()).status]).toEqual([rota, 403]);
        }
      }
      expect(escritas).toHaveLength(12);
      const guest = await loginAs('guest-a@veyra.test');
      await get('/api/clinics/services', guest).expect(403);
    });

    it('vincular conta exige também `members:read`; o resto do catálogo, não', async () => {
      // papel customizado com catalog:manage e SEM members:read
      const role = await prisma.raw.role.create({
        data: { workspaceId: wsA.workspaceId, name: 'Gestor do catálogo', isSystem: false },
      });
      await prisma.raw.rolePermission.createMany({
        data: ['clinics:catalog:read', 'clinics:catalog:manage'].map((permissionKey) => ({
          workspaceId: wsA.workspaceId,
          roleId: role.id,
          permissionKey,
        })),
      });
      const user = await createUserFixture(prisma, 'gestor-a@veyra.test');
      const membershipId = await createMembershipFixture(prisma, wsA.workspaceId, user, role.id);
      const gestor = await loginAs('gestor-a@veyra.test');

      const prof = (await novoProfissional(gestor).expect(201)).body.id as string;
      await put(`/api/clinics/professionals/${prof}/working-hours`, gestor, semana(unitA)).expect(
        200,
      );
      await put(`/api/clinics/professionals/${prof}/account`, gestor, { membershipId }).expect(403);
      await put(`/api/clinics/professionals/${prof}/account`, owner, { membershipId }).expect(200);
    });

    it('caso residual: chave presente com o Clinics desativado → 404', async () => {
      await app.get(ClinicsActivationService).disable('acme');
      await prisma.raw.rolePermission.create({
        data: {
          workspaceId: wsA.workspaceId,
          roleId: wsA.roles.owner,
          permissionKey: 'clinics:catalog:read',
        },
      });
      const s = await loginAs('owner-a@veyra.test');
      await get('/api/clinics/services', s).expect(404);
      await get('/api/clinics/units', s).expect(404);
    });
  });

  // ── Isolamento (P0) e FKs compostas ───────────────────────────────────────

  describe('isolamento por workspace (P0)', () => {
    it('B, também com o Clinics, não vê nem altera nada do catálogo de A', async () => {
      const servicoA = (await novoServico(owner).expect(201)).body.id as string;
      const profA = (await novoProfissional(owner).expect(201)).body.id as string;
      await app.get(ClinicsActivationService).enable('beta');
      const donoB = await loginAs('owner-b@veyra.test');

      expect((await get('/api/clinics/services', donoB).expect(200)).body).toEqual([]);
      expect((await get('/api/clinics/professionals', donoB).expect(200)).body).toEqual([]);
      const unidadesB = (await get('/api/clinics/units', donoB).expect(200)).body;
      expect(unidadesB.map((u: { id: string }) => u.id)).not.toContain(unitA);

      await patch(`/api/clinics/services/${servicoA}`, donoB, { name: 'X' }).expect(404);
      await post(`/api/clinics/services/${servicoA}/archive`, donoB).expect(404);
      await patch(`/api/clinics/professionals/${profA}`, donoB, { name: 'X' }).expect(404);
      await put(`/api/clinics/professionals/${profA}/working-hours`, donoB, semana(unitA)).expect(
        404,
      );
      await patch(`/api/clinics/units/${unitA}`, donoB, { name: 'X' }).expect(404);

      // B tenta habilitar serviço de A e usar unidade de A no PRÓPRIO profissional
      const profB = (await novoProfissional(donoB).expect(201)).body.id as string;
      await put(`/api/clinics/professionals/${profB}/services`, donoB, {
        serviceIds: [servicoA],
      }).expect(400);
      await put(
        `/api/clinics/professionals/${profB}/working-hours`,
        donoB,
        semana(unitA, [1, 480, 720]),
      ).expect(400);

      const servicoIntacto = await prisma.raw.clinicsService.findFirst({ where: { id: servicoA } });
      expect(servicoIntacto).toMatchObject({ name: 'Limpeza de pele', archivedAt: null });
    });

    it('client protegido: cada workspace só enxerga as próprias linhas das quatro tabelas novas', async () => {
      await app.get(ClinicsActivationService).enable('beta');
      const donoB = await loginAs('owner-b@veyra.test');
      for (const s of [owner, donoB]) {
        const serv = (await novoServico(s).expect(201)).body.id as string;
        const prof = (await novoProfissional(s).expect(201)).body.id as string;
        const unit = (await get('/api/clinics/units', s).expect(200)).body[0].id as string;
        await put(`/api/clinics/professionals/${prof}/services`, s, { serviceIds: [serv] }).expect(
          200,
        );
        await put(
          `/api/clinics/professionals/${prof}/working-hours`,
          s,
          semana(unit, [1, 480, 720]),
        ).expect(200);
      }
      const cls = app.get(ClsService);
      await cls.run(async () => {
        cls.set('workspaceId', wsA.workspaceId);
        for (const rows of [
          await prisma.db.clinicsService.findMany(),
          await prisma.db.clinicsProfessional.findMany(),
          await prisma.db.clinicsProfessionalService.findMany(),
          await prisma.db.clinicsWorkingHours.findMany(),
        ]) {
          expect(rows).toHaveLength(1);
          expect(rows.every((r) => r.workspaceId === wsA.workspaceId)).toBe(true);
        }
      });
      await cls.run(async () => {
        await expect(prisma.db.clinicsWorkingHours.findMany()).rejects.toThrow();
      });
    });

    it('FK composta: nada do catálogo aponta para conta, profissional, serviço ou unidade de outro workspace', async () => {
      const a = wsA.workspaceId;
      const b = wsB.workspaceId;
      const membroB = await prisma.raw.membership.findFirst({ where: { workspaceId: b } });
      const unitB = await prisma.raw.clinicsUnit.create({ data: { workspaceId: b, name: 'UB' } });
      const profA = await prisma.raw.clinicsProfessional.create({
        data: { workspaceId: a, name: 'P' },
      });
      const servB = await prisma.raw.clinicsService.create({
        data: { workspaceId: b, name: 'S', durationMin: 30 },
      });
      const servA = await prisma.raw.clinicsService.create({
        data: { workspaceId: a, name: 'S', durationMin: 30 },
      });
      const profB = await prisma.raw.clinicsProfessional.create({
        data: { workspaceId: b, name: 'PB' },
      });
      const fk = { code: 'P2003' };
      await expect(
        prisma.raw.clinicsProfessional.create({
          data: { workspaceId: a, name: 'P2', membershipId: membroB!.id },
        }),
      ).rejects.toMatchObject(fk);
      await expect(
        prisma.raw.clinicsProfessionalService.create({
          data: { workspaceId: a, professionalId: profA.id, serviceId: servB.id },
        }),
      ).rejects.toMatchObject(fk);
      await expect(
        prisma.raw.clinicsProfessionalService.create({
          data: { workspaceId: a, professionalId: profB.id, serviceId: servA.id },
        }),
      ).rejects.toMatchObject(fk);
      await expect(
        prisma.raw.clinicsWorkingHours.create({
          data: {
            workspaceId: a,
            professionalId: profA.id,
            unitId: unitB.id,
            weekday: 1,
            startMinute: 0,
            endMinute: 60,
          },
        }),
      ).rejects.toMatchObject(fk);
      await expect(
        prisma.raw.clinicsWorkingHours.create({
          data: {
            workspaceId: a,
            professionalId: profB.id,
            unitId: unitA,
            weekday: 1,
            startMinute: 0,
            endMinute: 60,
          },
        }),
      ).rejects.toMatchObject(fk);
    });

    it('excluir o WORKSPACE leva o catálogo inteiro em cascata, passando pelas FKs NO ACTION internas', async () => {
      const serv = (await novoServico(owner).expect(201)).body.id as string;
      const prof = (await novoProfissional(owner).expect(201)).body.id as string;
      const membro = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsA.workspaceId, role: { systemKey: 'member' } },
      });
      await put(`/api/clinics/professionals/${prof}/account`, owner, {
        membershipId: membro!.id,
      }).expect(200);
      await put(`/api/clinics/professionals/${prof}/services`, owner, {
        serviceIds: [serv],
      }).expect(200);
      await put(
        `/api/clinics/professionals/${prof}/working-hours`,
        owner,
        semana(unitA, [1, 480, 720]),
      ).expect(200);

      await prisma.raw.workspace.deleteMany({ where: { id: wsA.workspaceId } });
      for (const restantes of [
        await prisma.raw.clinicsService.count({ where: { workspaceId: wsA.workspaceId } }),
        await prisma.raw.clinicsProfessional.count({ where: { workspaceId: wsA.workspaceId } }),
        await prisma.raw.clinicsProfessionalService.count({
          where: { workspaceId: wsA.workspaceId },
        }),
        await prisma.raw.clinicsWorkingHours.count({ where: { workspaceId: wsA.workspaceId } }),
        await prisma.raw.clinicsUnit.count({ where: { workspaceId: wsA.workspaceId } }),
      ]) {
        expect(restantes).toBe(0);
      }
      // o outro workspace não é tocado
      expect(await prisma.raw.workspace.count({ where: { id: wsB.workspaceId } })).toBe(1);
    });
  });

  // ── Unidade ───────────────────────────────────────────────────────────────

  describe('unidade', () => {
    it('uma só, com fuso padrão; edita nome e fuso IANA; fuso inválido e corpo vazio são 400', async () => {
      const lista = (await get('/api/clinics/units', owner).expect(200)).body;
      expect(lista).toEqual([
        { id: unitA, name: 'Unidade principal', timezone: 'America/Sao_Paulo' },
      ]);

      const editada = await patch(`/api/clinics/units/${unitA}`, owner, {
        name: 'Centro',
        timezone: 'America/Manaus',
      }).expect(200);
      expect(editada.body).toEqual({ id: unitA, name: 'Centro', timezone: 'America/Manaus' });
      await patch(`/api/clinics/units/${unitA}`, owner, { timezone: 'Marte/Fobos' }).expect(400);
      // o construtor do Intl aceitaria offsets e zonas POSIX (sinal invertido no
      // Postgres); a lista IANA canônica, não
      for (const timezone of ['+03:00', 'Etc/GMT+3', 'x'.repeat(65)]) {
        await patch(`/api/clinics/units/${unitA}`, owner, { timezone }).expect(400);
      }
      // caixa diferente é CANONIZADA, não gravada como veio
      const canonizada = await patch(`/api/clinics/units/${unitA}`, owner, {
        timezone: 'america/sao_paulo',
      }).expect(200);
      expect(canonizada.body.timezone).toBe('America/Sao_Paulo');
      await patch(`/api/clinics/units/${unitA}`, owner, { timezone: 'America/Manaus' }).expect(200);
      await patch(`/api/clinics/units/${unitA}`, owner, {}).expect(400);
      await post('/api/clinics/units', owner, { name: 'Filial' }).expect(404); // não há criação

      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.unit.updated' },
      });
      expect(trilha).toMatchObject({
        before: { name: 'Unidade principal', timezone: 'America/Sao_Paulo' },
        after: { name: 'Centro', timezone: 'America/Manaus' },
      });
    });
  });

  // ── Serviços ──────────────────────────────────────────────────────────────

  describe('serviços', () => {
    it('cria com BRL e sem preço por padrão; valida duração, preço, moeda e campos estranhos', async () => {
      const criado = await novoServico(owner).expect(201);
      expect(criado.body).toMatchObject({
        name: 'Limpeza de pele',
        durationMin: 60,
        priceCents: null,
        currency: 'BRL',
        archivedAt: null,
      });
      for (const body of [
        { durationMin: 7 },
        { durationMin: 0 },
        { durationMin: 485 },
        { priceCents: 99.5 },
        { priceCents: -1 },
        { currency: 'USD' },
        { cor: 'azul' },
        { name: '' },
      ]) {
        await novoServico(owner, body).expect(400);
      }
    });

    it('PATCH parcial não zera o preço; a trilha de serviço (classe C) leva os valores', async () => {
      const id = (await novoServico(owner, { priceCents: 15000 }).expect(201)).body.id as string;
      const editado = await patch(`/api/clinics/services/${id}`, owner, { durationMin: 90 }).expect(
        200,
      );
      expect(editado.body).toMatchObject({ durationMin: 90, priceCents: 15000 });
      await patch(`/api/clinics/services/${id}`, owner, {}).expect(400);
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.service.updated' },
      });
      expect(trilha).toMatchObject({ before: { durationMin: 60 }, after: { durationMin: 90 } });
    });

    it('arquivar some da lista (exceto com includeArchived), é idempotente e desarquiva', async () => {
      const id = (await novoServico(owner).expect(201)).body.id as string;
      await post(`/api/clinics/services/${id}/archive`, owner).expect(201);
      await post(`/api/clinics/services/${id}/archive`, owner).expect(201);
      expect((await get('/api/clinics/services', owner).expect(200)).body).toEqual([]);
      const todos = (await get('/api/clinics/services?includeArchived=true', owner).expect(200))
        .body;
      expect(todos).toHaveLength(1);
      expect(todos[0].archivedAt).not.toBeNull();
      await get('/api/clinics/services?includeArchived=sim', owner).expect(400);
      expect(
        await prisma.raw.auditLog.count({ where: { action: 'clinics.service.archived' } }),
      ).toBe(1);
      await post(`/api/clinics/services/${id}/unarchive`, owner).expect(201);
      expect((await get('/api/clinics/services', owner).expect(200)).body).toHaveLength(1);
      await post(`/api/clinics/services/${randomUUID()}/archive`, owner).expect(404);
    });
  });

  // ── Profissionais ─────────────────────────────────────────────────────────

  describe('profissionais', () => {
    it('o NOME do profissional nunca aparece na trilha (classe P)', async () => {
      const id = (await novoProfissional(owner, 'Beatriz Nogueira').expect(201)).body.id as string;
      await patch(`/api/clinics/professionals/${id}`, owner, { name: 'Beatriz N. Lima' }).expect(
        200,
      );
      const trilhas = await prisma.raw.auditLog.findMany({
        where: { entityType: 'clinicsProfessional' },
      });
      expect(trilhas.length).toBe(2);
      const texto = JSON.stringify(trilhas.map((t) => [t.before, t.after]));
      expect(texto).not.toMatch(/Beatriz|Nogueira|Lima/);
      expect(texto).toContain('[changed]');
    });

    it('vínculo com conta: só conta ativa, uma por profissional, e a remoção do membro aparece', async () => {
      const ana = (await novoProfissional(owner, 'Ana').expect(201)).body.id as string;
      const bia = (await novoProfissional(owner, 'Bia').expect(201)).body.id as string;
      const membro = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsA.workspaceId, role: { systemKey: 'member' } },
      });
      const membroB = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsB.workspaceId },
      });

      const vinculada = await put(`/api/clinics/professionals/${ana}/account`, owner, {
        membershipId: membro!.id,
      }).expect(200);
      expect(vinculada.body.account).toEqual({ membershipId: membro!.id, active: true });
      // vincular não muda papel nenhum
      expect((await prisma.raw.membership.findFirst({ where: { id: membro!.id } }))!.roleId).toBe(
        wsA.roles.member,
      );

      await put(`/api/clinics/professionals/${bia}/account`, owner, {
        membershipId: membro!.id,
      }).expect(409);
      await put(`/api/clinics/professionals/${bia}/account`, owner, {
        membershipId: membroB!.id,
      }).expect(400); // de outro workspace: "não encontrada"
      await put(`/api/clinics/professionals/${bia}/account`, owner, {
        membershipId: randomUUID(),
      }).expect(400);

      // membro removido depois: o vínculo fica, sinalizado
      await prisma.raw.membership.updateMany({
        where: { id: membro!.id },
        data: { status: 'removed' },
      });
      const lista = (await get('/api/clinics/professionals', owner).expect(200)).body;
      expect(lista.find((p: { id: string }) => p.id === ana).account).toEqual({
        membershipId: membro!.id,
        active: false,
      });
      // e uma conta removida não pode ser vinculada de novo a OUTRO profissional
      await put(`/api/clinics/professionals/${bia}/account`, owner, {
        membershipId: membro!.id,
      }).expect(400);
      // repetir o MESMO vínculo não faz nada (nem revalida a conta já removida)
      const repetido = await put(`/api/clinics/professionals/${ana}/account`, owner, {
        membershipId: membro!.id,
      }).expect(200);
      expect(repetido.body.account).toEqual({ membershipId: membro!.id, active: false });

      const desfeito = await put(`/api/clinics/professionals/${ana}/account`, owner, {
        membershipId: null,
      }).expect(200);
      expect(desfeito.body.account).toBeNull();
      const acoes = (
        await prisma.raw.auditLog.findMany({
          where: { action: { startsWith: 'clinics.professional.account_' } },
          orderBy: { createdAt: 'asc' },
        })
      ).map((t) => t.action);
      expect(acoes).toEqual([
        'clinics.professional.account_linked',
        'clinics.professional.account_unlinked',
      ]);
    });

    it('serviços habilitados: conjunto substituído; arquivado, de outro workspace ou repetido é recusado', async () => {
      const prof = (await novoProfissional(owner).expect(201)).body.id as string;
      const a = (await novoServico(owner, { name: 'A' }).expect(201)).body.id as string;
      const b = (await novoServico(owner, { name: 'B' }).expect(201)).body.id as string;
      const c = (await novoServico(owner, { name: 'C' }).expect(201)).body.id as string;
      await post(`/api/clinics/services/${c}/archive`, owner).expect(201);

      const rota = `/api/clinics/professionals/${prof}/services`;
      expect((await put(rota, owner, { serviceIds: [b, a] }).expect(200)).body.serviceIds).toEqual(
        [a, b].sort(),
      );
      expect((await put(rota, owner, { serviceIds: [b] }).expect(200)).body.serviceIds).toEqual([
        b,
      ]);
      await put(rota, owner, { serviceIds: [b, c] }).expect(400);
      await put(rota, owner, { serviceIds: [b, b] }).expect(400);
      await put(rota, owner, { serviceIds: ['nao-e-uuid'] }).expect(400);
      expect((await put(rota, owner, { serviceIds: [] }).expect(200)).body.serviceIds).toEqual([]);
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.professional.services_replaced' },
        orderBy: { createdAt: 'asc' },
      });
      expect(trilha!.after).toEqual({ serviceIds: [b, a] }); // como pedido
    });

    it('horários: semana com pausa, faixas contíguas; sobreposição e faixas inválidas são 400; a trilha só conta', async () => {
      const prof = (await novoProfissional(owner).expect(201)).body.id as string;
      const rota = `/api/clinics/professionals/${prof}/working-hours`;
      const ok = await put(
        rota,
        owner,
        semana(unitA, [1, 480, 720], [1, 780, 1080], [3, 720, 780], [3, 780, 840]),
      ).expect(200);
      expect(ok.body.workingHours).toHaveLength(4);

      // segunda unidade, só para provar que a regra vale ENTRE unidades
      const unitB = await prisma.raw.clinicsUnit.create({
        data: { workspaceId: wsA.workspaceId, name: 'Filial' },
      });
      for (const corpo of [
        semana(unitA, [1, 480, 720], [1, 700, 800]),
        {
          intervals: [
            ...semana(unitA, [2, 480, 720]).intervals,
            ...semana(unitB.id, [2, 600, 660]).intervals,
          ],
        },
        semana(unitA, [8, 0, 60]),
        semana(unitA, [1, 600, 600]),
        semana(unitA, [1, 0, 1441]),
      ]) {
        await put(rota, owner, corpo).expect(400);
      }
      // nada mudou com as recusas
      expect(
        (await get('/api/clinics/professionals', owner).expect(200)).body[0].workingHours,
      ).toHaveLength(4);

      await prisma.raw.clinicsUnit.updateMany({
        where: { id: unitB.id },
        data: { archivedAt: new Date() },
      });
      await put(rota, owner, semana(unitB.id, [5, 480, 720])).expect(400);

      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.professional.hours_replaced' },
      });
      expect(trilha!.after).toEqual({ intervalCount: 4 });
      expect(JSON.stringify(trilha!.after)).not.toMatch(/480|720/);
    });

    it('trocar a semana por outra que SOBREPÕE a anterior funciona (apagar e inserir na mesma transação)', async () => {
      const prof = (await novoProfissional(owner).expect(201)).body.id as string;
      const rota = `/api/clinics/professionals/${prof}/working-hours`;
      await put(rota, owner, semana(unitA, [1, 480, 720], [2, 480, 720])).expect(200);
      const nova = await put(rota, owner, semana(unitA, [1, 600, 900], [2, 540, 600])).expect(200);
      expect(nova.body.workingHours).toEqual([
        { unitId: unitA, weekday: 1, startMinute: 600, endMinute: 900 },
        { unitId: unitA, weekday: 2, startMinute: 540, endMinute: 600 },
      ]);
    });

    it('sobreposição que passa do contrato: o EXCLUDE do banco (23P01) responde 409, nunca 500, sem vazar o detalhe', async () => {
      const prof = (await novoProfissional(owner).expect(201)).body.id as string;
      const res = await post('/api/_test/clinics/overlap', owner, {
        professionalId: prof,
        unitId: unitA,
      }).expect(409);
      expect(JSON.stringify(res.body)).not.toMatch(/Key \(|conflicts with|int4range|[0-9a-f]{8}-/);
      expect(await prisma.raw.clinicsWorkingHours.count()).toBe(0);
    });

    it('toda substituição (conta, serviços, semana) TRAVA a linha do profissional antes de escrever', async () => {
      const prof = (await novoProfissional(owner).expect(201)).body.id as string;
      const rotas: [string, unknown][] = [
        [`/api/clinics/professionals/${prof}/account`, { membershipId: null }],
        [`/api/clinics/professionals/${prof}/services`, { serviceIds: [] }],
        [`/api/clinics/professionals/${prof}/working-hours`, { intervals: [] }],
      ];
      for (const [rota, corpo] of rotas) {
        const trava = new Client({ connectionString: TEST_DATABASE_URL });
        await trava.connect();
        try {
          await trava.query('BEGIN');
          // NO KEY UPDATE: barra a trava do serviço (UPDATE da linha), mas não as
          // checagens de FK (KEY SHARE) — só a trava explícita fica esperando
          await trava.query(
            'SELECT 1 FROM "ClinicsProfessional" WHERE "id" = $1 FOR NO KEY UPDATE',
            [prof],
          );
          let respondeu: number | null = null;
          const pedido = put(rota, owner, corpo).then((res) => {
            respondeu = res.status;
            return res;
          });
          await esperarBloqueadosPor(trava, 1, {
            descricao: `substituição em ${rota.split('/').pop()}`,
            aCadaTentativa: () => {
              if (respondeu !== null) {
                throw new Error(`${rota} respondeu ${respondeu} SEM esperar a trava`);
              }
            },
          });
          await trava.query('COMMIT');
          expect((await pedido).status).toBe(200);
        } finally {
          await trava.end();
        }
      }
    });

    it('duas substituições simultâneas da semana viram seriais: o resultado é uma delas, inteira', async () => {
      const prof = (await novoProfissional(owner).expect(201)).body.id as string;
      const rota = `/api/clinics/professionals/${prof}/working-hours`;
      const manha = semana(unitA, [1, 480, 720], [2, 480, 720]);
      const tarde = semana(unitA, [1, 780, 1080], [4, 780, 1080], [5, 780, 1080]);
      const [r1, r2] = await Promise.all([put(rota, owner, manha), put(rota, owner, tarde)]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      const final = (await get('/api/clinics/professionals', owner).expect(200)).body[0]
        .workingHours as { weekday: number; startMinute: number }[];
      const assinatura = final.map((i) => `${i.weekday}:${i.startMinute}`).sort();
      expect([
        ['1:480', '2:480'],
        ['1:780', '4:780', '5:780'],
      ]).toContainEqual(assinatura);
    });

    it('arquivar profissional: some da lista, é idempotente; o catálogo sobrevive a disable e enable', async () => {
      const prof = (await novoProfissional(owner).expect(201)).body.id as string;
      await novoServico(owner).expect(201);
      await post(`/api/clinics/professionals/${prof}/archive`, owner).expect(201);
      await post(`/api/clinics/professionals/${prof}/archive`, owner).expect(201);
      expect((await get('/api/clinics/professionals', owner).expect(200)).body).toEqual([]);
      expect(
        await prisma.raw.auditLog.count({ where: { action: 'clinics.professional.archived' } }),
      ).toBe(1);

      const ativacao = app.get(ClinicsActivationService);
      await ativacao.disable('acme');
      await ativacao.enable('acme');
      const s = await loginAs('owner-a@veyra.test');
      expect((await get('/api/clinics/services', s).expect(200)).body).toHaveLength(1);
      expect(
        (await get('/api/clinics/professionals?includeArchived=true', s).expect(200)).body,
      ).toHaveLength(1);
    });
  });
});
