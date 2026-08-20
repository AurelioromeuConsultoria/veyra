import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

describe('CRM — contatos, empresas, tags e custom fields (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });

  let sessionA: Session;
  let sessionB: Session;
  let guestA: Session;
  let memberMembershipA: string;

  async function loginAs(email: string): Promise<Session> {
    const res = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: TEST_PASSWORD })
      .expect(201);
    const setCookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
    const csrf = /veyra_csrf=([^;]+)/.exec(cookieHeader)?.[1] ?? '';
    return { cookieHeader, csrf };
  }

  function post(path: string, session: Session, body: unknown) {
    return request(http)
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send(body as object);
  }
  function patch(path: string, session: Session, body: unknown) {
    return request(http)
      .patch(path)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send(body as object);
  }
  function del(path: string, session: Session) {
    return request(http)
      .delete(path)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf);
  }
  function get(path: string, session: Session) {
    return request(http).get(path).set('Cookie', session.cookieHeader);
  }

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    const a = await createWorkspaceFixture(prisma, 'acme');
    const b = await createWorkspaceFixture(prisma, 'beta');

    const ownerAId = await createUserFixture(prisma, 'owner-a@veyra.test');
    await createMembershipFixture(prisma, a.workspaceId, ownerAId, a.roles.owner);
    const memberAId = await createUserFixture(prisma, 'member-a@veyra.test');
    memberMembershipA = await createMembershipFixture(
      prisma,
      a.workspaceId,
      memberAId,
      a.roles.member,
    );
    const ownerBId = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, b.workspaceId, ownerBId, b.roles.owner);
    const guestAId = await createUserFixture(prisma, 'guest-a@veyra.test');
    await createMembershipFixture(prisma, a.workspaceId, guestAId, a.roles.guest);
    sessionA = await loginAs('owner-a@veyra.test');
    sessionB = await loginAs('owner-b@veyra.test');
    guestA = await loginAs('guest-a@veyra.test');
  });

  it('CRUD de contato ponta a ponta com empresa, tag, dono e custom field', async () => {
    // configuração: custom field + tag + empresa
    await post('/api/custom-fields', sessionA, {
      entityType: 'contact',
      key: 'origem_detalhe',
      label: 'Detalhe da origem',
      type: 'select',
      options: ['indicação', 'evento', 'site'],
    }).expect(201);
    const tag = (await post('/api/tags', sessionA, { name: 'VIP', color: 'accent' }).expect(201))
      .body;
    const company = (
      await post('/api/companies', sessionA, { name: 'Acme Ltda', domain: 'acme.com.br' }).expect(
        201,
      )
    ).body;

    // create
    const created = (
      await post('/api/contacts', sessionA, {
        name: 'Ana Prospect',
        emails: ['ana@acme.com.br'],
        companyId: company.id,
        ownerMembershipId: memberMembershipA,
        tagIds: [tag.id],
        customFields: { origem_detalhe: 'indicação' },
      }).expect(201)
    ).body;
    expect(created.companyName).toBe('Acme Ltda');
    expect(created.ownerName).toBe('member-a');
    expect(created.tags.map((t: { name: string }) => t.name)).toEqual(['VIP']);
    expect(created.customFields.origem_detalhe).toBe('indicação');

    // list com busca e filtro
    const listed = (await get('/api/contacts?search=ana', sessionA).expect(200)).body;
    expect(listed.total).toBe(1);
    const byTag = (await get(`/api/contacts?tagId=${tag.id}`, sessionA).expect(200)).body;
    expect(byTag.total).toBe(1);

    // update: arquivar e limpar tag
    const updated = (
      await patch(`/api/contacts/${created.id}`, sessionA, {
        status: 'archived',
        tagIds: [],
      }).expect(200)
    ).body;
    expect(updated.status).toBe('archived');
    expect(updated.tags).toEqual([]);
    expect((await get('/api/contacts', sessionA).expect(200)).body.total).toBe(0); // default: active
    expect((await get('/api/contacts?status=archived', sessionA).expect(200)).body.total).toBe(1);

    // delete limpa custom values (sem FK) e junções
    await del(`/api/contacts/${created.id}`, sessionA).expect(200);
    const orphanValues = await prisma.raw.customFieldValue.count({
      where: { entityId: created.id },
    });
    expect(orphanValues).toBe(0);
  });

  it('P0: dois workspaces não veem contatos, empresas ou tags um do outro', async () => {
    const contactA = (await post('/api/contacts', sessionA, { name: 'Só do A' }).expect(201)).body;
    await post('/api/contacts', sessionB, { name: 'Só do B' }).expect(201);
    await post('/api/tags', sessionA, { name: 'tag-a' }).expect(201);

    const listB = (await get('/api/contacts', sessionB).expect(200)).body;
    expect(listB.total).toBe(1);
    expect(listB.items[0].name).toBe('Só do B');

    // acesso direto por id de outro workspace: 404, nunca o dado
    await get(`/api/contacts/${contactA.id}`, sessionB).expect(404);
    await patch(`/api/contacts/${contactA.id}`, sessionB, { name: 'invadido' }).expect(404);
    await del(`/api/contacts/${contactA.id}`, sessionB).expect(404);

    // tags de A invisíveis para B
    expect((await get('/api/tags', sessionB).expect(200)).body).toEqual([]);
  });

  it('referência cross-workspace é rejeitada (tag/empresa/dono de outro workspace)', async () => {
    const tagB = (await post('/api/tags', sessionB, { name: 'tag-b' }).expect(201)).body;
    const companyB = (await post('/api/companies', sessionB, { name: 'Beta Corp' }).expect(201))
      .body;

    await post('/api/contacts', sessionA, { name: 'X', tagIds: [tagB.id] }).expect(400);
    await post('/api/contacts', sessionA, { name: 'X', companyId: companyB.id }).expect(400);
    // membership de outro workspace como dono → inválido
    const ownerB = await prisma.raw.membership.findFirst({
      where: { workspace: { slug: 'beta' } },
    });
    await post('/api/contacts', sessionA, {
      name: 'X',
      ownerMembershipId: ownerB!.id,
    }).expect(400);
  });

  it('custom fields: valida tipo, opções, obrigatório e chave desconhecida', async () => {
    await post('/api/custom-fields', sessionA, {
      entityType: 'contact',
      key: 'nota',
      label: 'Nota',
      type: 'number',
      required: true,
    }).expect(201);

    // obrigatório ausente no create
    await post('/api/contacts', sessionA, { name: 'Sem nota' }).expect(400);
    // tipo errado
    await post('/api/contacts', sessionA, {
      name: 'Nota errada',
      customFields: { nota: 'dez' },
    }).expect(400);
    // chave desconhecida
    await post('/api/contacts', sessionA, {
      name: 'Chave',
      customFields: { nota: 10, inexistente: 1 },
    }).expect(400);
    // válido
    const ok = (
      await post('/api/contacts', sessionA, {
        name: 'Com nota',
        customFields: { nota: 10 },
      }).expect(201)
    ).body;
    expect(ok.customFields.nota).toBe(10);
    // update não pode limpar required
    await patch(`/api/contacts/${ok.id}`, sessionA, { customFields: { nota: null } }).expect(400);
    // definição é config: guest/member não criam; workspace:manage exigida
    await post('/api/custom-fields', guestA, {
      entityType: 'contact',
      key: 'x',
      label: 'X',
      type: 'text',
    }).expect(403);
  });

  it('empresas: unique de domínio por workspace; delete desvincula contatos', async () => {
    const company = (
      await post('/api/companies', sessionA, { name: 'Acme', domain: 'acme.dev' }).expect(201)
    ).body;
    await post('/api/companies', sessionA, { name: 'Clone', domain: 'acme.dev' }).expect(400);
    // mesmo domínio em OUTRO workspace é permitido (unique é tenant-scoped)
    await post('/api/companies', sessionB, { name: 'Beta', domain: 'acme.dev' }).expect(201);

    const contact = (
      await post('/api/contacts', sessionA, { name: 'Vinculada', companyId: company.id }).expect(
        201,
      )
    ).body;
    await del(`/api/companies/${company.id}`, sessionA).expect(200);
    const after = (await get(`/api/contacts/${contact.id}`, sessionA).expect(200)).body;
    expect(after.companyId).toBeNull(); // desvinculado, não excluído
  });

  it('tags: usageCount agrega contatos e empresas; delete remove junções', async () => {
    const tag = (await post('/api/tags', sessionA, { name: 'Chave' }).expect(201)).body;
    await post('/api/contacts', sessionA, { name: 'C1', tagIds: [tag.id] }).expect(201);
    await post('/api/companies', sessionA, { name: 'E1', tagIds: [tag.id] }).expect(201);
    const [listed] = (await get('/api/tags', sessionA).expect(200)).body;
    expect(listed.usageCount).toBe(2);

    await del(`/api/tags/${tag.id}`, sessionA).expect(200);
    const junctions = await prisma.raw.contactTag.count({ where: { tagId: tag.id } });
    expect(junctions).toBe(0);
  });

  it('import cria contatos com source=import; guest não importa (RBAC)', async () => {
    const res = (
      await post('/api/contacts/import', sessionA, {
        rows: [
          { name: 'Import 1', email: 'i1@x.com' },
          { name: 'Import 2', phone: '+55 11 99999-0000' },
        ],
      }).expect(201)
    ).body;
    expect(res.imported).toBe(2);
    const listed = (await get('/api/contacts', sessionA).expect(200)).body;
    expect(listed.total).toBe(2);
    expect(listed.items.every((c: { source: string }) => c.source === 'import')).toBe(true);

    await post('/api/contacts/import', guestA, { rows: [{ name: 'Nope' }] }).expect(403);
  });

  it('PATCH de empresa reenviando o próprio domínio não conflita (P1 da revisão)', async () => {
    const company = (
      await post('/api/companies', sessionA, { name: 'Acme', domain: 'acme.io' }).expect(201)
    ).body;
    const updated = (
      await patch(`/api/companies/${company.id}`, sessionA, {
        name: 'Acme Renomeada',
        domain: 'acme.io',
      }).expect(200)
    ).body;
    expect(updated.name).toBe('Acme Renomeada');
    // e null desvincula/limpa
    const cleared = (
      await patch(`/api/companies/${company.id}`, sessionA, { domain: null }).expect(200)
    ).body;
    expect(cleared.domain).toBeNull();
  });

  it('exclusão de Workspace cascateia CRM inteiro (NoAction não bloqueia — P1 da revisão)', async () => {
    const company = (await post('/api/companies', sessionA, { name: 'Cascata SA' }).expect(201))
      .body;
    await post('/api/contacts', sessionA, {
      name: 'Contato da cascata',
      companyId: company.id,
      ownerMembershipId: memberMembershipA,
    }).expect(201);
    // exclusão LGPD: cascade a partir do Workspace (SECURITY.md §9)
    await prisma.raw.workspace.delete({ where: { slug: 'acme' } });
    expect(await prisma.raw.contact.count()).toBe(0);
    expect(await prisma.raw.company.count()).toBe(0);
  });

  it('criação duplicada concorrente vira 409, nunca 500 (filtro P2002)', async () => {
    await post('/api/tags', sessionA, { name: 'Única' }).expect(201);
    // corrida TOCTOU simulada: segunda criação passa a checagem prévia? Não —
    // aqui validamos o caminho direto do unique via PATCH para nome ocupado
    const other = (await post('/api/tags', sessionA, { name: 'Outra' }).expect(201)).body;
    const res = await patch(`/api/tags/${other.id}`, sessionA, { name: 'Única' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|P2002/i);
  });

  it('import é bloqueado quando há custom field obrigatório (invariante preservada)', async () => {
    await post('/api/custom-fields', sessionA, {
      entityType: 'contact',
      key: 'nota',
      label: 'Nota',
      type: 'number',
      required: true,
    }).expect(201);
    const res = await post('/api/contacts/import', sessionA, {
      rows: [{ name: 'Furaria' }],
    }).expect(400);
    expect(res.body.message).toMatch(/obrigatórios/);
  });

  it('paginação e ordenação funcionam na tabela densa', async () => {
    for (let i = 1; i <= 7; i += 1) {
      await post('/api/contacts', sessionA, {
        name: `Contato ${String(i).padStart(2, '0')}`,
      }).expect(201);
    }
    const page1 = (
      await get('/api/contacts?pageSize=3&sortBy=name&sortDir=asc', sessionA).expect(200)
    ).body;
    expect(page1.total).toBe(7);
    expect(page1.items).toHaveLength(3);
    expect(page1.items[0].name).toBe('Contato 01');
    const page3 = (
      await get('/api/contacts?pageSize=3&page=3&sortBy=name&sortDir=asc', sessionA).expect(200)
    ).body;
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0].name).toBe('Contato 07');
  });
});
