import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { CryptoService } from '../../common/crypto.service';
import { MediaCollectorService } from '../../channels/media-collector.service';
import {
  META_TRANSPORT,
  type FetchOutcome,
  type MetaTransport,
  type SendOutcome,
} from '../../channels/meta.transport';
import {
  MENSAGEM_MIDIA_PROTEGIDA,
  MENSAGEM_MIDIA_SEM_RECEBIMENTO,
} from '../../conversations/conversation-sender.service';
import { ProtectedContentService } from '../../extensions/protected-content';
import { PrismaService } from '../../prisma/prisma.service';
import { createTestApp } from '../../../test/integration/app';
import { TEST_DATABASE_URL } from '../../../test/integration/db-url';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../test/integration/fixtures';
import { resetDb } from '../../../test/integration/harness';
import { esperarBloqueadosPor } from '../../../test/integration/locks';
import { ClinicsActivationService } from './clinics-activation.service';

const APP_SECRET = process.env.META_APP_SECRET as string;
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const NUMERO_A = '109876543401';
const NUMERO_B = '109876543402';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(48, 5),
]);

/** Transporte FALSO: a suíte nunca fala com a Meta. A coleta devolve um PNG fictício. */
class FakeMeta implements MetaTransport {
  async sendText(): Promise<SendOutcome> {
    return { ok: true, externalId: 'wamid.ENVIADA' };
  }
  async sendTemplate(): Promise<SendOutcome> {
    return { ok: true, externalId: 'wamid.T' };
  }
  async fetchMedia(): Promise<FetchOutcome> {
    return { ok: true, bytes: PNG, mimeType: 'image/png' };
  }
}

interface Session {
  cookieHeader: string;
  csrf: string;
}

/**
 * A CORREÇÃO SEGURA DO REMETENTE (ADR-061, adendo 9, item 2), pelas rotas
 * reais. Cada mensagem grava o contato da conversa no recebimento; a mídia é
 * protegida se ele OU o atual for oculto para quem pede. Rejeitar e desfazer a
 * conversa de um paciente com mídia passam a ser possíveis SÓ para quem lê
 * todo o conteúdo protegido (Owner, Admin, "Recepção e atendimento"), e a
 * mídia do paciente continua protegida depois — inclusive quando a conversa
 * acaba identificada como um interessado. Dados e números FICTÍCIOS.
 */
describe('Clinics — a correção segura do remetente com mídia (integração, adendo 9)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp([], [{ provide: META_TRANSPORT, useValue: new FakeMeta() }]);
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  let ws: WorkspaceFixture;
  let beta: WorkspaceFixture;
  let owner: Session;
  let recepcao: Session;
  let guest: Session;
  let membroBeta: Session;
  let paciente: string;
  let interessado: string;
  let seq = 0;

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
  const enviar = (
    metodo: 'post' | 'patch' | 'delete',
    path: string,
    s: Session,
    body?: unknown,
    cabecalhos: Record<string, string> = {},
  ) => {
    let r = request(http)
      [metodo](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    for (const [k, v] of Object.entries(cabecalhos)) r = r.set(k, v);
    return body === undefined ? r : r.send(body as object);
  };
  const post = (path: string, s: Session, body?: unknown) => enviar('post', path, s, body);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

  /** o webhook da Meta, assinado, com uma mensagem de `de` (o `wa_id`) */
  const webhook = (numero: string, mensagem: Record<string, unknown>) => {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: { metadata: { phone_number_id: numero }, messages: [mensagem] },
            },
          ],
        },
      ],
    });
    return request(http)
      .post('/api/channels/whatsapp/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'x-hub-signature-256',
        `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(raw)).digest('hex')}`,
      )
      .send(raw)
      .expect(200);
  };
  const base = (de: string) => ({
    id: `wamid.CORRECAO${++seq}`,
    from: de,
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  /** uma imagem recebida pela ingestão real: a mensagem e a mídia pendente */
  const chegaImagem = (de: string, numero = NUMERO_A) =>
    webhook(numero, {
      ...base(de),
      type: 'image',
      image: { id: `midia-${++seq}`, mime_type: 'image/png' },
    });
  const chegaTexto = (de: string, numero = NUMERO_A) =>
    webhook(numero, { ...base(de), type: 'text', text: { body: `Mensagem fictícia ${seq}` } });
  /** a coleta real das mídias pendentes (o transporte falso devolve um PNG) */
  const coletar = () => app.get(MediaCollectorService).collectPending();

  const contato = async (name: string, phones: string[] = [], s = owner) =>
    (await post('/api/contacts', s, { name, phones }).expect(201)).body.id as string;
  const telefones = (id: string, phones: string[], s = owner) =>
    enviar('patch', `/api/contacts/${id}`, s, { phones }).expect(200);
  const conversaDoNumero = async (workspaceId: string, numero: string) =>
    (await prisma.raw.conversation.findFirst({
      where: { workspaceId, externalAddress: numero },
      orderBy: { createdAt: 'desc' },
    }))!;
  /** os arquivos ligados às mensagens de uma conversa (anexos) */
  const arquivosDa = async (conversationId: string) =>
    (
      await prisma.raw.messageAttachment.findMany({
        where: { message: { conversationId } },
        select: { fileObjectId: true },
      })
    ).map((a) => a.fileObjectId);
  /** o que quem lê recebe da mídia: o corpo, o anexo, o download, a lista */
  const midiaVista = async (s: Session, conversa: string, arquivo: string) => {
    const msgs = await get(`/api/conversations/${conversa}/messages`, s).expect(200);
    const lista = await get('/api/files', s).expect(200);
    const comMidia = (
      msgs.body.items as { body: string; attachments: Record<string, unknown>[] }[]
    ).filter((m) => m.body !== m.body.replace(/^\[\w+\]$/, ''));
    return {
      corpo: comMidia.map((m) => m.body),
      anexos: comMidia.map((m) => m.attachments.map((a) => (a.restricted ? a : { aberto: true }))),
      download: (await get(`/api/files/${arquivo}/content`, s)).status,
      naLista: (lista.body as { id: string }[]).some((f) => f.id === arquivo),
    };
  };
  const RESTRITA = {
    corpo: ['[anexo]'],
    anexos: [[{ restricted: true }]],
    download: 404,
    naLista: false,
  };
  const ABERTA = { corpo: ['[image]'], anexos: [[{ aberto: true }]], download: 200, naLista: true };
  const trilha = async (s: Session, action: string) =>
    (await get(`/api/audit?action=${action}&limit=100`, s).expect(200)).body.items as {
      entityId: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }[];
  const papel = async (workspaceId: string, nome: string, chaves: string[], email: string) => {
    const role = await prisma.raw.role.create({
      data: { workspaceId, name: nome, isSystem: false },
    });
    await prisma.raw.rolePermission.createMany({
      data: chaves.map((permissionKey) => ({ workspaceId, roleId: role.id, permissionKey })),
    });
    await createMembershipFixture(
      prisma,
      workspaceId,
      await createUserFixture(prisma, email),
      role.id,
    );
    return loginAs(email);
  };

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    ws = await createWorkspaceFixture(prisma, 'acme');
    beta = await createWorkspaceFixture(prisma, 'beta');
    for (const systemKey of ['owner', 'member', 'guest']) {
      const user = await createUserFixture(prisma, `${systemKey}@veyra.test`);
      await createMembershipFixture(prisma, ws.workspaceId, user, ws.roles[systemKey]);
    }
    const userBeta = await createUserFixture(prisma, 'membro-beta@veyra.test');
    await createMembershipFixture(prisma, beta.workspaceId, userBeta, beta.roles.member);
    await app.get(ClinicsActivationService).enable('acme');
    for (const [workspaceId, numero] of [
      [ws.workspaceId, NUMERO_A],
      [beta.workspaceId, NUMERO_B],
    ] as const) {
      const canal = await prisma.raw.channel.create({
        data: { workspaceId, type: 'whatsapp', name: `WhatsApp ${numero}` },
      });
      await prisma.raw.channelCredential.create({
        data: {
          workspaceId,
          channelId: canal.id,
          phoneNumberId: numero,
          businessAccountId: `waba-${numero}`,
          tokenCipher: app.get(CryptoService).encrypt('token-ficticio'),
        },
      });
    }
    owner = await loginAs('owner@veyra.test');
    recepcao = await loginAs('member@veyra.test');
    guest = await loginAs('guest@veyra.test');
    membroBeta = await loginAs('membro-beta@veyra.test');
    paciente = await contato('Paciente Fictícia');
    await post('/api/clinics/patients', owner, { contactId: paciente }).expect(201);
    interessado = await contato('Interessado Fictício');
  });

  it('rejeitar SEM tirar o número: a ingestão grava o paciente, quem tem as chaves corrige, e a mídia segue protegida (recepção e Guest), também depois de identificada como interessado', async () => {
    const N = '5511987650001';
    await telefones(paciente, [`+${N}`]);
    await chegaImagem(N);
    const conversa = await conversaDoNumero(ws.workspaceId, `+${N}`);
    expect(conversa.contactId).toBe(paciente);
    // a ingestão gravou o contato do recebimento
    expect(
      await prisma.raw.message.findMany({
        where: { conversationId: conversa.id },
        select: { receivedContactId: true },
      }),
    ).toEqual([{ receivedContactId: paciente }]);
    expect(await coletar()).toMatchObject({ collected: 1 });
    const [arquivo] = await arquivosDa(conversa.id);
    expect(await midiaVista(recepcao, conversa.id, arquivo)).toEqual(RESTRITA);

    // a recepção continua recebendo a recusa de antes (403)
    const daRecepcao = await post(`/api/conversations/${conversa.id}/sender/reject`, recepcao, {
      removeNumber: false,
    }).expect(403);
    expect(daRecepcao.body.message).toBe('Conteúdo restrito');

    // quem tem as chaves corrige
    await post(`/api/conversations/${conversa.id}/sender/reject`, owner, {
      removeNumber: false,
    }).expect(201);
    expect(await prisma.raw.conversation.findFirst({ where: { id: conversa.id } })).toMatchObject({
      contactId: null,
      senderStatus: 'unidentified',
    });
    // a trilha: quem, de quem para quem e quantas mídias continuam protegidas
    const [linha] = await trilha(owner, 'conversation.sender_rejected');
    expect(linha).toMatchObject({
      entityId: conversa.id,
      before: { contactId: paciente },
      after: { contactId: null, protectedMedia: 1, numberRemoved: false },
    });
    expect(JSON.stringify(linha)).not.toMatch(/\.png|image\/png|5511987650001/);

    // na RAI, a recepção não a identifica como interessado (o paciente segue candidato)
    await telefones(interessado, [`+${N}`]);
    await post(`/api/conversations/${conversa.id}/sender/identify`, recepcao, {
      contactId: interessado,
    }).expect(403);
    // quem tem as chaves identifica como o interessado: a mídia do paciente NÃO abre
    await post(`/api/conversations/${conversa.id}/sender/identify`, owner, {
      contactId: interessado,
    }).expect(201);
    expect(await midiaVista(recepcao, conversa.id, arquivo)).toEqual(RESTRITA);
    await enviar('delete', `/api/files/${arquivo}`, recepcao).expect(404);
    // anexar o id em outra mensagem não é atalho
    await post(`/api/conversations/${conversa.id}/messages`, recepcao, {
      direction: 'outbound',
      body: 'segue',
      attachmentIds: [arquivo],
    }).expect(400);
    // o Guest (sem a agenda, no `uniforme`) também não
    const doGuest = await midiaVista(guest, conversa.id, arquivo);
    expect(doGuest.anexos).toEqual([[{ restricted: true }]]);
    expect(doGuest.download).toBe(404);
    // a correção não liberou nada para quem tem as chaves: segue o de sempre
    expect(await midiaVista(owner, conversa.id, arquivo)).toEqual(ABERTA);
  });

  it('rejeitar TIRANDO o número: a recepção põe o número no interessado e identifica a RAI como ele — a mídia do paciente continua restrita (o atalho do adendo 5 fechado)', async () => {
    const N = '5511987650002';
    await telefones(paciente, [`+${N}`]);
    await chegaImagem(N);
    const conversa = await conversaDoNumero(ws.workspaceId, `+${N}`);
    await coletar();
    const [arquivo] = await arquivosDa(conversa.id);

    await post(`/api/conversations/${conversa.id}/sender/reject`, owner, {
      removeNumber: true,
    }).expect(201);
    expect((await prisma.raw.contact.findFirst({ where: { id: paciente } }))?.phones).toEqual([]);
    // a recepção leva o número ao interessado e identifica: sem candidato protegido, pode
    await telefones(interessado, [`+${N}`], recepcao);
    await post(`/api/conversations/${conversa.id}/sender/identify`, recepcao, {
      contactId: interessado,
    }).expect(201);
    expect(await midiaVista(recepcao, conversa.id, arquivo)).toEqual(RESTRITA);
    // a trilha da correção
    const [linha] = await trilha(owner, 'conversation.sender_rejected');
    expect(linha.after).toMatchObject({ protectedMedia: 1, numberRemoved: true });
  });

  it('desfazer: a mídia registrada à mão na conversa do paciente (o contato gravado) segue protegida; a trilha `file.*` também', async () => {
    const N = '5511987650003';
    const outro = await contato('Outro Fictício', [`+${N}`]);
    await telefones(paciente, [`+${N}`]);
    // dois candidatos: a ingestão deixa RAI, e o Owner a identifica como o paciente
    await chegaTexto(N);
    const conversa = await conversaDoNumero(ws.workspaceId, `+${N}`);
    expect(conversa.senderStatus).toBe('unidentified');
    await post(`/api/conversations/${conversa.id}/sender/identify`, owner, {
      contactId: paciente,
    }).expect(201);
    // o registro manual de uma entrada com anexo (arquivo já verificado)
    const arquivo = (
      await request(http)
        .post('/api/files')
        .set('Origin', ORIGIN)
        .set('Cookie', owner.cookieHeader)
        .set('x-csrf-token', owner.csrf)
        .attach('file', PNG, `exame-${++seq}.png`)
        .expect(201)
    ).body.id as string;
    await prisma.raw.fileObject.updateMany({
      where: { id: arquivo },
      data: { scanStatus: 'clean' },
    });
    const registrada = await post(`/api/conversations/${conversa.id}/messages`, owner, {
      direction: 'inbound',
      body: '[image]',
      attachmentIds: [arquivo],
    }).expect(201);
    expect(
      await prisma.raw.message.findFirst({
        where: { id: registrada.body.id },
        select: { receivedContactId: true },
      }),
    ).toEqual({ receivedContactId: paciente });

    await post(`/api/conversations/${conversa.id}/sender/unidentify`, recepcao).expect(403);
    await post(`/api/conversations/${conversa.id}/sender/unidentify`, owner).expect(201);
    const [linha] = await trilha(owner, 'conversation.sender_unidentified');
    expect(linha).toMatchObject({
      before: { contactId: paciente },
      after: { contactId: null, protectedMedia: 1 },
    });
    // de novo RAI; o Owner a identifica como o outro contato
    await post(`/api/conversations/${conversa.id}/sender/identify`, owner, {
      contactId: outro,
    }).expect(201);
    expect(await midiaVista(recepcao, conversa.id, arquivo)).toEqual(RESTRITA);
    // a trilha `file.uploaded`, para quem tem a agenda e `audit:read`: o nome mascarado
    const auditor = await papel(
      ws.workspaceId,
      'Auditor com agenda',
      ['audit:read', 'clinics:schedule:read'],
      'auditor@veyra.test',
    );
    const [subida] = (await trilha(auditor, 'file.uploaded')).filter((l) => l.entityId === arquivo);
    expect(subida.after?.fileName).toBe('Conteúdo restrito');
    expect(
      (await trilha(owner, 'file.uploaded')).find((l) => l.entityId === arquivo)?.after?.fileName,
    ).toMatch(/^exame-/);
  });

  it('o download pendente: a correção vale para a mídia coletada DEPOIS, e o marcador não revela o tipo', async () => {
    const N = '5511987650004';
    await telefones(paciente, [`+${N}`]);
    await chegaImagem(N);
    const conversa = await conversaDoNumero(ws.workspaceId, `+${N}`);
    // a mídia ainda não foi coletada: a correção conta a pendente
    await post(`/api/conversations/${conversa.id}/sender/reject`, owner, {
      removeNumber: true,
    }).expect(201);
    expect((await trilha(owner, 'conversation.sender_rejected'))[0].after).toMatchObject({
      protectedMedia: 1,
    });
    await telefones(interessado, [`+${N}`], recepcao);
    await post(`/api/conversations/${conversa.id}/sender/identify`, recepcao, {
      contactId: interessado,
    }).expect(201);
    // pendente: o marcador genérico, sem o tipo
    const corpo = async (s: Session) =>
      (await get(`/api/conversations/${conversa.id}/messages`, s).expect(200)).body.items.map(
        (m: { body: string }) => m.body,
      );
    expect(await corpo(recepcao)).toEqual(['[anexo]']);
    expect(await corpo(owner)).toEqual(['[image]']);
    // coletada depois: protegida pelo contato do recebimento
    expect(await coletar()).toMatchObject({ collected: 1 });
    const [arquivo] = await arquivosDa(conversa.id);
    expect(await midiaVista(recepcao, conversa.id, arquivo)).toEqual(RESTRITA);
  });

  it('a mídia sem o contato do recebimento (RAI, ou código anterior): a correção é recusada a todos (409); NULL vale o contato atual', async () => {
    const N = '5511987650005';
    // o segundo candidato do número: a ingestão não escolhe, e a conversa nasce RAI
    await contato('Outro Fictício', [`+${N}`]);
    await telefones(paciente, [`+${N}`]);
    // a imagem chega na RAI (dois candidatos): sem o contato do recebimento
    await chegaImagem(N);
    const conversa = await conversaDoNumero(ws.workspaceId, `+${N}`);
    expect(conversa.senderStatus).toBe('unidentified');
    expect(
      (await prisma.raw.message.findFirst({ where: { conversationId: conversa.id } }))
        ?.receivedContactId,
    ).toBeNull();
    await coletar();
    const [arquivo] = await arquivosDa(conversa.id);
    await post(`/api/conversations/${conversa.id}/sender/identify`, owner, {
      contactId: paciente,
    }).expect(201);
    // NULL vale o contato atual: o paciente, restrita para a recepção
    expect(await midiaVista(recepcao, conversa.id, arquivo)).toEqual(RESTRITA);
    for (const [rota, corpo] of [
      ['unidentify', undefined],
      ['reject', { removeNumber: false }],
      ['reject', { removeNumber: true }],
    ] as const) {
      const r = await post(`/api/conversations/${conversa.id}/sender/${rota}`, owner, corpo).expect(
        409,
      );
      expect(r.body.message).toBe(MENSAGEM_MIDIA_SEM_RECEBIMENTO);
    }
    // nada mudou: o remetente, o número e o arquivo
    expect(await prisma.raw.conversation.findFirst({ where: { id: conversa.id } })).toMatchObject({
      contactId: paciente,
      senderStatus: 'identified',
    });
    expect((await prisma.raw.contact.findFirst({ where: { id: paciente } }))?.phones).toEqual([
      `+${N}`,
    ]);
    expect(await prisma.raw.fileObject.count({ where: { id: arquivo } })).toBe(1);
    expect(await midiaVista(owner, conversa.id, arquivo)).toEqual(ABERTA);
  });

  it('a mensagem antiga: o preenchimento da migration grava o contato atual, e então a correção é possível e a mídia segue protegida', async () => {
    // a conversa e a mensagem como o código anterior as deixou: sem o contato gravado
    const canal = (await prisma.raw.channel.findFirst({ where: { workspaceId: ws.workspaceId } }))!;
    const N = '+5511987650006';
    await telefones(paciente, [N]);
    const conversa = await prisma.raw.conversation.create({
      data: {
        workspaceId: ws.workspaceId,
        channelId: canal.id,
        contactId: paciente,
        externalAddress: N,
        senderStatus: 'identified',
      },
    });
    const msg = await prisma.raw.message.create({
      data: {
        workspaceId: ws.workspaceId,
        conversationId: conversa.id,
        channelId: canal.id,
        direction: 'inbound',
        authorType: 'contact',
        body: '[image]',
      },
    });
    const arquivo = (
      await request(http)
        .post('/api/files')
        .set('Origin', ORIGIN)
        .set('Cookie', owner.cookieHeader)
        .set('x-csrf-token', owner.csrf)
        .attach('file', PNG, `antigo-${++seq}.png`)
        .expect(201)
    ).body.id as string;
    await prisma.raw.messageAttachment.create({
      data: { workspaceId: ws.workspaceId, messageId: msg.id, fileObjectId: arquivo },
    });
    // antes do preenchimento: NULL, a correção recusada
    await post(`/api/conversations/${conversa.id}/sender/reject`, owner, {
      removeNumber: false,
    }).expect(409);

    // o preenchimento: o UPDATE da própria migration, rodado no banco de teste
    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261105090100_message_received_contact_backfill/migration.sql',
      ),
      'utf8',
    );
    const update = /UPDATE "Message"[\s\S]*?;/.exec(sql)?.[0];
    expect(update).toBeDefined();
    await prisma.raw.$executeRawUnsafe(update as string);
    expect((await prisma.raw.message.findFirst({ where: { id: msg.id } }))?.receivedContactId).toBe(
      paciente,
    );

    await post(`/api/conversations/${conversa.id}/sender/reject`, owner, {
      removeNumber: true,
    }).expect(201);
    await post(`/api/conversations/${conversa.id}/sender/identify`, owner, {
      newContact: { name: 'Contato Novo Fictício' },
    }).expect(201);
    expect(await midiaVista(recepcao, conversa.id, arquivo)).toEqual(RESTRITA);
    expect((await midiaVista(owner, conversa.id, arquivo)).download).toBe(200);
  });

  it('quem não lê todo o conteúdo protegido: 403 uniforme sem a agenda (igual para paciente e interessado); a ramificação de 409 continua para quem não tem as duas chaves', async () => {
    const operador = await papel(
      ws.workspaceId,
      'Sem agenda',
      [
        'contacts:read',
        'contacts:write',
        'conversations:read',
        'conversations:write',
        'audit:read',
      ],
      'sem-agenda@veyra.test',
    );
    const respostas: [number, string][] = [];
    for (const [pessoa, N] of [
      [paciente, '5511987650007'],
      [interessado, '5511987650008'],
    ] as const) {
      await telefones(pessoa, [`+${N}`]);
      await chegaImagem(N);
      const conversa = await conversaDoNumero(ws.workspaceId, `+${N}`);
      const r = await post(`/api/conversations/${conversa.id}/sender/reject`, operador, {
        removeNumber: false,
      });
      respostas.push([r.status, r.body.message]);
    }
    expect(respostas).toEqual([
      [403, 'Conteúdo restrito'],
      [403, 'Conteúdo restrito'],
    ]);

    // a ramificação defensiva: com mais de uma extensão, quem não tem as chaves
    // de TODAS chegaria aqui; simulada com o Owner fora do `livre`
    const conversa = await conversaDoNumero(ws.workspaceId, '+5511987650007');
    jest.spyOn(app.get(ProtectedContentService), 'liberaTudo').mockResolvedValue(false);
    const r = await post(`/api/conversations/${conversa.id}/sender/reject`, owner, {
      removeNumber: false,
    }).expect(409);
    expect(r.body.message).toBe(MENSAGEM_MIDIA_PROTEGIDA);
    jest.restoreAllMocks();

    // a trilha da correção feita pelo Owner, lida sem a agenda: a contagem tapada
    await post(`/api/conversations/${conversa.id}/sender/reject`, owner, {
      removeNumber: false,
    }).expect(201);
    const doInteressado = await conversaDoNumero(ws.workspaceId, '+5511987650008');
    await post(`/api/conversations/${doInteressado.id}/sender/reject`, owner, {
      removeNumber: false,
    }).expect(201);
    const linhas = await trilha(operador, 'conversation.sender_rejected');
    expect(linhas.map((l) => l.after?.protectedMedia)).toEqual([
      'Conteúdo restrito',
      'Conteúdo restrito',
    ]);
    expect(
      (await trilha(owner, 'conversation.sender_rejected'))
        .map((l) => l.after?.protectedMedia)
        .sort(),
    ).toEqual([0, 1]);
  });

  it('a repetição do registro (mesma chave) depois da correção: o anexo sai restrito pelo contato do recebimento, sem registrar de novo', async () => {
    const N = '5511987650009';
    await telefones(paciente, [`+${N}`]);
    await chegaTexto(N);
    const conversa = await conversaDoNumero(ws.workspaceId, `+${N}`);
    const arquivo = (
      await request(http)
        .post('/api/files')
        .set('Origin', ORIGIN)
        .set('Cookie', recepcao.cookieHeader)
        .set('x-csrf-token', recepcao.csrf)
        .attach('file', PNG, `recepcao-${++seq}.png`)
        .expect(201)
    ).body.id as string;
    await prisma.raw.fileObject.updateMany({
      where: { id: arquivo },
      data: { scanStatus: 'clean' },
    });
    const corpo = { direction: 'inbound', body: '[image]', attachmentIds: [arquivo] };
    const chave = { 'Idempotency-Key': 'k-correcao' };
    const primeira = await enviar(
      'post',
      `/api/conversations/${conversa.id}/messages`,
      recepcao,
      corpo,
      chave,
    ).expect(201);
    expect(primeira.body.attachments).toEqual([{ restricted: true }]);
    await post(`/api/conversations/${conversa.id}/sender/reject`, owner, {
      removeNumber: true,
    }).expect(201);
    await post(`/api/conversations/${conversa.id}/sender/identify`, owner, {
      newContact: { name: 'Contato Novo Fictício' },
    }).expect(201);
    const repetida = await enviar(
      'post',
      `/api/conversations/${conversa.id}/messages`,
      recepcao,
      corpo,
      chave,
    ).expect(201);
    expect(repetida.headers['idempotent-replay']).toBe('true');
    expect(repetida.body).toMatchObject({ body: '[anexo]', attachments: [{ restricted: true }] });
    expect(
      await prisma.raw.message.count({
        where: { conversationId: conversa.id, attachments: { some: {} } },
      }),
    ).toBe(1);
  });

  it('o registro de mensagem prende a conversa ANTES de gravar: a correção que comitou primeiro faz o registro ser recusado, sem efeito', async () => {
    const N = '5511987650010';
    await telefones(interessado, [`+${N}`]);
    await chegaTexto(N);
    const conversa = await conversaDoNumero(ws.workspaceId, `+${N}`);
    const trava = new Client({ connectionString: TEST_DATABASE_URL });
    await trava.connect();
    let pedido: Promise<request.Response> | null = null;
    try {
      await trava.query('BEGIN');
      await trava.query(
        `SELECT 1 FROM "Conversation" WHERE "workspaceId" = $1 AND "id" = $2 FOR UPDATE`,
        [ws.workspaceId, conversa.id],
      );
      pedido = post(`/api/conversations/${conversa.id}/messages`, owner, {
        direction: 'inbound',
        body: 'chegou agora',
      }).then((r) => r);
      await esperarBloqueadosPor(trava, 1, { descricao: 'o registro da mensagem' });
      // o que a correção comitaria primeiro: a conversa volta à RAI
      await trava.query(
        `UPDATE "Conversation" SET "contactId" = NULL, "senderStatus" = 'unidentified'
          WHERE "workspaceId" = $1 AND "id" = $2`,
        [ws.workspaceId, conversa.id],
      );
      await trava.query('COMMIT');
      const r = await pedido;
      expect(r.status).toBe(409);
      expect(r.body.message).toMatch(/A conversa acabou de mudar/);
    } finally {
      await trava.query('ROLLBACK').catch(() => undefined);
      await trava.end();
      await pedido?.catch(() => undefined);
    }
    expect(
      await prisma.raw.message.count({
        where: { conversationId: conversa.id, body: 'chegou agora' },
      }),
    ).toBe(0);
  });

  it('o contato do recebimento que não resolve (excluído, ou de outro workspace) vai na dúvida; o workspace sem o Clinics fica como sempre', async () => {
    const canal = (await prisma.raw.channel.findFirst({ where: { workspaceId: ws.workspaceId } }))!;
    const conversaCom = async (
      workspaceId: string,
      channelId: string,
      contactId: string,
      receivedContactId: string,
      s: Session,
    ) => {
      const conversa = await prisma.raw.conversation.create({
        data: { workspaceId, channelId, contactId, senderStatus: 'identified' },
      });
      const msg = await prisma.raw.message.create({
        data: {
          workspaceId,
          conversationId: conversa.id,
          channelId,
          direction: 'inbound',
          authorType: 'contact',
          body: '[image]',
          receivedContactId,
        },
      });
      const arquivo = (
        await request(http)
          .post('/api/files')
          .set('Origin', ORIGIN)
          .set('Cookie', s.cookieHeader)
          .set('x-csrf-token', s.csrf)
          .attach('file', PNG, `f-${++seq}.png`)
          .expect(201)
      ).body.id as string;
      await prisma.raw.messageAttachment.create({
        data: { workspaceId, messageId: msg.id, fileObjectId: arquivo },
      });
      return { conversa: conversa.id, arquivo };
    };
    // recebida por um interessado, hoje com outro: aberta; excluído o contato do
    // recebimento, a dúvida a protege para a recepção (o Owner segue lendo)
    const antigo = await contato('Antigo Fictício');
    const x = await conversaCom(ws.workspaceId, canal.id, interessado, antigo, owner);
    expect(await midiaVista(recepcao, x.conversa, x.arquivo)).toEqual(ABERTA);
    await enviar('delete', `/api/contacts/${antigo}`, owner).expect(200);
    expect(await midiaVista(recepcao, x.conversa, x.arquivo)).toEqual(RESTRITA);
    expect(await midiaVista(owner, x.conversa, x.arquivo)).toEqual(ABERTA);

    // isolamento: o id gravado de um contato de OUTRO workspace não resolve aqui
    const deBeta = await contato('Contato de Beta', [], membroBeta);
    const y = await conversaCom(ws.workspaceId, canal.id, interessado, deBeta, owner);
    expect(await midiaVista(recepcao, y.conversa, y.arquivo)).toEqual(RESTRITA);

    // o workspace sem o Clinics: a correção com mídia segue como sempre, e o
    // id de um paciente de outro workspace gravado ali não protege nada
    const canalBeta = (await prisma.raw.channel.findFirst({
      where: { workspaceId: beta.workspaceId },
    }))!;
    const z = await conversaCom(beta.workspaceId, canalBeta.id, deBeta, paciente, membroBeta);
    expect(await midiaVista(membroBeta, z.conversa, z.arquivo)).toEqual(ABERTA);
    const N = '5511987650011';
    await telefones(deBeta, [`+${N}`], membroBeta);
    await chegaImagem(N, NUMERO_B);
    const doBeta = await conversaDoNumero(beta.workspaceId, `+${N}`);
    expect(
      (await prisma.raw.message.findFirst({ where: { conversationId: doBeta.id } }))
        ?.receivedContactId,
    ).toBe(deBeta);
    await coletar();
    const [arquivoBeta] = await arquivosDa(doBeta.id);
    await post(`/api/conversations/${doBeta.id}/sender/reject`, membroBeta, {
      removeNumber: true,
    }).expect(201);
    await post(`/api/conversations/${doBeta.id}/sender/identify`, membroBeta, {
      newContact: { name: 'Novo de Beta' },
    }).expect(201);
    expect(await midiaVista(membroBeta, doBeta.id, arquivoBeta)).toEqual(ABERTA);
    const linha = (
      await prisma.raw.auditLog.findFirst({
        where: { workspaceId: beta.workspaceId, action: 'conversation.sender_rejected' },
      })
    )?.after as Record<string, unknown>;
    expect(linha.protectedMedia).toBe(0);
  });
});
