import { INestApplication } from '@nestjs/common';
import type { ClinicsLeadsPageDto } from '@veyra/contracts/verticals/clinics';
import type { DealDto } from '@veyra/contracts';
import request from 'supertest';
import { createTestApp } from '../../../test/integration/app';
import {
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  TEST_PASSWORD,
  type WorkspaceFixture,
} from '../../../test/integration/fixtures';
import { resetDb } from '../../../test/integration/harness';
import { PrismaService } from '../../prisma/prisma.service';
import { ClinicsActivationService } from './clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

/**
 * Interessados (E-3 do ADR-055, adendos 3 e 4): os contatos ativos SEM ficha,
 * paginados no servidor, só com `contacts:read` E `clinics:schedule:read` —
 * a lista é o complemento da de pacientes. E as oportunidades do contato, a
 * rota do Core que a ficha usa. Dados fictícios.
 */
describe('Clinics — Interessados e as oportunidades do contato (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let acme: WorkspaceFixture;
  let ownerMembershipId: string;

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
    acme = await createWorkspaceFixture(prisma, 'acme');
    const ownerId = await createUserFixture(prisma, 'owner@acme.test');
    ownerMembershipId = await createMembershipFixture(
      prisma,
      acme.workspaceId,
      ownerId,
      acme.roles.owner,
    );
    await app.get(ClinicsActivationService).enable('acme');
  });

  const entrar = async (email: string) => {
    const entrada = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: TEST_PASSWORD })
      .expect(201);
    return ((entrada.headers['set-cookie'] as unknown as string[]) ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
  };
  const pessoaCom = async (email: string, papel: 'member' | 'guest' | 'clinics:professional') => {
    const roleId =
      papel === 'clinics:professional'
        ? (await prisma.raw.role.findFirst({
            where: { workspaceId: acme.workspaceId, systemKey: papel },
          }))!.id
        : acme.roles[papel];
    const userId = await createUserFixture(prisma, email);
    await createMembershipFixture(prisma, acme.workspaceId, userId, roleId);
    return entrar(email);
  };
  /** um contato, com o instante de criação controlado (a ordem da lista) */
  const contato = async (
    workspaceId: string,
    name: string,
    createdAt: Date,
    status: 'active' | 'archived' = 'active',
  ) =>
    (
      await prisma.raw.contact.create({
        data: { workspaceId, name, createdAt, status },
      })
    ).id;
  const paciente = async (contactId: string) =>
    prisma.raw.clinicsPatient.create({
      data: {
        workspaceId: acme.workspaceId,
        contactId,
        createdByMembershipId: ownerMembershipId,
      },
    });
  const leads = (cookie: string, query = '') =>
    request(http).get(`/api/clinics/leads${query}`).set('Cookie', cookie);
  const minuto = (n: number) => new Date(Date.UTC(2030, 0, 1, 12, n));

  it('lista só os contatos ATIVOS sem ficha, do mais recente para o mais antigo', async () => {
    const ana = await contato(acme.workspaceId, 'Ana Fictícia', minuto(1));
    const bia = await contato(acme.workspaceId, 'Bia Fictícia', minuto(2));
    await paciente(await contato(acme.workspaceId, 'Caio Paciente', minuto(3)));
    await contato(acme.workspaceId, 'Duda Arquivada', minuto(4), 'archived');
    const res = await leads(await entrar('owner@acme.test')).expect(200);
    const pagina = res.body as ClinicsLeadsPageDto;
    expect(pagina.items.map((i) => i.id)).toEqual([bia, ana]);
    expect(pagina.items[0]).toEqual({
      id: bia,
      name: 'Bia Fictícia',
      createdAt: minuto(2).toISOString(),
    });
    expect(pagina.nextCursor).toBeNull();
  });

  it('isolamento (P0): os contatos sem ficha de OUTRO workspace nunca aparecem', async () => {
    const beta = await createWorkspaceFixture(prisma, 'beta');
    await contato(beta.workspaceId, 'Contato do Beta', minuto(9));
    const nosso = await contato(acme.workspaceId, 'Contato do Acme', minuto(1));
    const res = await leads(await entrar('owner@acme.test')).expect(200);
    expect((res.body as ClinicsLeadsPageDto).items.map((i) => i.id)).toEqual([nosso]);
  });

  it('as DUAS chaves: sem `clinics:schedule:read` (Guest) ou sem `contacts:read` (Profissional), 403; com as duas (Member), 200', async () => {
    await contato(acme.workspaceId, 'Ana Fictícia', minuto(1));
    // o Guest lê contatos, mas não consulta pacientes: deduziria quem é paciente
    await leads(await pessoaCom('guest@acme.test', 'guest')).expect(403);
    // o Profissional consulta pacientes, mas não lê contatos
    await leads(await pessoaCom('prof@acme.test', 'clinics:professional')).expect(403);
    const res = await leads(await pessoaCom('member@acme.test', 'member')).expect(200);
    expect((res.body as ClinicsLeadsPageDto).items).toHaveLength(1);
  });

  it('a paginação por cursor é estável: um contato novo no meio não repete nem pula ninguém', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      ids.push(await contato(acme.workspaceId, `Pessoa ${i}`, minuto(i)));
    }
    const cookie = await entrar('owner@acme.test');
    const primeira = (await leads(cookie, '?limit=2').expect(200)).body as ClinicsLeadsPageDto;
    expect(primeira.items.map((i) => i.id)).toEqual([ids[4], ids[3]]);
    // chegou alguém novo (mais recente) e alguém virou paciente no meio
    await contato(acme.workspaceId, 'Pessoa nova', minuto(30));
    await paciente(ids[2]);
    const segunda = (
      await leads(cookie, `?limit=2&cursor=${encodeURIComponent(primeira.nextCursor!)}`).expect(200)
    ).body as ClinicsLeadsPageDto;
    expect(segunda.items.map((i) => i.id)).toEqual([ids[1], ids[0]]);
    expect(segunda.nextCursor).toBeNull();
    await leads(cookie, '?cursor=nao-e-um-cursor').expect(400);
  });

  it('o cursor desempata pelo id: contatos com o MESMO instante (uma importação) não se repetem nem somem entre páginas', async () => {
    const mesmo = minuto(7);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await contato(acme.workspaceId, `Lote ${i}`, mesmo));
    const esperado = [...ids].sort().reverse();
    const cookie = await entrar('owner@acme.test');
    const vistos: string[] = [];
    let cursor: string | null = null;
    let voltas = 0;
    do {
      // um cursor quebrado repetiria a página: falha clara, não o prazo do Jest
      expect((voltas += 1)).toBeLessThanOrEqual(10);
      const query: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const pagina = (await leads(cookie, query).expect(200)).body as ClinicsLeadsPageDto;
      vistos.push(...pagina.items.map((i) => i.id));
      cursor = pagina.nextCursor;
    } while (cursor);
    expect(vistos).toEqual(esperado);
    // um cursor com data fora da faixa é recusado como cursor, não como erro do banco
    const fora = Buffer.from(`-004713-01-01T00:00:00.000Z|${ids[0]}`).toString('base64url');
    await leads(cookie, `?cursor=${fora}`).expect(400);
  });

  it('a busca é pelo nome, sem diferenciar maiúsculas, e continua excluindo os pacientes', async () => {
    const marina = await contato(acme.workspaceId, 'Marina Fictícia', minuto(1));
    await paciente(await contato(acme.workspaceId, 'Mariana Paciente', minuto(2)));
    await contato(acme.workspaceId, 'Otávio Fictício', minuto(3));
    const res = await leads(await entrar('owner@acme.test'), '?search=MARI').expect(200);
    expect((res.body as ClinicsLeadsPageDto).items.map((i) => i.id)).toEqual([marina]);
  });

  it('com o vertical desativado, a sessão anterior cai (revogação) e a nova é recusada pela rota', async () => {
    const antes = await entrar('owner@acme.test');
    await app.get(ClinicsActivationService).disable('acme');
    await leads(antes).expect(401);
    // desativar revoga as chaves do vertical: sem `clinics:schedule:read`, 403
    await leads(await entrar('owner@acme.test')).expect(403);
  });

  describe('as oportunidades do contato (rota do Core)', () => {
    const negocio = (contactId: string, title: string) =>
      prisma.raw.deal.create({
        data: {
          workspaceId: acme.workspaceId,
          pipelineId: acme.pipelineId,
          stageId: Object.values(acme.stages)[0],
          contactId,
          title,
          position: 0,
        },
      });

    it('lista as do contato, com as duas chaves; sem `pipelines:read` (Profissional não lê nem o contato), 403', async () => {
      const marina = await contato(acme.workspaceId, 'Marina Fictícia', minuto(1));
      const outro = await contato(acme.workspaceId, 'Outro Contato', minuto(2));
      await negocio(marina, 'Clareamento');
      await negocio(outro, 'De outro contato');
      const res = await request(http)
        .get(`/api/contacts/${marina}/deals`)
        .set('Cookie', await pessoaCom('member@acme.test', 'member'))
        .expect(200);
      expect((res.body as DealDto[]).map((d) => d.title)).toEqual(['Clareamento']);
      await request(http)
        .get(`/api/contacts/${marina}/deals`)
        .set('Cookie', await pessoaCom('prof@acme.test', 'clinics:professional'))
        .expect(403);
    });

    it('as DUAS chaves: um papel só com `contacts:read` (sem `pipelines:read`) recebe 403', async () => {
      const marina = await contato(acme.workspaceId, 'Marina Fictícia', minuto(1));
      // nenhum papel de sistema lê contatos sem ler oportunidades: um papel de teste
      const papel = await prisma.raw.role.create({
        data: { workspaceId: acme.workspaceId, name: 'Só contatos', isSystem: false },
      });
      await prisma.raw.rolePermission.create({
        data: { workspaceId: acme.workspaceId, roleId: papel.id, permissionKey: 'contacts:read' },
      });
      const userId = await createUserFixture(prisma, 'so-contatos@acme.test');
      await createMembershipFixture(prisma, acme.workspaceId, userId, papel.id);
      const cookie = await entrar('so-contatos@acme.test');
      await request(http).get(`/api/contacts/${marina}`).set('Cookie', cookie).expect(200);
      await request(http).get(`/api/contacts/${marina}/deals`).set('Cookie', cookie).expect(403);
    });

    it('as DUAS chaves: um papel só com `pipelines:read` (sem `contacts:read`) recebe 403', async () => {
      const marina = await contato(acme.workspaceId, 'Marina Fictícia', minuto(1));
      const papel = await prisma.raw.role.create({
        data: { workspaceId: acme.workspaceId, name: 'Só funil', isSystem: false },
      });
      await prisma.raw.rolePermission.create({
        data: { workspaceId: acme.workspaceId, roleId: papel.id, permissionKey: 'pipelines:read' },
      });
      const userId = await createUserFixture(prisma, 'so-funil@acme.test');
      await createMembershipFixture(prisma, acme.workspaceId, userId, papel.id);
      await request(http)
        .get(`/api/contacts/${marina}/deals`)
        .set('Cookie', await entrar('so-funil@acme.test'))
        .expect(403);
    });

    it('isolamento (P0): o contato de outro workspace é 404, mesmo com oportunidades lá', async () => {
      const beta = await createWorkspaceFixture(prisma, 'beta');
      const deles = await contato(beta.workspaceId, 'Contato do Beta', minuto(1));
      await prisma.raw.deal.create({
        data: {
          workspaceId: beta.workspaceId,
          pipelineId: beta.pipelineId,
          stageId: Object.values(beta.stages)[0],
          contactId: deles,
          title: 'Do Beta',
          position: 0,
        },
      });
      await request(http)
        .get(`/api/contacts/${deles}/deals`)
        .set('Cookie', await entrar('owner@acme.test'))
        .expect(404);
    });
  });
});
