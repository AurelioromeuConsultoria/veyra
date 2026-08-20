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
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

describe('Vendas — pipelines, deals e timeline (integração)', () => {
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

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let sessionA: Session;
  let sessionB: Session;

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
  const post = (path: string, s: Session, body?: unknown) =>
    request(http)
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send((body ?? {}) as object);
  const del = (path: string, s: Session) =>
    request(http)
      .delete(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const ownerA = await createUserFixture(prisma, 'owner-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, ownerA, wsA.roles.owner);
    const ownerB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, ownerB, wsB.roles.owner);
    sessionA = await loginAs('owner-a@veyra.test');
    sessionB = await loginAs('owner-b@veyra.test');
  });

  it('board do pipeline padrão vem com stages semeados e somatório por coluna', async () => {
    await post('/api/deals', sessionA, { title: 'Deal 1', amountCents: 150_000 }).expect(201);
    await post('/api/deals', sessionA, { title: 'Deal 2', amountCents: 50_000 }).expect(201);
    const board = (await get('/api/deals/board', sessionA).expect(200)).body;
    expect(board.pipelineName).toBe('Vendas');
    expect(board.columns.map((c: { stageName: string }) => c.stageName)).toEqual([
      'Novo',
      'Qualificado',
      'Proposta',
      'Fechamento',
      'Ganhou',
      'Perdeu',
    ]);
    expect(board.columns[0].totalCents).toBe(200_000);
    expect(board.columns[0].deals).toHaveLength(2);
  });

  it('AJUSTE #1: stage de OUTRO pipeline do mesmo workspace é rejeitado (serviço e banco)', async () => {
    const other = (await post('/api/pipelines', sessionA, { name: 'Parcerias' }).expect(201)).body;
    const otherStageId = other.stages[0].id;

    // via API: 400
    await post('/api/deals', sessionA, {
      title: 'Cruzado',
      pipelineId: wsA.pipelineId,
      stageId: otherStageId,
    }).expect(400);

    // via SQL cru (bypass do serviço): a FK TRIPLA do banco rejeita
    await expect(
      prisma.raw.$executeRawUnsafe(
        `INSERT INTO "Deal" ("id","workspaceId","pipelineId","stageId","title","position","updatedAt")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'Cruzado SQL', 1024, now())`,
        wsA.workspaceId,
        wsA.pipelineId,
        otherStageId,
      ),
    ).rejects.toThrow(/foreign key|Deal_workspaceId_pipelineId_stageId_fkey/i);
  });

  it('AJUSTE #2: exatamente um pipeline padrão por workspace (garantido no banco)', async () => {
    const defaults = await prisma.raw.pipeline.count({
      where: { workspaceId: wsA.workspaceId, defaultMark: true },
    });
    expect(defaults).toBe(1);

    // um segundo default direto no banco viola o unique estrutural
    await expect(
      prisma.raw.pipeline.create({
        data: { workspaceId: wsA.workspaceId, name: 'Outro default', defaultMark: true },
      }),
    ).rejects.toThrow();

    // trocar o default pela API mantém a contagem em 1
    const novo = (await post('/api/pipelines', sessionA, { name: 'Novo fluxo' }).expect(201)).body;
    await request(http)
      .patch(`/api/pipelines/${novo.id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', sessionA.cookieHeader)
      .set('x-csrf-token', sessionA.csrf)
      .send({ isDefault: true })
      .expect(200);
    expect(
      await prisma.raw.pipeline.count({
        where: { workspaceId: wsA.workspaceId, defaultMark: true },
      }),
    ).toBe(1);
  });

  it('AJUSTE #3: dois moves concorrentes preservam ordem (sem posições duplicadas)', async () => {
    const d1 = (await post('/api/deals', sessionA, { title: 'D1' }).expect(201)).body;
    const d2 = (await post('/api/deals', sessionA, { title: 'D2' }).expect(201)).body;
    const d3 = (await post('/api/deals', sessionA, { title: 'D3' }).expect(201)).body;
    const target = wsA.stages['Qualificado'];

    // três arrastos simultâneos para a MESMA coluna, todos no índice 0
    const results = await Promise.all([
      post(`/api/deals/${d1.id}/move`, sessionA, { stageId: target, index: 0 }),
      post(`/api/deals/${d2.id}/move`, sessionA, { stageId: target, index: 0 }),
      post(`/api/deals/${d3.id}/move`, sessionA, { stageId: target, index: 0 }),
    ]);
    expect(results.every((r) => r.status === 201)).toBe(true);

    const column = await prisma.raw.deal.findMany({
      where: { workspaceId: wsA.workspaceId, stageId: target },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    expect(column).toHaveLength(3);
    // ordenação estável: posições únicas e estritamente crescentes
    const positions = column.map((d) => d.position);
    expect(new Set(positions).size).toBe(3);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('mover gera Activity com payload da allowlist; won marca status e emite deal_won', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Contato do deal' }).expect(201))
      .body;
    const deal = (
      await post('/api/deals', sessionA, {
        title: 'Com timeline',
        contactId: contact.id,
        amountCents: 250_000,
      }).expect(201)
    ).body;

    await post(`/api/deals/${deal.id}/move`, sessionA, {
      stageId: wsA.stages['Ganhou'],
    }).expect(201);

    const timeline = (await get(`/api/activities?dealId=${deal.id}`, sessionA).expect(200)).body;
    const types = timeline.items.map((a: { type: string }) => a.type);
    expect(types).toContain('deal_created');
    expect(types).toContain('deal_stage_changed');
    expect(types).toContain('deal_won');
    const moved = timeline.items.find((a: { type: string }) => a.type === 'deal_stage_changed');
    expect(moved.payload).toEqual({ fromStage: 'Novo', toStage: 'Ganhou' });
    expect(moved.actorName).toBe('owner-a');

    const updated = (await get(`/api/deals/${deal.id}`, sessionA).expect(200)).body;
    expect(updated.status).toBe('won');
    // a timeline do contato também recebe os eventos do deal
    const contactTimeline = (
      await get(`/api/activities?contactId=${contact.id}`, sessionA).expect(200)
    ).body;
    expect(contactTimeline.items.length).toBeGreaterThanOrEqual(2);
  });

  it('AJUSTE #5: timeline recusa nenhum ou ambos os filtros; cursor pagina estável', async () => {
    const deal = (await post('/api/deals', sessionA, { title: 'Paginado' }).expect(201)).body;
    await get('/api/activities', sessionA).expect(400);
    await get(`/api/activities?dealId=${deal.id}&contactId=${deal.id}`, sessionA).expect(400);

    // várias mudanças de stage para gerar histórico
    for (const stage of ['Qualificado', 'Proposta', 'Fechamento']) {
      await post(`/api/deals/${deal.id}/move`, sessionA, {
        stageId: wsA.stages[stage],
      }).expect(201);
    }
    const page1 = (await get(`/api/activities?dealId=${deal.id}&limit=2`, sessionA).expect(200))
      .body;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (
      await get(
        `/api/activities?dealId=${deal.id}&limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
        sessionA,
      ).expect(200)
    ).body;
    const ids1 = page1.items.map((a: { id: string }) => a.id);
    const ids2 = page2.items.map((a: { id: string }) => a.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false); // sem sobreposição
  });

  it('AJUSTE #7: excluir stage/pipeline ocupado → 409 claro (nunca 500)', async () => {
    const deal = (await post('/api/deals', sessionA, { title: 'Ocupa' }).expect(201)).body;
    const stageOcupado = (await get(`/api/deals/${deal.id}`, sessionA).expect(200)).body.stageId;

    const res = await del(`/api/stages/${stageOcupado}`, sessionA);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/oportunidade/i);

    const pipelineRes = await del(`/api/pipelines/${wsA.pipelineId}`, sessionA);
    expect(pipelineRes.status).toBe(409); // é o default, além de ocupado

    // stage vazio some normalmente
    const outro = (await post('/api/pipelines', sessionA, { name: 'Vazio' }).expect(201)).body;
    await del(`/api/stages/${outro.stages[0].id}`, sessionA).expect(200);
  });

  it('P0: workspace B não vê board, deals nem timeline de A', async () => {
    const deal = (await post('/api/deals', sessionA, { title: 'Segredo A' }).expect(201)).body;

    const boardB = (await get('/api/deals/board', sessionB).expect(200)).body;
    expect(boardB.columns.every((c: { deals: unknown[] }) => c.deals.length === 0)).toBe(true);
    await get(`/api/deals/${deal.id}`, sessionB).expect(404);
    await post(`/api/deals/${deal.id}/move`, sessionB, {
      stageId: wsB.stages['Qualificado'],
    }).expect(404);
    const timelineB = (await get(`/api/activities?dealId=${deal.id}`, sessionB).expect(200)).body;
    expect(timelineB.items).toEqual([]);
  });

  it('referência cross-workspace no deal é rejeitada', async () => {
    const contactB = (await post('/api/contacts', sessionB, { name: 'De B' }).expect(201)).body;
    await post('/api/deals', sessionA, { title: 'X', contactId: contactB.id }).expect(400);
    // e o pipeline de B não é alcançável a partir de A
    await post('/api/deals', sessionA, {
      title: 'X',
      pipelineId: wsB.pipelineId,
    }).expect(400);
  });
});
