import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import request from 'supertest';
import { gravarSeOsTelefonesSaoOsLidos, normalizarWorkspace } from '../cli/phones-normalize.core';
import { derivadosDosTelefones } from '../contacts/phone-identity';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from '../content-use/content-use.pools';
import { TravasDeIdentidade } from '../content-use/identity-locks';
import { CHAVE } from '../content-use/restriction-locks';
import {
  LLM_CLIENT,
  type LlmClient,
  type LlmOutcome,
  type LlmRequest,
} from '../intelligence/llm/llm.client';
import { Prisma } from '../generated/prisma/client';
import { JobsService } from '../jobs/jobs.service';
import { ConversationSenderService } from '../conversations/conversation-sender.service';
import { WhatsappService } from './whatsapp.service';
import { CryptoService } from '../common/crypto.service';
import { FilesService } from '../files/files.service';
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
import { META_TRANSPORT, type MetaTransport, type SendOutcome } from './meta.transport';

/**
 * F4.1a (ADR-052 itens 1 a 3 e 10): identidade de quem escreve SEM atribuição
 * silenciosa. Números e nomes FICTÍCIOS. O que se prova:
 *
 * - o remetente só é atribuído com UM candidato exato; o resto é "remetente a
 *   identificar" (RAI), e nada da RAI vai à IA, a webhook, à timeline ou a quem
 *   não pode identificá-la;
 * - identificar, desfazer e rejeitar são religações: trilha sem número,
 *   conteúdo de IA expirado, despacho da IA barrado, legado bloqueado;
 * - a falha transitória não vira descarte, e o item inválido não derruba o lote.
 */

const APP_SECRET = process.env.META_APP_SECRET as string;
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const NUMERO_A1 = '109876543301';
const NUMERO_A2 = '109876543302';
const NUMERO_B = '109876543303';

/** O número de quem escreve, como o `wa_id` chega (só dígitos). */
const N = '5511987654321';
const N_E164 = `+${N}`;

class FakeLlm implements LlmClient {
  readonly model = 'claude-sonnet-5';
  calls: LlmRequest[] = [];
  nextText = '{}';
  /** o PORTÃO do uso em andamento: a chamada só responde quando ele abre */
  portao: Promise<void> | null = null;
  async complete(request: LlmRequest): Promise<LlmOutcome> {
    this.calls.push(request);
    if (this.portao) await this.portao;
    return { kind: 'ok', text: this.nextText, inputTokens: 500, outputTokens: 100 };
  }
}

/** Um portão que o teste abre quando quiser. */
function portao() {
  let abrir!: () => void;
  const aberto = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { aberto, abrir };
}

class FakeMeta implements MetaTransport {
  sends: { to: string; body?: string }[] = [];
  async sendText(_c: unknown, to: string, body: string): Promise<SendOutcome> {
    this.sends.push({ to, body });
    return { ok: true, externalId: `wamid.ENVIADA.${this.sends.length}` };
  }
  async sendTemplate(_c: unknown, to: string): Promise<SendOutcome> {
    this.sends.push({ to });
    return { ok: true, externalId: `wamid.T.${this.sends.length}` };
  }
  async fetchMedia(): Promise<never> {
    throw new Error('não usado');
  }
}

const RESUMO = JSON.stringify({
  subject: 'Agendamento',
  summary: 'A pessoa pediu horário.',
  pendencies: [],
  sentiment: 'neutro',
  injectionAttempt: false,
});
const RASCUNHO = JSON.stringify({
  body: 'Temos horário amanhã às 10h.',
  rationale: 'Pedido de horário.',
  injectionAttempt: false,
});

const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 1),
  ]);

interface Session {
  cookieHeader: string;
  csrf: string;
}

describe('F4.1a — identidade sem atribuição silenciosa (integração)', () => {
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
  let owner: Session;
  let atendente: Session;
  let guest: Session;
  let membroId: string;
  let atendenteId: string;
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
  const get = (path: string, s: Session) =>
    request(http).get(path).set('Origin', ORIGIN).set('Cookie', s.cookieHeader);

  /** A mensagem como a Meta a manda; `de` é o `wa_id` (só dígitos). */
  const mensagem = (de: string, extra: Record<string, unknown> = {}) => ({
    id: `wamid.ID${++seq}`,
    from: de,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text',
    text: { body: `Mensagem fictícia ${seq}` },
    ...extra,
  });
  const payload = (
    valor: { messages?: unknown[]; contacts?: unknown[]; statuses?: unknown[] },
    numero = NUMERO_A1,
  ) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          { field: 'messages', value: { metadata: { phone_number_id: numero }, ...valor } },
        ],
      },
    ],
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
    webhook(payload({ messages: [mensagem(de)] }, numero)).expect(200);

  const subirArquivo = async () =>
    (
      await request(http)
        .post('/api/files')
        .set('Origin', ORIGIN)
        .set('Cookie', owner.cookieHeader)
        .set('x-csrf-token', owner.csrf)
        .attach('file', png(), `f${++seq}.png`)
        .expect(201)
    ).body.id as string;

  const contato = async (nome: string, phones: string[], s = owner): Promise<string> =>
    (await enviar('post', '/api/contacts', s, { name: nome, phones }).expect(201)).body.id;
  const conversasDoNumero = (numero = N_E164) =>
    prisma.raw.conversation.findMany({
      where: { workspaceId: wsA.workspaceId, externalAddress: numero },
      orderBy: { createdAt: 'asc' },
    });
  const rai = async (numero = N_E164) => {
    const [c] = await prisma.raw.conversation.findMany({
      where: {
        workspaceId: wsA.workspaceId,
        externalAddress: numero,
        senderStatus: 'unidentified',
        status: { not: 'closed' },
      },
    });
    return c;
  };
  /**
   * A mídia recebida gravada pelo caminho do coletor: no contexto do workspace,
   * como o coletor a grava (o client filtrado exige o workspace no contexto).
   */
  const gravarRecebida = (input: {
    workspaceId: string;
    bytes: Buffer;
    fileName: string;
    mimeType: string;
  }) => {
    const cls = app.get(ClsService);
    return cls.run(() => {
      cls.set('workspaceId', input.workspaceId);
      return app.get(FilesService).storeFromChannel(input);
    });
  };

  /** As fichas das travas, como a aplicação as monta (o HMAC, nunca os dígitos). */
  const nivelZero = (numero: string) =>
    CHAVE.ingestao(
      wsA.workspaceId,
      app.get(TravasDeIdentidade).nivelZero(wsA.workspaceId, numero.replace(/\D/g, '').slice(-8)),
    );
  const endereco = (numero: string) =>
    CHAVE.entidade(
      wsA.workspaceId,
      app.get(TravasDeIdentidade).endereco(wsA.workspaceId, numero.replace(/\D/g, '').slice(-8)),
    );
  /** Uma conexão que segura travas numa transação aberta, para as corridas. */
  const abrirTravador = async () => {
    const c = new Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    await c.query('BEGIN');
    return c;
  };
  const soltar = async (c: Client) => {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  };

  const timeline = async (contactId: string, s = owner) =>
    (await get(`/api/activities?contactId=${contactId}&limit=50`, s).expect(200)).body.items as {
      type: string;
    }[];

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

  beforeEach(async () => {
    llm.calls = [];
    llm.portao = null;
    meta.sends = [];
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const dono = await createUserFixture(prisma, 'dono@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, dono, wsA.roles.owner);
    const membro = await createUserFixture(prisma, 'membro@veyra.test');
    membroId = await createMembershipFixture(prisma, wsA.workspaceId, membro, wsA.roles.member);
    // lê e responde conversas, mas NÃO escreve contatos: não identifica (C13)
    const atende = await createUserFixture(prisma, 'atende@veyra.test');
    atendenteId = await createMembershipFixture(
      prisma,
      wsA.workspaceId,
      atende,
      await papel('Atendente', [
        'workspace:read',
        'contacts:read',
        'conversations:read',
        'conversations:write',
        'files:read',
        'files:write',
        'intelligence:use',
      ]),
    );
    const convidado = await createUserFixture(prisma, 'guest@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, convidado, wsA.roles.guest);
    const donoB = await createUserFixture(prisma, 'dono-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, donoB, wsB.roles.owner);

    for (const [ws, numero, guardar] of [
      [wsA.workspaceId, NUMERO_A1, (id: string) => (canalA1 = id)],
      [wsA.workspaceId, NUMERO_A2, (id: string) => (canalA2 = id)],
      [wsB.workspaceId, NUMERO_B, () => undefined],
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
    owner = await login('dono@veyra.test');
    atendente = await login('atende@veyra.test');
    guest = await login('guest@veyra.test');
  });

  // ── A ingestão ──────────────────────────────────────────────────────────

  describe('a ingestão sem atribuição silenciosa', () => {
    it('formatos diferentes do mesmo número: o único candidato EXATO recebe, e nada grava o contato na mensagem nem na atividade', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321']);
      await chega();
      const [conversa] = await conversasDoNumero();
      expect(conversa).toMatchObject({ contactId: ana, senderStatus: 'identified' });
      const msg = await prisma.raw.message.findFirstOrThrow({
        where: { conversationId: conversa.id },
      });
      // a AUTORIA fica; a ATRIBUIÇÃO vem da conversa (C12)
      expect(msg).toMatchObject({ authorType: 'contact', authorContactId: null });
      expect(
        await prisma.raw.activity.count({
          where: { conversationId: conversa.id, contactId: { not: null } },
        }),
      ).toBe(0);
      expect((await timeline(ana)).map((a) => a.type)).toContain('message_received');
      const msgs = await get(`/api/conversations/${conversa.id}/messages`, owner).expect(200);
      expect(msgs.body.items[0].authorName).toBe('Ana Fictícia');
    });

    it('o número de DOIS contatos vira RAI: nenhum é escolhido, nada fica com contato, e a ingestão não enfileira nada', async () => {
      await contato('Ana Fictícia', ['+55 11 98765-4321']);
      await contato('Bia Fictícia', ['11987654321']);
      const eventos = await prisma.raw.outboxEvent.count();
      await chega();
      const [conversa] = await conversasDoNumero();
      expect(conversa).toMatchObject({ contactId: null, senderStatus: 'unidentified' });
      expect(await prisma.raw.contact.count({ where: { workspaceId: wsA.workspaceId } })).toBe(2);
      expect(await prisma.raw.outboxEvent.count()).toBe(eventos);
      expect(
        await prisma.raw.activity.count({
          where: { conversationId: conversa.id, contactId: { not: null } },
        }),
      ).toBe(0);
    });

    it('um ÚNICO candidato só possível também vira RAI, com ele listado: o telefone sem DDD e o 9º dígito', async () => {
      const semDdd = await contato('Cora Fictícia', ['98765-4321']);
      await chega();
      const r1 = await rai();
      expect(r1).toBeDefined();
      const candidatos = await get(`/api/conversations/${r1.id}/sender/candidates`, owner).expect(
        200,
      );
      expect(candidatos.body).toEqual([
        { contactId: semDdd, name: 'Cora Fictícia', match: 'possible' },
      ]);

      // o 9º dígito: o cadastro com o 9, o `wa_id` sem ele
      const outro = '+5521912345678';
      await contato('Dora Fictícia', [outro]);
      await chega('552112345678');
      expect(await rai('+552112345678')).toBeDefined();
    });

    it('o contato ARQUIVADO conta; o mesmo número em OUTRO workspace não conta (P0)', async () => {
      // só no B: no A, é lead novo
      await prisma.raw.contact.create({
        data: {
          workspaceId: wsB.workspaceId,
          name: 'Outra Fictícia',
          phones: [N_E164],
          phonesNormalized: [N_E164],
          phoneMatchKeys: ['87654321'],
        },
      });
      await chega();
      const [lead] = await conversasDoNumero();
      expect(lead.senderStatus).toBe('identified');
      const criado = await prisma.raw.contact.findFirstOrThrow({
        where: { id: lead.contactId as string },
      });
      expect(criado.workspaceId).toBe(wsA.workspaceId);

      // no A, um segundo contato com o número, ARQUIVADO: agora são dois
      const arquivado = await contato('Eva Fictícia', [N_E164]);
      await enviar('patch', `/api/contacts/${arquivado}`, owner, { status: 'archived' }).expect(
        200,
      );
      await chega();
      expect(await rai()).toBeDefined();
    });

    it('a mensagem seguinte à identificação continua RAI enquanto o número for compartilhado; sem a ambiguidade, nada é identificado sozinho', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const bia = await contato('Bia Fictícia', [N_E164]);
      await chega();
      const r1 = await rai();
      await enviar('post', `/api/conversations/${r1.id}/sender/identify`, owner, {
        contactId: ana,
      }).expect(201);
      await chega();
      const r2 = await rai();
      expect(r2.id).not.toBe(r1.id);
      // a ambiguidade some: o número sai da Bia
      await enviar('patch', `/api/contacts/${bia}`, owner, { phones: [] }).expect(200);
      await chega();
      // a nova vai para a conversa da Ana; a RAI aberta continua RAI
      const ultima = await prisma.raw.message.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
      expect(ultima.conversationId).toBe(r1.id);
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: r2.id } })).senderStatus,
      ).toBe('unidentified');
    });

    it('duas ingestões do mesmo número NOVO por dois canais, ao mesmo tempo: um contato só', async () => {
      await Promise.all([
        webhook(payload({ messages: [mensagem(N)] }, NUMERO_A1)).expect(200),
        webhook(payload({ messages: [mensagem(N)] }, NUMERO_A2)).expect(200),
      ]);
      expect(await prisma.raw.contact.count({ where: { workspaceId: wsA.workspaceId } })).toBe(1);
      const conversas = await conversasDoNumero();
      expect(new Set(conversas.map((c) => c.channelId))).toEqual(new Set([canalA1, canalA2]));
      expect(new Set(conversas.map((c) => c.contactId)).size).toBe(1);
    });

    it('a conversa é por NÚMERO: quem escreve de outro número abre outra conversa, e cada uma responde ao seu (D-b)', async () => {
      const segundo = '5511912345678';
      await contato('Ana Fictícia', [N_E164, `+${segundo}`]);
      await chega(N);
      await chega(segundo);
      const conversas = await prisma.raw.conversation.findMany({
        where: { workspaceId: wsA.workspaceId, channelId: canalA1 },
      });
      expect(conversas.map((c) => c.externalAddress).sort()).toEqual(
        [`+${segundo}`, N_E164].sort(),
      );
    });

    it('isolamento por item (C11): a mensagem sem `from` e o contato sem `wa_id` não derrubam os outros', async () => {
      const semFrom = {
        id: 'wamid.SEMFROM',
        timestamp: '1787000000',
        type: 'text',
        text: { body: 'x' },
      };
      const res = await webhook(
        payload({
          contacts: [
            { profile: { name: 'Sem wa_id' } },
            { wa_id: N, profile: { name: 'Fictícia' } },
          ],
          messages: [mensagem(N), semFrom, mensagem('5511900001111')],
        }),
      );
      expect(res.status).toBe(200);
      expect(await prisma.raw.message.count({ where: { workspaceId: wsA.workspaceId } })).toBe(2);
      expect(await prisma.raw.message.count({ where: { externalId: 'wamid.SEMFROM' } })).toBe(0);
    });

    it('a falha TRANSITÓRIA não vira descarte: sem a trava no prazo, erro; a reentrega não perde nem duplica', async () => {
      const travador = new Client({ connectionString: TEST_DATABASE_URL });
      await travador.connect();
      const outro = '5511900002222';
      const lote = payload({ messages: [mensagem(N), mensagem(outro)] });
      try {
        // alguém segura o nível 0 do SEGUNDO número
        await travador.query('BEGIN');
        await travador.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          nivelZero(outro),
        ]);
        const res = await webhook(lote);
        // não é 2xx: a Meta reentrega. A trava não obtida (55P03) sai como 409
        // pelo filtro de exceções do Prisma, como em toda espera estourada
        expect(res.status).toBe(409);
        // a primeira entrou; a segunda, não
        expect(await prisma.raw.message.count({ where: { workspaceId: wsA.workspaceId } })).toBe(1);
      } finally {
        await travador.query('ROLLBACK').catch(() => undefined);
        await travador.end();
      }
      // a Meta reentrega o MESMO lote
      await webhook(lote).expect(200);
      expect(await prisma.raw.message.count({ where: { workspaceId: wsA.workspaceId } })).toBe(2);
    });

    it('o `from` com menos de 8 dígitos é item isolado: sem chave, entraria sem trava nenhuma', async () => {
      const res = await webhook(payload({ messages: [mensagem('1234567'), mensagem(N)] }));
      expect(res.status).toBe(200);
      expect(await prisma.raw.message.count({ where: { workspaceId: wsA.workspaceId } })).toBe(1);
      expect(await prisma.raw.contact.count({ where: { workspaceId: wsA.workspaceId } })).toBe(1);
    });

    it('o `wa_id` sem o 9º dígito, que não se valida: a mensagem seguinte cai no MESMO lead, sem RAI', async () => {
      const semNono = '551187654321';
      await chega(semNono);
      await chega(semNono);
      expect(await prisma.raw.contact.count({ where: { workspaceId: wsA.workspaceId } })).toBe(1);
      const conversas = await conversasDoNumero(`+${semNono}`);
      expect(conversas).toHaveLength(1);
      expect(conversas[0].senderStatus).toBe('identified');
      expect(await prisma.raw.message.count({ where: { conversationId: conversas[0].id } })).toBe(
        2,
      );
    });

    it('o telefone com o 00 de operadora é candidato possível: com outro contato exato, vira RAI', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', ['0021 11 98765-4321']);
      await chega();
      expect(await rai()).toBeDefined();
    });

    it('o TETO do lote (item 3): corta a espera da mensagem, e esgotado não deixa a próxima começar; a reentrega não perde nada', async () => {
      const cfg = app.get<ConfigDaGuarda>(CONFIG_DA_GUARDA);
      const antes = cfg.ingestaoLoteMs;
      const lote = payload({ messages: [mensagem(N), mensagem('5511900003333')] });
      const t = await abrirTravador();
      try {
        // o teto curto vale mais que os 2 s da trava: o erro vem antes deles
        cfg.ingestaoLoteMs = 400;
        await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [nivelZero(N)]);
        const comeco = Date.now();
        const res = await webhook(lote);
        expect(res.status).toBe(409);
        expect(Date.now() - comeco).toBeLessThan(1_500);
        // sem teto nenhum, nem a primeira começa: 503, nunca 2xx
        cfg.ingestaoLoteMs = 0;
        expect((await webhook(lote)).status).toBe(503);
        // e o recibo, que não pega trava, também não começa: a conferência é entre os itens
        const recibo = {
          id: 'wamid.RECIBO.FICTICIO',
          status: 'delivered',
          timestamp: String(Math.floor(Date.now() / 1000)),
        };
        expect((await webhook(payload({ statuses: [recibo] }))).status).toBe(503);
        expect(await prisma.raw.message.count({ where: { workspaceId: wsA.workspaceId } })).toBe(0);
      } finally {
        cfg.ingestaoLoteMs = antes;
        await soltar(t);
      }
      await webhook(lote).expect(200);
      expect(await prisma.raw.message.count({ where: { workspaceId: wsA.workspaceId } })).toBe(2);
    });
  });

  // ── Identificar, desfazer e rejeitar ────────────────────────────────────

  describe('identificar, desfazer e rejeitar', () => {
    it('identificar entre os candidatos: a conversa passa ao contato, com trilha SEM número; fora dos candidatos é 400', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      const estranha = await contato('Cora Fictícia', ['+5531911112222']);
      await chega();
      const r1 = await rai();
      await enviar('post', `/api/conversations/${r1.id}/sender/identify`, owner, {
        contactId: estranha,
      }).expect(400);
      const res = await enviar('post', `/api/conversations/${r1.id}/sender/identify`, owner, {
        contactId: ana,
      }).expect(201);
      expect(res.body).toMatchObject({
        contactId: ana,
        senderStatus: 'identified',
        senderIdentifiedByPerson: true,
      });
      const trilha = await prisma.raw.auditLog.findFirstOrThrow({
        where: { action: 'conversation.sender_identified' },
      });
      expect(JSON.stringify(trilha)).not.toContain('87654321');
      expect(trilha.after).toMatchObject({ contactId: ana, candidates: 2 });
      expect((await timeline(ana)).map((a) => a.type)).toContain('message_received');
    });

    it('identificar com um contato NOVO: ele recebe o número, e a próxima mensagem vê os três', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await chega();
      const r1 = await rai();
      const res = await enviar('post', `/api/conversations/${r1.id}/sender/identify`, owner, {
        newContact: { name: 'Cora Fictícia' },
      }).expect(201);
      const nova = await prisma.raw.contact.findFirstOrThrow({ where: { id: res.body.contactId } });
      expect(nova.phones).toEqual([N_E164]);
      await chega();
      const r2 = await rai();
      const candidatos = await get(`/api/conversations/${r2.id}/sender/candidates`, owner).expect(
        200,
      );
      expect(candidatos.body).toHaveLength(3);
    });

    it('identificar para quem já tem conversa ABERTA com o número encerra a anterior, com trilha', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [anterior] = await conversasDoNumero();
      const bia = await contato('Bia Fictícia', [N_E164]);
      expect(bia).toBeDefined();
      await chega();
      const r1 = await rai();
      await enviar('post', `/api/conversations/${r1.id}/sender/identify`, owner, {
        contactId: ana,
      }).expect(201);
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: anterior.id } })).status,
      ).toBe('closed');
      expect(
        await prisma.raw.auditLog.count({
          where: { action: 'conversation.closed_by_identification' },
        }),
      ).toBe(1);
    });

    it('desfazer volta a RAI e EXPIRA o conteúdo de IA da conversa; a timeline do contato deixa de mostrá-la', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const r1 = await rai();
      await enviar('post', `/api/conversations/${r1.id}/sender/identify`, owner, {
        contactId: ana,
      }).expect(201);
      llm.nextText = RESUMO;
      expect(
        (
          await enviar('post', `/api/intelligence/conversations/${r1.id}/summary`, owner).expect(
            201,
          )
        ).body.status,
      ).toBe('ok');
      llm.nextText = RASCUNHO;
      await enviar(
        'post',
        `/api/intelligence/conversations/${r1.id}/reply-suggestion`,
        owner,
      ).expect(201);
      expect(
        await prisma.raw.aiProposal.count({ where: { conversationId: r1.id, status: 'pending' } }),
      ).toBe(1);

      await enviar('post', `/api/conversations/${r1.id}/sender/unidentify`, owner).expect(201);
      expect(
        await prisma.raw.aiRun.count({
          where: { conversationId: r1.id, result: { not: Prisma.DbNull } },
        }),
      ).toBe(0);
      expect(
        await prisma.raw.aiProposal.count({ where: { conversationId: r1.id, status: 'pending' } }),
      ).toBe(0);
      expect((await timeline(ana)).map((a) => a.type)).not.toContain('message_received');
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: r1.id } })).senderStatus,
      ).toBe('unidentified');
    });

    it('rejeitar a conversa atribuída pela ingestão: sem tirar o número, a próxima cai no contato; tirando, não; e com RAI aberta, a rejeitada fica RAI ENCERRADA', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [c1] = await conversasDoNumero();
      await enviar('post', `/api/conversations/${c1.id}/sender/reject`, owner, {
        removeNumber: false,
      }).expect(201);
      expect(
        await prisma.raw.conversation.findFirstOrThrow({ where: { id: c1.id } }),
      ).toMatchObject({
        senderStatus: 'unidentified',
        contactId: null,
      });
      await chega();
      const ultima = await prisma.raw.message.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
      const c2 = await prisma.raw.conversation.findFirstOrThrow({
        where: { id: ultima.conversationId },
      });
      expect(c2.contactId).toBe(ana);

      // a RAI de c1 está aberta: rejeitar c2 a deixa RAI encerrada
      await enviar('post', `/api/conversations/${c2.id}/sender/reject`, owner, {
        removeNumber: true,
      }).expect(201);
      expect(
        await prisma.raw.conversation.findFirstOrThrow({ where: { id: c2.id } }),
      ).toMatchObject({
        senderStatus: 'unidentified',
        status: 'closed',
      });
      expect((await prisma.raw.contact.findFirstOrThrow({ where: { id: ana } })).phones).toEqual(
        [],
      );
    });

    it('o LEGADO: conversa com mensagens antigas e novas — os três atos dão 409, nada muda, e as superfícies seguem consistentes', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [c1] = await conversasDoNumero();
      // a mensagem (com anexo) e a atividade ANTIGAS, gravadas como antes da F4.1a
      const antiga = await prisma.raw.message.create({
        data: {
          workspaceId: wsA.workspaceId,
          conversationId: c1.id,
          channelId: canalA1,
          direction: 'inbound',
          authorType: 'contact',
          authorContactId: ana,
          body: 'antiga',
          createdAt: new Date(Date.now() - 60_000),
        },
      });
      const anexoAntigo = await subirArquivo();
      await prisma.raw.messageAttachment.create({
        data: { workspaceId: wsA.workspaceId, messageId: antiga.id, fileObjectId: anexoAntigo },
      });
      await prisma.raw.activity.create({
        data: {
          workspaceId: wsA.workspaceId,
          type: 'message_received',
          actorType: 'system',
          payload: {},
          conversationId: c1.id,
          contactId: ana,
          occurredAt: new Date(Date.now() - 60_000),
        },
      });
      await chega();
      // AO LADO: uma conversa nova da Ana, por outro número, sem legado
      const outro = '5511912345678';
      await enviar('patch', `/api/contacts/${ana}`, owner, {
        phones: [N_E164, `+${outro}`],
      }).expect(200);
      await chega(outro);
      const [aoLado] = await conversasDoNumero(`+${outro}`);

      // rejeitar o legado: 409
      const r = await enviar('post', `/api/conversations/${c1.id}/sender/reject`, owner, {
        removeNumber: false,
      }).expect(409);
      expect(r.body.message).toMatch(/mensagens anteriores à atualização/);
      // desfazer: a conversa do legado como se uma pessoa a tivesse identificado
      await prisma.raw.conversation.update({
        where: { id: c1.id },
        data: { senderIdentifiedAt: new Date() },
      });
      expect(
        (await enviar('post', `/api/conversations/${c1.id}/sender/unidentify`, owner).expect(409))
          .body.message,
      ).toMatch(/mensagens anteriores à atualização/);
      // identificar: uma RAI com uma mensagem antiga ligada a um contato
      await contato('Bia Fictícia', [N_E164]);
      await chega();
      const r1 = await rai();
      await prisma.raw.message.create({
        data: {
          workspaceId: wsA.workspaceId,
          conversationId: r1.id,
          channelId: canalA1,
          direction: 'inbound',
          authorType: 'contact',
          authorContactId: ana,
          body: 'antiga da RAI',
        },
      });
      expect(
        (
          await enviar('post', `/api/conversations/${r1.id}/sender/identify`, owner, {
            contactId: ana,
          }).expect(409)
        ).body.message,
      ).toMatch(/mensagens anteriores à atualização/);
      // nada mudou, e a tela sabe disso antes de tentar
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: c1.id } })).contactId,
      ).toBe(ana);
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: r1.id } })).senderStatus,
      ).toBe('unidentified');
      expect((await get(`/api/conversations/${c1.id}`, owner).expect(200)).body).toMatchObject({
        senderRelinkBlocked: true,
      });
      expect((await get(`/api/conversations/${aoLado.id}`, owner).expect(200)).body).toMatchObject({
        senderRelinkBlocked: false,
      });
      // timeline e autor: as antigas e as novas, todas da Ana; o anexo antigo continua dela
      expect((await timeline(ana)).filter((a) => a.type === 'message_received')).toHaveLength(4);
      const msgs = await get(`/api/conversations/${c1.id}/messages`, owner).expect(200);
      expect(new Set(msgs.body.items.map((m: { authorName: string }) => m.authorName))).toEqual(
        new Set(['Ana Fictícia']),
      );
      await get(`/api/files/${anexoAntigo}/content`, owner).expect(200);

      // a conversa ao lado, rejeitada: sai da timeline e deixa de ser da Ana
      await enviar('post', `/api/conversations/${aoLado.id}/sender/reject`, owner, {
        removeNumber: false,
      }).expect(201);
      expect((await timeline(ana)).filter((a) => a.type === 'message_received')).toHaveLength(3);
      expect((await get(`/api/conversations/${aoLado.id}`, owner).expect(200)).body).toMatchObject({
        contactId: null,
        contactName: null,
        senderStatus: 'unidentified',
      });

      // a exclusão da Ana leva a conversa do legado e TODAS as mensagens dela, e
      // a mídia recebida nela; a rejeitada, que já não é dela, fica
      await enviar('delete', `/api/contacts/${ana}`, owner).expect(200);
      expect(await prisma.raw.message.count({ where: { conversationId: c1.id } })).toBe(0);
      expect(await prisma.raw.fileObject.findFirst({ where: { id: anexoAntigo } })).toBeNull();
      expect(
        await prisma.raw.conversation.findFirstOrThrow({ where: { id: aoLado.id } }),
      ).toMatchObject({ contactId: null, senderStatus: 'unidentified' });
      expect(await prisma.raw.message.count({ where: { conversationId: aoLado.id } })).toBe(1);
    });

    it('identificar uma RAI ENCERRADA não encerra a conversa aberta do contato', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [primeira] = await conversasDoNumero();
      await enviar('post', `/api/conversations/${primeira.id}/sender/reject`, owner, {
        removeNumber: false,
      }).expect(201);
      // a primeira é a RAI aberta; a próxima volta à Ana, e rejeitada fica RAI ENCERRADA
      await chega();
      const encerrada = await prisma.raw.conversation.findFirstOrThrow({
        where: { contactId: ana },
      });
      await enviar('post', `/api/conversations/${encerrada.id}/sender/reject`, owner, {
        removeNumber: false,
      }).expect(201);
      await chega();
      const aberta = await prisma.raw.conversation.findFirstOrThrow({ where: { contactId: ana } });
      await enviar('post', `/api/conversations/${encerrada.id}/sender/identify`, owner, {
        contactId: ana,
      }).expect(201);
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: aberta.id } })).status,
      ).toBe('open');
      expect(
        await prisma.raw.conversation.findFirstOrThrow({ where: { id: encerrada.id } }),
      ).toMatchObject({ contactId: ana, status: 'closed', senderStatus: 'identified' });
      expect(
        await prisma.raw.auditLog.count({
          where: { action: 'conversation.closed_by_identification' },
        }),
      ).toBe(0);
    });

    it('levar à RAI tira o responsável que não pode vê-la, com trilha e a contagem dos candidatos; quem pode fica', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [c1] = await conversasDoNumero();
      await enviar('patch', `/api/conversations/${c1.id}`, owner, {
        assigneeMembershipId: atendenteId,
      }).expect(200);
      await enviar('post', `/api/conversations/${c1.id}/sender/reject`, owner, {
        removeNumber: false,
      }).expect(201);
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: c1.id } }))
          .assigneeMembershipId,
      ).toBeNull();
      const trilha = await prisma.raw.auditLog.findFirstOrThrow({
        where: { action: 'conversation.sender_rejected' },
      });
      expect(trilha.after).toMatchObject({ unassigned: true, candidates: 1 });

      await chega();
      const c2 = await prisma.raw.conversation.findFirstOrThrow({ where: { contactId: ana } });
      await enviar('patch', `/api/conversations/${c2.id}`, owner, {
        assigneeMembershipId: membroId,
      }).expect(200);
      await enviar('post', `/api/conversations/${c2.id}/sender/reject`, owner, {
        removeNumber: false,
      }).expect(201);
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: c2.id } }))
          .assigneeMembershipId,
      ).toBe(membroId);
    });

    it('levar à RAI com uma atribuição comitando no meio: a linha presa a lê, e o responsável sem contacts:write sai', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [c1] = await conversasDoNumero();
      const t = await abrirTravador();
      try {
        await t.query('SELECT 1 FROM "Conversation" WHERE "id" = $1 FOR UPDATE', [c1.id]);
        const rejeitar = enviar('post', `/api/conversations/${c1.id}/sender/reject`, owner, {
          removeNumber: false,
        }).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'o rejeitar na linha da conversa' });
        // a atribuição de outra pessoa comita enquanto o rejeitar espera
        await t.query(`UPDATE "Conversation" SET "assigneeMembershipId" = $1 WHERE "id" = $2`, [
          atendenteId,
          c1.id,
        ]);
        await t.query('COMMIT');
        expect((await rejeitar).status).toBe(201);
      } finally {
        await soltar(t);
      }
      expect(
        await prisma.raw.conversation.findFirstOrThrow({ where: { id: c1.id } }),
      ).toMatchObject({ senderStatus: 'unidentified', assigneeMembershipId: null });
    });

    it('atribuir a quem não vê a RAI, com a conversa indo à RAI no meio: a condição na escrita recusa, sem aviso', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [c1] = await conversasDoNumero();
      const t = await abrirTravador();
      try {
        await t.query('SELECT 1 FROM "Conversation" WHERE "id" = $1 FOR UPDATE', [c1.id]);
        const atribuir = enviar('patch', `/api/conversations/${c1.id}`, owner, {
          assigneeMembershipId: atendenteId,
        }).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'a atribuição na linha da conversa' });
        // o que desfazer e rejeitar fariam, com a linha segura
        await t.query(
          `UPDATE "Conversation" SET "contactId" = NULL, "senderStatus" = 'unidentified' WHERE "id" = $1`,
          [c1.id],
        );
        await t.query('COMMIT');
        expect((await atribuir).status).toBe(400);
      } finally {
        await soltar(t);
      }
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: c1.id } }))
          .assigneeMembershipId,
      ).toBeNull();
      expect(await prisma.raw.notification.count()).toBe(0);
    });
  });

  // ── C13 ─────────────────────────────────────────────────────────────────

  describe('C13: a RAI só existe para quem pode identificá-la', () => {
    it('sem contacts:write, a RAI some da lista e cada rota dela dá 404', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await chega();
      const r1 = await rai();
      for (const s of [atendente, guest]) {
        const lista = await get('/api/conversations?status=all', s).expect(200);
        expect(lista.body.items.map((c: { id: string }) => c.id)).not.toContain(r1.id);
      }
      await get(`/api/conversations/${r1.id}`, atendente).expect(404);
      await get(`/api/conversations/${r1.id}/messages`, atendente).expect(404);
      await get(`/api/conversations/${r1.id}/send-policy`, atendente).expect(404);
      await enviar('patch', `/api/conversations/${r1.id}`, atendente, { status: 'pending' }).expect(
        404,
      );
      await enviar('post', `/api/conversations/${r1.id}/messages`, atendente, {
        direction: 'outbound',
        body: 'oi',
      }).expect(404);
      await get(`/api/intelligence/conversations/${r1.id}/summary`, atendente).expect(404);
      await enviar('post', `/api/intelligence/conversations/${r1.id}/summary`, atendente).expect(
        404,
      );
      await get(`/api/conversations/${r1.id}/sender/candidates`, atendente).expect(403);
      await enviar('post', `/api/conversations/${r1.id}/sender/identify`, atendente, {
        contactId: r1.id,
      }).expect(403);
      // quem pode vê
      await get(`/api/conversations/${r1.id}`, owner).expect(200);
    });

    it('C13 nas rotas da IA: o rascunho, a sugestão e a aprovação de uma RAI dão 404 a quem não a vê', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await chega();
      const r1 = await rai();
      await get(`/api/intelligence/conversations/${r1.id}/reply-suggestion`, atendente).expect(404);
      await enviar(
        'post',
        `/api/intelligence/conversations/${r1.id}/reply-suggestion`,
        atendente,
      ).expect(404);
      expect(llm.calls).toEqual([]);
    });

    it('a FILA de propostas não devolve proposta de conversa que virou RAI, em status nenhum, nem a quem tem contacts:write', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const r1 = await rai();
      await enviar('post', `/api/conversations/${r1.id}/sender/identify`, owner, {
        contactId: ana,
      }).expect(201);
      llm.nextText = RASCUNHO;
      const sugestao = await enviar(
        'post',
        `/api/intelligence/conversations/${r1.id}/reply-suggestion`,
        owner,
      ).expect(201);
      const proposta = sugestao.body.proposalId as string;
      // revisor: aprova e lê conversas, mas não escreve contatos
      const revisor = await createUserFixture(prisma, 'revisor@veyra.test');
      await createMembershipFixture(
        prisma,
        wsA.workspaceId,
        revisor,
        await papel('Revisor', [
          'workspace:read',
          'contacts:read',
          'conversations:read',
          'intelligence:approve',
        ]),
      );
      const rev = await login('revisor@veyra.test');
      const ids = async (s: Session, status: string) =>
        (await get(`/api/intelligence/proposals?status=${status}`, s).expect(200)).body.map(
          (p: { id: string }) => p.id,
        );
      expect(await ids(owner, 'all')).toContain(proposta);
      expect(await ids(rev, 'all')).toContain(proposta);

      await enviar('post', `/api/conversations/${r1.id}/sender/unidentify`, owner).expect(201);
      for (const s of [owner, rev]) {
        for (const status of ['all', 'expired', 'pending']) {
          expect(await ids(s, status)).not.toContain(proposta);
        }
      }
      // o payload continua na linha: é o filtro que o esconde
      expect(await prisma.raw.aiProposal.count({ where: { id: proposta } })).toBe(1);
    });

    it('o REPLAY de um resumo guardado não volta quando a conversa virou RAI: a guarda descarta e a rota recusa de novo', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const [c1] = await conversasDoNumero();
      expect(c1.contactId).toBe(ana);
      llm.nextText = RESUMO;
      const chave = 'resumo-f41a-replay-0001';
      const primeiro = await enviar(
        'post',
        `/api/intelligence/conversations/${c1.id}/summary`,
        owner,
      )
        .set('Idempotency-Key', chave)
        .expect(201);
      expect(primeiro.body.status).toBe('ok');
      // a RAI sem a limpeza da religação: o replay sobreviveu (a corrida que a
      // guarda do replay cobre)
      await prisma.raw.conversation.update({
        where: { id: c1.id },
        data: { contactId: null, senderStatus: 'unidentified' },
      });
      const repetido = await enviar(
        'post',
        `/api/intelligence/conversations/${c1.id}/summary`,
        owner,
      ).set('Idempotency-Key', chave);
      expect(repetido.body.status).toBe('content_restricted');
      expect(JSON.stringify(repetido.body)).not.toContain('A pessoa pediu horário');
      expect(llm.calls).toHaveLength(1);
    });

    it('atribuir a RAI a quem não tem contacts:write é recusado; a quem tem, passa', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await chega();
      const r1 = await rai();
      await enviar('patch', `/api/conversations/${r1.id}`, owner, {
        assigneeMembershipId: atendenteId,
      }).expect(400);
      await enviar('patch', `/api/conversations/${r1.id}`, owner, {
        assigneeMembershipId: membroId,
      }).expect(200);
    });

    it('reabrir, ou responder, numa conversa encerrada com outra aberta da mesma chave: 409 apontando a outra', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [c1] = await conversasDoNumero();
      await enviar('post', `/api/conversations/${c1.id}/sender/reject`, owner, {
        removeNumber: false,
      }).expect(201);
      await chega();
      const c2 = await prisma.raw.conversation.findFirstOrThrow({ where: { contactId: ana } });
      await enviar('post', `/api/conversations/${c2.id}/sender/reject`, owner, {
        removeNumber: false,
      }).expect(201);
      // c2 é RAI encerrada; c1 é a RAI aberta
      const r = await enviar('patch', `/api/conversations/${c2.id}`, owner, {
        status: 'open',
      }).expect(409);
      expect(r.body).toMatchObject({ conversationId: c1.id });
    });

    it('a regra ESTRITA: tirar o número não apaga outro que só divide a chave, e esse outro não libera a resposta', async () => {
      const ana = await contato('Ana Fictícia', [N_E164, '021 8765-4321']);
      await chega();
      const [c1] = await conversasDoNumero();
      await enviar('post', `/api/conversations/${c1.id}/sender/reject`, owner, {
        removeNumber: true,
      }).expect(201);
      expect((await prisma.raw.contact.findFirstOrThrow({ where: { id: ana } })).phones).toEqual([
        '021 8765-4321',
      ]);

      // outro número (outra chave, para a Ana não ser candidata)
      const bia = await contato('Bia Fictícia', ['+5531912348888']);
      await chega('5531912348888');
      const c2 = await prisma.raw.conversation.findFirstOrThrow({ where: { contactId: bia } });
      // sobrou à Bia só um outro DDD, num formato que não se valida, com a mesma
      // chave: o número da conversa saiu do cadastro
      await enviar('patch', `/api/contacts/${bia}`, owner, { phones: ['021 1234-8888'] }).expect(
        200,
      );
      const politica = await get(`/api/conversations/${c2.id}/send-policy`, owner).expect(200);
      expect(politica.body).toMatchObject({ mode: 'blocked' });
      expect(politica.body.reason).toMatch(/não confere, de forma exata/);
    });

    it('a resposta é BLOQUEADA quando o número saiu do cadastro do contato', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [c1] = await conversasDoNumero();
      await enviar('patch', `/api/contacts/${ana}`, owner, { phones: ['+5531911112222'] }).expect(
        200,
      );
      // a recusa é a da política única de envio (ADR-038), como toda outra: 400
      const r = await enviar('post', `/api/conversations/${c1.id}/messages`, owner, {
        direction: 'outbound',
        body: 'oi',
      }).expect(400);
      expect(r.body.message).toMatch(/não confere, de forma exata/);
      const politica = await get(`/api/conversations/${c1.id}/send-policy`, owner).expect(200);
      expect(politica.body.mode).toBe('blocked');
    });
  });

  // ── IA e despacho ───────────────────────────────────────────────────────

  describe('IA e despacho', () => {
    it('a IA recusa a RAI num workspace SEM o Clinics, sem chamar o provedor', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const r1 = await rai();
      llm.nextText = RESUMO;
      expect(
        (await enviar('post', `/api/intelligence/conversations/${r1.id}/summary`, owner)).body
          .status,
      ).toBe('content_restricted');
      llm.nextText = RASCUNHO;
      expect(
        (await enviar('post', `/api/intelligence/conversations/${r1.id}/reply-suggestion`, owner))
          .body.status,
      ).toBe('content_restricted');
      expect(llm.calls).toEqual([]);
      // recusada ANTES de montar o contexto: nenhuma reserva, e o run diz onde
      expect(await prisma.raw.usageReservation.count()).toBe(0);
      const runs = await prisma.raw.aiRun.findMany({ where: { conversationId: r1.id } });
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) expect(run.contextSummary).toMatch(/antes de montar contexto/);
    });

    it('o despacho da IA aprovado ANTES de religar a conversa não sai', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const [c1] = await conversasDoNumero();
      llm.nextText = RASCUNHO;
      const sugestao = await enviar(
        'post',
        `/api/intelligence/conversations/${c1.id}/reply-suggestion`,
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
      await enviar('post', `/api/conversations/${c1.id}/sender/reject`, owner, {
        removeNumber: false,
      }).expect(201);
      for (let i = 0; i < 5; i++) {
        const { delivered } = await app.get(JobsService).dispatchPending();
        if (delivered === 0) break;
      }
      expect(
        await prisma.raw.messageDispatch.findFirstOrThrow({
          where: { messageId: despacho.messageId },
        }),
      ).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'conversation_relinked',
      });
      expect(meta.sends).toEqual([]);
    });

    const drenar = async () => {
      for (let i = 0; i < 5; i++) {
        const { delivered } = await app.get(JobsService).dispatchPending();
        if (delivered === 0) break;
      }
    };
    const despachoDe = (messageId: string) =>
      prisma.raw.messageDispatch.findFirstOrThrow({ where: { messageId } });

    it('a resposta de PESSOA na fila não sai se a conversa foi religada antes do worker', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [c1] = await conversasDoNumero();
      const enviada = await enviar('post', `/api/conversations/${c1.id}/messages`, owner, {
        direction: 'outbound',
        body: 'Oi, tudo bem?',
      }).expect(201);
      // o contato que a pessoa via quando escreveu fica no despacho
      expect((await despachoDe(enviada.body.id)).approvalContactIds).toEqual([ana]);
      await enviar('post', `/api/conversations/${c1.id}/sender/reject`, owner, {
        removeNumber: false,
      }).expect(201);
      await drenar();
      expect(await despachoDe(enviada.body.id)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'conversation_relinked',
      });
      expect(meta.sends).toEqual([]);
    });

    const credencialDeVerdade = () =>
      prisma.raw.channelCredential.updateMany({
        where: { channelId: canalA1 },
        data: { tokenCipher: app.get(CryptoService).encrypt('token-ficticio') },
      });

    it('a RAI não recebe resposta (decisão de 2026-10-23): a API recusa antes de mensagem, despacho e reserva, e a política explica', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      const r1 = await rai();
      const politica = await get(`/api/conversations/${r1.id}/send-policy`, owner).expect(200);
      expect(politica.body).toMatchObject({ mode: 'blocked' });
      expect(politica.body.reason).toMatch(/ainda não foi identificado/);
      const r = await enviar('post', `/api/conversations/${r1.id}/messages`, owner, {
        direction: 'outbound',
        body: 'Olá! Com quem eu falo?',
      }).expect(400);
      expect(r.body.message).toMatch(/ainda não foi identificado/);
      expect(
        await prisma.raw.message.count({ where: { conversationId: r1.id, direction: 'outbound' } }),
      ).toBe(0);
      expect(await prisma.raw.messageDispatch.count()).toBe(0);
      expect(await prisma.raw.usageReservation.count()).toBe(0);
      await drenar();
      expect(meta.sends).toEqual([]);
    });

    it('a conversa LEGADA atribuída automaticamente responde: o telefone dela é o número com "+", exato mesmo antes do phones:normalize', async () => {
      // o contato e a conversa como a ingestão antiga os deixava: o telefone é a
      // string exata do número, e a forma normalizada ainda não foi preenchida
      const ana = await prisma.raw.contact.create({
        data: {
          workspaceId: wsA.workspaceId,
          name: 'Ana Fictícia',
          phones: [N_E164],
          phonesNormalized: [],
          phoneMatchKeys: ['87654321'],
        },
      });
      const conversa = await prisma.raw.conversation.create({
        data: {
          workspaceId: wsA.workspaceId,
          channelId: canalA1,
          contactId: ana.id,
          externalAddress: N_E164,
          lastInboundAt: new Date(),
        },
      });
      await prisma.raw.message.create({
        data: {
          workspaceId: wsA.workspaceId,
          conversationId: conversa.id,
          channelId: canalA1,
          direction: 'inbound',
          authorType: 'contact',
          authorContactId: ana.id,
          body: 'antiga',
        },
      });
      const politica = await get(`/api/conversations/${conversa.id}/send-policy`, owner).expect(
        200,
      );
      expect(politica.body.mode).toBe('free_form');
      await enviar('post', `/api/conversations/${conversa.id}/messages`, owner, {
        direction: 'outbound',
        body: 'Oi, tudo bem?',
      }).expect(201);
    });

    it('a troca de telefone que deixa só uma coincidência POSSÍVEL bloqueia a resposta: aproximação não autoriza envio', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [c1] = await conversasDoNumero();
      // o mesmo celular, sem o DDD: possível, nunca exato
      await enviar('patch', `/api/contacts/${ana}`, owner, { phones: ['98765-4321'] }).expect(200);
      const politica = await get(`/api/conversations/${c1.id}/send-policy`, owner).expect(200);
      expect(politica.body).toMatchObject({ mode: 'blocked' });
      expect(politica.body.reason).toMatch(/não confere, de forma exata/);
      await enviar('post', `/api/conversations/${c1.id}/messages`, owner, {
        direction: 'outbound',
        body: 'Oi',
      }).expect(400);
      expect(await prisma.raw.messageDispatch.count()).toBe(0);
    });

    it('a identificação HUMANA de um candidato só possível também não libera a resposta: sem exceção', async () => {
      const cora = await contato('Cora Fictícia', ['98765-4321']);
      await chega();
      const r1 = await rai();
      await enviar('post', `/api/conversations/${r1.id}/sender/identify`, owner, {
        contactId: cora,
      }).expect(201);
      const politica = await get(`/api/conversations/${r1.id}/send-policy`, owner).expect(200);
      expect(politica.body).toMatchObject({ mode: 'blocked' });
      expect(politica.body.reason).toMatch(/não confere, de forma exata/);
      // com o número exato no cadastro, a resposta volta
      await enviar('patch', `/api/contacts/${cora}`, owner, { phones: [N_E164] }).expect(200);
      expect(
        (await get(`/api/conversations/${r1.id}/send-policy`, owner).expect(200)).body.mode,
      ).toBe('free_form');
    });

    it('o número que sai do cadastro com a resposta na fila: o worker recusa pela MESMA regra do envio', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [c1] = await conversasDoNumero();
      const enviada = await enviar('post', `/api/conversations/${c1.id}/messages`, owner, {
        direction: 'outbound',
        body: 'Oi, tudo bem?',
      }).expect(201);
      await enviar('patch', `/api/contacts/${ana}`, owner, { phones: ['+5531911112222'] }).expect(
        200,
      );
      await drenar();
      expect(await despachoDe(enviada.body.id)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'number_not_exact',
      });
      expect(meta.sends).toEqual([]);
    });

    it('aprovar o rascunho depois que o número saiu do cadastro: 400 pela mesma regra, e a proposta fica pendente', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const [c1] = await conversasDoNumero();
      llm.nextText = RASCUNHO;
      const sugestao = await enviar(
        'post',
        `/api/intelligence/conversations/${c1.id}/reply-suggestion`,
        owner,
      ).expect(201);
      await enviar('patch', `/api/contacts/${ana}`, owner, { phones: ['+5531911112222'] }).expect(
        200,
      );
      const r = await enviar(
        'post',
        `/api/intelligence/proposals/${sugestao.body.proposalId}/approve-reply`,
        owner,
        {},
      ).expect(400);
      expect(r.body.message).toMatch(/não confere, de forma exata/);
      expect(
        (await prisma.raw.aiProposal.findFirstOrThrow({ where: { id: sugestao.body.proposalId } }))
          .status,
      ).toBe('pending');
      expect(await prisma.raw.messageDispatch.count()).toBe(0);
    });

    it('religada ENTRE a checagem rápida e a guarda: a reconferência sob as travas barra, com o motivo certo', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const bia = await contato('Bia Fictícia', ['+5531933334444']);
      await prisma.raw.channelCredential.updateMany({
        where: { channelId: canalA1 },
        data: { tokenCipher: app.get(CryptoService).encrypt('token-ficticio') },
      });
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const [c1] = await conversasDoNumero();
      llm.nextText = RASCUNHO;
      const sugestao = await enviar(
        'post',
        `/api/intelligence/conversations/${c1.id}/reply-suggestion`,
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
      const t = await abrirTravador();
      try {
        // a checagem rápida passa (a conversa ainda é da Ana); a guarda espera a trava dela
        await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          CHAVE.contato(wsA.workspaceId, ana),
        ]);
        const envio = app.get(JobsService).dispatchPending();
        await esperarBloqueadosPor(t, 1, { descricao: 'a guarda do envio na trava da Ana' });
        // sob a trava, a conversa passa à Bia (o que identificar faria)
        await t.query(`UPDATE "Conversation" SET "contactId" = $1 WHERE "id" = $2`, [bia, c1.id]);
        await t.query('COMMIT');
        await envio;
      } finally {
        await soltar(t);
      }
      expect(await despachoDe(despacho.messageId)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'conversation_relinked',
      });
      expect(meta.sends).toEqual([]);
    });

    it('o número que deixa de conferir ENTRE a checagem rápida e a guarda: a reconferência sob as travas barra o rascunho', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const [c1] = await conversasDoNumero();
      llm.nextText = RASCUNHO;
      const sugestao = await enviar(
        'post',
        `/api/intelligence/conversations/${c1.id}/reply-suggestion`,
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
      const t = await abrirTravador();
      try {
        // a checagem rápida passa (o número ainda confere); a guarda espera a trava da Ana
        await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          CHAVE.contato(wsA.workspaceId, ana),
        ]);
        const envio = app.get(JobsService).dispatchPending();
        await esperarBloqueadosPor(t, 1, { descricao: 'a guarda do envio na trava da Ana' });
        // sob a trava, o telefone da Ana vira só uma coincidência possível
        await t.query(
          `UPDATE "Contact" SET "phones" = ARRAY['98765-4321'], "phonesNormalized" = '{}'
            WHERE "id" = $1`,
          [ana],
        );
        await t.query('COMMIT');
        await envio;
      } finally {
        await soltar(t);
      }
      expect(await despachoDe(despacho.messageId)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'number_not_exact',
      });
      expect(meta.sends).toEqual([]);
    });

    it('a geração de IA que esperava a trava de X é recusada quando, no meio, a conversa passou a Y', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const bia = await contato('Bia Fictícia', ['+5531933334444']);
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const [c1] = await conversasDoNumero();
      const travador = new Client({ connectionString: TEST_DATABASE_URL });
      await travador.connect();
      try {
        // a mudança segura a trava exclusiva da Ana...
        await travador.query('BEGIN');
        await travador.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          CHAVE.contato(wsA.workspaceId, ana),
        ]);
        llm.nextText = RESUMO;
        const resumo = enviar(
          'post',
          `/api/intelligence/conversations/${c1.id}/summary`,
          owner,
        ).then((r) => r);
        // ...espera a geração parar na trava...
        const observador = new Client({ connectionString: TEST_DATABASE_URL });
        await observador.connect();
        try {
          for (let i = 0; i < 100; i++) {
            const { rows } = await observador.query(
              `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
            );
            if (rows[0].n > 0) break;
            await new Promise((r) => setTimeout(r, 50));
          }
        } finally {
          await observador.end();
        }
        // ...e, sob a trava, a conversa passa da Ana à Bia (o que identificar faria)
        await travador.query(`UPDATE "Conversation" SET "contactId" = $1 WHERE "id" = $2`, [
          bia,
          c1.id,
        ]);
        await travador.query('COMMIT');
        expect((await resumo).body.status).toBe('content_restricted');
        expect(llm.calls).toEqual([]);
      } finally {
        await travador.query('ROLLBACK').catch(() => undefined);
        await travador.end();
      }
    });
  });

  // ── A ordem das travas (critério 5, nota 8, item 3) ─────────────────────

  describe('a ordem global nos caminhos da F4.1a: corridas determinísticas e a fumaça', () => {
    const ate = async (condicao: () => Promise<boolean> | boolean, descricao: string) => {
      for (let i = 0; i < 400; i++) {
        if (await condicao()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`não aconteceu: ${descricao}`);
    };
    const travaConsultivaPendente = async () => {
      const observador = new Client({ connectionString: TEST_DATABASE_URL });
      await observador.connect();
      try {
        await ate(async () => {
          const { rows } = await observador.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
          );
          return Number(rows[0].n) > 0;
        }, 'uma trava consultiva pedida e não concedida');
      } finally {
        await observador.end();
      }
    };
    const usosAutorizados = () =>
      prisma.raw.contentUse.count({
        where: { workspaceId: wsA.workspaceId, status: 'authorized' },
      });
    const identificar = (conversationId: string, contactId: string) =>
      enviar('post', `/api/conversations/${conversationId}/sender/identify`, owner, { contactId });

    it('identificar e a ingestão do MESMO número se serializam no nível 0, nas duas ordens', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const bia = await contato('Bia Fictícia', [N_E164]);
      await chega();
      const r1 = await rai();

      // a identificação primeiro: a mensagem que vem depois vê r1 já da Ana
      let t = await abrirTravador();
      try {
        await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [nivelZero(N)]);
        const ato = identificar(r1.id, ana).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'a identificação no nível 0' });
        const ingestao = webhook(payload({ messages: [mensagem(N)] })).then((r) => r);
        await esperarBloqueadosPor(t, 2, { descricao: 'a ingestão atrás dela' });
        await t.query('COMMIT');
        expect((await ato).status).toBe(201);
        expect((await ingestao).status).toBe(200);
      } finally {
        await soltar(t);
      }
      const r2 = await rai();
      expect(r2.id).not.toBe(r1.id);
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: r1.id } })).contactId,
      ).toBe(ana);

      // a ingestão primeiro: a mensagem entra na RAI r2, que a identificação leva inteira
      t = await abrirTravador();
      try {
        await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [nivelZero(N)]);
        const ingestao = webhook(payload({ messages: [mensagem(N)] })).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'a ingestão no nível 0' });
        const ato = identificar(r2.id, bia).then((r) => r);
        await esperarBloqueadosPor(t, 2, { descricao: 'a identificação atrás dela' });
        await t.query('COMMIT');
        expect((await ingestao).status).toBe(200);
        expect((await ato).status).toBe(201);
      } finally {
        await soltar(t);
      }
      expect(await prisma.raw.message.count({ where: { conversationId: r2.id } })).toBe(2);
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: r2.id } })).contactId,
      ).toBe(bia);
    });

    it('desfazer com um uso de IA EM ANDAMENTO: a mudança espera o uso terminar e expira o resultado na mesma transação', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const r1 = await rai();
      await identificar(r1.id, ana).expect(201);
      const p = portao();
      llm.portao = p.aberto;
      llm.nextText = RESUMO;
      const resumo = enviar('post', `/api/intelligence/conversations/${r1.id}/summary`, owner).then(
        (r) => r,
      );
      // o uso está DENTRO da chamada, com as travas compartilhadas
      await ate(() => llm.calls.length === 1, 'o uso chegar ao provedor');
      const desfazer = enviar('post', `/api/conversations/${r1.id}/sender/unidentify`, owner).then(
        (r) => r,
      );
      await travaConsultivaPendente();
      p.abrir();
      expect((await resumo).body.status).toBe('ok');
      expect((await desfazer).status).toBe(201);
      expect(
        await prisma.raw.aiRun.count({
          where: { conversationId: r1.id, result: { not: Prisma.DbNull } },
        }),
      ).toBe(0);
      expect(await usosAutorizados()).toBe(0);
    });

    it('desfazer PRIMEIRO: o uso de IA espera a mudança e, depois do commit, recusa sem chamar o provedor', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const r1 = await rai();
      await identificar(r1.id, ana).expect(201);
      const t = await abrirTravador();
      try {
        // o desfazer pega as travas dele e para na linha da conversa
        await t.query('SELECT 1 FROM "Conversation" WHERE "id" = $1 FOR UPDATE', [r1.id]);
        const desfazer = enviar(
          'post',
          `/api/conversations/${r1.id}/sender/unidentify`,
          owner,
        ).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'o desfazer na linha da conversa' });
        llm.nextText = RESUMO;
        const resumo = enviar(
          'post',
          `/api/intelligence/conversations/${r1.id}/summary`,
          owner,
        ).then((r) => r);
        // o uso espera as travas EXCLUSIVAS do desfazer
        await travaConsultivaPendente();
        await t.query('COMMIT');
        expect((await desfazer).status).toBe(201);
        expect((await resumo).body.status).toBe('content_restricted');
      } finally {
        await soltar(t);
      }
      expect(llm.calls).toEqual([]);
      expect(await usosAutorizados()).toBe(0);
    });

    it('o lead de id FRESCO e o contato criado na tela com o mesmo número novo: as duas ordens se serializam, e a próxima mensagem é RAI', async () => {
      // o contato da tela primeiro: a ingestão, que esperava o nível 0, o acha
      const N2 = '5521912340000';
      let t = await abrirTravador();
      let yara: string;
      try {
        await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [nivelZero(N2)]);
        const ingestao = webhook(payload({ messages: [mensagem(N2)] })).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'a ingestão no nível 0' });
        yara = await contato('Yara Fictícia', [`+${N2}`]);
        await t.query('COMMIT');
        expect((await ingestao).status).toBe(200);
      } finally {
        await soltar(t);
      }
      expect((await conversasDoNumero(`+${N2}`))[0].contactId).toBe(yara);

      // a ingestão primeiro: o lead nasce com id fresco, e a criação na tela espera o endereço
      const N3 = '5521912349999';
      t = await abrirTravador();
      try {
        await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [endereco(N3)]);
        const ingestao = webhook(payload({ messages: [mensagem(N3)] })).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'a ingestão no endereço' });
        const criar = enviar('post', '/api/contacts', owner, {
          name: 'Zoe Fictícia',
          phones: [`+${N3}`],
        }).then((r) => r);
        await esperarBloqueadosPor(t, 2, { descricao: 'a criação atrás dela' });
        await t.query('COMMIT');
        expect((await ingestao).status).toBe(200);
        expect((await criar).status).toBe(201);
      } finally {
        await soltar(t);
      }
      expect(
        await prisma.raw.contact.count({
          where: { workspaceId: wsA.workspaceId, phoneMatchKeys: { has: N3.slice(-8) } },
        }),
      ).toBe(2);
      // dois contatos com o número: a próxima mensagem é RAI, nunca de um deles em silêncio
      await chega(N3);
      expect(await rai(`+${N3}`)).toBeDefined();
    });

    /**
     * A IMPORTAÇÃO não trava endereço (desvio 7). Ela só cria contatos, então
     * o que importa é QUANDO o commit dela cai diante da leitura dos candidatos
     * de quem decide. Um espião para o serviço depois de um passo real — as
     * travas, ou a leitura dos candidatos —, a importação comita, e o portão
     * abre. Cada teste diz a ordem lógica que o desfecho representa.
     */
    describe('a importação, sem trava de endereço (desvio 7), contra quem decide pelos candidatos', () => {
      afterEach(() => jest.restoreAllMocks());

      /** Para `metodo` de `servico` DEPOIS do original, na primeira chamada, até o portão abrir. */
      const pausarDepois = (servico: object, metodo: string) => {
        const chegou = portao();
        const segue = portao();
        const alvo = servico as Record<string, (...args: unknown[]) => Promise<unknown>>;
        const original = alvo[metodo].bind(servico);
        jest.spyOn(alvo, metodo).mockImplementationOnce(async (...args: unknown[]) => {
          const valor = await original(...args);
          chegou.abrir();
          await segue.aberto;
          return valor;
        });
        return { chegou: chegou.aberto, segue: segue.abrir };
      };
      const importar = (nome: string) =>
        enviar('post', '/api/contacts/import', owner, { rows: [{ name: nome, phone: N_E164 }] });
      const contatosDoNumero = () =>
        prisma.raw.contact.findMany({
          where: { workspaceId: wsA.workspaceId, phoneMatchKeys: { has: '87654321' } },
          orderBy: { createdAt: 'asc' },
        });

      it('a importação comita ANTES de a ingestão ler os candidatos: a ingestão a vê (ordem lógica: importação, depois ingestão)', async () => {
        const pausa = pausarDepois(app.get(TravasDeIdentidade), 'paraIngestao');
        // o `.then` dispara a requisição: sem ele, o supertest não a envia
        const ingestao = chega().then((r) => r);
        await pausa.chegou;
        await importar('Yara Fictícia').expect(201);
        pausa.segue();
        await ingestao;
        const contatos = await contatosDoNumero();
        expect(contatos.map((c) => c.name)).toEqual(['Yara Fictícia']);
        const [conversa] = await conversasDoNumero();
        expect(conversa).toMatchObject({ contactId: contatos[0].id, senderStatus: 'identified' });
      });

      it('a importação comita DEPOIS da leitura e ANTES do commit da ingestão, sem candidato: um lead a mais, e a próxima é RAI (ordem lógica: ingestão, depois importação)', async () => {
        const pausa = pausarDepois(app.get(WhatsappService), 'decidirRemetente');
        // o `.then` dispara a requisição: sem ele, o supertest não a envia
        const ingestao = chega().then((r) => r);
        await pausa.chegou;
        await importar('Yara Fictícia').expect(201);
        pausa.segue();
        await ingestao;
        const contatos = await contatosDoNumero();
        expect(contatos.map((c) => c.name).sort()).toEqual([N_E164, 'Yara Fictícia'].sort());
        const lead = contatos.find((c) => c.name === N_E164);
        const [conversa] = await conversasDoNumero();
        // a mensagem foi ao lead que ela mesma criou, como se viesse antes da importação
        expect(conversa).toMatchObject({ contactId: lead?.id, senderStatus: 'identified' });
        await chega();
        expect(await rai()).toBeDefined();
      });

      it('a importação comita DEPOIS da leitura, com um contato EXATO: a mensagem vai a ele, embora o importado também tenha o número (ordem lógica: ingestão, depois importação)', async () => {
        const ana = await contato('Ana Fictícia', [N_E164]);
        const pausa = pausarDepois(app.get(WhatsappService), 'decidirRemetente');
        // o `.then` dispara a requisição: sem ele, o supertest não a envia
        const ingestao = chega().then((r) => r);
        await pausa.chegou;
        await importar('Yara Fictícia').expect(201);
        pausa.segue();
        await ingestao;
        const [conversa] = await conversasDoNumero();
        // NÃO é garantia absoluta: no commit, a Yara já tinha o número; a
        // atribuição à Ana é a da ordem em que a ingestão veio antes
        expect(conversa).toMatchObject({ contactId: ana, senderStatus: 'identified' });
        expect((await contatosDoNumero()).map((c) => c.name)).toEqual([
          'Ana Fictícia',
          'Yara Fictícia',
        ]);
        await chega();
        expect(await rai()).toBeDefined();
      });

      it('com um contato exato e a importação ANTES da leitura: dois candidatos, e a mensagem é RAI (ordem lógica: importação, depois ingestão)', async () => {
        await contato('Ana Fictícia', [N_E164]);
        const pausa = pausarDepois(app.get(TravasDeIdentidade), 'paraIngestao');
        // o `.then` dispara a requisição: sem ele, o supertest não a envia
        const ingestao = chega().then((r) => r);
        await pausa.chegou;
        await importar('Yara Fictícia').expect(201);
        pausa.segue();
        await ingestao;
        expect(await rai()).toBeDefined();
        expect(
          await prisma.raw.conversation.count({
            where: { workspaceId: wsA.workspaceId, contactId: { not: null } },
          }),
        ).toBe(0);
      });

      it('identificar com a importação ANTES da leitura dos candidatos: o importado é candidato, e a trilha conta três (ordem lógica: importação, depois identificação)', async () => {
        const ana = await contato('Ana Fictícia', [N_E164]);
        await contato('Bia Fictícia', [N_E164]);
        await chega();
        const r1 = await rai();
        const pausa = pausarDepois(app.get(ConversationSenderService), 'travarERelear');
        const ato = identificar(r1.id, ana).then((r) => r);
        await pausa.chegou;
        await importar('Cora Fictícia').expect(201);
        pausa.segue();
        expect((await ato).status).toBe(201);
        const trilha = await prisma.raw.auditLog.findFirstOrThrow({
          where: { action: 'conversation.sender_identified' },
        });
        expect(trilha.after).toMatchObject({ contactId: ana, candidates: 3 });
      });

      it('identificar com a importação DEPOIS da leitura dos candidatos: a escolha vale pelos lidos, e a trilha conta dois (ordem lógica: identificação, depois importação)', async () => {
        const ana = await contato('Ana Fictícia', [N_E164]);
        await contato('Bia Fictícia', [N_E164]);
        await chega();
        const r1 = await rai();
        const pausa = pausarDepois(app.get(ConversationSenderService), 'classificar');
        const ato = identificar(r1.id, ana).then((r) => r);
        await pausa.chegou;
        await importar('Cora Fictícia').expect(201);
        pausa.segue();
        expect((await ato).status).toBe(201);
        const trilha = await prisma.raw.auditLog.findFirstOrThrow({
          where: { action: 'conversation.sender_identified' },
        });
        expect(trilha.after).toMatchObject({ contactId: ana, candidates: 2 });
        expect(
          (await prisma.raw.conversation.findFirstOrThrow({ where: { id: r1.id } })).contactId,
        ).toBe(ana);
        // a próxima mensagem vê os três
        await chega();
        const r2 = await rai();
        expect(
          (await get(`/api/conversations/${r2.id}/sender/candidates`, owner).expect(200)).body,
        ).toHaveLength(3);
      });
    });

    it('fumaça: ingestão por dois canais, os três atos, os escritores de telefone, a importação e um uso de IA, juntos, terminam sem deadlock e com desfechos previstos', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const bia = await contato('Bia Fictícia', [N_E164]);
      await contato('Cora Fictícia', ['+5531955556666']);
      const dora = await contato('Dora Fictícia', [N_E164, '+5521912345678']);
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const r1 = await rai();
      await chega('5531955556666');
      const [daCora] = await conversasDoNumero('+5531955556666');
      const p = portao();
      llm.portao = p.aberto;
      llm.nextText = RESUMO;
      setTimeout(() => p.abrir(), 150);
      const respostas = await Promise.all([
        webhook(payload({ messages: [mensagem(N)] }, NUMERO_A1)),
        webhook(payload({ messages: [mensagem(N)] }, NUMERO_A2)),
        identificar(r1.id, ana),
        enviar('post', `/api/conversations/${daCora.id}/sender/reject`, owner, {
          removeNumber: true,
        }),
        enviar('post', `/api/intelligence/conversations/${daCora.id}/summary`, owner),
        enviar('patch', `/api/contacts/${bia}`, owner, { phones: [] }),
        enviar('patch', `/api/contacts/${ana}`, owner, { phones: [N_E164, '+5511912345678'] }),
        enviar('post', '/api/contacts', owner, { name: 'Eva Fictícia', phones: [N_E164] }),
        enviar('post', '/api/contacts/import', owner, {
          rows: [{ name: 'Fia Fictícia', phone: N_E164 }],
        }),
        enviar('delete', `/api/contacts/${dora}`, owner),
      ]);
      // nenhum 500 (o deadlock, 40P01, sairia como 500): só sucesso ou as recusas
      // do protocolo — a espera estourada (409), o ato que perdeu a corrida (400/404)
      for (const r of respostas) expect([200, 201, 400, 404, 409]).toContain(r.status);
      expect(await usosAutorizados()).toBe(0);
      // e as garantias do banco seguem: no máximo uma RAI aberta por (canal, número)
      const raisAbertas = await prisma.raw.conversation.groupBy({
        by: ['channelId', 'externalAddress'],
        where: {
          workspaceId: wsA.workspaceId,
          senderStatus: 'unidentified',
          status: { not: 'closed' },
        },
        _count: { _all: true },
      });
      for (const g of raisAbertas) expect(g._count._all).toBe(1);
    });
  });

  // ── Anexos ──────────────────────────────────────────────────────────────

  describe('anexos de conversa (critério 3)', () => {
    const subir = async () =>
      (
        await request(http)
          .post('/api/files')
          .set('Origin', ORIGIN)
          .set('Cookie', owner.cookieHeader)
          .set('x-csrf-token', owner.csrf)
          .attach('file', png(), `f${++seq}.png`)
          .expect(201)
      ).body.id as string;
    const anexar = async (fileObjectId: string, conversationId: string) => {
      const msg = await prisma.raw.message.findFirstOrThrow({ where: { conversationId } });
      await prisma.raw.messageAttachment.create({
        data: { workspaceId: wsA.workspaceId, messageId: msg.id, fileObjectId },
      });
    };

    it('o anexo de uma RAI some e dá 404 para quem não a vê; ligado a duas conversas, exige as duas; sem vínculo, nada muda', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await contato('Bia Fictícia', [N_E164]);
      await contato('Cora Fictícia', ['+5531955556666']);
      await chega();
      await chega('5531955556666');
      const r1 = await rai();
      const [cora] = await conversasDoNumero('+5531955556666');
      const daRai = await subir();
      const dasDuas = await subir();
      const daCora = await subir();
      const solto = await subir();
      await anexar(daRai, r1.id);
      await anexar(dasDuas, r1.id);
      await anexar(dasDuas, cora.id);
      await anexar(daCora, cora.id);

      const lista = (await get('/api/files', atendente).expect(200)).body.map(
        (f: { id: string }) => f.id,
      );
      expect(lista).toContain(solto);
      // a conversa comum: quem lê conversas vê o anexo dela
      expect(lista).toContain(daCora);
      expect(lista).not.toContain(daRai);
      expect(lista).not.toContain(dasDuas);
      await get(`/api/files/${daRai}/content`, atendente).expect(404);
      await get(`/api/files/${dasDuas}/content`, atendente).expect(404);
      await enviar('delete', `/api/files/${daRai}`, atendente).expect(404);
      // nem anexar a outra conversa: o id da mídia da RAI não basta
      const anexada = await enviar('post', `/api/conversations/${cora.id}/messages`, atendente, {
        direction: 'outbound',
        body: 'segue',
        attachmentIds: [daRai],
      }).expect(400);
      expect(anexada.body.message).toMatch(/Arquivo inválido/);
      await get(`/api/files/${daRai}/content`, owner).expect(200);

      // files:read sem conversations:read: o anexo de conversa comum também some
      const soArquivos = await createUserFixture(prisma, 'arquivos@veyra.test');
      await createMembershipFixture(
        prisma,
        wsA.workspaceId,
        soArquivos,
        await papel('Arquivos', ['files:read', 'files:write']),
      );
      const arquivos = await login('arquivos@veyra.test');
      const deArquivos = (await get('/api/files', arquivos).expect(200)).body.map(
        (f: { id: string }) => f.id,
      );
      expect(deArquivos).toEqual([solto]);
    });
  });

  describe('a exclusão do contato e a mídia dele', () => {
    it('expurga a mídia RECEBIDA que fica sem vínculo; a ligada a outra conversa e o anexo de quem enviou ficam', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await contato('Cora Fictícia', ['+5531955556666']);
      await chega();
      await chega('5531955556666');
      const [daAna] = await conversasDoNumero();
      const [daCora] = await conversasDoNumero('+5531955556666');
      const msgAna = await prisma.raw.message.findFirstOrThrow({
        where: { conversationId: daAna.id },
      });
      const msgCora = await prisma.raw.message.findFirstOrThrow({
        where: { conversationId: daCora.id },
      });
      const recebida = await subirArquivo();
      const recebidaNasDuas = await subirArquivo();
      const enviada = await subirArquivo();
      for (const [fileObjectId, mid] of [
        [recebida, 'mid.FICTICIA.1'],
        [recebidaNasDuas, 'mid.FICTICIA.2'],
      ] as const) {
        await prisma.raw.inboundMedia.create({
          data: {
            workspaceId: wsA.workspaceId,
            messageId: msgAna.id,
            providerMediaId: mid,
            mimeType: 'image/png',
            fileObjectId,
          },
        });
      }
      await prisma.raw.messageAttachment.create({
        data: {
          workspaceId: wsA.workspaceId,
          messageId: msgCora.id,
          fileObjectId: recebidaNasDuas,
        },
      });
      const saida = await prisma.raw.message.create({
        data: {
          workspaceId: wsA.workspaceId,
          conversationId: daAna.id,
          channelId: canalA1,
          direction: 'outbound',
          authorType: 'system',
          body: 'segue o arquivo',
        },
      });
      await prisma.raw.messageAttachment.create({
        data: { workspaceId: wsA.workspaceId, messageId: saida.id, fileObjectId: enviada },
      });

      await enviar('delete', `/api/contacts/${ana}`, owner).expect(200);
      expect(await prisma.raw.fileObject.findFirst({ where: { id: recebida } })).toBeNull();
      expect(
        await prisma.raw.fileObject.findFirst({ where: { id: recebidaNasDuas } }),
      ).not.toBeNull();
      expect(await prisma.raw.fileObject.findFirst({ where: { id: enviada } })).not.toBeNull();
      // e os BYTES deles também ficam: nenhum expurgo pedido, e o download funciona
      for (const fica of [recebidaNasDuas, enviada]) {
        expect(
          await prisma.raw.outboxEvent.count({
            where: { eventType: 'file.purge', dedupeKey: `file.purge:${fica}` },
          }),
        ).toBe(0);
        await get(`/api/files/${fica}/content`, owner).expect(200);
      }
      expect(
        await prisma.raw.outboxEvent.count({
          where: { eventType: 'file.purge', dedupeKey: `file.purge:${recebida}` },
        }),
      ).toBe(1);
      expect(
        await prisma.raw.auditLog.count({ where: { action: 'file.deleted', entityId: recebida } }),
      ).toBe(1);
      // a que ficou ligada à Cora continua com a regra dela
      await get(`/api/files/${recebidaNasDuas}/content`, atendente).expect(200);
    });
  });

  describe('a quarentena de um contato excluído (decisão de 2026-10-23)', () => {
    it('a evidência fica, com o nome original, mas quem não via a conversa continua sem vê-la', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [daAna] = await conversasDoNumero();
      const msg = await prisma.raw.message.findFirstOrThrow({
        where: { conversationId: daAna.id },
      });
      const barrado = await subirArquivo();
      await prisma.raw.inboundMedia.create({
        data: {
          workspaceId: wsA.workspaceId,
          messageId: msg.id,
          providerMediaId: 'mid.FICTICIA.QUARENTENA',
          mimeType: 'image/png',
          state: 'fetched',
          fileObjectId: barrado,
        },
      });
      // o scanner barrou o arquivo e os bytes já saíram (ADR-043)
      await prisma.raw.fileObject.updateMany({
        where: { id: barrado },
        data: { scanStatus: 'quarantined', bytesPurgedAt: new Date() },
      });
      const nomeOriginal = (
        await prisma.raw.fileObject.findFirstOrThrow({ where: { id: barrado } })
      ).fileName;
      // só arquivos: nunca leu conversas
      const soArquivos = await createUserFixture(prisma, 'so-arquivos@veyra.test');
      await createMembershipFixture(
        prisma,
        wsA.workspaceId,
        soArquivos,
        await papel('Só arquivos', ['files:read', 'files:write']),
      );
      const arquivos = await login('so-arquivos@veyra.test');
      const ids = async (s: Session) =>
        (await get('/api/files', s).expect(200)).body.map((f: { id: string }) => f.id);
      expect(await ids(arquivos)).not.toContain(barrado);

      await enviar('delete', `/api/contacts/${ana}`, owner).expect(200);
      // a evidência continua inteira
      expect(
        await prisma.raw.fileObject.findFirstOrThrow({ where: { id: barrado } }),
      ).toMatchObject({
        fileName: nomeOriginal,
        scanStatus: 'quarantined',
        conversationRestricted: true,
      });
      // quem não via a conversa continua sem ver: nem na lista, nem pelo id
      expect(await ids(arquivos)).not.toContain(barrado);
      await get(`/api/files/${barrado}/content`, arquivos).expect(404);
      await enviar('delete', `/api/files/${barrado}`, arquivos).expect(404);
      // e quem lia conversas continua vendo a evidência
      expect(await ids(owner)).toContain(barrado);
    });
  });

  describe('a mídia recebida leva a regra consigo (revisão da F4.1a)', () => {
    it('a mídia recebida que PERDE o vínculo não volta a ficar pública na biblioteca: só quem lê conversas a vê', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [daAna] = await conversasDoNumero();
      const msg = await prisma.raw.message.findFirstOrThrow({
        where: { conversationId: daAna.id },
      });
      const midia = await gravarRecebida({
        workspaceId: wsA.workspaceId,
        bytes: png(),
        fileName: 'documento-ficticio.png',
        mimeType: 'image/png',
      });
      const ligacao = await prisma.raw.inboundMedia.create({
        data: {
          workspaceId: wsA.workspaceId,
          messageId: msg.id,
          providerMediaId: 'mid.FICTICIA.SOLTA',
          mimeType: 'image/png',
          state: 'fetched',
          fileObjectId: midia.id,
        },
      });
      const soArquivos = await createUserFixture(prisma, 'so-arquivos-3@veyra.test');
      await createMembershipFixture(
        prisma,
        wsA.workspaceId,
        soArquivos,
        await papel('Só arquivos', ['files:read', 'files:write']),
      );
      const arquivos = await login('so-arquivos-3@veyra.test');
      const ids = async (sessao: Session) =>
        (await get('/api/files', sessao).expect(200)).body.map((f: { id: string }) => f.id);
      expect(await ids(arquivos)).not.toContain(midia.id);
      // o vínculo some (qualquer caminho que o tire): a marca continua valendo
      await prisma.raw.inboundMedia.updateMany({
        where: { id: ligacao.id },
        data: { fileObjectId: null },
      });
      expect(await ids(arquivos)).not.toContain(midia.id);
      await get(`/api/files/${midia.id}/content`, arquivos).expect(404);
      await enviar('delete', `/api/files/${midia.id}`, arquivos).expect(404);
      expect(await ids(owner)).toContain(midia.id);
    });

    it('a mídia de X anexada na conversa de Y: nunca volta a quem só tem files:read, e sai com o último titular', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const cora = await contato('Cora Fictícia', ['+5531955556666']);
      await chega();
      await chega('5531955556666');
      const [daAna] = await conversasDoNumero();
      const [daCora] = await conversasDoNumero('+5531955556666');
      const msgAna = await prisma.raw.message.findFirstOrThrow({
        where: { conversationId: daAna.id },
      });
      // a mídia que a Ana mandou, gravada pelo caminho do coletor
      const midia = await gravarRecebida({
        workspaceId: wsA.workspaceId,
        bytes: png(),
        fileName: 'exame-ficticio.png',
        mimeType: 'image/png',
      });
      await prisma.raw.inboundMedia.create({
        data: {
          workspaceId: wsA.workspaceId,
          messageId: msgAna.id,
          providerMediaId: 'mid.FICTICIA.ANA',
          mimeType: 'image/png',
          state: 'fetched',
          fileObjectId: midia.id,
        },
      });
      // alguém a anexa a uma mensagem de saída na conversa da Cora
      const saida = await prisma.raw.message.create({
        data: {
          workspaceId: wsA.workspaceId,
          conversationId: daCora.id,
          channelId: canalA1,
          direction: 'outbound',
          authorType: 'system',
          body: 'segue',
        },
      });
      await prisma.raw.messageAttachment.create({
        data: { workspaceId: wsA.workspaceId, messageId: saida.id, fileObjectId: midia.id },
      });
      const soArquivos = await createUserFixture(prisma, 'so-arquivos-2@veyra.test');
      await createMembershipFixture(
        prisma,
        wsA.workspaceId,
        soArquivos,
        await papel('Só arquivos', ['files:read', 'files:write']),
      );
      const arquivos = await login('so-arquivos-2@veyra.test');
      const ids = async () =>
        (await get('/api/files', arquivos).expect(200)).body.map((f: { id: string }) => f.id);

      // a Ana sai: o arquivo continua ligado à conversa da Cora, e fica — com os bytes
      await enviar('delete', `/api/contacts/${ana}`, owner).expect(200);
      expect(await prisma.raw.fileObject.findFirst({ where: { id: midia.id } })).not.toBeNull();
      expect(
        await prisma.raw.outboxEvent.count({
          where: { eventType: 'file.purge', dedupeKey: `file.purge:${midia.id}` },
        }),
      ).toBe(0);
      await get(`/api/files/${midia.id}/content`, owner).expect(200);
      expect(await ids()).not.toContain(midia.id);
      // a Cora sai: era o último vínculo, e a mídia recebida sai junto
      await enviar('delete', `/api/contacts/${cora}`, owner).expect(200);
      expect(await prisma.raw.fileObject.findFirst({ where: { id: midia.id } })).toBeNull();
    });
  });

  describe('a exclusão do contato contra quem grava vínculo de arquivo ao mesmo tempo', () => {
    it('o coletor ligando a mídia no meio da exclusão: a exclusão espera e expurga o arquivo', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [daAna] = await conversasDoNumero();
      const msg = await prisma.raw.message.findFirstOrThrow({
        where: { conversationId: daAna.id },
      });
      const midia = await prisma.raw.inboundMedia.create({
        data: {
          workspaceId: wsA.workspaceId,
          messageId: msg.id,
          providerMediaId: 'mid.FICTICIA.COLETOR',
          mimeType: 'image/png',
          claimToken: randomUUID(),
          claimedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const arquivo = await subirArquivo();
      const t = await abrirTravador();
      try {
        // o coletor, no meio da transação que liga o arquivo à mídia
        await t.query(
          `UPDATE "InboundMedia" SET "state" = 'fetched', "fileObjectId" = $1, "claimToken" = NULL
            WHERE "id" = $2`,
          [arquivo, midia.id],
        );
        const excluir = enviar('delete', `/api/contacts/${ana}`, owner).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'a exclusão na mídia que o coletor grava' });
        await t.query('COMMIT');
        expect((await excluir).status).toBe(200);
      } finally {
        await soltar(t);
      }
      expect(await prisma.raw.fileObject.findFirst({ where: { id: arquivo } })).toBeNull();
    });

    it('o ANEXAR real prende o arquivo antes de ligá-lo: com o expurgo segurando a linha, ele espera e, sem o arquivo, recusa', async () => {
      const cora = await contato('Cora Fictícia', ['+5531955556666']);
      const interna = await enviar('post', '/api/conversations', owner, {
        contactId: cora,
        subject: 'Interna fictícia',
      }).expect(201);
      const arquivo = await subirArquivo();
      const t = await abrirTravador();
      try {
        // o expurgo, no meio da transação: a escrita sem efeito na linha do arquivo
        await t.query(
          `UPDATE "FileObject" SET "scanAttempts" = "scanAttempts" + 0 WHERE "id" = $1`,
          [arquivo],
        );
        const anexar = enviar('post', `/api/conversations/${interna.body.id}/messages`, owner, {
          direction: 'outbound',
          body: 'segue',
          attachmentIds: [arquivo],
        }).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'o anexar na linha do arquivo' });
        await t.query(`DELETE FROM "FileObject" WHERE "id" = $1`, [arquivo]);
        await t.query('COMMIT');
        const r = await anexar;
        expect(r.status).toBe(400);
        expect(r.body.message).toMatch(/Arquivo inválido/);
      } finally {
        await soltar(t);
      }
      expect(await prisma.raw.messageAttachment.count({ where: { fileObjectId: arquivo } })).toBe(
        0,
      );
    });

    it('um ANEXAR comitando no meio do expurgo: o expurgo vê o vínculo novo, e o arquivo e o anexo ficam', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await contato('Cora Fictícia', ['+5531955556666']);
      await chega();
      await chega('5531955556666');
      const [daAna] = await conversasDoNumero();
      const [daCora] = await conversasDoNumero('+5531955556666');
      const msgAna = await prisma.raw.message.findFirstOrThrow({
        where: { conversationId: daAna.id },
      });
      const msgCora = await prisma.raw.message.findFirstOrThrow({
        where: { conversationId: daCora.id },
      });
      const recebida = await subirArquivo();
      await prisma.raw.inboundMedia.create({
        data: {
          workspaceId: wsA.workspaceId,
          messageId: msgAna.id,
          providerMediaId: 'mid.FICTICIA.ANEXAR',
          mimeType: 'image/png',
          state: 'fetched',
          fileObjectId: recebida,
        },
      });
      const t = await abrirTravador();
      try {
        // o anexar à mensagem da Cora, no meio da transação: a escrita sem efeito e o vínculo
        await t.query(
          `UPDATE "FileObject" SET "scanAttempts" = "scanAttempts" + 0 WHERE "id" = $1`,
          [recebida],
        );
        await t.query(
          `INSERT INTO "MessageAttachment" ("id", "workspaceId", "messageId", "fileObjectId")
           VALUES (gen_random_uuid(), $1, $2, $3)`,
          [wsA.workspaceId, msgCora.id, recebida],
        );
        const excluir = enviar('delete', `/api/contacts/${ana}`, owner).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'o expurgo na linha do arquivo' });
        await t.query('COMMIT');
        expect((await excluir).status).toBe(200);
      } finally {
        await soltar(t);
      }
      expect(await prisma.raw.fileObject.findFirst({ where: { id: recebida } })).not.toBeNull();
      expect(await prisma.raw.messageAttachment.count({ where: { fileObjectId: recebida } })).toBe(
        1,
      );
    });
  });

  // ── Escritores de telefone e o banco ────────────────────────────────────

  describe('escritores de telefone e as garantias do banco', () => {
    it('criar, editar e importar recalculam as colunas derivadas, com o original preservado', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321', '98765-4321']);
      expect(await prisma.raw.contact.findFirstOrThrow({ where: { id: ana } })).toMatchObject({
        phones: ['(11) 98765-4321', '98765-4321'],
        phonesNormalized: [N_E164],
        phoneMatchKeys: ['87654321'],
      });
      await enviar('patch', `/api/contacts/${ana}`, owner, {
        phones: ['+55 21 91234-5678'],
      }).expect(200);
      expect(await prisma.raw.contact.findFirstOrThrow({ where: { id: ana } })).toMatchObject({
        phonesNormalized: ['+5521912345678'],
        phoneMatchKeys: ['12345678'],
      });
      await enviar('post', '/api/contacts/import', owner, {
        rows: [{ name: 'Bia Fictícia', phone: '(11) 98765-4321' }],
      }).expect(201);
      expect(
        await prisma.raw.contact.findFirstOrThrow({ where: { name: 'Bia Fictícia' } }),
      ).toMatchObject({
        phonesNormalized: [N_E164],
        phoneMatchKeys: ['87654321'],
      });
    });

    it('o PATCH parcial não toca o que não veio: editar só o status mantém telefones, emails e tags', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await enviar('patch', `/api/contacts/${ana}`, owner, {
        emails: ['ana@ficticia.test'],
      }).expect(200);
      await enviar('patch', `/api/contacts/${ana}`, owner, { status: 'archived' }).expect(200);
      expect(await prisma.raw.contact.findFirstOrThrow({ where: { id: ana } })).toMatchObject({
        phones: [N_E164],
        emails: ['ana@ficticia.test'],
        phoneMatchKeys: ['87654321'],
      });
    });

    it('editar telefone ESPERA a ingestão que segura o endereço do número', async () => {
      const ana = await contato('Ana Fictícia', []);
      const travador = new Client({ connectionString: TEST_DATABASE_URL });
      await travador.connect();
      try {
        await travador.query('BEGIN');
        // o endereço compartilhado, como a ingestão o segura
        await travador.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
          endereco(N),
        ]);
        let terminou = false;
        const edicao = enviar('patch', `/api/contacts/${ana}`, owner, { phones: [N_E164] }).then(
          (r) => {
            terminou = true;
            return r;
          },
        );
        await new Promise((r) => setTimeout(r, 500));
        expect(terminou).toBe(false);
        await travador.query('COMMIT');
        expect((await edicao).status).toBe(200);
      } finally {
        await travador.query('ROLLBACK').catch(() => undefined);
        await travador.end();
      }
    });

    it('pôr o 9º dígito mantém a chave e ainda assim ESPERA a ingestão do número: a diferença é por número', async () => {
      const ana = await contato('Ana Fictícia', ['+55 11 8765-4321']);
      const t = await abrirTravador();
      try {
        await t.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
          endereco(N),
        ]);
        let terminou = false;
        const edicao = enviar('patch', `/api/contacts/${ana}`, owner, {
          phones: ['+55 11 98765-4321'],
        }).then((r) => {
          terminou = true;
          return r;
        });
        await esperarBloqueadosPor(t, 1, { descricao: 'a edição no endereço do número' });
        expect(terminou).toBe(false);
        await t.query('COMMIT');
        expect((await edicao).status).toBe(200);
      } finally {
        await soltar(t);
      }
    });

    it('o PATCH com os MESMOS telefones, com outro escritor tirando o número no meio: 409, e o número não volta', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const t = await abrirTravador();
      try {
        await t.query('SELECT 1 FROM "Contact" WHERE "id" = $1 FOR UPDATE', [ana]);
        const editar = enviar('patch', `/api/contacts/${ana}`, owner, {
          name: 'Ana Fictícia Silva',
          phones: [N_E164],
        }).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'a edição na linha do contato' });
        // o que o rejeitar com retirada do número faria, sob a linha
        await t.query(
          `UPDATE "Contact" SET "phones" = '{}', "phonesNormalized" = '{}', "phoneMatchKeys" = '{}'
            WHERE "id" = $1`,
          [ana],
        );
        await t.query('COMMIT');
        expect((await editar).status).toBe(409);
      } finally {
        await soltar(t);
      }
      expect((await prisma.raw.contact.findFirstOrThrow({ where: { id: ana } })).phones).toEqual(
        [],
      );
    });

    it('editar só o nome não trava endereço nenhum: nenhum telefone muda', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const t = await abrirTravador();
      try {
        await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [endereco(N)]);
        await enviar('patch', `/api/contacts/${ana}`, owner, {
          name: 'Ana Fictícia Silva',
          phones: [N_E164],
        }).expect(200);
      } finally {
        await soltar(t);
      }
    });

    it('o phones:normalize não põe de volta as colunas de um número que saiu enquanto ele lia', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const lido = await prisma.raw.contact.findFirstOrThrow({ where: { id: ana } });
      // um escritor de telefone muda o número depois da leitura da CLI
      await enviar('patch', `/api/contacts/${ana}`, owner, { phones: ['+5531911112222'] }).expect(
        200,
      );
      expect(
        await gravarSeOsTelefonesSaoOsLidos(
          prisma,
          wsA.workspaceId,
          lido,
          derivadosDosTelefones(lido.phones, 'BR'),
        ),
      ).toBe(false);
      expect(await prisma.raw.contact.findFirstOrThrow({ where: { id: ana } })).toMatchObject({
        phones: ['+5531911112222'],
        phoneMatchKeys: ['11112222'],
      });
      // e a passada inteira acha tudo em dia
      expect(
        await normalizarWorkspace(prisma, { id: wsA.workspaceId, phoneRegion: 'BR' }),
      ).toMatchObject({ lidos: 1, alterados: 0, pulados: 0 });
    });

    it('o banco recusa RAI com contato, e as marcas dos únicos seguem o status pelo gatilho', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await chega();
      const [c1] = await conversasDoNumero();
      expect(c1.openMark).toBe(true);
      await expect(
        prisma.raw.conversation.update({
          where: { id: c1.id },
          data: { senderStatus: 'unidentified' },
        }),
      ).rejects.toThrow();
      await prisma.raw.conversation.update({ where: { id: c1.id }, data: { status: 'closed' } });
      expect(
        (await prisma.raw.conversation.findFirstOrThrow({ where: { id: c1.id } })).openMark,
      ).toBeNull();
      // duas conversas abertas do mesmo (canal, contato, número): o único recusa
      await prisma.raw.conversation.update({ where: { id: c1.id }, data: { status: 'open' } });
      await expect(
        prisma.raw.conversation.create({
          data: {
            workspaceId: wsA.workspaceId,
            channelId: canalA1,
            contactId: ana,
            externalAddress: N_E164,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
