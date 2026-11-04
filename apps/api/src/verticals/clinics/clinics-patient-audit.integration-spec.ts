import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { AuditService } from '../../audit/audit.service';
import { JobsService } from '../../jobs/jobs.service';
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
import { ClinicsActivationService } from './clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const RESTRITO = 'Conteúdo restrito';

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
 * F5.3d (ADR-061, adendo 7): a trilha de auditoria sob o E8, os títulos
 * antigos na timeline, o histórico das automações e a corrida na
 * identificação do remetente. Dados FICTÍCIOS. A corrida é forçada pela pausa
 * na auditoria da conversão e vista esperando a trava, nunca por sono.
 */
describe('Clinics — trilha, timeline, automações e identificação (integração, F5.3d)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let observador: Client;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
    observador = new Client({ connectionString: TEST_DATABASE_URL });
    await observador.connect();
  });
  afterAll(async () => {
    await observador.end();
    await app.close();
  });

  let portoes: (() => void)[] = [];
  let pendentes: Promise<unknown>[] = [];
  afterEach(async () => {
    for (const abrir of portoes) abrir();
    portoes = [];
    await Promise.allSettled(pendentes);
    pendentes = [];
    jest.restoreAllMocks();
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
  const papel = async (workspaceId: string, email: string, chaves: string[]) => {
    const role = await prisma.raw.role.create({
      data: { workspaceId, name: `Papel ${email}`, isSystem: false },
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
  type Entrada = {
    action: string;
    entityId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  };
  const trilha = async (s: Session, query = '') =>
    (await get(`/api/audit?limit=100${query}`, s).expect(200)).body.items as Entrada[];

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

  // ── a trilha de auditoria ─────────────────────────────────────────────────
  /** títulos e nomes de arquivo na trilha: do paciente, do interessado, sem pessoa e apagado */
  const comConteudoNaTrilha = async () => {
    const dP = (await post('/api/deals', owner, { title: 'Acne', contactId: paciente }).expect(201))
      .body.id as string;
    await enviar('patch', `/api/deals/${dP}`, owner, { title: 'Acne severa' }).expect(200);
    const dI = (
      await post('/api/deals', owner, { title: 'Peeling', contactId: interessado }).expect(201)
    ).body.id as string;
    await enviar('patch', `/api/deals/${dI}`, owner, { title: 'Peeling leve' }).expect(200);
    const dSem = (await post('/api/deals', owner, { title: 'Estoque' }).expect(201)).body
      .id as string;
    await enviar('patch', `/api/deals/${dSem}`, owner, { title: 'Estoque novo' }).expect(200);
    const dApagado = (
      await post('/api/deals', owner, { title: 'Apagado', contactId: paciente }).expect(201)
    ).body.id as string;
    await enviar('delete', `/api/deals/${dApagado}`, owner).expect(200);
    // um arquivo enviado e ligado à conversa do paciente
    const arquivo = (
      await request(http)
        .post('/api/files')
        .set('Origin', ORIGIN)
        .set('Cookie', owner.cookieHeader)
        .set('x-csrf-token', owner.csrf)
        .attach('file', png(), `exame-${++seq}.png`)
        .expect(201)
    ).body.id as string;
    const canal = (await prisma.raw.channel.findFirst({ where: { workspaceId: ws.workspaceId } }))!
      .id;
    const conversa = await prisma.raw.conversation.create({
      data: { workspaceId: ws.workspaceId, channelId: canal, contactId: paciente },
    });
    const msg = await prisma.raw.message.create({
      data: {
        workspaceId: ws.workspaceId,
        conversationId: conversa.id,
        channelId: canal,
        direction: 'inbound',
        authorType: 'contact',
        body: '[image]',
      },
    });
    await prisma.raw.messageAttachment.create({
      data: { workspaceId: ws.workspaceId, messageId: msg.id, fileObjectId: arquivo },
    });
    return { dP, dI, dSem, dApagado, arquivo };
  };
  const campo = (itens: Entrada[], action: string, entityId: string, nome: string) => {
    const e = itens.find((i) => i.action === action && i.entityId === entityId);
    return e ? (e.after?.[nome] ?? e.before?.[nome]) : 'ausente';
  };

  it('trilha: quem lê sem a chave do conteúdo (com a agenda) vê o título e o arquivo do paciente como restritos; o resto, como sempre', async () => {
    const { dP, dI, dSem, dApagado, arquivo } = await comConteudoNaTrilha();
    const leitor = await papel(ws.workspaceId, 'auditor@veyra.test', [
      'audit:read',
      'clinics:schedule:read',
    ]);
    const itens = await trilha(leitor);
    expect(campo(itens, 'deal.updated', dP, 'title')).toBe(RESTRITO);
    expect(campo(itens, 'deal.deleted', dApagado, 'title')).toBe(RESTRITO);
    expect(campo(itens, 'file.uploaded', arquivo, 'fileName')).toBe(RESTRITO);
    expect(campo(itens, 'deal.updated', dI, 'title')).toBe('Peeling leve');
    expect(campo(itens, 'deal.updated', dSem, 'title')).toBe('Estoque novo');
    expect(JSON.stringify(itens)).not.toMatch(/Acne|exame-/);
    // quem pode saber quem é paciente vê as ações do vertical
    expect(itens.some((i) => i.action === 'clinics.patient.created')).toBe(true);
    // com as duas chaves (o Owner), tudo como sempre
    const doOwner = await trilha(owner);
    expect(campo(doOwner, 'deal.updated', dP, 'title')).toBe('Acne severa');
    expect(campo(doOwner, 'file.uploaded', arquivo, 'fileName')).toMatch(/^exame-/);
  });

  it('trilha: sem a agenda, as ações do vertical não saem e toda pessoa é restrita — paciente e interessado iguais', async () => {
    const { dP, dI, dSem } = await comConteudoNaTrilha();
    // linhas do Core que dizem quem é paciente: o envio do vertical e o
    // consentimento de uma finalidade dele (gravadas como o Core as grava)
    const finalidade = await prisma.raw.consentPurpose.create({
      data: {
        workspaceId: ws.workspaceId,
        key: 'clinics_confirmacao',
        version: 1,
        description: 'Confirmação (fictícia)',
        category: 'utility',
        fields: [],
      },
    });
    const qualquerId = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e99';
    await prisma.raw.auditLog.createMany({
      data: [
        {
          workspaceId: ws.workspaceId,
          action: 'business_outbound.approved',
          entityType: 'outboundApproval',
          entityId: qualquerId,
          after: { contactId: paciente, originRef: `clinics.outreach:${qualquerId}` },
        },
        {
          workspaceId: ws.workspaceId,
          action: 'consent.granted',
          entityType: 'consent',
          entityId: qualquerId,
          after: { contactId: paciente, purposeId: finalidade.id },
        },
      ],
    });
    const leitor = await papel(ws.workspaceId, 'auditor@veyra.test', ['audit:read']);
    const itens = await trilha(leitor);
    // a configuração do vertical segue; o que diz quem é paciente, não
    expect(itens.some((i) => i.action === 'clinics.enabled')).toBe(true);
    expect(itens.some((i) => i.action === 'clinics.patient.created')).toBe(false);
    expect(await trilha(leitor, '&action=clinics.patient.created')).toEqual([]);
    expect(await trilha(leitor, '&action=business_outbound.approved')).toEqual([]);
    expect(await trilha(leitor, '&action=consent.granted')).toEqual([]);
    expect(JSON.stringify(itens)).not.toContain(paciente);
    // quem pode saber quem é paciente vê essas linhas
    expect(
      await trilha(
        await papel(ws.workspaceId, 'auditor-agenda@veyra.test', [
          'audit:read',
          'clinics:schedule:read',
        ]),
        '&action=business_outbound.approved',
      ),
    ).toHaveLength(1);
    expect(campo(itens, 'deal.updated', dP, 'title')).toBe(RESTRITO);
    expect(campo(itens, 'deal.updated', dI, 'title')).toBe(RESTRITO);
    expect(campo(itens, 'deal.updated', dSem, 'title')).toBe('Estoque novo');
  });

  it('trilha: no workspace que nunca teve o Clinics, como sempre', async () => {
    const beta = await createWorkspaceFixture(prisma, 'beta');
    await createMembershipFixture(
      prisma,
      beta.workspaceId,
      await createUserFixture(prisma, 'owner-beta@veyra.test'),
      beta.roles.owner,
    );
    const dona = await loginAs('owner-beta@veyra.test');
    const leitor = await papel(beta.workspaceId, 'auditor-beta@veyra.test', ['audit:read']);
    const c = await contato('Contato do Core', dona);
    const d = (await post('/api/deals', dona, { title: 'Proposta', contactId: c }).expect(201)).body
      .id as string;
    await enviar('patch', `/api/deals/${d}`, dona, { title: 'Proposta final' }).expect(200);
    expect(campo(await trilha(leitor), 'deal.updated', d, 'title')).toBe('Proposta final');
  });

  // ── (a) os títulos antigos na timeline ────────────────────────────────────
  it('timeline: a oportunidade que saiu do paciente não devolve à recepção os títulos do tempo dele', async () => {
    const d = (await post('/api/deals', owner, { title: 'Acne', contactId: paciente }).expect(201))
      .body.id as string;
    // quem tem as chaves a passa ao interessado (o título atual passa a ser dele)
    await enviar('patch', `/api/deals/${d}`, owner, { contactId: interessado }).expect(200);
    const daOportunidade = (await get(`/api/activities?dealId=${d}`, recepcao).expect(200)).body;
    const criada = daOportunidade.items.find((a: { type: string }) => a.type === 'deal_created');
    expect(criada.payload.title).toBeUndefined();
    expect(daOportunidade.restrictedContent).toBe(true);
    // pela timeline do paciente, igual
    const doPaciente = (await get(`/api/activities?contactId=${paciente}`, recepcao).expect(200))
      .body;
    expect(JSON.stringify(doPaciente)).not.toMatch(/"title":"Acne"/);
  });

  // ── (b) o histórico das automações ────────────────────────────────────────
  it('automações: fora do modo livre, as execuções de gatilho de oportunidade não saem (com ou sem condição) — igual para todos', async () => {
    const comTitulo = (
      await post('/api/automations', owner, {
        name: 'Acne',
        trigger: 'deal.created',
        conditions: [{ field: 'title', op: 'contains', value: 'acne' }],
        action: 'create_task',
        actionConfig: { title: 'Ligar', dueInDays: 1 },
      }).expect(201)
    ).body.id as string;
    const semTitulo = (
      await post('/api/automations', owner, {
        name: 'Toda oportunidade',
        trigger: 'deal.created',
        action: 'create_task',
        actionConfig: { title: 'Ligar', dueInDays: 1 },
      }).expect(201)
    ).body.id as string;
    await post('/api/deals', owner, { title: 'Acne', contactId: paciente }).expect(201);
    await post('/api/deals', owner, { title: 'Peeling', contactId: interessado }).expect(201);
    const jobs = app.get(JobsService);
    for (let n = 0; n < 6; n += 1) {
      if ((await jobs.dispatchPending()).delivered === 0) break;
    }
    const gestor = await papel(ws.workspaceId, 'gestor@veyra.test', ['automations:manage']);
    const vistas = (await get('/api/automations/executions', gestor).expect(200)).body as {
      automationId: string;
    }[];
    // de evento de oportunidade: nenhuma sai, com ou sem condição sobre o título
    expect(vistas.some((e) => e.automationId === comTitulo)).toBe(false);
    expect(vistas.some((e) => e.automationId === semTitulo)).toBe(false);
    const doOwner = (await get('/api/automations/executions', owner).expect(200)).body as {
      automationId: string;
    }[];
    expect(doOwner.filter((e) => e.automationId === comTitulo)).toHaveLength(2);
  });

  // ── (c) a corrida na identificação do remetente ───────────────────────────
  it('identificação: a conversão de OUTRO candidato do número, em curso, é esperada — e a identificação vê a classificação nova', async () => {
    const NUMERO = '+5511987654321';
    const bia = await contato('Bia Fictícia');
    for (const id of [interessado, bia]) {
      await enviar('patch', `/api/contacts/${id}`, owner, { phones: [NUMERO] }).expect(200);
    }
    // a RAI do número, com mídia
    const canal = await prisma.raw.channel.create({
      data: { workspaceId: ws.workspaceId, type: 'whatsapp', name: 'WhatsApp' },
    });
    const rai = await prisma.raw.conversation.create({
      data: {
        workspaceId: ws.workspaceId,
        channelId: canal.id,
        externalAddress: NUMERO,
        senderStatus: 'unidentified',
      },
    });
    const msg = await prisma.raw.message.create({
      data: {
        workspaceId: ws.workspaceId,
        conversationId: rai.id,
        channelId: canal.id,
        direction: 'inbound',
        authorType: 'contact',
        body: '[image]',
      },
    });
    await prisma.raw.inboundMedia.create({
      data: {
        workspaceId: ws.workspaceId,
        messageId: msg.id,
        providerMediaId: 'midia',
        mimeType: 'image/jpeg',
      },
    });
    const portao = () => {
      let abrir!: () => void;
      const aberto = new Promise<void>((r) => (abrir = r));
      portoes.push(abrir);
      return { aberto, abrir };
    };
    const disparar = <T>(p: PromiseLike<T>): Promise<T> => {
      const promessa = Promise.resolve(p);
      pendentes.push(promessa);
      return promessa;
    };
    // a conversão da Bia pausa na auditoria, segurando a trava do contato
    const audit = app.get(AuditService);
    const real = audit.record.bind(audit);
    const chegou = portao();
    const segue = portao();
    jest.spyOn(audit, 'record').mockImplementation(async (db, w, action, input) => {
      if (action === 'clinics.patient.created') {
        chegou.abrir();
        await segue.aberto;
      }
      return real(db, w, action, input);
    });
    const conversao = disparar(post('/api/clinics/patients', owner, { contactId: bia }));
    await chegou.aberto;
    // a recepção identifica a RAI como o interessado (a Bia ainda não é paciente)
    const identificacao = disparar(
      post(`/api/conversations/${rai.id}/sender/identify`, recepcao, { contactId: interessado }),
    );
    for (let n = 0; n < 400; n++) {
      const { rows } = await observador.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`,
      );
      if (Number(rows[0].n) > 0) break;
      if (n === 399) throw new Error('a identificação não esperou a trava');
      await new Promise((r) => setTimeout(r, 10));
    }
    segue.abrir();
    expect((await conversao).status).toBe(201);
    // depois da conversão, a Bia é candidata oculta: a identificação como o
    // interessado abriria a mídia dela — recusada
    expect((await identificacao).status).toBe(403);
    expect((await prisma.raw.conversation.findFirst({ where: { id: rai.id } }))?.contactId).toBe(
      null,
    );
  });

  // ── os furos da revisão final ─────────────────────────────────────────────
  it('trilha e timeline: os títulos do tempo do paciente seguem restritos depois da transferência; o título dado depois, não', async () => {
    const d = (await post('/api/deals', owner, { title: 'Acne', contactId: paciente }).expect(201))
      .body.id as string;
    await enviar('patch', `/api/deals/${d}`, owner, { title: 'Acne severa' }).expect(200);
    // quem tem as chaves a passa ao interessado e, depois, a renomeia
    await enviar('patch', `/api/deals/${d}`, owner, { contactId: interessado }).expect(200);
    await enviar('patch', `/api/deals/${d}`, owner, { title: 'Peeling' }).expect(200);
    const leitor = await papel(ws.workspaceId, 'auditor@veyra.test', [
      'audit:read',
      'clinics:schedule:read',
    ]);
    const atualizacoes = (await trilha(leitor, `&entityId=${d}&action=deal.updated`)).map((e) => [
      e.before?.title,
      e.after?.title,
    ]);
    expect(atualizacoes).toContainEqual([RESTRITO, RESTRITO]);
    expect(atualizacoes).toContainEqual([RESTRITO, 'Peeling']);
    expect(JSON.stringify(atualizacoes)).not.toMatch(/Acne/);
    // a timeline da oportunidade, pela recepção: o mesmo
    const titulos = (await get(`/api/activities?dealId=${d}`, recepcao).expect(200)).body.items
      .filter((a: { type: string }) => a.type === 'deal_created' || a.type === 'deal_updated')
      .map((a: { payload: { title?: string } }) => a.payload.title);
    expect(titulos).toContain('Peeling');
    expect(JSON.stringify(titulos)).not.toMatch(/Acne/);
  });

  it('automações: tirar a condição sobre o título não devolve as execuções antigas', async () => {
    const a = (
      await post('/api/automations', owner, {
        name: 'Acne',
        trigger: 'deal.created',
        conditions: [{ field: 'title', op: 'contains', value: 'acne' }],
        action: 'create_task',
        actionConfig: { title: 'Ligar', dueInDays: 1 },
      }).expect(201)
    ).body.id as string;
    const rodar = async () => {
      const jobs = app.get(JobsService);
      for (let n = 0; n < 6; n += 1) {
        if ((await jobs.dispatchPending()).delivered === 0) break;
      }
    };
    await post('/api/deals', owner, { title: 'Acne', contactId: paciente }).expect(201);
    await rodar();
    const gestor = await papel(ws.workspaceId, 'gestor@veyra.test', ['automations:manage']);
    await enviar('patch', `/api/automations/${a}`, gestor, { conditions: [] }).expect(200);
    await post('/api/deals', owner, { title: 'Peeling', contactId: interessado }).expect(201);
    await rodar();
    const vistas = (await get('/api/automations/executions', gestor).expect(200)).body as {
      automationId: string;
    }[];
    // nenhuma: o gatilho é de oportunidade, a condição de antes não importa
    expect(vistas.filter((e) => e.automationId === a)).toHaveLength(0);
    expect(
      ((await get('/api/automations/executions', owner).expect(200)).body as unknown[]).length,
    ).toBe(2);
  });

  it('trilha: depois da desativação, o Owner vê a configuração do vertical, não as ações que dizem quem é paciente', async () => {
    await app.get(ClinicsActivationService).disable('acme');
    const dono = await loginAs('owner@veyra.test');
    const itens = await trilha(dono);
    expect(itens.some((i) => i.action === 'clinics.disabled')).toBe(true);
    expect(itens.some((i) => i.action === 'clinics.patient.created')).toBe(false);
  });

  it('trilha: a tarefa da automação sobre a oportunidade do paciente e o arquivo, para quem não tem a agenda', async () => {
    await post('/api/automations', owner, {
      name: 'Retorno',
      trigger: 'deal.created',
      action: 'create_task',
      actionConfig: { title: 'Ligar: {{title}}', dueInDays: 1 },
    }).expect(201);
    await post('/api/deals', owner, { title: 'Acne', contactId: paciente }).expect(201);
    const jobs = app.get(JobsService);
    for (let n = 0; n < 6; n += 1) {
      if ((await jobs.dispatchPending()).delivered === 0) break;
    }
    const { arquivo } = await comConteudoNaTrilha();
    for (const chaves of [['audit:read', 'clinics:schedule:read'], ['audit:read']]) {
      const leitor = await papel(ws.workspaceId, `auditor-${chaves.length}@veyra.test`, chaves);
      const itens = await trilha(leitor);
      // a linha inteira sai: a existência dela diria que a automação executou
      expect(itens.some((i) => i.action === 'task.created_by_automation')).toBe(false);
      expect(campo(itens, 'file.uploaded', arquivo, 'fileName')).toBe(RESTRITO);
    }
  });
});
