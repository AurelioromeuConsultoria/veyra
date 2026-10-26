import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import request from 'supertest';
import { AUDIT_FIELDS } from '../audit/audit-fields';
import { CryptoService } from '../common/crypto.service';
import { TravasDeIdentidade } from '../content-use/identity-locks';
import { CHAVE } from '../content-use/restriction-locks';
import { META_TRANSPORT, type MetaTransport, type SendOutcome } from '../channels/meta.transport';
import {
  LLM_CLIENT,
  type LlmClient,
  type LlmOutcome,
  type LlmRequest,
} from '../intelligence/llm/llm.client';
import { ConversationsService } from '../conversations/conversations.service';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import { TEST_DATABASE_URL } from '../../test/integration/db-url';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { esperarBloqueadosPor } from '../../test/integration/locks';
import { ConsentPurposesService } from './consent-purposes.service';

/**
 * F4.1b (ADR-052 item 5): finalidades, consentimentos, o pedido de parar, as
 * permissões e a recusa transitória dos templates. Números e nomes FICTÍCIOS.
 * O que se prova:
 *
 * - o consentimento é imutável, revogado uma vez só, e só por número exato;
 * - o pedido de parar vale para (workspace, número), em todos os canais e por
 *   qualquer contato, revoga o que havia, cancela o que não saiu e nada sai
 *   sob ele (a exceção da resposta ainda é proposta);
 * - o template é indisponível no compositor, na API e no worker;
 * - a ordem das operações não deixa consentimento utilizável sob bloqueio nem
 *   para número que saiu do contato (travas, nas duas ordens).
 */

const APP_SECRET = process.env.META_APP_SECRET as string;
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const NUMERO_A1 = '109876543401';
const NUMERO_A2 = '109876543402';
const NUMERO_B = '109876543403';

/** O número de quem escreve, como o `wa_id` chega (só dígitos). */
const N = '5511987654321';
const N_E164 = `+${N}`;
const OUTRO = '+5521912345678';

class FakeLlm implements LlmClient {
  readonly model = 'claude-sonnet-5';
  nextText = '{}';
  calls = 0;
  async complete(_request: LlmRequest): Promise<LlmOutcome> {
    this.calls += 1;
    return { kind: 'ok', text: this.nextText, inputTokens: 500, outputTokens: 100 };
  }
}

class FakeMeta implements MetaTransport {
  sends: { to: string; body?: string; template?: boolean }[] = [];
  async sendText(_c: unknown, to: string, body: string): Promise<SendOutcome> {
    this.sends.push({ to, body });
    return { ok: true, externalId: `wamid.ENVIADA.${this.sends.length}` };
  }
  async sendTemplate(_c: unknown, to: string): Promise<SendOutcome> {
    this.sends.push({ to, template: true });
    return { ok: true, externalId: `wamid.T.${this.sends.length}` };
  }
  async fetchMedia(): Promise<never> {
    throw new Error('não usado');
  }
}

const RASCUNHO = JSON.stringify({
  body: 'Temos horário amanhã às 10h.',
  rationale: 'Pedido de horário.',
  injectionAttempt: false,
});

interface Session {
  cookieHeader: string;
  csrf: string;
}

describe('F4.1b — consentimento, pedido de parar e templates na transição (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const llm = new FakeLlm();
  const meta = new FakeMeta();

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: LLM_CLIENT, useValue: llm },
        { provide: META_TRANSPORT, useValue: meta },
      ],
    );
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let canalA1: string;
  let canalA2: string;
  let canalB: string;
  let owner: Session;
  let membro: Session;
  let atendente: Session;
  let leitor: Session;
  let guest: Session;
  let ownerB: Session;
  let ownerId: string;
  let finalidade: string;
  let finalidadeB: string;
  let seq = 0;

  const login = async (email: string): Promise<Session> => {
    const res = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: TEST_PASSWORD })
      .expect(201);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
    return { cookieHeader, csrf: /veyra_csrf=([^;]+)/.exec(cookieHeader)?.[1] ?? '' };
  };
  const enviar = (
    metodo: 'post' | 'patch' | 'put' | 'delete',
    path: string,
    s: Session,
    body?: unknown,
  ) =>
    request(http)
      [metodo](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send((body ?? {}) as object);
  /** Os registros exigem `Idempotency-Key`: uma nova por chamada, salvo quando o teste repete. */
  const registrar = (path: string, s: Session, body: unknown, chave: string = randomUUID()) =>
    enviar('post', path, s, body).set('idempotency-key', chave);
  const get = (path: string, s: Session) =>
    request(http).get(path).set('Origin', ORIGIN).set('Cookie', s.cookieHeader);

  const mensagem = (de: string) => ({
    id: `wamid.ID${++seq}`,
    from: de,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text',
    text: { body: `Mensagem fictícia ${seq}` },
  });
  const webhook = (corpo: unknown) => {
    const raw = JSON.stringify(corpo);
    return request(http)
      .post('/api/channels/whatsapp/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'x-hub-signature-256',
        `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(raw)).digest('hex')}`,
      )
      .send(raw);
  };
  const chega = (de = N, numero = NUMERO_A1) =>
    webhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: { metadata: { phone_number_id: numero }, messages: [mensagem(de)] },
            },
          ],
        },
      ],
    }).expect(200);

  const contato = async (nome: string, phones: string[], s = owner): Promise<string> =>
    (await enviar('post', '/api/contacts', s, { name: nome, phones }).expect(201)).body.id;
  const conversaDe = async (numero = N_E164, canal = canalA1, ws = () => wsA.workspaceId) =>
    prisma.raw.conversation.findFirstOrThrow({
      where: { workspaceId: ws(), externalAddress: numero, channelId: canal },
      orderBy: { createdAt: 'desc' },
    });

  const conceder = (
    contactId: string,
    extra: Partial<{ channelId: string; number: string; purposeId: string; origin: string }> = {},
    s = owner,
    chave?: string,
  ) =>
    registrar(
      `/api/contacts/${contactId}/consents`,
      s,
      { channelId: canalA1, number: N_E164, purposeId: finalidade, origin: 'in_person', ...extra },
      chave,
    );
  const parar = (contactId: string, numero = N_E164, s = owner, chave?: string) =>
    registrar(`/api/contacts/${contactId}/stop`, s, { number: numero, origin: 'phone' }, chave);
  const desbloquear = (contactId: string, numero = N_E164, s = owner) =>
    registrar(`/api/contacts/${contactId}/stop/lift`, s, { number: numero, origin: 'paper_form' });
  const consentimento = (id: string) => prisma.raw.consent.findUniqueOrThrow({ where: { id } });
  const bloqueiosAtivos = (ws = () => wsA.workspaceId) =>
    prisma.raw.stopBlock.findMany({ where: { workspaceId: ws(), activeMark: true } });

  const drenar = async () => {
    for (let i = 0; i < 5; i++) {
      const { delivered } = await app.get(JobsService).dispatchPending();
      if (delivered === 0) break;
    }
  };
  const despachoDe = (messageId: string) =>
    prisma.raw.messageDispatch.findFirstOrThrow({ where: { messageId } });
  const credencialDeVerdade = () =>
    prisma.raw.channelCredential.updateMany({
      where: { workspaceId: wsA.workspaceId },
      data: { tokenCipher: app.get(CryptoService).encrypt('token-ficticio') },
    });
  const responder = (conversationId: string, extra: Record<string, unknown> = {}) =>
    enviar('post', `/api/conversations/${conversationId}/messages`, owner, {
      direction: 'outbound',
      body: 'Resposta fictícia',
      ...extra,
    });

  /** A ficha do `address:` do número, como a aplicação a monta (o HMAC). */
  const endereco = (numero: string) =>
    CHAVE.entidade(
      wsA.workspaceId,
      app.get(TravasDeIdentidade).endereco(wsA.workspaceId, numero.replace(/\D/g, '').slice(-8)),
    );
  /** Uma conexão que segura travas numa transação aberta, para as corridas. */
  const travar = async (chave: string, compartilhada = false) => {
    const c = new Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query(
      `SELECT pg_advisory_xact_lock${compartilhada ? '_shared' : ''}(hashtextextended($1, 0))`,
      [chave],
    );
    return c;
  };
  const soltar = async (c: Client) => {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  };

  const papel = async (nome: string, chaves: string[]): Promise<string> => {
    const role = await prisma.raw.role.create({
      data: { workspaceId: wsA.workspaceId, name: nome, isSystem: false },
    });
    await prisma.raw.rolePermission.createMany({
      data: chaves.map((permissionKey) => ({
        workspaceId: wsA.workspaceId,
        roleId: role.id,
        permissionKey,
      })),
    });
    return role.id;
  };

  /**
   * No contexto do workspace, como uma requisição o teria. O `await` fica DENTRO
   * do `cls.run`: a consulta do Prisma é preguiçosa e só roda no `then`.
   */
  const noWorkspace = <T>(workspaceId: string, fn: () => Promise<T>): Promise<T> => {
    const cls = app.get(ClsService);
    return cls.run(async () => {
      cls.set('workspaceId', workspaceId);
      return await fn();
    });
  };

  beforeEach(async () => {
    meta.sends = [];
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const dono = await createUserFixture(prisma, 'dono@veyra.test');
    ownerId = await createMembershipFixture(prisma, wsA.workspaceId, dono, wsA.roles.owner);
    const m = await createUserFixture(prisma, 'membro@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, m, wsA.roles.member);
    // lê e responde conversas e lê contatos; não escreve contatos nem vê consentimento
    const a = await createUserFixture(prisma, 'atende@veyra.test');
    await createMembershipFixture(
      prisma,
      wsA.workspaceId,
      a,
      await papel('Atendente', [
        'workspace:read',
        'contacts:read',
        'conversations:read',
        'conversations:write',
      ]),
    );
    // vê consentimento pela conversa, sem ler contatos: o número sai mascarado
    const l = await createUserFixture(prisma, 'leitor@veyra.test');
    await createMembershipFixture(
      prisma,
      wsA.workspaceId,
      l,
      await papel('Leitor', ['workspace:read', 'conversations:read', 'consents:read']),
    );
    const g = await createUserFixture(prisma, 'guest@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, g, wsA.roles.guest);
    const donoB = await createUserFixture(prisma, 'dono-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, donoB, wsB.roles.owner);

    for (const [ws, numero, guardar] of [
      [wsA.workspaceId, NUMERO_A1, (id: string) => (canalA1 = id)],
      [wsA.workspaceId, NUMERO_A2, (id: string) => (canalA2 = id)],
      [wsB.workspaceId, NUMERO_B, (id: string) => (canalB = id)],
    ] as const) {
      const canal = await prisma.raw.channel.create({
        data: { workspaceId: ws, type: 'whatsapp', name: `WhatsApp ${numero}` },
      });
      guardar(canal.id);
      await prisma.raw.channelCredential.create({
        data: {
          workspaceId: ws,
          channelId: canal.id,
          phoneNumberId: numero,
          businessAccountId: `waba-${numero}`,
          tokenCipher: 'cifrado',
        },
      });
    }
    const purposes = app.get(ConsentPurposesService);
    finalidade = (
      await purposes.criarVersao('acme', {
        key: 'lembrete',
        description: 'Lembretes de horário marcado',
        category: 'utility',
        fields: ['nome', 'data'],
      })
    ).purposeId;
    finalidadeB = (
      await purposes.criarVersao('beta', {
        key: 'lembrete',
        description: 'Lembretes de horário marcado',
        category: 'utility',
        fields: ['nome'],
      })
    ).purposeId;
    owner = await login('dono@veyra.test');
    membro = await login('membro@veyra.test');
    atendente = await login('atende@veyra.test');
    leitor = await login('leitor@veyra.test');
    guest = await login('guest@veyra.test');
    ownerB = await login('dono-b@veyra.test');
  });

  // ── O modelo: imutável, revogação uma vez, o relógio do banco ─────────────

  describe('o modelo', () => {
    it('a finalidade é versionada pela CLI, imutável, com auditoria; a lista exige consents:read', async () => {
      const v2 = await app.get(ConsentPurposesService).criarVersao('acme', {
        key: 'lembrete',
        description: 'Lembretes de horário, com o endereço',
        category: 'utility',
        fields: ['nome', 'data', 'endereco'],
      });
      expect(v2.version).toBe(2);
      const lista = await get('/api/consent-purposes', owner).expect(200);
      expect(lista.body.map((p: { version: number }) => p.version)).toEqual([1, 2]);
      await get('/api/consent-purposes', atendente).expect(403);
      expect(
        await prisma.raw.auditLog.count({
          where: { workspaceId: wsA.workspaceId, action: 'consent_purpose.created' },
        }),
      ).toBe(2);
      await expect(
        noWorkspace(wsA.workspaceId, () =>
          prisma.db.consentPurpose.updateMany({ where: {}, data: { description: 'outra' } }),
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('o client só aceita o preenchimento do desfecho, por updateMany; o resto do registro é imutável', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const c = (await conceder(ana).expect(201)).body.id as string;
      await noWorkspace(wsA.workspaceId, async () => {
        await expect(
          prisma.db.consent.updateMany({ where: { id: c }, data: { number: OUTRO } }),
        ).rejects.toThrow(/só aceita o preenchimento do desfecho/);
        await expect(
          prisma.db.consent.updateMany({ where: { id: c }, data: { revokedAt: new Date(0) } }),
        ).rejects.toThrow(/só aceita o preenchimento do desfecho/);
        await expect(prisma.db.consent.deleteMany({ where: { id: c } })).rejects.toThrow(
          /só aceita o preenchimento do desfecho/,
        );
        await expect(
          prisma.db.consent.update({ where: { id: c }, data: { activeMark: null } }),
        ).rejects.toThrow(/não é tenant-safe/);
        await expect(prisma.db.stopBlock.deleteMany({ where: { number: N_E164 } })).rejects.toThrow(
          /só aceita o preenchimento do desfecho/,
        );
        await expect(prisma.db.permissionBackfill.deleteMany({ where: {} })).rejects.toThrow(
          /append-only/,
        );
        // a criação: nasce ativo, sem desfecho e sem instante vindo daqui
        await expect(
          prisma.db.consent.create({
            data: {
              contactId: ana,
              channelId: canalA2,
              number: N_E164,
              purposeId: finalidade,
              origin: 'phone',
              receipt: 'CON-X',
              purposeDescription: 'x',
              grantedByMembershipId: ownerId,
              revokedAt: new Date(),
            },
          } as never),
        ).rejects.toThrow(/nasce ativo, sem desfecho/);
        await expect(
          prisma.db.stopBlock.createMany({
            data: [
              {
                number: OUTRO,
                origin: 'phone',
                receipt: 'PAR-X',
                createdByMembershipId: ownerId,
                createdAt: new Date(0),
              },
            ],
          } as never),
        ).rejects.toThrow(/nasce ativo, sem desfecho/);
      });
      expect(await consentimento(c)).toMatchObject({ number: N_E164, activeMark: true });
      expect(await prisma.raw.stopBlock.count()).toBe(0);
    });

    it('o gatilho: nasce ativo, a concessão é imutável, a revogação é uma só e os instantes são do banco', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const c = (await conceder(ana).expect(201)).body.id as string;
      const agoraDoBanco = async () =>
        (
          await prisma.raw.$queryRawUnsafe<{ agora: Date }[]>('SELECT clock_timestamp() AS agora')
        )[0].agora;
      const perto = (instante: Date | null, de: Date) =>
        expect(Math.abs((instante as Date).getTime() - de.getTime())).toBeLessThan(60_000);
      const inserir = (numero: string, extra: { coluna: string; valor: string } | null) =>
        prisma.raw.$executeRawUnsafe(
          `INSERT INTO "Consent" ("id","workspaceId","contactId","channelId","number","purposeId",
             "origin","receipt","purposeDescription","grantedByMembershipId","grantedAt"
             ${extra ? `,"${extra.coluna}"` : ''})
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'phone',
                   'CON-CRU-' || md5(random()::text), 'x', $6::uuid, '2000-01-01'
                   ${extra ? `, ${extra.valor}` : ''})`,
          wsA.workspaceId,
          ana,
          canalA2,
          numero,
          finalidade,
          ownerId,
        );
      // a criação: nasce ativo e sem desfecho, e o instante enviado é descartado
      await expect(inserir(N_E164, { coluna: 'activeMark', valor: 'NULL' })).rejects.toThrow(
        /nasce ativo, sem revogação/,
      );
      await expect(
        inserir(N_E164, { coluna: 'revocationReason', valor: `'manual'` }),
      ).rejects.toThrow(/nasce ativo, sem revogação/);
      await expect(inserir('5511987654321', null)).rejects.toThrow(/Consent_number_check/);
      await inserir(N_E164, null);
      const cru = await prisma.raw.consent.findFirstOrThrow({ where: { channelId: canalA2 } });
      perto(cru.grantedAt, await agoraDoBanco());

      // o desfecho: só ele, completo, uma vez — cada ramo com a sua recusa
      await expect(
        prisma.raw.$executeRawUnsafe(
          `UPDATE "Consent" SET "revocationReason" = 'manual' WHERE "id" = $1::uuid`,
          c,
        ),
      ).rejects.toThrow(/só a revogação completa se preenche/);
      await expect(
        prisma.raw.$executeRawUnsafe(
          `UPDATE "Consent" SET "revocationReason" = 'manual', "activeMark" = NULL, "number" = $1
            WHERE "id" = $2::uuid`,
          OUTRO,
          c,
        ),
      ).rejects.toThrow(/a concessão é imutável/);
      await prisma.raw.$executeRawUnsafe(
        `UPDATE "Consent" SET "revocationReason" = 'manual', "activeMark" = NULL,
                "revokedAt" = '2000-01-01' WHERE "id" = $1::uuid`,
        c,
      );
      const revogado = await consentimento(c);
      perto(revogado.revokedAt, await agoraDoBanco());
      // o instante de depois das travas: a revogação nunca fica antes da concessão
      expect((revogado.revokedAt as Date).getTime()).toBeGreaterThanOrEqual(
        revogado.grantedAt.getTime(),
      );
      await expect(
        prisma.raw.$executeRawUnsafe(
          `UPDATE "Consent" SET "revocationReason" = 'stop_requested' WHERE "id" = $1::uuid`,
          c,
        ),
      ).rejects.toThrow(/registrada uma vez/);

      // o pedido de parar: o mesmo, com o desbloqueio
      await parar(ana).expect(201);
      const [bloqueio] = await bloqueiosAtivos();
      perto(bloqueio.createdAt, await agoraDoBanco());
      await expect(
        prisma.raw.$executeRawUnsafe(
          `UPDATE "StopBlock" SET "liftOrigin" = 'phone', "liftReceipt" = 'DES-X', "activeMark" = NULL
            WHERE "id" = $1::uuid`,
          bloqueio.id,
        ),
      ).rejects.toThrow(/só o desbloqueio completo se preenche/);
      await expect(
        prisma.raw.$executeRawUnsafe(
          `UPDATE "StopBlock" SET "liftOrigin" = 'phone', "liftReceipt" = 'DES-X', "activeMark" = NULL,
                  "liftedByMembershipId" = $1::uuid, "number" = $2 WHERE "id" = $3::uuid`,
          ownerId,
          OUTRO,
          bloqueio.id,
        ),
      ).rejects.toThrow(/o pedido é imutável/);
      await expect(
        prisma.raw.$executeRawUnsafe(
          `INSERT INTO "StopBlock" ("id","workspaceId","number","origin","receipt","createdByMembershipId","liftReceipt")
           VALUES (gen_random_uuid(), $1::uuid, $2, 'phone', 'PAR-CRU', $3::uuid, 'DES-CRU')`,
          wsA.workspaceId,
          OUTRO,
          ownerId,
        ),
      ).rejects.toThrow(/nasce ativo, sem desbloqueio/);
    });

    it('o CHECK de coerência segura a marca ativa mesmo sem o gatilho, nas duas tabelas', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await conceder(ana).expect(201);
      await parar(ana).expect(201);
      // cada caso numa transação desfeita no fim: prova a segunda camada sozinha
      const semOGatilho = async (tabela: string, gatilho: string, restricao: RegExp) => {
        const c = new Client({ connectionString: TEST_DATABASE_URL });
        await c.connect();
        try {
          await c.query('BEGIN');
          await c.query(`ALTER TABLE "${tabela}" DISABLE TRIGGER ${gatilho}`);
          await expect(
            c.query(`UPDATE "${tabela}" SET "activeMark" = false WHERE "workspaceId" = $1::uuid`, [
              wsA.workspaceId,
            ]),
          ).rejects.toThrow(restricao);
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
          await c.end();
        }
      };
      await semOGatilho('Consent', 'consent_guard', /Consent_outcome_check/);
      await semOGatilho('StopBlock', 'stop_block_guard', /StopBlock_outcome_check/);
      expect(await prisma.raw.stopBlock.count({ where: { activeMark: true } })).toBe(1);
    });

    it('a finalidade com consentimento não se apaga (FK NO ACTION, conferida no fim do comando)', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await conceder(ana).expect(201);
      await expect(
        prisma.raw.$executeRawUnsafe(
          'DELETE FROM "ConsentPurpose" WHERE "id" = $1::uuid',
          finalidade,
        ),
      ).rejects.toThrow(/Consent_workspaceId_purposeId_fkey|23503|foreign key/i);
      expect(await prisma.raw.consentPurpose.count({ where: { id: finalidade } })).toBe(1);
    });

    it('a exclusão do contato leva os consentimentos; o pedido de parar fica, sem contato, e continua valendo', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await conceder(ana).expect(201);
      await parar(ana).expect(201);
      await enviar('delete', `/api/contacts/${ana}`, owner).expect(200);
      expect(await prisma.raw.consent.count({ where: { contactId: ana } })).toBe(0);
      expect(await bloqueiosAtivos()).toHaveLength(1);
      // outro contato com o mesmo número não contorna o pedido (C16)
      const bia = await contato('Bia Fictícia', [N_E164]);
      const r = await conceder(bia).expect(409);
      expect(r.body.message).toMatch(/pedido de parar ativo/);
      await chega();
      const conversa = await conversaDe();
      const politica = await get(`/api/conversations/${conversa.id}/send-policy`, owner).expect(
        200,
      );
      expect(politica.body).toMatchObject({ mode: 'blocked' });
      expect(politica.body.reason).toMatch(/pediu para não receber/);
    });
  });

  // ── As permissões, ato por ato ─────────────────────────────────────────

  describe('as permissões', () => {
    it('consultar pelo contato exige consents:read e contacts:read; o guest e o atendente não veem', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await get(`/api/contacts/${ana}/consents`, owner).expect(200);
      await get(`/api/contacts/${ana}/consents`, membro).expect(200);
      await get(`/api/contacts/${ana}/consents`, guest).expect(403);
      await get(`/api/contacts/${ana}/consents`, atendente).expect(403);
      // o leitor tem consents:read, mas não contacts:read
      await get(`/api/contacts/${ana}/consents`, leitor).expect(403);
    });

    it('pela conversa: o número completo só com contacts:read, e a RAI só para quem tem contacts:write (C13)', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const conversa = await conversaDe();
      await conceder(ana).expect(201);
      const completo = await get(`/api/conversations/${conversa.id}/consents`, owner).expect(200);
      expect(completo.body.number).toBe(N_E164);
      expect(completo.body.consents).toHaveLength(1);
      const mascarado = await get(`/api/conversations/${conversa.id}/consents`, leitor).expect(200);
      expect(mascarado.body.number).toBe(`•••• ${N_E164.slice(-4)}`);
      expect(mascarado.body.consents[0].number).toBe(`•••• ${N_E164.slice(-4)}`);

      // a RAI: dois contatos com o número
      await contato('Bia Fictícia', [OUTRO]);
      await contato('Cora Fictícia', [OUTRO]);
      await chega(OUTRO.slice(1));
      const rai = await conversaDe(OUTRO);
      expect(rai.senderStatus).toBe('unidentified');
      await get(`/api/conversations/${rai.id}/consents`, leitor).expect(404);
      const daRai = await get(`/api/conversations/${rai.id}/consents`, owner).expect(200);
      expect(daRai.body).toMatchObject({ number: OUTRO, stopBlock: null, consents: [] });
    });

    it('conceder e parar: consents:manage com a visibilidade; desbloquear: consents:unblock, que o member não tem', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await conceder(ana, {}, atendente).expect(403);
      await conceder(ana, {}, membro).expect(201);
      await parar(ana, N_E164, atendente).expect(403);
      await parar(ana, N_E164, membro).expect(201);
      await desbloquear(ana, N_E164, membro).expect(403);
      await desbloquear(ana, N_E164, owner).expect(201);
    });

    it('os registros exigem Idempotency-Key', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const sem = await enviar('post', `/api/contacts/${ana}/consents`, owner, {
        channelId: canalA1,
        number: N_E164,
        purposeId: finalidade,
        origin: 'in_person',
      }).expect(400);
      expect(sem.body.message).toMatch(/Idempotency-Key obrigatória/);
      await enviar('post', `/api/contacts/${ana}/stop`, owner, {
        number: N_E164,
        origin: 'phone',
      }).expect(400);
      expect(await prisma.raw.consent.count()).toBe(0);
      expect(await prisma.raw.stopBlock.count()).toBe(0);
    });
  });

  // ── Conceder e revogar ──────────────────────────────────────────────────

  describe('conceder e revogar', () => {
    it('só um número EXATO do contato, num canal de WhatsApp, numa finalidade do workspace', async () => {
      const ana = await contato('Ana Fictícia', ['98765-4321', '+1 202 555 0100']);
      // sem DDD: só coincidência possível, nunca exata
      await conceder(ana, { number: N_E164 }).expect(400);
      const ok = await conceder(ana, { number: '+12025550100' }).expect(201);
      expect(ok.body).toMatchObject({
        number: '+12025550100',
        receipt: 'CON-000001',
        purposeKey: 'lembrete',
        purposeVersion: 1,
        purposeDescription: 'Lembretes de horário marcado',
        revokedAt: null,
      });
      const interno = await prisma.raw.channel.findFirstOrThrow({
        where: { workspaceId: wsA.workspaceId, type: 'internal' },
      });
      await conceder(ana, { number: '+12025550100', channelId: interno.id }).expect(400);
      // a finalidade de OUTRO workspace não existe aqui (P0)
      await conceder(ana, { number: '+12025550100', purposeId: finalidadeB }).expect(404);
    });

    it('repetir o mesmo pedido devolve o MESMO consentimento e recibo; o replay da chave também', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const chave = randomUUID();
      const primeiro = await conceder(ana, {}, owner, chave).expect(201);
      const replay = await conceder(ana, {}, owner, chave).expect(201);
      expect(replay.headers['idempotent-replay']).toBe('true');
      const repetido = await conceder(ana).expect(201);
      expect(replay.body.id).toBe(primeiro.body.id);
      expect(repetido.body).toMatchObject({ id: primeiro.body.id, receipt: 'CON-000001' });
      expect(await prisma.raw.consent.count()).toBe(1);
      // outro canal é outro consentimento, com o recibo seguinte
      const segundo = await conceder(ana, { channelId: canalA2 }).expect(201);
      expect(segundo.body.receipt).toBe('CON-000002');
      // com outra origem não é repetição: devolver o antigo esconderia a origem nova
      const outra = await conceder(ana, { origin: 'paper_form' }).expect(409);
      expect(outra.body.message).toMatch(/outra origem/);
      // a chave de outra pessoa não devolve a resposta guardada dela
      const alheia = await conceder(ana, {}, membro, chave).expect(409);
      expect(alheia.body.message).toMatch(/Idempotency-Key já usada/);
      expect(await prisma.raw.consent.count()).toBe(2);
    });

    it('revogar é uma vez só, com a origem; a trilha não leva o número', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const c = (await conceder(ana).expect(201)).body.id as string;
      const revogado = await registrar(`/api/contacts/${ana}/consents/${c}/revoke`, owner, {
        origin: 'phone',
      }).expect(201);
      expect(revogado.body).toMatchObject({ revocationReason: 'manual' });
      expect(revogado.body.revokedAt).not.toBeNull();
      expect(await consentimento(c)).toMatchObject({
        revocationOrigin: 'phone',
        revokedByMembershipId: ownerId,
        activeMark: null,
      });
      await registrar(`/api/contacts/${ana}/consents/${c}/revoke`, owner, {
        origin: 'phone',
      }).expect(409);
      const trilha = await prisma.raw.auditLog.findMany({
        where: { workspaceId: wsA.workspaceId, entityType: 'consent' },
      });
      expect(trilha.map((t) => t.action).sort()).toEqual(['consent.granted', 'consent.revoked']);
      expect(JSON.stringify(trilha)).not.toContain(N);
    });
  });

  // ── O pedido de parar ──────────────────────────────────────────────────

  describe('o pedido de parar', () => {
    it('vale para o número no workspace: revoga os consentimentos de todo contato e canal, com recibo e trilha sem número', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const bia = await contato('Bia Fictícia', [N_E164, OUTRO]);
      const c1 = (await conceder(ana).expect(201)).body.id as string;
      const c2 = (await conceder(bia, { channelId: canalA2 }).expect(201)).body.id as string;
      const c3 = (await conceder(bia, { number: OUTRO }).expect(201)).body.id as string;
      const pedido = await parar(ana).expect(201);
      expect(pedido.body).toMatchObject({ number: N_E164, receipt: 'PAR-000004', liftedAt: null });
      for (const id of [c1, c2]) {
        expect(await consentimento(id)).toMatchObject({
          revocationReason: 'stop_requested',
          activeMark: null,
        });
      }
      // o outro número da Bia não é tocado
      expect(await consentimento(c3)).toMatchObject({ activeMark: true });
      const [registro] = await prisma.raw.auditLog.findMany({
        where: { workspaceId: wsA.workspaceId, action: 'stop.registered' },
      });
      expect(registro.after).toMatchObject({
        receipt: 'PAR-000004',
        origin: 'phone',
        consentsRevoked: 2,
        dispatchesCanceled: 0,
        dispatchesInFlight: 0,
      });
      expect(JSON.stringify(registro)).not.toContain(N);
      // o pedido não guarda contato nem nome
      const [bloqueio] = await bloqueiosAtivos();
      expect(Object.keys(bloqueio)).not.toContain('contactId');
    });

    it('repetir devolve o MESMO pedido e recibo; desbloquear exige a nova solicitação e NÃO restaura consentimento', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const c = (await conceder(ana).expect(201)).body.id as string;
      const primeiro = await parar(ana).expect(201);
      const repetido = await parar(ana).expect(201);
      expect(repetido.body).toMatchObject({ id: primeiro.body.id, receipt: 'PAR-000002' });
      const lift = await desbloquear(ana).expect(201);
      expect(lift.body).toMatchObject({ id: primeiro.body.id, liftReceipt: 'DES-000003' });
      expect(lift.body.liftedAt).not.toBeNull();
      expect(
        await prisma.raw.stopBlock.findUniqueOrThrow({ where: { id: primeiro.body.id } }),
      ).toMatchObject({
        liftOrigin: 'paper_form',
        liftedByMembershipId: ownerId,
        activeMark: null,
      });
      // o consentimento revogado pelo pedido continua revogado
      expect(await consentimento(c)).toMatchObject({ revocationReason: 'stop_requested' });
      // sem pedido ativo, desbloquear é 409; conceder volta a ser possível, com recibo novo
      await desbloquear(ana).expect(409);
      const novo = await conceder(ana).expect(201);
      expect(novo.body.id).not.toBe(c);
      expect(novo.body.receipt).toBe('CON-000004');
    });

    it('pela conversa RAI, sem atribuí-la; só quem vê a RAI (C13)', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await chega();
      const rai = await conversaDe();
      expect(rai.senderStatus).toBe('unidentified');
      await registrar(`/api/conversations/${rai.id}/stop`, atendente, { origin: 'phone' }).expect(
        403,
      );
      await registrar(`/api/conversations/${rai.id}/stop`, leitor, { origin: 'phone' }).expect(403);
      // com a chave do ato e sem contacts:write, a RAI não existe para ele: 404, não 403
      const g = await createUserFixture(prisma, 'gestor@veyra.test');
      await createMembershipFixture(
        prisma,
        wsA.workspaceId,
        g,
        await papel('Gestor', [
          'workspace:read',
          'conversations:read',
          'consents:read',
          'consents:manage',
          'consents:unblock',
        ]),
      );
      const gestor = await login('gestor@veyra.test');
      await registrar(`/api/conversations/${rai.id}/stop`, gestor, { origin: 'phone' }).expect(404);
      await get(`/api/conversations/${rai.id}/consents`, gestor).expect(404);
      expect(await prisma.raw.stopBlock.count()).toBe(0);
      const pedido = await registrar(`/api/conversations/${rai.id}/stop`, owner, {
        origin: 'phone',
      }).expect(201);
      expect(pedido.body.number).toBe(N_E164);
      // a conversa continua RAI
      expect((await conversaDe()).senderStatus).toBe('unidentified');
      const lift = await registrar(`/api/conversations/${rai.id}/stop/lift`, owner, {
        origin: 'in_person',
      }).expect(201);
      expect(lift.body.liftReceipt).toBe('DES-000002');
    });

    it('nada sai sob o pedido: a API recusa antes de mensagem, despacho e reserva, em qualquer canal e por qualquer contato', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      await chega(N, NUMERO_A2);
      await parar(ana).expect(201);
      for (const canal of [canalA1, canalA2]) {
        const conversa = await conversaDe(N_E164, canal);
        const politica = await get(`/api/conversations/${conversa.id}/send-policy`, owner).expect(
          200,
        );
        expect(politica.body).toMatchObject({ mode: 'blocked', templates: [] });
        expect(politica.body.reason).toMatch(/pediu para não receber/);
        const r = await responder(conversa.id).expect(400);
        expect(r.body.message).toMatch(/pediu para não receber/);
      }
      expect(await prisma.raw.message.count({ where: { direction: 'outbound' } })).toBe(0);
      expect(await prisma.raw.messageDispatch.count()).toBe(0);
      expect(await prisma.raw.usageReservation.count()).toBe(0);
      await drenar();
      expect(meta.sends).toEqual([]);
    });

    it('cancela os despachos NÃO iniciados do número (reserva devolvida); o que está em voo só é contado', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      await chega(N, NUMERO_A2);
      const c1 = await conversaDe(N_E164, canalA1);
      const c2 = await conversaDe(N_E164, canalA2);
      const pendente = (await responder(c1.id).expect(201)).body.id as string;
      const emVoo = (await responder(c2.id).expect(201)).body.id as string;
      // o segundo já com o marcador de despacho, como um worker no meio da chamada
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId: emVoo },
        data: { state: 'sending', dispatchedAt: new Date(), claimToken: randomUUID() },
      });
      expect(await prisma.raw.usageReservation.count()).toBe(2);
      const ana = (await prisma.raw.contact.findFirstOrThrow({ where: { name: 'Ana Fictícia' } }))
        .id;
      await parar(ana).expect(201);
      expect(await despachoDe(pendente)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'stop_requested',
        reservationId: null,
        claimToken: null,
      });
      expect(await despachoDe(emVoo)).toMatchObject({ state: 'sending' });
      // só a reserva do cancelado voltou
      expect(await prisma.raw.usageReservation.count()).toBe(1);
      const [registro] = await prisma.raw.auditLog.findMany({
        where: { action: 'stop.registered' },
      });
      expect(registro.after).toMatchObject({ dispatchesCanceled: 1, dispatchesInFlight: 1 });
      await drenar();
      expect(meta.sends).toEqual([]);
    });

    it('cancela também o reivindicado sem marcador e o a retentar: o worker perde a posse e não chama a Meta', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      const conversa = await conversaDe();
      const reivindicado = (await responder(conversa.id).expect(201)).body.id as string;
      const aRetentar = (await responder(conversa.id, { body: 'Outra' }).expect(201)).body
        .id as string;
      const posse = randomUUID();
      // um worker reivindicou e ainda não marcou; o outro falhou antes de enviar
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId: reivindicado },
        data: {
          state: 'sending',
          claimToken: posse,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          dispatchedAt: null,
        },
      });
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId: aRetentar },
        data: { state: 'failed_before_send' },
      });
      await parar(ana).expect(201);
      for (const id of [reivindicado, aRetentar]) {
        expect(await despachoDe(id)).toMatchObject({
          state: 'failed_permanent',
          errorCode: 'stop_requested',
          claimToken: null,
          reservationId: null,
        });
      }
      // o marcador do worker exige a posse: ele não marca, e por isso não chama a Meta
      const marcou = await prisma.raw.messageDispatch.updateMany({
        where: { messageId: reivindicado, claimToken: posse, state: 'sending' },
        data: { dispatchedAt: new Date() },
      });
      expect(marcou.count).toBe(0);
      expect(await prisma.raw.usageReservation.count()).toBe(0);
      await drenar();
      expect(meta.sends).toEqual([]);
    });

    it('o envio de pessoa grava o marcador sob o endereço: o pedido que comita no meio é visto, e nada sai', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      const conversa = await conversaDe();
      const enviada = (await responder(conversa.id).expect(201)).body.id as string;
      // a trava exclusiva do endereço, como a do pedido de parar
      const t = await travar(endereco(N_E164));
      try {
        const envio = app.get(JobsService).dispatchPending();
        await esperarBloqueadosPor(t, 1, { descricao: 'o marcador do envio no endereço' });
        await t.query(
          `INSERT INTO "StopBlock" ("id","workspaceId","number","origin","receipt","createdByMembershipId")
           VALUES (gen_random_uuid(), $1, $2, 'phone', 'PAR-MEIO', $3)`,
          [wsA.workspaceId, N_E164, ownerId],
        );
        await t.query('COMMIT');
        await envio;
      } finally {
        await soltar(t);
      }
      expect(await despachoDe(enviada)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'stop_requested',
        dispatchedAt: null,
      });
      expect(await prisma.raw.usageReservation.count()).toBe(0);
      expect(meta.sends).toEqual([]);
    });

    it('o worker recusa o despacho pendente sob pedido que ele não cancelou (stop_requested)', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      const conversa = await conversaDe();
      const enviada = (await responder(conversa.id).expect(201)).body.id as string;
      // o pedido gravado por fora do serviço: só o worker pode recusar
      await prisma.raw.stopBlock.create({
        data: {
          workspaceId: wsA.workspaceId,
          number: N_E164,
          origin: 'phone',
          receipt: 'PAR-FORA',
          createdByMembershipId: ownerId,
        },
      });
      await drenar();
      expect(await despachoDe(enviada)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'stop_requested',
      });
      expect(meta.sends).toEqual([]);
    });

    it('a IA não gera sob o pedido, e o rascunho de antes não é aprovado (fica pendente)', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const conversa = await conversaDe();
      llm.nextText = RASCUNHO;
      const antes = await enviar(
        'post',
        `/api/intelligence/conversations/${conversa.id}/reply-suggestion`,
        owner,
      ).expect(201);
      await parar(ana).expect(201);
      const chamadas = llm.calls;
      const depois = await enviar(
        'post',
        `/api/intelligence/conversations/${conversa.id}/reply-suggestion`,
        owner,
      ).expect(201);
      expect(depois.body.status).toBe('send_blocked');
      expect(llm.calls).toBe(chamadas);
      const r = await enviar(
        'post',
        `/api/intelligence/proposals/${antes.body.proposalId}/approve-reply`,
        owner,
        {},
      ).expect(400);
      expect(r.body.message).toMatch(/pediu para não receber/);
      expect(
        await prisma.raw.aiProposal.findUniqueOrThrow({ where: { id: antes.body.proposalId } }),
      ).toMatchObject({ status: 'pending' });
      expect(await prisma.raw.messageDispatch.count()).toBe(0);
    });

    it('o despacho da IA que esperava a guarda é recusado pela reconferência quando o pedido chega no meio', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const conversa = await conversaDe();
      llm.nextText = RASCUNHO;
      const sugestao = await enviar(
        'post',
        `/api/intelligence/conversations/${conversa.id}/reply-suggestion`,
        owner,
      ).expect(201);
      await enviar(
        'post',
        `/api/intelligence/proposals/${sugestao.body.proposalId}/approve-reply`,
        owner,
        {},
      ).expect(201);
      const despacho = await prisma.raw.messageDispatch.findFirstOrThrow({
        where: { fromAiProposal: true },
      });
      const t = await travar(CHAVE.contato(wsA.workspaceId, ana));
      try {
        const envio = app.get(JobsService).dispatchPending();
        await esperarBloqueadosPor(t, 1, { descricao: 'a guarda do envio na trava da Ana' });
        // o despacho já tem o marcador: o pedido não o cancela, a reconferência o recusa
        await t.query(
          `INSERT INTO "StopBlock" ("id","workspaceId","number","origin","receipt","createdByMembershipId")
           VALUES (gen_random_uuid(), $1, $2, 'phone', 'PAR-GUARDA', $3)`,
          [wsA.workspaceId, N_E164, ownerId],
        );
        await t.query('COMMIT');
        await envio;
      } finally {
        await soltar(t);
      }
      expect(await despachoDe(despacho.messageId)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'stop_requested',
      });
      expect(meta.sends).toEqual([]);
    });
  });

  // ── O replay da idempotência com o acesso de agora ──────────────────────

  describe('o replay pela conversa, com o acesso de agora', () => {
    /** Um membro com papel próprio, para mudar o acesso dele no meio do teste. */
    const operador = async (email: string, chaves: string[]) => {
      const u = await createUserFixture(prisma, email);
      const roleId = await papel(`Operador ${email}`, ['workspace:read', ...chaves]);
      await createMembershipFixture(prisma, wsA.workspaceId, u, roleId);
      return { sessao: await login(email), roleId };
    };
    const tirar = (roleId: string, permissionKey: string) =>
      prisma.raw.rolePermission.deleteMany({ where: { roleId, permissionKey } });
    const estado = async () => ({
      pedidos: await prisma.raw.stopBlock.count(),
      trilha: await prisma.raw.auditLog.count({ where: { entityType: 'stopBlock' } }),
    });

    it('a mesma pessoa, sem contacts:read agora, não recebe o número completo guardado', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const conversa = await conversaDe();
      const { sessao, roleId } = await operador('op@veyra.test', [
        'conversations:read',
        'consents:read',
        'consents:manage',
        'contacts:read',
      ]);
      const chave = randomUUID();
      const primeiro = await registrar(
        `/api/conversations/${conversa.id}/stop`,
        sessao,
        { origin: 'phone' },
        chave,
      ).expect(201);
      expect(primeiro.body.number).toBe(N_E164);
      const antes = await estado();
      await tirar(roleId, 'contacts:read');
      const replay = await registrar(
        `/api/conversations/${conversa.id}/stop`,
        sessao,
        { origin: 'phone' },
        chave,
      ).expect(403);
      expect(JSON.stringify(replay.body)).not.toContain(N);
      expect(replay.headers['idempotent-replay']).toBeUndefined();
      // nada executou de novo, e a resposta guardada fica (não é descartada)
      expect(await estado()).toEqual(antes);
      expect(await prisma.raw.idempotencyKey.count({ where: { key: chave } })).toBe(1);
    });

    it('sem o acesso da RAI agora, o replay não contorna a recusa da rota (404)', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await chega();
      const rai = await conversaDe();
      expect(rai.senderStatus).toBe('unidentified');
      const { sessao, roleId } = await operador('op@veyra.test', [
        'conversations:read',
        'consents:read',
        'consents:manage',
        'contacts:read',
        'contacts:write',
      ]);
      const chave = randomUUID();
      await registrar(
        `/api/conversations/${rai.id}/stop`,
        sessao,
        { origin: 'phone' },
        chave,
      ).expect(201);
      const antes = await estado();
      await tirar(roleId, 'contacts:write');
      const replay = await registrar(
        `/api/conversations/${rai.id}/stop`,
        sessao,
        { origin: 'phone' },
        chave,
      ).expect(404);
      expect(JSON.stringify(replay.body)).not.toContain(N);
      expect(await estado()).toEqual(antes);
    });

    it('com o acesso mantido, a repetição devolve o mesmo registro e recibo, sem operação nova — mascarado ou não', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const conversa = await conversaDe();
      const completo = await operador('op@veyra.test', [
        'conversations:read',
        'consents:read',
        'consents:manage',
        'consents:unblock',
        'contacts:read',
      ]);
      // quem nunca teve contacts:read recebeu o número mascarado, e o replay também
      const mascarado = await operador('op2@veyra.test', [
        'conversations:read',
        'consents:read',
        'consents:manage',
      ]);
      const chave = randomUUID();
      const primeiro = await registrar(
        `/api/conversations/${conversa.id}/stop`,
        completo.sessao,
        { origin: 'phone' },
        chave,
      ).expect(201);
      const antes = await estado();
      const replay = await registrar(
        `/api/conversations/${conversa.id}/stop`,
        completo.sessao,
        { origin: 'phone' },
        chave,
      ).expect(201);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(replay.body).toEqual(primeiro.body);
      expect(replay.body.receipt).toBe('PAR-000001');

      const outraChave = randomUUID();
      const doMascarado = await registrar(
        `/api/conversations/${conversa.id}/stop`,
        mascarado.sessao,
        { origin: 'phone' },
        outraChave,
      ).expect(201);
      expect(doMascarado.body).toMatchObject({
        id: primeiro.body.id,
        number: `•••• ${N_E164.slice(-4)}`,
      });
      const replayMascarado = await registrar(
        `/api/conversations/${conversa.id}/stop`,
        mascarado.sessao,
        { origin: 'phone' },
        outraChave,
      ).expect(201);
      expect(replayMascarado.headers['idempotent-replay']).toBe('true');
      expect(replayMascarado.body).toEqual(doMascarado.body);

      // o desbloqueio pela conversa também repete sem operar de novo
      const chaveLift = randomUUID();
      const lift = await registrar(
        `/api/conversations/${conversa.id}/stop/lift`,
        completo.sessao,
        { origin: 'in_person' },
        chaveLift,
      ).expect(201);
      const depoisDoLift = await estado();
      const replayLift = await registrar(
        `/api/conversations/${conversa.id}/stop/lift`,
        completo.sessao,
        { origin: 'in_person' },
        chaveLift,
      ).expect(201);
      expect(replayLift.headers['idempotent-replay']).toBe('true');
      expect(replayLift.body).toEqual(lift.body);
      expect(await estado()).toEqual(depoisDoLift);
      expect(antes.pedidos).toBe(1);
    });

    it('o replay do desbloqueio pela conversa também recusa sem contacts:read (403)', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const conversa = await conversaDe();
      await parar(ana).expect(201);
      const { sessao, roleId } = await operador('op@veyra.test', [
        'conversations:read',
        'consents:read',
        'consents:unblock',
        'contacts:read',
      ]);
      const chave = randomUUID();
      const lift = await registrar(
        `/api/conversations/${conversa.id}/stop/lift`,
        sessao,
        { origin: 'in_person' },
        chave,
      ).expect(201);
      expect(lift.body.number).toBe(N_E164);
      const antes = await estado();
      await tirar(roleId, 'contacts:read');
      const replay = await registrar(
        `/api/conversations/${conversa.id}/stop/lift`,
        sessao,
        { origin: 'in_person' },
        chave,
      ).expect(403);
      expect(replay.body.message).toMatch(/já foi feito/);
      expect(JSON.stringify(replay.body)).not.toContain(N);
      expect(await estado()).toEqual(antes);
    });

    it('sem a RAI e sem contacts:read, a recusa é a da rota (404), e não a da projeção', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await chega();
      const rai = await conversaDe();
      const { sessao, roleId } = await operador('op@veyra.test', [
        'conversations:read',
        'consents:read',
        'consents:manage',
        'contacts:read',
        'contacts:write',
      ]);
      const chave = randomUUID();
      await registrar(
        `/api/conversations/${rai.id}/stop`,
        sessao,
        { origin: 'phone' },
        chave,
      ).expect(201);
      await tirar(roleId, 'contacts:write');
      await tirar(roleId, 'contacts:read');
      // a visibilidade vem antes: o 403 diria a quem não vê a RAI que ela existe
      await registrar(
        `/api/conversations/${rai.id}/stop`,
        sessao,
        { origin: 'phone' },
        chave,
      ).expect(404);
    });

    it('sem conseguir conferir o acesso, 503: nada é devolvido, apagado nem executado de novo', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const conversa = await conversaDe();
      const { sessao } = await operador('op@veyra.test', [
        'conversations:read',
        'consents:read',
        'consents:manage',
        'contacts:read',
      ]);
      const chave = randomUUID();
      const primeiro = await registrar(
        `/api/conversations/${conversa.id}/stop`,
        sessao,
        { origin: 'phone' },
        chave,
      ).expect(201);
      const antes = await estado();
      const leitura = jest
        .spyOn(app.get(ConversationsService), 'alvoDoConsentimento')
        .mockRejectedValueOnce(new Error('banco fora do ar (fictício)'));
      try {
        await registrar(
          `/api/conversations/${conversa.id}/stop`,
          sessao,
          { origin: 'phone' },
          chave,
        ).expect(503);
      } finally {
        leitura.mockRestore();
      }
      expect(await estado()).toEqual(antes);
      expect(await prisma.raw.idempotencyKey.count({ where: { key: chave } })).toBe(1);
      // a leitura volta: o replay sai igual
      const replay = await registrar(
        `/api/conversations/${conversa.id}/stop`,
        sessao,
        { origin: 'phone' },
        chave,
      ).expect(201);
      expect(replay.body).toEqual(primeiro.body);
    });

    it('outro membro com a mesma chave recebe 409, nunca o corpo guardado', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const conversa = await conversaDe();
      const um = await operador('op@veyra.test', [
        'conversations:read',
        'consents:read',
        'consents:manage',
        'contacts:read',
      ]);
      const outro = await operador('op2@veyra.test', [
        'conversations:read',
        'consents:read',
        'consents:manage',
        'contacts:read',
      ]);
      const chave = randomUUID();
      await registrar(
        `/api/conversations/${conversa.id}/stop`,
        um.sessao,
        { origin: 'phone' },
        chave,
      ).expect(201);
      const antes = await estado();
      const alheio = await registrar(
        `/api/conversations/${conversa.id}/stop`,
        outro.sessao,
        { origin: 'phone' },
        chave,
      ).expect(409);
      expect(alheio.body.message).toMatch(/Idempotency-Key já usada/);
      expect(JSON.stringify(alheio.body)).not.toContain(N);
      expect(await estado()).toEqual(antes);
    });
  });

  // ── A leitura exigida nos registros (decisão 19) ────────────────────────

  describe('a leitura exigida nos seis registros (decisão 19)', () => {
    /** Tem tudo o que cada registro exige, menos `consents:read`. */
    const SEM_LEITURA = [
      'workspace:read',
      'contacts:read',
      'contacts:write',
      'conversations:read',
      'consents:manage',
      'consents:unblock',
    ];
    const registrador = async (email: string, chaves: string[]) => {
      const u = await createUserFixture(prisma, email);
      const roleId = await papel(`Registrador ${email}`, chaves);
      await createMembershipFixture(prisma, wsA.workspaceId, u, roleId);
      return { sessao: await login(email), roleId };
    };
    const estado = async () => ({
      consentimentos: await prisma.raw.consent.count(),
      ativos: await prisma.raw.consent.count({ where: { activeMark: true } }),
      pedidos: await prisma.raw.stopBlock.count(),
      pedidosAtivos: await prisma.raw.stopBlock.count({ where: { activeMark: true } }),
      trilha: await prisma.raw.auditLog.count(),
      chaves: await prisma.raw.idempotencyKey.count(),
    });

    it('sem consents:read, as seis rotas respondem 403, sem efeito e sem devolver o registro anterior', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const conversa = await conversaDe();
      // registros anteriores, de outra pessoa: a chave natural os devolveria
      const c = (await conceder(ana).expect(201)).body.id as string;
      const { sessao } = await registrador('reg@veyra.test', SEM_LEITURA);
      const semEfeito = async (
        tentativa: () => PromiseLike<{ status: number; body: unknown }>,
        ...proibidos: string[]
      ) => {
        const antes = await estado();
        const r = await tentativa();
        expect(r.status).toBe(403);
        for (const texto of proibidos) expect(JSON.stringify(r.body)).not.toContain(texto);
        expect(await estado()).toEqual(antes);
      };
      await semEfeito(() => conceder(ana, {}, sessao).then((r) => r), 'CON-', N);
      await semEfeito(
        () =>
          registrar(`/api/contacts/${ana}/consents/${c}/revoke`, sessao, {
            origin: 'phone',
          }).then((r) => r),
        'CON-',
        N,
      );
      await parar(ana).expect(201);
      await semEfeito(() => parar(ana, N_E164, sessao).then((r) => r), 'PAR-', N);
      await semEfeito(
        () =>
          registrar(`/api/conversations/${conversa.id}/stop`, sessao, { origin: 'phone' }).then(
            (r) => r,
          ),
        'PAR-',
        N,
      );
      await semEfeito(() => desbloquear(ana, N_E164, sessao).then((r) => r), 'PAR-', 'DES-', N);
      await semEfeito(
        () =>
          registrar(`/api/conversations/${conversa.id}/stop/lift`, sessao, {
            origin: 'in_person',
          }).then((r) => r),
        'PAR-',
        'DES-',
        N,
      );
      expect(await bloqueiosAtivos()).toHaveLength(1);
    });

    it('com a leitura somada às permissões, as mesmas rotas funcionam', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const conversa = await conversaDe();
      const { sessao } = await registrador('reg@veyra.test', [...SEM_LEITURA, 'consents:read']);
      const c = (await conceder(ana, {}, sessao).expect(201)).body.id as string;
      await registrar(`/api/contacts/${ana}/consents/${c}/revoke`, sessao, {
        origin: 'phone',
      }).expect(201);
      await parar(ana, N_E164, sessao).expect(201);
      await registrar(`/api/conversations/${conversa.id}/stop`, sessao, { origin: 'phone' }).expect(
        201,
      );
      await desbloquear(ana, N_E164, sessao).expect(201);
      await parar(ana, N_E164, sessao).expect(201);
      await registrar(`/api/conversations/${conversa.id}/stop/lift`, sessao, {
        origin: 'in_person',
      }).expect(201);
      expect(await bloqueiosAtivos()).toHaveLength(0);
    });

    it('a trilha é supervisão: com audit:read e sem consents:read, vê recibo, origem e data, nunca o número, e segue barrado nas rotas', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const conversa = await conversaDe();
      const c = (await conceder(ana).expect(201)).body.id as string;
      await parar(ana).expect(201);
      // tudo o que registra e lê a trilha, menos a leitura do consentimento
      const { sessao } = await registrador('auditor@veyra.test', [...SEM_LEITURA, 'audit:read']);

      const trilha = async (entityType: string) =>
        (await get(`/api/audit?entityType=${entityType}&limit=100`, sessao).expect(200)).body
          .items as {
          action: string;
          entityId: string;
          after: Record<string, unknown>;
          createdAt: string;
        }[];
      const consentimentos = await trilha('consent');
      const concedido = consentimentos.find((e) => e.action === 'consent.granted');
      expect(concedido).toMatchObject({
        entityId: c,
        after: { receipt: 'CON-000001', origin: 'in_person' },
      });
      expect(Number.isNaN(Date.parse(concedido!.createdAt))).toBe(false);
      const pedidos = await trilha('stopBlock');
      expect(pedidos.find((e) => e.action === 'stop.registered')).toMatchObject({
        after: { receipt: 'PAR-000002', origin: 'phone' },
      });
      // o número, a evidência e o registro completo nunca: só os campos revisados
      for (const entrada of [...consentimentos, ...pedidos]) {
        expect(JSON.stringify(entrada)).not.toContain(N);
        const permitidos =
          AUDIT_FIELDS[entrada.action.startsWith('consent.') ? 'consent' : 'stopBlock'];
        for (const campo of Object.keys(entrada.after ?? {})) expect(permitidos).toContain(campo);
      }
      // campo novo na trilha passa por revisão: mudar a lista quebra este teste
      expect(AUDIT_FIELDS.consent).toEqual([
        'contactId',
        'channelId',
        'purposeId',
        'origin',
        'receipt',
        'revocationReason',
        'revocationOrigin',
      ]);
      expect(AUDIT_FIELDS.stopBlock).toEqual([
        'origin',
        'receipt',
        'liftOrigin',
        'liftReceipt',
        'consentsRevoked',
        'dispatchesCanceled',
        'dispatchesInFlight',
      ]);

      // os links da trilha seguem as permissões das rotas: consultar e registrar, 403
      await get(`/api/contacts/${ana}/consents`, sessao).expect(403);
      await get(`/api/conversations/${conversa.id}/consents`, sessao).expect(403);
      await get('/api/consent-purposes', sessao).expect(403);
      await conceder(ana, { channelId: canalA2 }, sessao).expect(403);
      await registrar(`/api/conversations/${conversa.id}/stop`, sessao, { origin: 'phone' }).expect(
        403,
      );
      await desbloquear(ana, N_E164, sessao).expect(403);
      expect(await bloqueiosAtivos()).toHaveLength(1);
    });

    it('perder consents:read entre a primeira execução e o replay: 403, sem devolver nem apagar a resposta guardada', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const conversa = await conversaDe();
      const { sessao, roleId } = await registrador('reg@veyra.test', [
        ...SEM_LEITURA,
        'consents:read',
      ]);
      const chaveConceder = randomUUID();
      const chaveParar = randomUUID();
      const concedido = await conceder(ana, {}, sessao, chaveConceder).expect(201);
      const parado = await registrar(
        `/api/conversations/${conversa.id}/stop`,
        sessao,
        { origin: 'phone' },
        chaveParar,
      ).expect(201);
      const antes = await estado();
      await prisma.raw.rolePermission.deleteMany({
        where: { roleId, permissionKey: 'consents:read' },
      });
      const r1 = await conceder(ana, {}, sessao, chaveConceder).expect(403);
      expect(JSON.stringify(r1.body)).not.toContain(concedido.body.receipt);
      const r2 = await registrar(
        `/api/conversations/${conversa.id}/stop`,
        sessao,
        { origin: 'phone' },
        chaveParar,
      ).expect(403);
      expect(JSON.stringify(r2.body)).not.toContain(parado.body.receipt);
      expect(r1.headers['idempotent-replay']).toBeUndefined();
      expect(r2.headers['idempotent-replay']).toBeUndefined();
      // nada executou, e as duas respostas guardadas continuam lá
      expect(await estado()).toEqual(antes);
      expect(
        await prisma.raw.idempotencyKey.count({
          where: { key: { in: [chaveConceder, chaveParar] }, state: 'completed' },
        }),
      ).toBe(2);
    });
  });

  // ── Os templates na transição ───────────────────────────────────────────

  describe('os templates na transição', () => {
    const comTemplateAntigo = async (contactId: string) => {
      // o consentimento da 9.1 e um template aprovado: nada disso autoriza mais
      await prisma.raw.contactChannelConsent.create({
        data: {
          workspaceId: wsA.workspaceId,
          contactId,
          channelType: 'whatsapp',
          source: 'agent',
          activeMark: true,
        },
      });
      await prisma.raw.messageTemplate.create({
        data: {
          workspaceId: wsA.workspaceId,
          channelId: canalA1,
          name: 'retorno_consulta',
          language: 'pt_BR',
          paramCount: 1,
        },
      });
    };

    it('a API recusa o template, dentro da janela, antes de mensagem, despacho e reserva', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await comTemplateAntigo(ana);
      await chega();
      const conversa = await conversaDe();
      const r = await responder(conversa.id, {
        template: { name: 'retorno_consulta', language: 'pt_BR', params: ['quinta'] },
      }).expect(400);
      expect(r.body.message).toMatch(/template está indisponível/);
      expect(await prisma.raw.message.count({ where: { direction: 'outbound' } })).toBe(0);
      expect(await prisma.raw.messageDispatch.count()).toBe(0);
      expect(await prisma.raw.usageReservation.count()).toBe(0);
    });

    it('o compositor: janela fechada mostra a indisponibilidade, sem templates nem o estado da 9.1', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await comTemplateAntigo(ana);
      await chega();
      const conversa = await conversaDe();
      await prisma.raw.conversation.updateMany({
        where: { id: conversa.id },
        data: { lastInboundAt: new Date(Date.now() - 25 * 3600_000) },
      });
      const politica = await get(`/api/conversations/${conversa.id}/send-policy`, owner).expect(
        200,
      );
      expect(politica.body).toMatchObject({ mode: 'blocked', consentStatus: null, templates: [] });
      expect(politica.body.reason).toMatch(
        /Janela de 24h fechada\. O envio por template está indisponível/,
      );
      // dentro da janela, o texto livre segue, ainda sem templates oferecidos
      await prisma.raw.conversation.updateMany({
        where: { id: conversa.id },
        data: { lastInboundAt: new Date() },
      });
      const aberta = await get(`/api/conversations/${conversa.id}/send-policy`, owner).expect(200);
      expect(aberta.body).toMatchObject({ mode: 'free_form', consentStatus: null, templates: [] });
    });

    it('o worker leva o despacho de template ainda pendente a failed_permanent, sem tocar consentimento', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await comTemplateAntigo(ana);
      await credencialDeVerdade();
      await chega();
      const c = (await conceder(ana).expect(201)).body.id as string;
      const conversa = await conversaDe();
      const enviada = (await responder(conversa.id).expect(201)).body.id as string;
      // o pedido antigo, anterior à F4.1b: o despacho guardava o template
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId: enviada },
        data: {
          templateName: 'retorno_consulta',
          templateLanguage: 'pt_BR',
          templateParams: ['x'],
        },
      });
      await drenar();
      expect(await despachoDe(enviada)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'template_flow_unavailable',
      });
      expect(meta.sends).toEqual([]);
      expect(await consentimento(c)).toMatchObject({ activeMark: true, revokedAt: null });
    });
  });

  // ── O número que sai do contato ─────────────────────────────────────────

  describe('o número que sai do contato', () => {
    it('editar tira o número: o consentimento dele é revogado (number_removed); o de outro número e a formatação não', async () => {
      const ana = await contato('Ana Fictícia', ['+55 11 98765-4321', OUTRO]);
      const c1 = (await conceder(ana).expect(201)).body.id as string;
      const c2 = (await conceder(ana, { number: OUTRO }).expect(201)).body.id as string;
      // só a formatação muda: o número exato é o mesmo
      await enviar('patch', `/api/contacts/${ana}`, owner, {
        phones: ['(11) 98765-4321', OUTRO],
      }).expect(200);
      expect(await consentimento(c1)).toMatchObject({ activeMark: true });
      await enviar('patch', `/api/contacts/${ana}`, owner, { phones: [OUTRO] }).expect(200);
      expect(await consentimento(c1)).toMatchObject({
        revocationReason: 'number_removed',
        activeMark: null,
        revokedByMembershipId: ownerId,
      });
      expect(await consentimento(c2)).toMatchObject({ activeMark: true });
    });

    it('rejeitar o remetente com a retirada do número revoga o consentimento dele', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const conversa = await conversaDe();
      expect(conversa.contactId).toBe(ana);
      const c = (await conceder(ana).expect(201)).body.id as string;
      await enviar('post', `/api/conversations/${conversa.id}/sender/reject`, owner, {
        removeNumber: true,
      }).expect(201);
      expect(await consentimento(c)).toMatchObject({ revocationReason: 'number_removed' });
    });
  });

  // ── O isolamento entre workspaces (P0) ──────────────────────────────────

  describe('o isolamento entre workspaces (P0)', () => {
    it('o pedido de um workspace não bloqueia o mesmo número em outro, nem cancela o despacho dele', async () => {
      const anaA = await contato('Ana Fictícia', [N_E164]);
      const anaB = await contato('Ana Fictícia B', [N_E164], ownerB);
      await credencialDeVerdade();
      await chega();
      const conversa = await conversaDe();
      const pendente = (await responder(conversa.id).expect(201)).body.id as string;
      await registrar(`/api/contacts/${anaB}/stop`, ownerB, {
        number: N_E164,
        origin: 'phone',
      }).expect(201);
      expect(await bloqueiosAtivos(() => wsB.workspaceId)).toHaveLength(1);
      expect(await bloqueiosAtivos()).toHaveLength(0);
      // o despacho do A, para o mesmo número, segue reservado e sai
      expect(await despachoDe(pendente)).toMatchObject({ state: 'reserved' });
      await drenar();
      expect(await despachoDe(pendente)).toMatchObject({ state: 'sent' });
      // no A, nada bloqueado: conceder funciona, e o recibo começa do 1
      const c = await conceder(anaA).expect(201);
      expect(c.body.receipt).toBe('CON-000001');
      const politica = await get(`/api/conversations/${conversa.id}/send-policy`, owner).expect(
        200,
      );
      expect(politica.body).toMatchObject({ mode: 'free_form' });
    });

    it('o B não alcança nada do A: contato, consentimento, conversa nem finalidade', async () => {
      const anaA = await contato('Ana Fictícia', [N_E164]);
      const c = await conceder(anaA).expect(201);
      await chega();
      const conversa = await conversaDe();
      await get(`/api/contacts/${anaA}/consents`, ownerB).expect(404);
      await registrar(`/api/contacts/${anaA}/consents/${c.body.id}/revoke`, ownerB, {
        origin: 'phone',
      }).expect(404);
      await registrar(`/api/contacts/${anaA}/stop`, ownerB, {
        number: N_E164,
        origin: 'phone',
      }).expect(404);
      await get(`/api/conversations/${conversa.id}/consents`, ownerB).expect(404);
      await registrar(`/api/conversations/${conversa.id}/stop`, ownerB, { origin: 'phone' }).expect(
        404,
      );
      await registrar(`/api/conversations/${conversa.id}/stop/lift`, ownerB, {
        origin: 'phone',
      }).expect(404);
      // a finalidade do A, no contato do B, não existe
      const anaB = await contato('Ana Fictícia B', [OUTRO], ownerB);
      await registrar(`/api/contacts/${anaB}/consents`, ownerB, {
        channelId: canalB,
        number: OUTRO,
        purposeId: finalidade,
        origin: 'phone',
      }).expect(404);
      expect(await prisma.raw.stopBlock.count()).toBe(0);
      expect(await consentimento(c.body.id)).toMatchObject({ activeMark: true });
    });

    it('a FK composta impede consentimento de um workspace apontar para contato de outro', async () => {
      const anaA = await contato('Ana Fictícia', [N_E164]);
      const membroB = await prisma.raw.membership.findFirstOrThrow({
        where: { workspaceId: wsB.workspaceId },
      });
      await expect(
        prisma.raw.consent.create({
          data: {
            workspaceId: wsB.workspaceId,
            contactId: anaA,
            channelId: canalB,
            number: N_E164,
            purposeId: finalidadeB,
            origin: 'phone',
            receipt: 'CON-X',
            purposeDescription: 'x',
            grantedByMembershipId: membroB.id,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('excluir o workspace leva tudo: finalidade, consentimento, pedido, recibos e o livro', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await conceder(ana).expect(201);
      await parar(ana).expect(201);
      await prisma.raw.permissionBackfill.create({
        data: {
          workspaceId: wsA.workspaceId,
          roleId: wsA.roles.member,
          permissionKey: 'consents:read',
        },
      });
      // a FK da finalidade é NO ACTION: conferida no fim do comando, a cascata
      // do workspace não depende da ordem em que apaga as linhas
      await prisma.raw.$executeRawUnsafe(
        'DELETE FROM "Workspace" WHERE "id" = $1::uuid',
        wsA.workspaceId,
      );
      for (const contagem of [
        prisma.raw.consentPurpose.count({ where: { workspaceId: wsA.workspaceId } }),
        prisma.raw.consent.count({ where: { workspaceId: wsA.workspaceId } }),
        prisma.raw.stopBlock.count({ where: { workspaceId: wsA.workspaceId } }),
        prisma.raw.consentReceiptCounter.count({ where: { workspaceId: wsA.workspaceId } }),
        prisma.raw.permissionBackfill.count({ where: { workspaceId: wsA.workspaceId } }),
      ]) {
        expect(await contagem).toBe(0);
      }
      // o B fica intacto
      expect(
        await prisma.raw.consentPurpose.count({ where: { workspaceId: wsB.workspaceId } }),
      ).toBe(1);
    });
  });

  // ── A concorrência: as travas nas duas ordens ───────────────────────────

  describe('a concorrência, com a ordem controlada pela trava do endereço', () => {
    /**
     * O travador segura o `address:` do número. A primeira operação pega o
     * contato e espera o endereço; a segunda espera o contato, presa pela
     * primeira. Solta a trava, elas correm NESSA ordem.
     */
    const emOrdem = async <A, B>(
      primeira: () => PromiseLike<A>,
      segunda: () => PromiseLike<B>,
      numero = N_E164,
    ): Promise<[A, B]> => {
      const t = await travar(endereco(numero));
      try {
        const a = primeira();
        await esperarBloqueadosPor(t, 1, { descricao: 'a primeira operação' });
        const b = segunda();
        await esperarBloqueadosPor(t, 2, { descricao: 'as duas operações' });
        await t.query('ROLLBACK');
        return [await a, await b];
      } finally {
        await soltar(t);
      }
    };

    it('conceder, revogar, parar e desbloquear pegam a trava do contato, exclusiva', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const c = (await conceder(ana).expect(201)).body.id as string;
      // o travador segura a trava COMPARTILHADA, como a guarda de um uso da IA:
      // só um pedido exclusivo espera por ela
      const naTravaDaAna = async <T>(operacao: () => PromiseLike<T>): Promise<T> => {
        const t = await travar(CHAVE.contato(wsA.workspaceId, ana), true);
        try {
          const r = operacao();
          await esperarBloqueadosPor(t, 1, { descricao: 'a operação na trava da Ana' });
          await t.query('ROLLBACK');
          return await r;
        } finally {
          await soltar(t);
        }
      };
      const revogada = await naTravaDaAna(() =>
        registrar(`/api/contacts/${ana}/consents/${c}/revoke`, owner, { origin: 'phone' }).then(
          (r) => r,
        ),
      );
      expect(revogada.status).toBe(201);
      expect((await naTravaDaAna(() => conceder(ana).then((r) => r))).status).toBe(201);
      expect((await naTravaDaAna(() => parar(ana).then((r) => r))).status).toBe(201);
      expect((await naTravaDaAna(() => desbloquear(ana).then((r) => r))).status).toBe(201);
    });

    it('parar antes de conceder: a concessão vê o pedido e é recusada (409)', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const [p, c] = await emOrdem(
        () => parar(ana).then((r) => r),
        () => conceder(ana).then((r) => r),
      );
      expect(p.status).toBe(201);
      expect(c.status).toBe(409);
      expect(await prisma.raw.consent.count()).toBe(0);
    });

    it('conceder antes de parar: o pedido revoga o consentimento recém-criado', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const [c, p] = await emOrdem(
        () => conceder(ana).then((r) => r),
        () => parar(ana).then((r) => r),
      );
      expect(c.status).toBe(201);
      expect(p.status).toBe(201);
      expect(await consentimento(c.body.id)).toMatchObject({
        revocationReason: 'stop_requested',
        activeMark: null,
      });
    });

    it('parar × importação: o contato importado no meio é relido, o pedido tenta de novo e vale para ele', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const travas = jest.spyOn(app.get(TravasDeIdentidade), 'paraNumero');
      const t = await travar(endereco(N_E164));
      let pedido;
      let travados: string[][];
      try {
        const p = parar(ana).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'o pedido de parar' });
        // a importação não trava endereço (desvio 7): termina com o pedido preso
        await registrar('/api/contacts/import', owner, {
          rows: [{ name: 'Importada Fictícia', phone: N_E164 }],
        }).expect(201);
        await t.query('ROLLBACK');
        pedido = await p;
      } finally {
        await soltar(t);
        // as chamadas ANTES de restaurar: o restore as apaga
        travados = travas.mock.calls.map(([, escopo]) => [...escopo.contactIds].sort());
        travas.mockRestore();
      }
      expect(pedido.status).toBe(201);
      const importada = await prisma.raw.contact.findFirstOrThrow({
        where: { name: 'Importada Fictícia' },
      });
      // a primeira passada travou só a Ana, releu o conjunto e recomeçou com as duas
      expect(travados).toEqual([[ana], [ana, importada.id].sort()]);
      // a importação não cria consentimento, e o pedido é por número: ela nasce coberta
      expect(await prisma.raw.consent.count({ where: { contactId: importada.id } })).toBe(0);
      expect(await bloqueiosAtivos()).toHaveLength(1);
      await conceder(importada.id).expect(409);
    });

    it('parar antes de tirar o número: o pedido revoga (stop_requested), e a edição não acha mais nada', async () => {
      const ana = await contato('Ana Fictícia', [N_E164, OUTRO]);
      const c = (await conceder(ana).expect(201)).body.id as string;
      const [p, e] = await emOrdem(
        () => parar(ana).then((r) => r),
        () => enviar('patch', `/api/contacts/${ana}`, owner, { phones: [OUTRO] }).then((r) => r),
      );
      expect([p.status, e.status]).toEqual([201, 200]);
      expect(await consentimento(c)).toMatchObject({ revocationReason: 'stop_requested' });
    });

    it('tirar o número antes de parar: a edição revoga (number_removed), e o pedido pela conversa vale assim mesmo', async () => {
      const ana = await contato('Ana Fictícia', [N_E164, OUTRO]);
      await chega();
      const conversa = await conversaDe();
      const c = (await conceder(ana).expect(201)).body.id as string;
      const [e, p] = await emOrdem(
        () => enviar('patch', `/api/contacts/${ana}`, owner, { phones: [OUTRO] }).then((r) => r),
        // pelo contato, o número já não seria dele: o pedido vem pela conversa
        () =>
          registrar(`/api/conversations/${conversa.id}/stop`, owner, { origin: 'phone' }).then(
            (r) => r,
          ),
      );
      expect([e.status, p.status]).toEqual([200, 201]);
      expect(await consentimento(c)).toMatchObject({ revocationReason: 'number_removed' });
      expect(await bloqueiosAtivos()).toHaveLength(1);
    });

    it('conceder antes de tirar o número: a edição revoga o consentimento recém-criado (number_removed)', async () => {
      const ana = await contato('Ana Fictícia', [N_E164, OUTRO]);
      const [c, e] = await emOrdem(
        () => conceder(ana).then((r) => r),
        () => enviar('patch', `/api/contacts/${ana}`, owner, { phones: [OUTRO] }).then((r) => r),
      );
      expect([c.status, e.status]).toEqual([201, 200]);
      expect(await consentimento(c.body.id)).toMatchObject({ revocationReason: 'number_removed' });
    });

    it('tirar o número antes de conceder: a concessão relê o contato e é recusada', async () => {
      const ana = await contato('Ana Fictícia', [N_E164, OUTRO]);
      const [e, c] = await emOrdem(
        () => enviar('patch', `/api/contacts/${ana}`, owner, { phones: [OUTRO] }).then((r) => r),
        () => conceder(ana).then((r) => r),
      );
      expect([e.status, c.status]).toEqual([200, 400]);
      expect(await prisma.raw.consent.count()).toBe(0);
    });

    it('desbloquear antes de conceder: a concessão passa', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await parar(ana).expect(201);
      const [d, c] = await emOrdem(
        () => desbloquear(ana).then((r) => r),
        () => conceder(ana).then((r) => r),
      );
      expect([d.status, c.status]).toEqual([201, 201]);
    });

    it('conceder antes de desbloquear: a concessão ainda vê o pedido (409), e o desbloqueio passa', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await parar(ana).expect(201);
      const [c, d] = await emOrdem(
        () => conceder(ana).then((r) => r),
        () => desbloquear(ana).then((r) => r),
      );
      expect([c.status, d.status]).toEqual([409, 201]);
      expect(await prisma.raw.consent.count()).toBe(0);
      expect(await bloqueiosAtivos()).toHaveLength(0);
    });
  });
});
