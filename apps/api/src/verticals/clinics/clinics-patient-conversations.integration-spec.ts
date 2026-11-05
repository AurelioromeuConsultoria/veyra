import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CLINICS_RECEPTION_CARE_SYSTEM_KEY } from '@veyra/contracts/verticals/clinics';
import { PrismaService } from '../../prisma/prisma.service';
import { createTestApp } from '../../../test/integration/app';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../test/integration/fixtures';
import { resetDb } from '../../../test/integration/harness';
import { ClinicsActivationService } from './clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const RESTRITO = 'Conteúdo restrito';

/**
 * O texto de uma conversa de paciente e o de um interessado (FICTÍCIOS), com
 * a MESMA forma: um assunto, uma saída, uma entrada, a mídia recebida (o
 * marcador do tipo) e uma saída por template com o despacho cancelado.
 */
const DO_PACIENTE = {
  subject: 'Retorno da toxina',
  saida: 'Confirmando seu retorno amanhã às 10h',
  entrada: 'Estou com inchaço depois da aplicação',
  // o corpo neutro da origem do vertical (F4.2) e o cancelamento dela
  template: 'Mensagem por template',
  erro: 'origin_invalidated',
};
const DO_INTERESSADO = {
  subject: 'Orçamento de pacotes',
  saida: 'Segue o orçamento dos pacotes',
  entrada: 'Quanto custa a avaliação?',
  template: 'Olá! Temos horários nesta semana.',
  erro: 'stop_requested',
};
type Texto = typeof DO_PACIENTE;
const CLINICO = /toxina|retorno|inchaço|aplicação|Mensagem por template|origin_invalidated/i;

interface Session {
  cookieHeader: string;
  csrf: string;
}

/**
 * B1, o texto das conversas sob o E8 (ADR-061, adendo 9, item 8). Antes, quem
 * lê conversas e NÃO tem `clinics:schedule:read` (o Guest padrão, um papel
 * personalizado) distinguia o paciente do interessado pelo texto: o assunto,
 * o corpo das mensagens (a confirmação com data e hora, o que o paciente
 * escreveu, o corpo neutro da origem do vertical), o código do despacho
 * cancelado e o assunto na notificação de atribuição. Agora:
 * - `uniforme` (sem a agenda clínica): o texto de TODA conversa com pessoa ou
 *   a identificar sai como "Conteúdo restrito", e as escritas de texto nelas
 *   são recusadas, igual para todo contato;
 * - `restrito` (a recepção) e `livre`: o texto de sempre, e nada que a
 *   recepção fazia é recusado.
 * Dados FICTÍCIOS.
 */
describe('Clinics — o texto das conversas sob o E8 (integração, ADR-061 adendo 9, item 8)', () => {
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

  let ws: WorkspaceFixture;
  let owner: Session;
  let recepcao: Session;
  let combinado: Session;
  let membershipRecepcao: string;
  let membershipCombinado: string;
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
    metodo: 'post' | 'patch',
    path: string,
    s: Session,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const r = request(http)
      [metodo](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return body === undefined ? r : r.send(body as object);
  };
  const post = (path: string, s: Session, body?: unknown, headers?: Record<string, string>) =>
    enviar('post', path, s, body, headers);
  const patch = (path: string, s: Session, body: unknown) => enviar('patch', path, s, body);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);
  const contato = async (name: string, s = owner) =>
    (await post('/api/contacts', s, { name }).expect(201)).body.id as string;

  const membro = async (workspaceId: string, email: string, roleId: string) => {
    const membership = await createMembershipFixture(
      prisma,
      workspaceId,
      await createUserFixture(prisma, email),
      roleId,
    );
    return { membership, sessao: await loginAs(email) };
  };
  /** um papel PERSONALIZADO só com chaves do Core, sem a agenda clínica */
  const SEM_AGENDA = [
    'workspace:read',
    'contacts:read',
    'contacts:write',
    'conversations:read',
    'conversations:write',
    'consents:read',
  ];
  const papel = async (workspaceId: string, nome: string, chaves: readonly string[]) => {
    const role = await prisma.raw.role.create({
      data: { workspaceId, name: nome, isSystem: false },
    });
    await prisma.raw.rolePermission.createMany({
      data: chaves.map((permissionKey) => ({ workspaceId, roleId: role.id, permissionKey })),
    });
    return role.id;
  };

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    ws = await createWorkspaceFixture(prisma, 'acme');
    await createMembershipFixture(
      prisma,
      ws.workspaceId,
      await createUserFixture(prisma, 'owner@veyra.test'),
      ws.roles.owner,
    );
    membershipRecepcao = await createMembershipFixture(
      prisma,
      ws.workspaceId,
      await createUserFixture(prisma, 'member@veyra.test'),
      ws.roles.member,
    );
    await app.get(ClinicsActivationService).enable('acme');
    const papelCombinado = (await prisma.raw.role.findFirst({
      where: { workspaceId: ws.workspaceId, systemKey: CLINICS_RECEPTION_CARE_SYSTEM_KEY },
    }))!.id;
    membershipCombinado = await createMembershipFixture(
      prisma,
      ws.workspaceId,
      await createUserFixture(prisma, 'combinado@veyra.test'),
      papelCombinado,
    );
    owner = await loginAs('owner@veyra.test');
    recepcao = await loginAs('member@veyra.test');
    combinado = await loginAs('combinado@veyra.test');
    paciente = await contato('Paciente Fictícia');
    await post('/api/clinics/patients', owner, { contactId: paciente }).expect(201);
    interessado = await contato('Interessado Fictício');
  });

  /**
   * A conversa da pessoa, escrita pelo Owner pelas rotas reais (o assunto, a
   * saída, a entrada e a mídia recebida), mais a saída por template com o
   * despacho cancelado, que só a origem do envio grava (pelo banco).
   */
  const conversaDa = async (contactId: string | null, t: Texto, workspaceId = ws.workspaceId) => {
    const id = (
      await post('/api/conversations', owner, {
        ...(contactId ? { contactId } : {}),
        subject: t.subject,
      }).expect(201)
    ).body.id as string;
    await post(`/api/conversations/${id}/messages`, owner, {
      direction: 'outbound',
      body: t.saida,
    }).expect(201);
    if (contactId) {
      await post(`/api/conversations/${id}/messages`, owner, {
        direction: 'inbound',
        body: t.entrada,
      }).expect(201);
      await post(`/api/conversations/${id}/messages`, owner, {
        direction: 'inbound',
        body: '[image]',
      }).expect(201);
    }
    const canal = (await prisma.raw.conversation.findFirst({ where: { id } }))!.channelId;
    const msg = await prisma.raw.message.create({
      data: {
        workspaceId,
        conversationId: id,
        channelId: canal,
        direction: 'outbound',
        authorType: 'system',
        body: t.template,
      },
    });
    await prisma.raw.messageDispatch.create({
      data: { workspaceId, messageId: msg.id, state: 'canceled', errorCode: t.erro },
    });
    return id;
  };

  /** uma conversa a identificar (RAI), com uma entrada */
  const rai = async (body: string) => {
    const canal = (await prisma.raw.channel.findFirst({
      where: { workspaceId: ws.workspaceId, systemMark: true },
    }))!.id;
    const conversa = await prisma.raw.conversation.create({
      data: {
        workspaceId: ws.workspaceId,
        channelId: canal,
        senderStatus: 'unidentified',
        externalAddress: `+55119999${String(++seq).padStart(5, '0')}`,
      },
    });
    await prisma.raw.message.create({
      data: {
        workspaceId: ws.workspaceId,
        conversationId: conversa.id,
        channelId: canal,
        direction: 'inbound',
        authorType: 'contact',
        body,
      },
    });
    return conversa.id;
  };

  /**
   * O que a sessão LÊ da conversa, por todos os caminhos: a lista, a conversa
   * e as mensagens. Sem ids, nomes e datas (que diferem por construção e não
   * são o sinal); com a forma, o estado, o assunto e o corpo.
   */
  const leitura = async (s: Session, conversa: string) => {
    const projetar = (c: Record<string, unknown>) => ({
      subject: c.subject,
      status: c.status,
      channelType: c.channelType,
      senderStatus: c.senderStatus,
      textRestricted: c.textRestricted,
    });
    const lista = (await get('/api/conversations?status=all&limit=100', s).expect(200)).body
      .items as Record<string, unknown>[];
    const msgs = (await get(`/api/conversations/${conversa}/messages`, s).expect(200)).body
      .items as Record<string, unknown>[];
    return {
      naLista: lista.filter((c) => c.id === conversa).map(projetar),
      porId: projetar((await get(`/api/conversations/${conversa}`, s).expect(200)).body),
      mensagens: msgs.map((m) => ({
        direction: m.direction,
        authorType: m.authorType,
        body: m.body,
        attachments: m.attachments,
        dispatchState: m.dispatchState,
        dispatchError: m.dispatchError,
        textRestricted: m.textRestricted,
      })),
    };
  };

  /** os assuntos das atribuições na caixa da sessão */
  const atribuicoes = async (s: Session) =>
    (
      (await get('/api/notifications', s).expect(200)).body.items as {
        type: string;
        payload: { subject: string };
      }[]
    )
      .filter((n) => n.type === 'conversation_assigned')
      .map((n) => n.payload.subject);

  it('uniforme: o Guest e o papel sem a agenda clínica não distinguem o paciente pelo texto da conversa', async () => {
    const guest = await membro(ws.workspaceId, 'guest@veyra.test', ws.roles.guest);
    const personalizado = await membro(
      ws.workspaceId,
      'conversas-crm@veyra.test',
      await papel(ws.workspaceId, 'Conversas do CRM', SEM_AGENDA),
    );
    const cP = await conversaDa(paciente, DO_PACIENTE);
    const cI = await conversaDa(interessado, DO_INTERESSADO);
    // a atribuição avisa quem recebe, com o assunto gravado no envio
    for (const c of [cP, cI]) {
      await patch(`/api/conversations/${c}`, owner, {
        assigneeMembershipId: guest.membership,
      }).expect(200);
    }

    for (const s of [guest.sessao, personalizado.sessao]) {
      const lidoP = await leitura(s, cP);
      // o sinal: o texto da conversa do paciente não sai por nenhum caminho
      expect(JSON.stringify(lidoP)).not.toMatch(CLINICO);
      // a mesma resposta para o paciente e para o interessado
      expect(lidoP).toEqual(await leitura(s, cI));
      // e o que é igual é o texto mascarado, com a estrutura de sempre
      const conversa = {
        subject: RESTRITO,
        status: 'open',
        channelType: 'internal',
        senderStatus: 'identified',
        textRestricted: true,
      };
      expect(lidoP.naLista).toEqual([conversa]);
      expect(lidoP.porId).toEqual(conversa);
      const mensagem = (direction: string, authorType: string, dispatchState: string | null) => ({
        direction,
        authorType,
        body: RESTRITO,
        attachments: [],
        dispatchState,
        dispatchError: null,
        textRestricted: true,
      });
      expect(lidoP.mensagens).toEqual([
        mensagem('outbound', 'system', 'canceled'),
        mensagem('inbound', 'contact', null),
        mensagem('inbound', 'contact', null),
        mensagem('outbound', 'user', null),
      ]);
    }
    // a notificação de quem recebe a conversa: o assunto mascarado, nas duas
    expect(await atribuicoes(guest.sessao)).toEqual([RESTRITO, RESTRITO]);

    // a RAI também (o papel personalizado a vê: tem `contacts:write`)
    const r = await rai('Oi, é da clínica? Quero remarcar a aplicação');
    const lidoRai = await leitura(personalizado.sessao, r);
    expect(JSON.stringify(lidoRai)).not.toMatch(CLINICO);
    expect(lidoRai.porId).toMatchObject({ subject: RESTRITO, textRestricted: true });
    expect(lidoRai.mensagens).toEqual([
      expect.objectContaining({ body: RESTRITO, textRestricted: true }),
    ]);

    // a conversa SEM pessoa segue como sempre
    const semPessoa = await conversaDa(null, { ...DO_INTERESSADO, subject: 'Reunião interna' });
    const lidoSem = await leitura(guest.sessao, semPessoa);
    expect(lidoSem.porId).toMatchObject({ subject: 'Reunião interna' });
    expect(lidoSem.porId.textRestricted).toBeUndefined();
    expect(lidoSem.mensagens.map((m) => m.body)).toEqual([
      DO_INTERESSADO.template,
      DO_INTERESSADO.saida,
    ]);
    expect(lidoSem.mensagens[0].dispatchError).toBe(DO_INTERESSADO.erro);
  });

  it('uniforme: as escritas de texto numa conversa com pessoa são recusadas iguais; a estrutura e o que não tem pessoa, como sempre', async () => {
    const { sessao: operador } = await membro(
      ws.workspaceId,
      'conversas-crm@veyra.test',
      await papel(ws.workspaceId, 'Conversas do CRM', SEM_AGENDA),
    );
    const cP = await conversaDa(paciente, DO_PACIENTE);
    const cI = await conversaDa(interessado, DO_INTERESSADO);
    const antes = await prisma.raw.message.count({ where: { workspaceId: ws.workspaceId } });
    const r = (x: { status: number; body: { message?: unknown } }) => [x.status, x.body.message];

    const escritas = async (conversa: string, contactId: string) => ({
      saida: r(
        await post(`/api/conversations/${conversa}/messages`, operador, {
          direction: 'outbound',
          body: 'Bom dia!',
        }),
      ),
      entrada: r(
        await post(`/api/conversations/${conversa}/messages`, operador, {
          direction: 'inbound',
          body: 'Bom dia!',
        }),
      ),
      assunto: r(await patch(`/api/conversations/${conversa}`, operador, { subject: 'Novo' })),
      limparAssunto: r(await patch(`/api/conversations/${conversa}`, operador, { subject: null })),
      criar: r(await post('/api/conversations', operador, { contactId, subject: 'Oi' })),
      criarSemAssunto: r(await post('/api/conversations', operador, { contactId })),
      politica: (await get(`/api/conversations/${conversa}/send-policy`, operador).expect(200))
        .body,
      previa: r(
        await post('/api/business-outbound/preview', operador, {
          items: [
            {
              originRef: `conversation:${conversa}`,
              channelId: (await prisma.raw.conversation.findFirst({ where: { id: conversa } }))!
                .channelId,
              contactId,
              number: '+5511999990001',
              templateVersionId: '00000000-0000-4000-8000-000000000001',
              purposeId: '00000000-0000-4000-8000-000000000002',
            },
          ],
        }),
      ),
    });
    const doPaciente = await escritas(cP, paciente);
    expect(doPaciente).toEqual(await escritas(cI, interessado));
    expect(doPaciente).toEqual({
      saida: [403, RESTRITO],
      entrada: [403, RESTRITO],
      assunto: [403, RESTRITO],
      limparAssunto: [403, RESTRITO],
      criar: [403, RESTRITO],
      criarSemAssunto: [403, RESTRITO],
      politica: {
        channelType: 'internal',
        mode: 'blocked',
        reason: RESTRITO,
        windowExpiresAt: null,
        consentStatus: null,
        templates: [],
      },
      previa: [403, RESTRITO],
    });
    // nada foi escrito
    expect(await prisma.raw.message.count({ where: { workspaceId: ws.workspaceId } })).toBe(antes);
    expect((await prisma.raw.conversation.findFirst({ where: { id: cP } }))!.subject).toBe(
      DO_PACIENTE.subject,
    );

    // a estrutura (estado e responsável) segue editável, igual para os dois
    for (const c of [cP, cI]) {
      const feito = await patch(`/api/conversations/${c}`, operador, { status: 'pending' }).expect(
        200,
      );
      expect(feito.body).toMatchObject({ status: 'pending', subject: RESTRITO });
    }

    // sem pessoa: escreve como sempre
    const semPessoa = (
      await post('/api/conversations', operador, { subject: 'Reunião interna' }).expect(201)
    ).body;
    expect(semPessoa).toMatchObject({ subject: 'Reunião interna' });
    expect(semPessoa.textRestricted).toBeUndefined();
    const registrada = await post(`/api/conversations/${semPessoa.id}/messages`, operador, {
      direction: 'outbound',
      body: 'Pauta da semana',
    }).expect(201);
    expect(registrada.body).toMatchObject({ body: 'Pauta da semana' });
    await patch(`/api/conversations/${semPessoa.id}`, operador, { subject: 'Pauta' }).expect(200);
  });

  it('restrito, a recepção, e livre, "Recepção e atendimento" e o Owner: o texto de sempre, sem marca, e nada do que escreviam é recusado', async () => {
    const cP = await conversaDa(paciente, DO_PACIENTE);
    const cI = await conversaDa(interessado, DO_INTERESSADO);
    for (const s of [recepcao, combinado, owner]) {
      for (const [c, t] of [
        [cP, DO_PACIENTE],
        [cI, DO_INTERESSADO],
      ] as const) {
        const lido = await leitura(s, c);
        expect(lido.porId).toMatchObject({ subject: t.subject });
        expect(lido.porId.textRestricted).toBeUndefined();
        expect(lido.mensagens.map((m) => m.body)).toEqual([
          t.template,
          // o marcador do tipo da mídia é a regra da mídia (adendo 6): no
          // `restrito`, o paciente sai genérico; no livre e no interessado, o tipo
          s === recepcao && c === cP ? '[anexo]' : '[image]',
          t.entrada,
          t.saida,
        ]);
        expect(lido.mensagens[0].dispatchError).toBe(t.erro);
        expect(lido.mensagens.every((m) => m.textRestricted === undefined)).toBe(true);
      }
    }

    // as escritas da recepção e do papel combinado na conversa do paciente
    for (const [s, membership] of [
      [recepcao, membershipRecepcao],
      [combinado, membershipCombinado],
    ] as const) {
      const saida = await post(`/api/conversations/${cP}/messages`, s, {
        direction: 'outbound',
        body: 'Confirmado para amanhã às 10h',
      }).expect(201);
      expect(saida.body.body).toBe('Confirmado para amanhã às 10h');
      await post(`/api/conversations/${cP}/messages`, s, {
        direction: 'inbound',
        body: 'Obrigada, estarei lá',
      }).expect(201);
      const assunto = await patch(`/api/conversations/${cP}`, s, {
        subject: 'Retorno confirmado',
        assigneeMembershipId: membership,
        status: 'pending',
      }).expect(200);
      expect(assunto.body).toMatchObject({ subject: 'Retorno confirmado', status: 'pending' });
      const nova = await post('/api/conversations', s, {
        contactId: paciente,
        subject: 'Pós-procedimento',
      }).expect(201);
      expect(nova.body).toMatchObject({ subject: 'Pós-procedimento' });
      expect(nova.body.textRestricted).toBeUndefined();
      // a conversa nova fecha, para a próxima sessão abrir outra
      await patch(`/api/conversations/${nova.body.id}`, s, { status: 'closed' }).expect(200);
      const politica = (await get(`/api/conversations/${cP}/send-policy`, s).expect(200)).body;
      expect(politica).toMatchObject({ mode: 'free_form', reason: null });
    }
    // a atribuição feita pelo Owner chega com o assunto à recepção
    await patch(`/api/conversations/${cP}`, owner, {
      assigneeMembershipId: membershipRecepcao,
    }).expect(200);
    expect(await atribuicoes(recepcao)).toEqual(['Retorno confirmado']);
  });

  it('a repetição com a mesma chave dá a resposta de um pedido novo: 403 no uniforme, o corpo de sempre no restrito', async () => {
    // um papel com a agenda clínica, que depois a perde
    const roleId = await papel(ws.workspaceId, 'Conversas e agenda', [
      ...SEM_AGENDA,
      'clinics:schedule:read',
    ]);
    const { sessao: comAgenda } = await membro(ws.workspaceId, 'gestor@veyra.test', roleId);
    const cP = await conversaDa(paciente, DO_PACIENTE);
    const cI = await conversaDa(interessado, DO_INTERESSADO);
    const semPessoa = (
      await post('/api/conversations', owner, { subject: 'Reunião interna' }).expect(201)
    ).body.id as string;
    const registrar = (s: Session, c: string, chave?: string) =>
      post(
        `/api/conversations/${c}/messages`,
        s,
        { direction: 'outbound', body: 'Até amanhã às 10h' },
        chave ? { 'Idempotency-Key': chave } : {},
      );
    const criar = (s: Session, contactId: string, chave?: string) =>
      post(
        '/api/conversations',
        s,
        { contactId, subject: 'Avaliação' },
        chave ? { 'Idempotency-Key': chave } : {},
      );
    // o prazo FIXO: a mesma chave com outro corpo seria 409
    const prazo = new Date(Date.now() + 60 * 60_000).toISOString();
    const aprovar = (s: Session, c: string, contactId: string, chave: string) =>
      post(
        '/api/business-outbound',
        s,
        {
          items: [
            {
              originRef: `conversation:${c}`,
              channelId: '00000000-0000-4000-8000-000000000003',
              contactId,
              number: '+5511999990001',
              templateVersionId: '00000000-0000-4000-8000-000000000001',
              purposeId: '00000000-0000-4000-8000-000000000002',
              expiresAt: prazo,
              approvalHash: 'a'.repeat(64),
            },
          ],
        },
        { 'Idempotency-Key': chave },
      );
    await registrar(comAgenda, cP, 'm-p').expect(201);
    await registrar(comAgenda, cI, 'm-i').expect(201);
    await registrar(comAgenda, semPessoa, 'm-sem').expect(201);
    await criar(comAgenda, paciente, 'c-p').expect(201);
    await criar(comAgenda, interessado, 'c-i').expect(201);
    // a aprovação com um alvo inválido: 200 com o item recusado, guardado
    await aprovar(comAgenda, cP, paciente, 'a-p').expect(200);
    await aprovar(comAgenda, cI, interessado, 'a-i').expect(200);

    // a recepção (restrito): a repetição devolve o corpo de sempre
    const daRecepcao = await registrar(recepcao, cP, 'm-recepcao').expect(201);
    const repetida = await registrar(recepcao, cP, 'm-recepcao').expect(201);
    expect(repetida.body).toEqual(daRecepcao.body);
    expect(repetida.body.body).toBe('Até amanhã às 10h');

    await prisma.raw.rolePermission.deleteMany({
      where: { roleId, permissionKey: 'clinics:schedule:read' },
    });
    const semAgenda = await loginAs('gestor@veyra.test');
    const mensagens = await prisma.raw.message.count({ where: { workspaceId: ws.workspaceId } });
    const conversas = await prisma.raw.conversation.count({
      where: { workspaceId: ws.workspaceId },
    });
    const resposta = (x: { status: number; body: { message?: unknown } }) => [
      x.status,
      x.body.message,
    ];
    // o pedido novo para uma pessoa: 403; a repetição, a mesma resposta
    const novo = resposta(await registrar(semAgenda, cI));
    expect(novo).toEqual([403, RESTRITO]);
    expect(resposta(await registrar(semAgenda, cP, 'm-p'))).toEqual(novo);
    expect(resposta(await registrar(semAgenda, cI, 'm-i'))).toEqual(novo);
    expect(resposta(await criar(semAgenda, interessado))).toEqual(novo);
    expect(resposta(await criar(semAgenda, paciente, 'c-p'))).toEqual(novo);
    expect(resposta(await criar(semAgenda, interessado, 'c-i'))).toEqual(novo);
    expect(resposta(await aprovar(semAgenda, cI, interessado, 'a-novo'))).toEqual(novo);
    expect(resposta(await aprovar(semAgenda, cP, paciente, 'a-p'))).toEqual(novo);
    expect(resposta(await aprovar(semAgenda, cI, interessado, 'a-i'))).toEqual(novo);
    // o que não tem pessoa: o corpo guardado, como um pedido novo também registraria
    const semPessoaRepetida = await registrar(semAgenda, semPessoa, 'm-sem').expect(201);
    expect(semPessoaRepetida.body.body).toBe('Até amanhã às 10h');
    expect(semPessoaRepetida.body.textRestricted).toBeUndefined();
    // nada executou de novo
    expect(await prisma.raw.message.count({ where: { workspaceId: ws.workspaceId } })).toBe(
      mensagens,
    );
    expect(await prisma.raw.conversation.count({ where: { workspaceId: ws.workspaceId } })).toBe(
      conversas,
    );
  });

  it('a desativação mantém a proteção: o Owner também fica no uniforme', async () => {
    const cP = await conversaDa(paciente, DO_PACIENTE);
    const cI = await conversaDa(interessado, DO_INTERESSADO);
    await app.get(ClinicsActivationService).disable('acme');
    owner = await loginAs('owner@veyra.test');
    const lidoP = await leitura(owner, cP);
    expect(JSON.stringify(lidoP)).not.toMatch(CLINICO);
    expect(lidoP).toEqual(await leitura(owner, cI));
    await post(`/api/conversations/${cI}/messages`, owner, {
      direction: 'outbound',
      body: 'Oi',
    }).expect(403);
  });

  it('num workspace que nunca ativou o Clinics, o Guest e o mesmo papel leem e escrevem como sempre', async () => {
    const beta = await createWorkspaceFixture(prisma, 'beta');
    const { sessao: operador } = await membro(
      beta.workspaceId,
      'conversas-beta@veyra.test',
      await papel(beta.workspaceId, 'Conversas do CRM', SEM_AGENDA),
    );
    const { sessao: guest } = await membro(
      beta.workspaceId,
      'guest-beta@veyra.test',
      beta.roles.guest,
    );
    const c = await contato('Contato do Core', operador);
    const conversa = (
      await post('/api/conversations', operador, { contactId: c, subject: 'Orçamento' }).expect(201)
    ).body;
    expect(conversa).toMatchObject({ subject: 'Orçamento' });
    expect(conversa.textRestricted).toBeUndefined();
    await post(`/api/conversations/${conversa.id}/messages`, operador, {
      direction: 'inbound',
      body: 'Quanto custa?',
    }).expect(201);
    await patch(`/api/conversations/${conversa.id}`, operador, { subject: 'Orçamento 2' }).expect(
      200,
    );
    for (const s of [operador, guest]) {
      const lido = await leitura(s, conversa.id);
      expect(lido.porId).toMatchObject({ subject: 'Orçamento 2' });
      expect(lido.porId.textRestricted).toBeUndefined();
      expect(lido.mensagens.map((m) => m.body)).toEqual(['Quanto custa?']);
    }
    const politica = (
      await get(`/api/conversations/${conversa.id}/send-policy`, operador).expect(200)
    ).body;
    expect(politica).toMatchObject({ mode: 'free_form' });
  });
});
