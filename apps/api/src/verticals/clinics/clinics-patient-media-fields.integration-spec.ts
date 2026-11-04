import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { JobsService } from '../../jobs/jobs.service';
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

interface Session {
  cookieHeader: string;
  csrf: string;
}

const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]);

/**
 * F5.3c (ADR-061, adendo 5): a mídia das conversas, os campos personalizados
 * do contato e o título da oportunidade seguem o E8. A recepção (agenda, sem a
 * chave do conteúdo) vê "restrito" no paciente e o de sempre no interessado;
 * quem não tem a agenda recebe a regra uniforme (respostas iguais); o
 * workspace que nunca teve o Clinics fica como sempre. Dados FICTÍCIOS.
 */
describe('Clinics — mídia, campos e título de pacientes (integração, F5.3c)', () => {
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
  ) => {
    const r = request(http)
      [metodo](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    return body === undefined ? r : r.send(body as object);
  };
  const post = (path: string, s: Session, body?: unknown) => enviar('post', path, s, body);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);
  const contato = async (name: string, s = owner) =>
    (await post('/api/contacts', s, { name }).expect(201)).body.id as string;
  const subir = async (s = owner) =>
    (
      await request(http)
        .post('/api/files')
        .set('Origin', ORIGIN)
        .set('Cookie', s.cookieHeader)
        .set('x-csrf-token', s.csrf)
        .attach('file', png(), `exame-${++seq}.png`)
        .expect(201)
    ).body.id as string;
  /** uma conversa (identificada ou RAI) com uma mensagem de mídia recebida */
  const conversaComMidia = async (
    workspaceId: string,
    contactId: string | null,
    fileObjectId: string,
  ) => {
    const canal = (await prisma.raw.channel.findFirst({ where: { workspaceId } }))!.id;
    const conversa = await prisma.raw.conversation.create({
      data: {
        workspaceId,
        channelId: canal,
        contactId,
        senderStatus: contactId ? 'identified' : 'unidentified',
      },
    });
    const msg = await prisma.raw.message.create({
      data: {
        workspaceId,
        conversationId: conversa.id,
        channelId: canal,
        direction: 'inbound',
        authorType: 'contact',
        body: '[image]',
      },
    });
    await prisma.raw.messageAttachment.create({
      data: { workspaceId, messageId: msg.id, fileObjectId },
    });
    return conversa.id;
  };
  /** o que quem lê recebe da mídia: a mensagem, o download, a lista e a exclusão */
  const midiaVista = async (s: Session, conversa: string, arquivo: string) => {
    const msgs = await get(`/api/conversations/${conversa}/messages`, s).expect(200);
    const lista = await get('/api/files', s).expect(200);
    return {
      corpo: msgs.body.items.map((m: { body: string }) => m.body),
      anexos: msgs.body.items.map((m: { attachments: unknown[] }) =>
        (m.attachments as Record<string, unknown>[]).map((a) =>
          a.restricted ? a : { aberto: true },
        ),
      ),
      download: (await get(`/api/files/${arquivo}/content`, s)).status,
      naLista: (lista.body as { id: string }[]).some((f) => f.id === arquivo),
    };
  };
  const SEM_AGENDA = [
    'contacts:read',
    'contacts:write',
    'conversations:read',
    'conversations:write',
    'files:read',
    'files:write',
    'pipelines:read',
    'deals:write',
  ];
  const operadorSemAgenda = async (workspaceId: string, email: string) => {
    const role = await prisma.raw.role.create({
      data: { workspaceId, name: `Sem agenda ${email}`, isSystem: false },
    });
    await prisma.raw.rolePermission.createMany({
      data: SEM_AGENDA.map((permissionKey) => ({ workspaceId, roleId: role.id, permissionKey })),
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
    for (const systemKey of ['owner', 'member']) {
      const user = await createUserFixture(prisma, `${systemKey}@veyra.test`);
      await createMembershipFixture(prisma, ws.workspaceId, user, ws.roles[systemKey]);
    }
    await app.get(ClinicsActivationService).enable('acme');
    owner = await loginAs('owner@veyra.test');
    recepcao = await loginAs('member@veyra.test');
    paciente = await contato('Paciente Fictícia');
    await post('/api/clinics/patients', owner, { contactId: paciente }).expect(201);
    interessado = await contato('Interessado Fictício');
  });

  // ── a mídia das conversas ─────────────────────────────────────────────────
  it('mídia: a recepção lê o texto do paciente, mas o anexo é "restrito" em todo caminho; o interessado segue', async () => {
    const doPaciente = await subir();
    const doInteressado = await subir();
    const cP = await conversaComMidia(ws.workspaceId, paciente, doPaciente);
    const cI = await conversaComMidia(ws.workspaceId, interessado, doInteressado);

    const vistaP = await midiaVista(recepcao, cP, doPaciente);
    expect(vistaP).toEqual({
      corpo: ['[image]'],
      anexos: [[{ restricted: true }]],
      download: 404,
      naLista: false,
    });
    const msgs = await get(`/api/conversations/${cP}/messages`, recepcao).expect(200);
    expect(JSON.stringify(msgs.body)).not.toMatch(/exame-|fileObjectId|image\/png/);
    await enviar('delete', `/api/files/${doPaciente}`, recepcao).expect(404);
    // anexar o id em outra conversa não é atalho
    await post(`/api/conversations/${cI}/messages`, recepcao, {
      direction: 'outbound',
      body: 'segue',
      attachmentIds: [doPaciente],
    }).expect(400);

    expect(await midiaVista(recepcao, cI, doInteressado)).toEqual({
      corpo: ['[image]'],
      anexos: [[{ aberto: true }]],
      download: 200,
      naLista: true,
    });
    // com as duas chaves, o de sempre
    expect((await midiaVista(owner, cP, doPaciente)).download).toBe(200);
  });

  it('mídia: o interessado que vira paciente — a mídia anterior passa a ser restrita na leitura seguinte; um vínculo protegido protege o arquivo em todo lugar', async () => {
    const arquivo = await subir();
    const cI = await conversaComMidia(ws.workspaceId, interessado, arquivo);
    expect((await midiaVista(recepcao, cI, arquivo)).download).toBe(200);
    // o mesmo arquivo, também numa conversa de outro interessado
    const outro = await contato('Outro Fictício');
    const cO = await conversaComMidia(ws.workspaceId, outro, arquivo);
    await post('/api/clinics/patients', owner, { contactId: interessado }).expect(201);
    expect(await midiaVista(recepcao, cI, arquivo)).toMatchObject({
      anexos: [[{ restricted: true }]],
      download: 404,
    });
    expect((await midiaVista(recepcao, cO, arquivo)).anexos).toEqual([[{ restricted: true }]]);
  });

  it('mídia: a RAI é conservadora; identificar ou desfazer o vínculo não cria atalho', async () => {
    const arquivo = await subir();
    const rai = await conversaComMidia(ws.workspaceId, null, arquivo);
    // a recepção vê a RAI (contacts:write), mas não abre a mídia na dúvida
    expect(await midiaVista(recepcao, rai, arquivo)).toMatchObject({
      corpo: ['[image]'],
      anexos: [[{ restricted: true }]],
      download: 404,
    });
    expect((await midiaVista(owner, rai, arquivo)).download).toBe(200);
    // identificada como paciente: continua restrita
    const marcar = (contactId: string | null) =>
      prisma.raw.conversation.updateMany({
        where: { id: rai },
        data: { contactId, senderStatus: contactId ? 'identified' : 'unidentified' },
      });
    await marcar(paciente);
    expect((await midiaVista(recepcao, rai, arquivo)).download).toBe(404);
    // desfeito o vínculo: de volta à dúvida, restrita
    await marcar(null);
    expect((await midiaVista(recepcao, rai, arquivo)).download).toBe(404);
    // identificada como interessado, sem outro vínculo protegido: a de sempre
    await marcar(interessado);
    expect((await midiaVista(recepcao, rai, arquivo)).download).toBe(200);
  });

  it('mídia: sem a agenda, paciente e interessado dão as MESMAS respostas', async () => {
    const operador = await operadorSemAgenda(ws.workspaceId, 'sem-agenda@veyra.test');
    const doPaciente = await subir();
    const doInteressado = await subir();
    const cP = await conversaComMidia(ws.workspaceId, paciente, doPaciente);
    const cI = await conversaComMidia(ws.workspaceId, interessado, doInteressado);
    const vistaP = await midiaVista(operador, cP, doPaciente);
    expect(vistaP).toEqual(await midiaVista(operador, cI, doInteressado));
    expect(vistaP).toEqual({
      corpo: ['[image]'],
      anexos: [[{ restricted: true }]],
      download: 404,
      naLista: false,
    });
  });

  // ── os campos personalizados ──────────────────────────────────────────────
  const comCampo = async () => {
    await post('/api/custom-fields', owner, {
      entityType: 'contact',
      key: 'alergias',
      label: 'Alergias',
      type: 'text',
    }).expect(201);
    for (const id of [paciente, interessado]) {
      await enviar('patch', `/api/contacts/${id}`, owner, {
        customFields: { alergias: 'Látex (fictício)' },
      }).expect(200);
    }
  };

  it('campos: a recepção não lê nem muda os do paciente (lista, leitura, edição); os do interessado seguem; o resto do contato é editável', async () => {
    await comCampo();
    const lido = (await get(`/api/contacts/${paciente}`, recepcao).expect(200)).body;
    expect(lido).toMatchObject({ customFields: {}, customFieldsRestricted: true });
    const lista = (await get('/api/contacts?pageSize=100', recepcao).expect(200)).body.items as {
      id: string;
      customFields: Record<string, unknown>;
      customFieldsRestricted?: true;
    }[];
    expect(lista.find((c) => c.id === paciente)).toMatchObject({
      customFields: {},
      customFieldsRestricted: true,
    });
    expect(lista.find((c) => c.id === interessado)?.customFields).toEqual({
      alergias: 'Látex (fictício)',
    });
    await enviar('patch', `/api/contacts/${paciente}`, recepcao, {
      customFields: { alergias: 'outra' },
    }).expect(403);
    const editado = await enviar('patch', `/api/contacts/${paciente}`, recepcao, {
      name: 'Paciente Renomeada',
    }).expect(200);
    expect(editado.body).toMatchObject({
      name: 'Paciente Renomeada',
      customFieldsRestricted: true,
    });
    expect(JSON.stringify(editado.body)).not.toMatch(/Látex/);
    expect((await get(`/api/contacts/${paciente}`, owner).expect(200)).body.customFields).toEqual({
      alergias: 'Látex (fictício)',
    });
  });

  it('campos: sem a agenda, as mesmas respostas para paciente e interessado', async () => {
    await comCampo();
    const operador = await operadorSemAgenda(ws.workspaceId, 'sem-agenda@veyra.test');
    const ver = async (id: string) => {
      const lido = (await get(`/api/contacts/${id}`, operador).expect(200)).body;
      const muda = await enviar('patch', `/api/contacts/${id}`, operador, {
        customFields: { alergias: 'x' },
      });
      return [lido.customFields, lido.customFieldsRestricted, muda.status, muda.body.message];
    };
    const p = await ver(paciente);
    expect(p).toEqual(await ver(interessado));
    expect(p).toEqual([{}, true, 403, 'Conteúdo restrito']);
  });

  // ── o título da oportunidade ──────────────────────────────────────────────
  const oportunidades = async () => {
    const dP = (
      await post('/api/deals', owner, { title: 'Tratamento de acne', contactId: paciente }).expect(
        201,
      )
    ).body.id as string;
    const dI = (
      await post('/api/deals', owner, {
        title: 'Tratamento de acne',
        contactId: interessado,
      }).expect(201)
    ).body.id as string;
    return { dP, dI };
  };
  const tituloVisto = async (s: Session, deal: string, contactId: string) => {
    const board = (await get('/api/deals/board', s).expect(200)).body as {
      columns: { deals: { id: string; title: string; titleRestricted?: true }[] }[];
    };
    const noBoard = board.columns.flatMap((c) => c.deals).find((d) => d.id === deal)!;
    const lido = (await get(`/api/deals/${deal}`, s).expect(200)).body;
    const doContato = (await get(`/api/contacts/${contactId}/deals`, s).expect(200)).body.find(
      (d: { id: string }) => d.id === deal,
    );
    const timeline = (await get(`/api/activities?contactId=${contactId}`, s).expect(200)).body;
    const criada = timeline.items.find((a: { type: string }) => a.type === 'deal_created');
    return {
      board: [noBoard.title, noBoard.titleRestricted],
      lido: [lido.title, lido.titleRestricted],
      doContato: [doContato.title, doContato.titleRestricted],
      timeline: [criada?.payload?.title, timeline.restrictedContent],
    };
  };

  it('título: a recepção vê "restrito" no paciente em todo caminho, e o de sempre no interessado; muda o valor, não o título', async () => {
    const { dP, dI } = await oportunidades();
    expect(await tituloVisto(recepcao, dP, paciente)).toEqual({
      board: ['', true],
      lido: ['', true],
      doContato: ['', true],
      timeline: [undefined, true],
    });
    expect(await tituloVisto(recepcao, dI, interessado)).toEqual({
      board: ['Tratamento de acne', undefined],
      lido: ['Tratamento de acne', undefined],
      doContato: ['Tratamento de acne', undefined],
      timeline: ['Tratamento de acne', undefined],
    });
    await enviar('patch', `/api/deals/${dP}`, recepcao, { title: 'outro' }).expect(403);
    const valor = await enviar('patch', `/api/deals/${dP}`, recepcao, {
      amountCents: 90_000,
    }).expect(200);
    expect(valor.body).toMatchObject({ amountCents: 90_000, title: '', titleRestricted: true });
    expect((await get(`/api/deals/${dP}`, owner).expect(200)).body.title).toBe(
      'Tratamento de acne',
    );
  });

  it('título: sem a agenda, as mesmas respostas para paciente e interessado', async () => {
    const { dP, dI } = await oportunidades();
    const operador = await operadorSemAgenda(ws.workspaceId, 'sem-agenda@veyra.test');
    const vistoP = await tituloVisto(operador, dP, paciente);
    expect(vistoP).toEqual(await tituloVisto(operador, dI, interessado));
    expect(vistoP.lido).toEqual(['', true]);
    const muda = async (d: string) => {
      const r = await enviar('patch', `/api/deals/${d}`, operador, { title: 'x' });
      return [r.status, r.body.message];
    };
    expect(await muda(dP)).toEqual(await muda(dI));
  });

  it('título: a automação de deal.created usa a linha atual e liga a tarefa à oportunidade — protegida como ela', async () => {
    await post('/api/automations', owner, {
      name: 'Retorno da oportunidade',
      trigger: 'deal.created',
      action: 'create_task',
      actionConfig: { title: 'Ligar: {{title}}', dueInDays: 1 },
    }).expect(201);
    const { dP } = await oportunidades();
    const jobs = app.get(JobsService);
    for (let n = 0; n < 6; n += 1) {
      if ((await jobs.dispatchPending()).delivered === 0) break;
    }
    const criadas = await prisma.raw.task.findMany({
      where: { workspaceId: ws.workspaceId, title: { startsWith: 'Ligar:' } },
      select: { title: true, dealId: true, contactId: true },
    });
    expect(criadas).toHaveLength(2);
    expect(criadas.find((t) => t.dealId === dP)).toMatchObject({ contactId: paciente });
    // a recepção vê a tarefa do interessado, nunca a do paciente
    const lista = (await get('/api/tasks?status=all', recepcao).expect(200)).body;
    expect(lista.total).toBe(1);
  });

  // ── o workspace que nunca teve o Clinics ──────────────────────────────────
  it('no workspace que nunca teve o Clinics, mídia, campos, título e automação ficam como sempre', async () => {
    const beta = await createWorkspaceFixture(prisma, 'beta');
    for (const systemKey of ['owner', 'member']) {
      const user = await createUserFixture(prisma, `${systemKey}-beta@veyra.test`);
      await createMembershipFixture(prisma, beta.workspaceId, user, beta.roles[systemKey]);
    }
    const dona = await loginAs('owner-beta@veyra.test');
    const membro = await loginAs('member-beta@veyra.test');
    const c = await contato('Contato do Core', dona);
    const arquivo = await subir(dona);
    const conversa = await conversaComMidia(beta.workspaceId, c, arquivo);
    expect(await midiaVista(membro, conversa, arquivo)).toEqual({
      corpo: ['[image]'],
      anexos: [[{ aberto: true }]],
      download: 200,
      naLista: true,
    });
    await post('/api/custom-fields', dona, {
      entityType: 'contact',
      key: 'origem',
      label: 'Origem',
      type: 'text',
    }).expect(201);
    await enviar('patch', `/api/contacts/${c}`, membro, {
      customFields: { origem: 'Indicação' },
    }).expect(200);
    expect((await get(`/api/contacts/${c}`, membro).expect(200)).body).toMatchObject({
      customFields: { origem: 'Indicação' },
    });
    await post('/api/automations', dona, {
      name: 'Retorno',
      trigger: 'deal.created',
      action: 'create_task',
      actionConfig: { title: 'Ligar: {{title}}', dueInDays: 1 },
    }).expect(201);
    const deal = (await post('/api/deals', dona, { title: 'Proposta', contactId: c }).expect(201))
      .body.id as string;
    const lido = (await get(`/api/deals/${deal}`, membro).expect(200)).body;
    expect(lido.title).toBe('Proposta');
    expect(lido.titleRestricted).toBeUndefined();
    const jobs = app.get(JobsService);
    for (let n = 0; n < 6; n += 1) {
      if ((await jobs.dispatchPending()).delivered === 0) break;
    }
    // a automação de sempre: o título do evento, sem vínculo herdado
    expect(
      await prisma.raw.task.findFirst({
        where: { workspaceId: beta.workspaceId, title: 'Ligar: Proposta' },
        select: { contactId: true, dealId: true },
      }),
    ).toEqual({ contactId: null, dealId: null });
  });

  // ── a RAI pelas rotas reais: desfazer, rejeitar e identificar sem atalho ──
  const NUMERO = '+5511987654321';
  /** uma conversa de WhatsApp do número, com uma mídia recebida, como a ingestão a deixa */
  const conversaDoNumero = async (contactId: string | null, fileObjectId: string) => {
    const canal = await prisma.raw.channel.create({
      data: { workspaceId: ws.workspaceId, type: 'whatsapp', name: `WhatsApp ${++seq}` },
    });
    const conversa = await prisma.raw.conversation.create({
      data: {
        workspaceId: ws.workspaceId,
        channelId: canal.id,
        contactId,
        externalAddress: NUMERO,
        senderStatus: contactId ? 'identified' : 'unidentified',
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
    await prisma.raw.messageAttachment.create({
      data: { workspaceId: ws.workspaceId, messageId: msg.id, fileObjectId },
    });
    return conversa.id;
  };
  const comNumero = (id: string) =>
    enviar('patch', `/api/contacts/${id}`, owner, { phones: [NUMERO] }).expect(200);

  it('RAI: a recepção não leva à RAI a conversa do paciente (rejeitar ou desfazer) — nem depois a identifica como outro', async () => {
    await comNumero(paciente);
    const arquivo = await subir();
    const conversa = await conversaDoNumero(paciente, arquivo);
    // rejeitar: 403, a conversa segue do paciente e a mídia, restrita
    const r = await post(`/api/conversations/${conversa}/sender/reject`, recepcao, {
      removeNumber: false,
    }).expect(403);
    expect(r.body.message).toMatch(/Conteúdo restrito/);
    expect((await prisma.raw.conversation.findFirst({ where: { id: conversa } }))?.contactId).toBe(
      paciente,
    );
    expect((await midiaVista(recepcao, conversa, arquivo)).download).toBe(404);
    // quem tem as chaves rejeita; a RAI fica na dúvida (restrita) para a recepção…
    await post(`/api/conversations/${conversa}/sender/reject`, owner, {
      removeNumber: false,
    }).expect(201);
    expect((await midiaVista(recepcao, conversa, arquivo)).download).toBe(404);
    // …que não a identifica como um contato novo (o paciente é candidato do número)
    const novo = await post(`/api/conversations/${conversa}/sender/identify`, recepcao, {
      newContact: { name: 'Outra pessoa' },
    }).expect(403);
    expect(novo.body.message).toMatch(/Conteúdo restrito/);
    expect((await midiaVista(recepcao, conversa, arquivo)).download).toBe(404);
    // identificar como o próprio paciente segue possível — e a mídia, restrita
    await post(`/api/conversations/${conversa}/sender/identify`, recepcao, {
      contactId: paciente,
    }).expect(201);
    expect((await midiaVista(recepcao, conversa, arquivo)).download).toBe(404);
    // desfazer a identificação (feita por pessoa) também é recusado à recepção
    await post(`/api/conversations/${conversa}/sender/unidentify`, recepcao).expect(403);
  });

  it('RAI: número compartilhado com um paciente — a recepção não identifica a conversa com mídia como o interessado; quem tem as chaves, sim', async () => {
    await comNumero(paciente);
    await comNumero(interessado);
    const arquivo = await subir();
    const rai = await conversaDoNumero(null, arquivo);
    await post(`/api/conversations/${rai}/sender/identify`, recepcao, {
      contactId: interessado,
    }).expect(403);
    expect((await midiaVista(recepcao, rai, arquivo)).download).toBe(404);
    await post(`/api/conversations/${rai}/sender/identify`, owner, {
      contactId: interessado,
    }).expect(201);
  });

  it('RAI: a recepção não tira do paciente o número (o que deixaria a RAI só com outro candidato); acrescentar segue livre', async () => {
    await comNumero(paciente);
    const r = await enviar('patch', `/api/contacts/${paciente}`, recepcao, { phones: [] }).expect(
      403,
    );
    expect(r.body.message).toMatch(/Conteúdo restrito/);
    expect((await prisma.raw.contact.findFirst({ where: { id: paciente } }))?.phones).toEqual([
      NUMERO,
    ]);
    await enviar('patch', `/api/contacts/${paciente}`, recepcao, {
      phones: [NUMERO, '+5511912345678'],
    }).expect(200);
    // no interessado, tirar o número segue como sempre
    await comNumero(interessado);
    await enviar('patch', `/api/contacts/${interessado}`, recepcao, { phones: [] }).expect(200);
  });

  it('RAI: sem a agenda, a RAI com mídia não é identificada nem a conversa é levada à RAI — igual para paciente e interessado', async () => {
    const operador = await operadorSemAgenda(ws.workspaceId, 'sem-agenda@veyra.test');
    const respostas: [string, number, string][] = [];
    for (const pessoa of [paciente, interessado]) {
      await prisma.raw.contact.updateMany({
        where: { phones: { has: NUMERO } },
        data: { phones: [] },
      });
      await comNumero(pessoa);
      const rai = await conversaDoNumero(null, await subir());
      const ident = await post(`/api/conversations/${rai}/sender/identify`, operador, {
        contactId: pessoa,
      });
      respostas.push(['identificar', ident.status, ident.body.message]);
      const identificada = await conversaDoNumero(pessoa, await subir());
      const rej = await post(`/api/conversations/${identificada}/sender/reject`, operador, {
        removeNumber: false,
      });
      respostas.push(['rejeitar', rej.status, rej.body.message]);
    }
    expect(respostas.slice(0, 2)).toEqual(respostas.slice(2));
    expect(respostas.slice(0, 2)).toEqual([
      ['identificar', 403, 'Conteúdo restrito'],
      ['rejeitar', 403, 'Conteúdo restrito'],
    ]);
  });
});
