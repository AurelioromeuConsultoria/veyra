import { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  setPlanLimit,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { UsageService } from './usage.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(200, 3),
  ]);

describe('Uso e quotas (integração)', () => {
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
  const patch = (path: string, s: Session, body?: unknown) =>
    request(http)
      .patch(path)
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
  const upload = (s: Session, bytes: Buffer, name: string) =>
    request(http)
      .post('/api/files')
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .attach('file', bytes, name);

  /**
   * Chamar o service direto (sem request) não tem contexto de workspace, e o
   * client protegido barra — como deve. Aqui entramos no contexto como uma
   * request faria.
   */
  const asWorkspace = async <T>(fn: () => Promise<T>): Promise<T> => {
    const cls = app.get(ClsService);
    return cls.run(async () => {
      cls.set('workspaceId', wsA.workspaceId);
      return fn();
    });
  };

  const counterOf = async (metric: string) => {
    const row = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric },
    });
    return Number(row?.value ?? 0);
  };

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    const wsB = await createWorkspaceFixture(prisma, 'beta');
    const ownerA = await createUserFixture(prisma, 'owner-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, ownerA, wsA.roles.owner);
    const ownerB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, ownerB, wsB.roles.owner);
    sessionA = await loginAs('owner-a@veyra.test');
    sessionB = await loginAs('owner-b@veyra.test');
  });

  // ── Plano e visão de uso ──────────────────────────────────────────────────

  it.each([
    ['member', 'membro-a@veyra.test'],
    // ADMIN é o caso que expõe implementação por NOME de papel: tem TODAS as
    // permissões menos `billing:manage`, então quem ramificasse por
    // `systemKey === 'owner'` (proibido, §3.5) passaria no teste do Member e
    // falharia aqui
    ['admin', 'admin-a@veyra.test'],
    ['guest', 'guest-a@veyra.test'],
  ])('P1: %s NÃO recebe situação comercial, só uso e plano aplicado', async (roleKey, email) => {
    const usuario = await createUserFixture(prisma, email);
    await createMembershipFixture(prisma, wsA.workspaceId, usuario, wsA.roles[roleKey]);
    const sessao = await loginAs(email);

    const overview = (await get('/api/usage', sessao).expect(200)).body;

    /**
     * Esconder na tela não bastava: qualquer portador do medidor obtinha
     * status, preço e fim do período chamando a API. O SERVIDOR é que não envia.
     */
    expect(overview.subscription).toBeNull();
    // e o que é informação de TRABALHO continua chegando
    expect(overview.appliedPlan).toMatchObject({ key: 'base', source: 'subscription' });
    const contacts = overview.metrics.find((m: { metric: string }) => m.metric === 'contacts');
    expect(contacts).toMatchObject({ limit: 2000, enforced: true, limitSource: 'plan' });
    // nenhum resquício de preço ou período em qualquer canto do payload
    const bruto = JSON.stringify(overview);
    expect(bruto).not.toContain('priceCents');
    expect(bruto).not.toContain('currentPeriodEnd');

    /**
     * Custo em USD é dado comercial tão sensível quanto preço de plano — mais,
     * para convidado externo, porque é o gasto REAL da conta. O trabalho precisa
     * saber que existe teto de IA e se está perto dele, não os centavos.
     */
    const custo = overview.metrics.find((m: { metric: string }) => m.metric === 'ai_cost_cents');
    expect(custo).toMatchObject({ used: null, limit: null, monetaryRedacted: true });
    // DISPONIBILIDADE continua: é o que serve ao trabalho, e não revela valor
    expect(typeof custo.usedRatio).toBe('number');

    /**
     * E a omissão é por UNIDADE, não por nome de métrica: `ai_runs` conta a mesma
     * atividade de IA e segue com valores, porque não é dinheiro.
     */
    const runs = overview.metrics.find((m: { metric: string }) => m.metric === 'ai_runs');
    expect(runs).toMatchObject({ used: 0, limit: 200 });
    expect(runs.monetaryRedacted).toBeUndefined();
  });

  /**
   * Um run REAL. Sem isto o laço `for (const run of runs)` iterava zero vezes e
   * a asserção do custo por execução era vácua — reverter a projeção não
   * reprovava nada. É o campo mais granular, justamente o que motivou o achado.
   */
  const seedAiRun = async (costCents: number) => {
    await prisma.raw.aiRun.create({
      data: {
        workspaceId: wsA.workspaceId,
        capability: 'conversation_summary',
        model: 'claude-haiku-4-5',
        contextSummary: 'conversa com 3 mensagens',
        status: 'ok',
        inputTokens: 800,
        outputTokens: 120,
        costCents,
        latencyMs: 420,
      },
    });
  };

  it('P1: ADMIN administra a IA e NÃO vê o custo em dólar', async () => {
    await seedAiRun(37);
    const usuario = await createUserFixture(prisma, 'admin-ia@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, usuario, wsA.roles.admin);
    const sessao = await loginAs('admin-ia@veyra.test');

    /**
     * Admin TEM `workspace:manage` e NÃO tem `billing:manage`: a porta da frente
     * (`/api/usage`) estava fechada e esta, de serviço, ficava aberta — com o
     * gasto real POR EXECUÇÃO, mais granular que o total do período.
     *
     * O 200 é asserido de propósito: um 403 aqui faria o teste "passar" sem
     * provar nada sobre a projeção.
     */
    const res = await get('/api/intelligence/usage', sessao).expect(200);
    expect(res.body.totalCostCents).toBeNull();
    expect(res.body.monetaryRedacted).toBe(true);
    // o laço só prova algo se houver run: sem esta guarda ele iterava vazio
    expect(res.body.runs.length).toBeGreaterThan(0);
    for (const run of res.body.runs) expect(run.costCents).toBeNull();
    // e o diagnóstico de administração continua: a rota não perdeu propósito
    expect(res.body.runs[0]).toMatchObject({ capability: 'conversation_summary', latencyMs: 420 });
  });

  it('MEMBER não administra a IA: negado antes de qualquer projeção', async () => {
    const usuario = await createUserFixture(prisma, 'membro-ia@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, usuario, wsA.roles.member);
    const sessao = await loginAs('membro-ia@veyra.test');

    await get('/api/intelligence/usage', sessao).expect(403);
  });

  it('razão de uso da métrica redigida vem em DECIS, e sem procedência do teto', async () => {
    const membro = await createUserFixture(prisma, 'decis@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, membro, wsA.roles.member);
    const sessao = await loginAs('decis@veyra.test');
    await setPlanLimit(prisma, 'ai_cost_cents', 500);
    // 137 de 500 = 0,274: a razão exata devolveria o centavo (0,274 × 500 = 137)
    await asWorkspace(() =>
      app.get(UsageService).ensureCounterRow(wsA.workspaceId, 'ai_cost_cents'),
    );
    await prisma.raw.usageCounter.updateMany({
      where: { workspaceId: wsA.workspaceId, metric: 'ai_cost_cents' },
      data: { value: BigInt(137) },
    });

    const overview = (await get('/api/usage', sessao).expect(200)).body;
    const custo = overview.metrics.find((m: { metric: string }) => m.metric === 'ai_cost_cents');

    expect(custo.usedRatio).toBe(0.3); // decil, não 0.274
    // e a procedência FIXARIA o denominador: também é omitida
    expect(custo.limitSource).toBeNull();
    // já a métrica não monetária mantém a procedência, que é informação de trabalho
    const contacts = overview.metrics.find((m: { metric: string }) => m.metric === 'contacts');
    expect(contacts.limitSource).toBe('plan');
  });

  it('teto ZERO é razão 1, não "sem teto" — o oposto da verdade', async () => {
    const membro = await createUserFixture(prisma, 'zero@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, membro, wsA.roles.member);
    const sessao = await loginAs('zero@veyra.test');
    await setPlanLimit(prisma, 'ai_cost_cents', 0);

    const overview = (await get('/api/usage', sessao).expect(200)).body;
    const custo = overview.metrics.find((m: { metric: string }) => m.metric === 'ai_cost_cents');

    // bloqueio total; devolver null diria "sem teto definido" a quem já não vê valores
    expect(custo.usedRatio).toBe(1);
  });

  it('quem gere billing vê o custo de IA POR EXECUÇÃO', async () => {
    await seedAiRun(37);

    const res = await get('/api/intelligence/usage', sessionA).expect(200);
    expect(res.body.totalCostCents).toBe(37);
    expect(res.body.monetaryRedacted).toBeUndefined();
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].costCents).toBe(37);
  });

  it('quem gere billing recebe assinatura e valores monetários completos', async () => {
    const overview = (await get('/api/usage', sessionA).expect(200)).body;

    expect(overview.subscription).toMatchObject({
      status: 'active',
      plan: { key: 'base' },
    });
    expect(overview.subscription.plan.priceCents).toBe(0);
    expect(overview.subscription.currentPeriodEnd).toBeTruthy();

    // e o custo de IA vem em centavos, com teto — é para isso que existe o direito
    const custo = overview.metrics.find((m: { metric: string }) => m.metric === 'ai_cost_cents');
    expect(custo).toMatchObject({ used: 0, limit: 500, unit: 'usd_cents' });
    expect(custo.monetaryRedacted).toBeUndefined();
  });

  it('workspace nasce com assinatura no plano-base e uso zerado', async () => {
    const overview = (await get('/api/usage', sessionA).expect(200)).body;
    expect(overview.subscription.plan.key).toBe('base');
    expect(overview.subscription.status).toBe('active');
    const contacts = overview.metrics.find((m: { metric: string }) => m.metric === 'contacts');
    expect(contacts).toMatchObject({ kind: 'gauge', used: 0, limit: 2000, enforced: true });
    // gauge não tem virada de período
    expect(contacts.resetsAt).toBeNull();
  });

  it('counter declara a virada, e mensagens enviadas passou a ser cobrada', async () => {
    const overview = (await get('/api/usage', sessionA).expect(200)).body;
    const aiRuns = overview.metrics.find((m: { metric: string }) => m.metric === 'ai_runs');
    expect(aiRuns.kind).toBe('counter');
    expect(aiRuns.resetsAt).toBeTruthy();

    // a partir da 9.1.b existe envio externo de verdade: a métrica é cobrada
    const messages = overview.metrics.find((m: { metric: string }) => m.metric === 'messages_sent');
    expect(messages.enforced).toBe(true);
    expect(messages.limit).toBe(1000);
  });

  it('custo de IA é declarado em centavos de DÓLAR', async () => {
    const overview = (await get('/api/usage', sessionA).expect(200)).body;
    const cost = overview.metrics.find((m: { metric: string }) => m.metric === 'ai_cost_cents');
    expect(cost.unit).toBe('usd_cents');
  });

  // ── Gauge de contatos ─────────────────────────────────────────────────────

  it('contato criado sobe o gauge; arquivar desce; reativar sobe de novo', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Ciclo' }).expect(201)).body;
    expect(await counterOf('contacts')).toBe(1);

    await patch(`/api/contacts/${contact.id}`, sessionA, { status: 'archived' }).expect(200);
    expect(await counterOf('contacts')).toBe(0); // arquivado não conta

    await patch(`/api/contacts/${contact.id}`, sessionA, { status: 'active' }).expect(200);
    expect(await counterOf('contacts')).toBe(1);

    await del(`/api/contacts/${contact.id}`, sessionA).expect(200);
    expect(await counterOf('contacts')).toBe(0);
  });

  it('excluir contato ARQUIVADO não desconta de novo (não fica negativo)', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Arquivado' }).expect(201)).body;
    await patch(`/api/contacts/${contact.id}`, sessionA, { status: 'archived' }).expect(200);
    await del(`/api/contacts/${contact.id}`, sessionA).expect(200);
    expect(await counterOf('contacts')).toBe(0);
  });

  it('quota estourada devolve 402 estruturado e NÃO cria o contato', async () => {
    await setPlanLimit(prisma, 'contacts', 1);
    await post('/api/contacts', sessionA, { name: 'Primeiro' }).expect(201);

    const res = await post('/api/contacts', sessionA, { name: 'Excedente' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      code: 'quota_exceeded',
      metric: 'contacts',
      limit: 1,
    });
    // o rollback desfez tudo: nem contato nem contador inflado
    expect(await prisma.raw.contact.count({ where: { workspaceId: wsA.workspaceId } })).toBe(1);
    expect(await counterOf('contacts')).toBe(1);
  });

  it('reativar contato TAMBÉM esbarra no teto', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Volta' }).expect(201)).body;
    await patch(`/api/contacts/${contact.id}`, sessionA, { status: 'archived' }).expect(200);
    await post('/api/contacts', sessionA, { name: 'Ocupa a vaga' }).expect(201);
    await setPlanLimit(prisma, 'contacts', 1);

    const res = await patch(`/api/contacts/${contact.id}`, sessionA, { status: 'active' });
    expect(res.status).toBe(402);
    const row = await prisma.raw.contact.findFirst({ where: { id: contact.id } });
    expect(row!.status).toBe('archived'); // rollback preservou o estado
    expect(await counterOf('contacts')).toBe(1);
  });

  it('importação em lote é TUDO OU NADA quando a quota não cabe', async () => {
    await setPlanLimit(prisma, 'contacts', 2);
    const res = await post('/api/contacts/import', sessionA, {
      rows: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    });
    expect(res.status).toBe(402);
    // nenhuma linha entrou: importação parcial deixaria o usuário sem saber
    // quais foram importadas
    expect(await prisma.raw.contact.count({ where: { workspaceId: wsA.workspaceId } })).toBe(0);
    expect(await counterOf('contacts')).toBe(0);

    const ok = await post('/api/contacts/import', sessionA, {
      rows: [{ name: 'A' }, { name: 'B' }],
    });
    expect(ok.status).toBe(201);
    expect(await counterOf('contacts')).toBe(2);
  });

  it('concorrência: dez criações simultâneas com teto 5 param em 5', async () => {
    await setPlanLimit(prisma, 'contacts', 5);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => post('/api/contacts', sessionA, { name: `C${i}` })),
    );
    const criados = results.filter((r) => r.status === 201).length;
    const recusados = results.filter((r) => r.status === 402).length;
    expect(criados).toBe(5);
    expect(recusados).toBe(5);
    expect(await counterOf('contacts')).toBe(5);
    expect(await prisma.raw.contact.count({ where: { workspaceId: wsA.workspaceId } })).toBe(5);
  });

  // ── Gauge de storage ──────────────────────────────────────────────────────

  it('upload soma bytes e exclusão devolve', async () => {
    const file = (await upload(sessionA, png(), 'foto.png').expect(201)).body;
    expect(await counterOf('storage_bytes')).toBe(png().length);
    await del(`/api/files/${file.id}`, sessionA).expect(200);
    expect(await counterOf('storage_bytes')).toBe(0);
  });

  it('quota de storage recusa o upload E apaga os bytes já gravados', async () => {
    await setPlanLimit(prisma, 'storage_bytes', 100);
    const res = await upload(sessionA, png(), 'grande.png');
    expect(res.status).toBe(402);
    expect(res.body.metric).toBe('storage_bytes');
    // nem linha nem contador
    expect(await prisma.raw.fileObject.count()).toBe(0);
    expect(await counterOf('storage_bytes')).toBe(0);
    // e o arquivo recusado não virou lixo em disco
    const { readdir } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const dir = resolve(process.env.STORAGE_ROOT ?? '.storage-test/1', wsA.workspaceId);
    const restos = await readdir(dir).catch(() => []);
    expect(restos).toEqual([]);
  });

  // ── P0: isolamento ────────────────────────────────────────────────────────

  it('P0: uso de um workspace não conta no outro', async () => {
    await post('/api/contacts', sessionA, { name: 'De A' }).expect(201);
    const overviewB = (await get('/api/usage', sessionB).expect(200)).body;
    const contactsB = overviewB.metrics.find((m: { metric: string }) => m.metric === 'contacts');
    expect(contactsB.used).toBe(0);
  });

  it('teto de um workspace não bloqueia o outro', async () => {
    await setPlanLimit(prisma, 'contacts', 1);
    await post('/api/contacts', sessionA, { name: 'Primeiro' }).expect(201);
    await post('/api/contacts', sessionA, { name: 'Excede' }).expect(402);
    // B tem o mesmo plano, mas o consumo é dele
    await post('/api/contacts', sessionB, { name: 'De B' }).expect(201);
  });

  // ── Reserva (ADR-033) ─────────────────────────────────────────────────────

  it('reserva impede que chamadas concorrentes furem o teto', async () => {
    const usage = app.get(UsageService);
    await setPlanLimit(prisma, 'ai_cost_cents', 10);

    const reservas = await asWorkspace(() =>
      Promise.all(
        Array.from({ length: 6 }, () => usage.reserve(wsA.workspaceId, 'ai_cost_cents', 3)),
      ),
    );
    const aceitas = reservas.filter((r) => r !== 'quota_exceeded');
    // 3 centavos por reserva, teto 10 → no máximo 3 cabem
    expect(aceitas).toHaveLength(3);
    expect(reservas.filter((r) => r === 'quota_exceeded')).toHaveLength(3);
  });

  it('liquidação cobra o custo REAL e libera a diferença', async () => {
    const usage = app.get(UsageService);
    const reserva = await asWorkspace(() => usage.reserve(wsA.workspaceId, 'ai_cost_cents', 50));
    if (reserva === 'quota_exceeded') throw new Error('esperava reserva');
    // a reserva JÁ ocupa o orçamento: é isso que impede a corrida
    expect(await counterOf('ai_cost_cents')).toBe(50);

    await asWorkspace(() =>
      usage.settle(wsA.workspaceId, reserva.reservationId, 'ai_cost_cents', 2),
    );
    expect(await counterOf('ai_cost_cents')).toBe(2); // sobra devolvida
    const restantes = await prisma.raw.usageReservation.count();
    expect(restantes).toBe(0); // a reserva foi consumida
  });

  it('reserva liberada não cobra nada', async () => {
    const usage = app.get(UsageService);
    const reserva = await asWorkspace(() => usage.reserve(wsA.workspaceId, 'ai_cost_cents', 50));
    if (reserva === 'quota_exceeded') throw new Error('esperava reserva');
    expect(await counterOf('ai_cost_cents')).toBe(50); // reservado
    await asWorkspace(() => usage.release(reserva.reservationId));
    expect(await counterOf('ai_cost_cents')).toBe(0); // devolvido por inteiro
    expect(await prisma.raw.usageReservation.count()).toBe(0);
  });

  it('reserva órfã expira e é varrida — nunca deixa orçamento preso para sempre', async () => {
    const usage = app.get(UsageService);
    const reserva = await asWorkspace(() => usage.reserve(wsA.workspaceId, 'ai_cost_cents', 50));
    if (reserva === 'quota_exceeded') throw new Error('esperava reserva');
    await prisma.raw.usageReservation.updateMany({
      where: { id: reserva.reservationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await usage.purgeExpiredReservations()).toBe(1);
    // o valor preso voltou ao orçamento
    expect(await counterOf('ai_cost_cents')).toBe(0);
    // e liquidar uma reserva já varrida não cobra em dobro
    await asWorkspace(() =>
      usage.settle(wsA.workspaceId, reserva.reservationId, 'ai_cost_cents', 7),
    );
    expect(await counterOf('ai_cost_cents')).toBe(0);
  });

  // ── Teto sem assinatura ativa (ADR-041) ───────────────────────────────────

  it('P0: sem assinatura ativa, o teto de CUSTO DE IA é herdado, não anulado', async () => {
    await prisma.raw.subscription.updateMany({
      where: { workspaceId: wsA.workspaceId },
      data: { status: 'canceled' },
    });

    /**
     * O call site de IA é outro (`reserve` em `intelligence.service`), e todos os
     * testes do ADR-041 exercitavam só o envio de WhatsApp. Sem este caso,
     * apagar a marca de `ai_cost_cents` devolveria gasto de LLM sem teto com a
     * suíte inteira verde.
     */
    const usage = app.get(UsageService);
    expect(await usage.limitFor(wsA.workspaceId, 'ai_cost_cents')).not.toBeNull();
    expect(await usage.limitFor(wsA.workspaceId, 'ai_runs')).not.toBeNull();
    // e a métrica interna segue sem teto no mesmo cenário — o recorte deliberado
    expect(await usage.limitFor(wsA.workspaceId, 'contacts')).toBeNull();
  });

  it('sem assinatura ativa, reserva de IA acima do teto herdado é RECUSADA', async () => {
    await setPlanLimit(prisma, 'ai_cost_cents', 10);
    await prisma.raw.subscription.updateMany({
      where: { workspaceId: wsA.workspaceId },
      data: { status: 'canceled' },
    });
    const usage = app.get(UsageService);
    await usage.ensureCounterRow(wsA.workspaceId, 'ai_cost_cents');

    const primeira = await asWorkspace(() => usage.reserve(wsA.workspaceId, 'ai_cost_cents', 8));
    expect(primeira).not.toBe('quota_exceeded');
    const segunda = await asWorkspace(() => usage.reserve(wsA.workspaceId, 'ai_cost_cents', 8));
    // antes do ADR-041 isto passava: sem assinatura, sem limite, gasto sem fim
    expect(segunda).toBe('quota_exceeded');
  });
});
