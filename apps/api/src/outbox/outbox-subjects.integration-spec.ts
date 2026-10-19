import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import request from 'supertest';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { TEST_DATABASE_URL } from '../../test/integration/db-url';
import { resetDb } from '../../test/integration/harness';
import { JobsService } from '../jobs/jobs.service';
import { MAX_ATTEMPTS, OutboxService } from './outbox.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

/**
 * FOTOGRAFIA dos contatos na emissão (ADR-047 adendo 2). Duas garantias:
 * 1. todo emissor público declara de quais contatos é o evento, na MESMA
 *    transação — inclusive a tarefa, que responde também pelo contato do deal;
 * 2. como a coluna não tem FK, o ISOLAMENTO é conferido na emissão: id de outro
 *    workspace, inexistente ou malformado derruba a transação e nada é gravado.
 */
describe('Outbox — contatos de quem é o evento, na emissão (integração)', () => {
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
  let cookies = '';
  let csrf = '';

  const post = (path: string, body: unknown) =>
    request(http)
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', cookies)
      .set('x-csrf-token', csrf)
      .send(body as object);
  const patch = (path: string, body: unknown) =>
    request(http)
      .patch(path)
      .set('Origin', ORIGIN)
      .set('Cookie', cookies)
      .set('x-csrf-token', csrf)
      .send(body as object);
  const del = (path: string) =>
    request(http)
      .delete(path)
      .set('Origin', ORIGIN)
      .set('Cookie', cookies)
      .set('x-csrf-token', csrf);

  const fotografia = async (eventType: string) => {
    const evento = await prisma.raw.outboxEvent.findFirst({
      where: { workspaceId: wsA.workspaceId, eventType },
      orderBy: { createdAt: 'desc' },
    });
    expect(evento).toBeTruthy();
    return [...(evento!.subjectContactIds ?? [])].sort();
  };

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const owner = await createUserFixture(prisma, 'owner-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, owner, wsA.roles.owner);
    const res = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'owner-a@veyra.test', password: TEST_PASSWORD })
      .expect(201);
    const set = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    cookies = set.map((c) => c.split(';')[0]).join('; ');
    csrf = /veyra_csrf=([^;]+)/.exec(cookies)?.[1] ?? '';
  });

  // ── 1. Cada emissor público grava a fotografia ────────────────────────────

  it('contato: created e deleted levam o próprio contato', async () => {
    const id = (await post('/api/contacts', { name: 'Ana' }).expect(201)).body.id;
    expect(await fotografia('contact.created')).toEqual([id]);
    await del(`/api/contacts/${id}`).expect(200);
    // emitido antes do delete: a validação viu o contato vivo
    expect(await fotografia('contact.deleted')).toEqual([id]);
  });

  it('deal: created, stage_changed e won levam o contato do deal; sem contato, []', async () => {
    const contato = (await post('/api/contacts', { name: 'Bruno' }).expect(201)).body.id;
    const deal = (await post('/api/deals', { title: 'Pacote', contactId: contato }).expect(201))
      .body.id;
    expect(await fotografia('deal.created')).toEqual([contato]);

    await post(`/api/deals/${deal}/move`, { stageId: wsA.stages['Qualificado'] }).expect(201);
    expect(await fotografia('deal.stage_changed')).toEqual([contato]);
    await post(`/api/deals/${deal}/move`, { stageId: wsA.stages['Ganhou'] }).expect(201);
    expect(await fotografia('deal.won')).toEqual([contato]);

    const perdido = (await post('/api/deals', { title: 'Perdido', contactId: contato }).expect(201))
      .body.id;
    await post(`/api/deals/${perdido}/move`, { stageId: wsA.stages['Perdeu'] }).expect(201);
    expect(await fotografia('deal.lost')).toEqual([contato]);

    await post('/api/deals', { title: 'Avulso' }).expect(201);
    expect(await fotografia('deal.created')).toEqual([]);
  });

  it('tarefa criada por AUTOMAÇÃO herda os contatos do evento que a disparou', async () => {
    const contato = (await post('/api/contacts', { name: 'Elisa' }).expect(201)).body.id;
    await post('/api/automations', {
      name: 'Ligar sobre o negócio',
      trigger: 'deal.created',
      action: 'create_task',
      actionConfig: { title: 'Ligar sobre {{title}}', dueInDays: 1 },
    }).expect(201);
    await post('/api/deals', { title: 'Pacote Elisa', contactId: contato }).expect(201);

    // UMA rodada: a automação roda e enfileira o task.created, que fica pendente
    await prisma.raw.outboxEvent.updateMany({
      where: { status: 'pending' },
      data: { nextRetryAt: new Date(0) },
    });
    await app.get(JobsService).dispatchPending(50);
    const tarefa = await prisma.raw.task.findFirst({
      where: { title: 'Ligar sobre Pacote Elisa' },
    });
    expect(tarefa).toBeTruthy();
    expect(tarefa!.contactId).toBeNull(); // a tarefa em si não aponta para o contato…
    expect(await fotografia('task.created')).toEqual([contato]); // …mas o evento é dele
  });

  // ── Retenção: a fotografia não sobrevive ao evento ────────────────────────

  it('fotografia é zerada quando o evento é ENTREGUE ou MORRE; numa nova tentativa, fica', async () => {
    const outbox = app.get(OutboxService);
    await post('/api/contacts', { name: 'Fábio' }).expect(201);
    await post('/api/contacts', { name: 'Gina' }).expect(201);
    await post('/api/contacts', { name: 'Hugo' }).expect(201);
    await prisma.raw.outboxEvent.updateMany({ data: { nextRetryAt: new Date(0) } });
    const [entregue, morto, retentado] = await outbox.claimBatch(10);

    await outbox.markDelivered(entregue.id, entregue.claimToken);
    await outbox.markFailed(morto.id, morto.claimToken, MAX_ATTEMPTS, 'falha final');
    await outbox.markFailed(retentado.id, retentado.claimToken, 1, 'falha transitória');

    const linha = async (id: string) =>
      (
        await prisma.raw.$queryRawUnsafe<{ status: string; subjectContactIds: string[] | null }[]>(
          `SELECT "status", "subjectContactIds" FROM "OutboxEvent" WHERE "id" = $1::uuid`,
          id,
        )
      )[0];
    expect(await linha(entregue.id)).toEqual({ status: 'delivered', subjectContactIds: null });
    expect(await linha(morto.id)).toEqual({ status: 'dead', subjectContactIds: null });
    const viva = await linha(retentado.id);
    expect(viva.status).toBe('pending');
    expect(viva.subjectContactIds).toHaveLength(1); // ainda pode ser entregue
  });

  describe('estados terminais são definitivos (a fotografia não pode faltar num replay)', () => {
    const terminal = async (status: 'delivered' | 'dead') => {
      const contato = (await post('/api/contacts', { name: `T-${status}` }).expect(201)).body.id;
      const evento = await prisma.raw.outboxEvent.findFirst({
        where: { eventType: 'contact.created', payload: { path: ['id'], equals: contato } },
      });
      await prisma.raw.outboxEvent.updateMany({
        where: { id: evento!.id },
        data: { nextRetryAt: new Date(0) },
      });
      const outbox = app.get(OutboxService);
      const [claimed] = await outbox.claimBatch(10);
      expect(claimed.id).toBe(evento!.id);
      if (status === 'delivered') await outbox.markDelivered(claimed.id, claimed.claimToken);
      else await outbox.markFailed(claimed.id, claimed.claimToken, MAX_ATTEMPTS, 'fim');
      return { id: evento!.id, contato };
    };

    it.each(['delivered', 'dead'] as const)(
      '%s: o banco recusa reabrir (pending/processing) e devolver a fotografia — inclusive SQL manual',
      async (status) => {
        const { id, contato } = await terminal(status);
        for (const novo of ['pending', 'processing']) {
          await expect(
            prisma.raw.$executeRawUnsafe(
              `UPDATE "OutboxEvent" SET "status" = $2::"OutboxStatus" WHERE "id" = $1::uuid`,
              id,
              novo,
            ),
          ).rejects.toThrow(/não pode ser reaberto/);
        }
        await expect(
          prisma.raw.$executeRawUnsafe(
            `UPDATE "OutboxEvent" SET "subjectContactIds" = ARRAY[$2::uuid] WHERE "id" = $1::uuid`,
            id,
            contato,
          ),
        ).rejects.toThrow(/fotografia/);
        const [linha] = await prisma.raw.$queryRawUnsafe<
          { status: string; subjectContactIds: string[] | null }[]
        >(`SELECT "status", "subjectContactIds" FROM "OutboxEvent" WHERE "id" = $1::uuid`, id);
        expect(linha).toEqual({ status, subjectContactIds: null });
      },
    );

    it('o claim nunca pega evento terminal, nem com prazos vencidos; conclusões não o tocam', async () => {
      const entregue = await terminal('delivered');
      const morto = await terminal('dead');
      // prazos "vencidos" de propósito: só o status decide
      await prisma.raw.outboxEvent.updateMany({
        where: { id: { in: [entregue.id, morto.id] } },
        data: { nextRetryAt: new Date(0), leaseExpiresAt: new Date(0) },
      });
      const outbox = app.get(OutboxService);
      const lote = await outbox.claimBatch(50);
      expect(lote.map((e) => e.id)).not.toContain(entregue.id);
      expect(lote.map((e) => e.id)).not.toContain(morto.id);
      const tokenQualquer = randomUUID();
      expect(await outbox.markDelivered(morto.id, tokenQualquer)).toBe(false);
      expect(await outbox.markFailed(entregue.id, tokenQualquer, 1, 'x')).toBe('lost');
    });

    it('mudança que não reabre (anular causalidade, como na exclusão de automação) continua permitida', async () => {
      const { id } = await terminal('delivered');
      await expect(
        prisma.raw.outboxEvent.updateMany({ where: { id }, data: { originAutomationId: null } }),
      ).resolves.toEqual({ count: 1 });
    });
  });

  /**
   * CONCORRÊNCIA DETERMINÍSTICA: uma conexão externa segura a trava da linha do
   * contato até as DUAS requisições estarem comprovadamente esperando por ela.
   * Sem isso, as duas podiam acabar em série e o 404 sairia da checagem de fora
   * da transação — o teste passaria sem exercitar a trava.
   */
  const corridaSobreContato = async (id: string, pedidos: (() => request.Test)[]) => {
    const trava = new Client({ connectionString: TEST_DATABASE_URL });
    await trava.connect();
    try {
      await trava.query('BEGIN');
      await trava.query('SELECT 1 FROM "Contact" WHERE "id" = $1 FOR UPDATE', [id]);
      const emCurso = pedidos.map((pedido) => pedido().then((res) => res));
      for (let tentativa = 0; ; tentativa += 1) {
        const { rows } = await trava.query<{ n: string }>(
          `SELECT count(DISTINCT l.pid)::text AS n FROM pg_locks l
             JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE NOT l.granted AND l.pid <> pg_backend_pid() AND a.datname = current_database()
              -- só quem espera pela linha do CONTATO: outra sessão no banco
              -- compartilhado não pode liberar o laço cedo (verde falso)
              AND a.query ILIKE '%"Contact"%'`,
        );
        if (Number(rows[0].n) >= pedidos.length) break;
        if (tentativa > 400) throw new Error('as requisições não chegaram à trava da linha');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await trava.query('COMMIT'); // solta a linha SEM alterá-la
      return await Promise.all(emCurso);
    } finally {
      await trava.end();
    }
  };
  const cotaDeContatos = async () =>
    Number(
      (await prisma.raw.usageCounter.findFirst({
        where: { workspaceId: wsA.workspaceId, metric: 'contacts' },
      }))!.value,
    );

  it('exclusão CONCORRENTE do mesmo contato: uma vence, a outra é 404, a cota cai uma vez só', async () => {
    const id = (await post('/api/contacts', { name: 'Ivo' }).expect(201)).body.id;
    expect(await cotaDeContatos()).toBe(1);
    const [a, b] = await corridaSobreContato(id, [
      () => del(`/api/contacts/${id}`),
      () => del(`/api/contacts/${id}`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(await cotaDeContatos()).toBe(0);
  });

  it('ARQUIVAR e EXCLUIR o mesmo contato ao mesmo tempo: a cota cai uma vez só', async () => {
    const id = (await post('/api/contacts', { name: 'Joana' }).expect(201)).body.id;
    const [arquivar, excluir] = await corridaSobreContato(id, [
      () => patch(`/api/contacts/${id}`, { status: 'archived' }),
      () => del(`/api/contacts/${id}`),
    ]);
    // qualquer ordem é válida; o que não pode é descontar duas vezes
    expect(excluir.status).toBe(200);
    expect([200, 404]).toContain(arquivar.status);
    expect(await cotaDeContatos()).toBe(0);
  });

  it('tarefa: contato próprio, contato do deal, os dois, ou nenhum', async () => {
    const proprio = (await post('/api/contacts', { name: 'Carla' }).expect(201)).body.id;
    const doDeal = (await post('/api/contacts', { name: 'Dora' }).expect(201)).body.id;
    const deal = (await post('/api/deals', { title: 'D', contactId: doDeal }).expect(201)).body.id;

    await post('/api/tasks', { title: 'só contato', contactId: proprio }).expect(201);
    expect(await fotografia('task.created')).toEqual([proprio]);

    await post('/api/tasks', { title: 'só deal', dealId: deal }).expect(201);
    expect(await fotografia('task.created')).toEqual([doDeal]);

    await post('/api/tasks', { title: 'os dois', contactId: proprio, dealId: deal }).expect(201);
    expect(await fotografia('task.created')).toEqual([proprio, doDeal].sort());

    await post('/api/tasks', { title: 'nenhum' }).expect(201);
    expect(await fotografia('task.created')).toEqual([]);
  });

  // ── 2. Isolamento na emissão (a coluna não tem FK) ────────────────────────

  describe('isolamento na emissão', () => {
    const emitir = (
      workspaceId: string,
      subjectContactIds?: string[],
      raw = false,
      contexto: string = wsA.workspaceId,
    ) => {
      const outbox = app.get(OutboxService);
      const cls = app.get(ClsService);
      return cls.run(async () => {
        cls.set('workspaceId', contexto);
        const client = (raw ? prisma.raw : prisma.db) as unknown as TxRunner;
        return client.$transaction((tx) =>
          outbox.enqueue(
            tx,
            workspaceId,
            'contact.updated',
            { id: randomUUID(), name: 'x' },
            `teste:${randomUUID()}`,
            // `{}` só passa pelo cast: o TIPO já exige os sujeitos — aqui se
            // prova que o runtime também recusa, para quem burlar o tipo
            (subjectContactIds === undefined ? {} : { subjectContactIds }) as {
              subjectContactIds: string[];
            },
          ),
        );
      });
    };
    const contarEventos = () => prisma.raw.outboxEvent.count();

    let contatoA: string;
    let contatoB: string;
    beforeEach(async () => {
      contatoA = (
        await prisma.raw.contact.create({ data: { workspaceId: wsA.workspaceId, name: 'A' } })
      ).id;
      contatoB = (
        await prisma.raw.contact.create({ data: { workspaceId: wsB.workspaceId, name: 'B' } })
      ).id;
    });

    it('aceita contato do MESMO workspace do evento', async () => {
      await emitir(wsA.workspaceId, [contatoA]);
      expect(await contarEventos()).toBe(1);
    });

    it.each([
      ['client protegido', false],
      ['transação raw (como a da automação)', true],
    ])('RECUSA contato de OUTRO workspace — %s — e nada é gravado', async (_label, raw) => {
      const antes = await contarEventos();
      await expect(emitir(wsA.workspaceId, [contatoA, contatoB], raw)).rejects.toThrow(
        /inexistente ou de outro workspace/,
      );
      expect(await contarEventos()).toBe(antes);
    });

    it('client protegido com CONTEXTO divergente do evento (CLS=A, evento=B) é recusado', async () => {
      // contato e evento do B, mas a transação corre no contexto do A: o filtro
      // do client protegido E o workspaceId explícito se cruzam — nenhuma linha
      await expect(emitir(wsB.workspaceId, [contatoB], false, wsA.workspaceId)).rejects.toThrow(
        /inexistente ou de outro workspace/,
      );
      // e sem contato nenhum, o create do evento no workspace alheio é barrado
      await expect(emitir(wsB.workspaceId, [], false, wsA.workspaceId)).rejects.toThrow(
        /diverge do contexto/,
      );
      expect(await contarEventos()).toBe(0);
    });

    it('RECUSA contato inexistente e id malformado', async () => {
      await expect(emitir(wsA.workspaceId, [randomUUID()])).rejects.toThrow(
        /inexistente ou de outro workspace/,
      );
      await expect(emitir(wsA.workspaceId, ['nao-e-uuid'])).rejects.toThrow(/inválido/);
      expect(await contarEventos()).toBe(0);
    });

    it('RECUSA evento público sem declarar os contatos', async () => {
      await expect(emitir(wsA.workspaceId)).rejects.toThrow(/sem subjectContactIds/);
      expect(await contarEventos()).toBe(0);
    });

    it('a transação de domínio inteira é desfeita junto (o efeito não sobra sem o evento)', async () => {
      const cls = app.get(ClsService);
      const outbox = app.get(OutboxService);
      await expect(
        cls.run(async () => {
          cls.set('workspaceId', wsA.workspaceId);
          return (prisma.db as unknown as TxRunner).$transaction(async (tx) => {
            await tx.contact.create({ data: { workspaceId: wsA.workspaceId, name: 'Fantasma' } });
            await outbox.enqueue(
              tx,
              wsA.workspaceId,
              'contact.created',
              { id: randomUUID(), name: 'Fantasma' },
              `teste:${randomUUID()}`,
              { subjectContactIds: [contatoB] },
            );
          });
        }),
      ).rejects.toThrow(/inexistente ou de outro workspace/);
      expect(await prisma.raw.contact.count({ where: { name: 'Fantasma' } })).toBe(0);
    });

    describe('herança (evento derivado)', () => {
      const herdar = (origem: string, workspaceId = wsA.workspaceId) =>
        (prisma.raw as unknown as TxRunner).$transaction((tx) =>
          app
            .get(OutboxService)
            .enqueue(
              tx,
              workspaceId,
              'task.created',
              { id: randomUUID(), title: 'derivada' },
              `teste:${randomUUID()}`,
              { subjectContactIds: [], inheritSubjectsFrom: origem },
            ),
        );
      const evento = (workspaceId: string, extra: Record<string, unknown> = {}) =>
        prisma.raw.outboxEvent.create({
          data: {
            workspaceId,
            eventType: 'deal.created',
            payload: { id: randomUUID(), title: 'x', amountCents: 0, currency: 'BRL' },
            dedupeKey: `origem:${randomUUID()}`,
            ...extra,
          },
        });

      it('origem de OUTRO workspace: lança (não herda "nada" em silêncio)', async () => {
        const deOutro = await evento(wsB.workspaceId, { subjectContactIds: [contatoB] });
        await expect(herdar(deOutro.id)).rejects.toThrow(/origem inexistente/);
      });

      it('origem já CONCLUÍDA: lança', async () => {
        const concluido = await evento(wsA.workspaceId, { status: 'delivered' });
        await expect(herdar(concluido.id)).rejects.toThrow(/já concluído/);
      });

      it('origem ANTIGA (sem fotografia) é resolvida pela entidade dela', async () => {
        const deal = await prisma.raw.deal.create({
          data: {
            workspaceId: wsA.workspaceId,
            title: 'Antigo',
            pipelineId: wsA.pipelineId,
            stageId: Object.values(wsA.stages)[0],
            contactId: contatoA,
            position: 0,
          },
        });
        const antigo = await prisma.raw.outboxEvent.create({
          data: {
            workspaceId: wsA.workspaceId,
            eventType: 'deal.created',
            payload: { id: deal.id, title: 'Antigo', amountCents: 0, currency: 'BRL' },
            dedupeKey: `antigo:${deal.id}`,
          },
        });
        // a coluna nasce sem valor no INSERT acima: é o caso "anterior à coluna"
        await prisma.raw.$executeRawUnsafe(
          `UPDATE "OutboxEvent" SET "subjectContactIds" = NULL WHERE "id" = $1::uuid`,
          antigo.id,
        );
        await herdar(antigo.id);
        const derivado = await prisma.raw.outboxEvent.findFirst({
          where: { eventType: 'task.created' },
        });
        expect(derivado!.subjectContactIds).toEqual([contatoA]);
      });
    });

    it('evento INTERNO não declara contatos e fica sem fotografia (NULL)', async () => {
      const cls = app.get(ClsService);
      await cls.run(async () => {
        cls.set('workspaceId', wsA.workspaceId);
        await (prisma.db as unknown as TxRunner).$transaction((tx) =>
          app
            .get(OutboxService)
            .enqueue(tx, wsA.workspaceId, 'file.purge', { key: 'x/y' }, `teste:${randomUUID()}`),
        );
      });
      const [linha] = await prisma.raw.$queryRawUnsafe<{ subjectContactIds: string[] | null }[]>(
        `SELECT "subjectContactIds" FROM "OutboxEvent" WHERE "eventType" = 'file.purge'`,
      );
      expect(linha.subjectContactIds).toBeNull();
    });
  });
});
