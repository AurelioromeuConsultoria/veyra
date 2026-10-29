import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import {
  FakeTemplateCatalog,
  META_TEMPLATE_CATALOG,
  type TemplateDaMeta,
} from '../../../channels/meta-templates.catalog';
import {
  META_TRANSPORT,
  type FetchOutcome,
  type MetaTransport,
  type ParametrosDoTemplate,
  type SendOutcome,
} from '../../../channels/meta.transport';
import { CryptoService } from '../../../common/crypto.service';
import { ConsentPurposesService } from '../../../consents/consent-purposes.service';
import { CHAVE } from '../../../content-use/restriction-locks';
import { EnvioDoNegocioService } from '../../../business-outbound/business-outbound.service';
import { JobsService } from '../../../jobs/jobs.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { TemplateVersionsService } from '../../../templates/template-versions.service';
import { createTestApp } from '../../../../test/integration/app';
import { TEST_DATABASE_URL } from '../../../../test/integration/db-url';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../../test/integration/fixtures';
import { resetDb } from '../../../../test/integration/harness';
import { esperarBloqueadosPor } from '../../../../test/integration/locks';
import type { AuthContext } from '../../../common/decorators';
import { ClinicsActivationService } from '../clinics-activation.service';
import { PermissionsService } from '../../../auth/permissions.service';
import { ClinicsOutreachPrecondition } from './clinics-outreach.precondition';
import { ClinicsOutreachService } from './clinics-outreach.service';
import { VarreduraDosPedidos } from './clinics-outreach.sweep';

/**
 * F4.2, a parte do Clinics (ADR-048 adendos 8 e 9): o pedido de envio da
 * clínica, a porta do E7, a validade, o lote e a varredura do texto. O
 * catálogo falso faz o papel da Meta e o transporte falso nunca envia.
 * Pacientes, nomes, números e textos FICTÍCIOS.
 */

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const WABA = '1001';
const PHONE = '100000000000001';
const NUMERO = '+5511988887777';

interface Session {
  cookieHeader: string;
  csrf: string;
}

/** O transporte falso: guarda o template enviado. */
class MetaFalsa implements MetaTransport {
  templates: { to: string; name: string; params: ParametrosDoTemplate }[] = [];
  async sendText(): Promise<SendOutcome> {
    return { ok: true, externalId: 'wamid.TEXTO' };
  }
  async sendTemplate(
    _credencial: unknown,
    to: string,
    template: { name: string; language: string },
    params: ParametrosDoTemplate,
  ): Promise<SendOutcome> {
    this.templates.push({ to, name: template.name, params });
    return { ok: true, externalId: `wamid.${this.templates.length}` };
  }
  async fetchMedia(): Promise<FetchOutcome> {
    return { ok: false, failure: { status: 400 } };
  }
}

const confirmacao = (texto: string): TemplateDaMeta => ({
  id: '5001',
  name: 'confirmacao_horario',
  language: 'pt_BR',
  status: 'APPROVED',
  category: 'UTILITY',
  parameterFormat: 'POSITIONAL',
  components: [{ type: 'BODY', text: texto }],
});
const reativacao: TemplateDaMeta = {
  id: '5002',
  name: 'reativacao_retorno',
  language: 'pt_BR',
  status: 'APPROVED',
  category: 'MARKETING',
  parameterFormat: 'POSITIONAL',
  components: [{ type: 'BODY', text: 'Ola {{1}}, que tal marcar o seu retorno?' }],
};
const TEXTO_DA_CONFIRMACAO = 'Ola {{1}}, confirma o seu horario em {{2}} as {{3}}?';

/** Uma segunda-feira ao menos uma semana à frente de hoje: o horário é futuro. */
function segundaFutura(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

describe('F4.2 — o envio iniciado pela clínica (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let observador: Client;
  const catalogo = new FakeTemplateCatalog();
  const meta = new MetaFalsa();

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: META_TEMPLATE_CATALOG, useValue: catalogo },
        { provide: META_TRANSPORT, useValue: meta },
      ],
    );
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
    observador = new Client({ connectionString: TEST_DATABASE_URL });
    await observador.connect();
  });
  afterAll(async () => {
    await observador.end();
    await app.close();
  });

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let owner: Session;
  let ownerB: Session;
  let authDono: AuthContext;
  let canal: string;
  let contato: string;
  let paciente: string;
  let servico: string;
  let profissional: string;
  let agendamento: string;
  let dataDoAgendamento: string;
  let finalidade: string;
  let versao: string;

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
  const post = (path: string, s: Session, body: unknown = {}, chave?: string) => {
    const r = request(http)
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    return (chave ? r.set('Idempotency-Key', chave) : r).send(body as object);
  };
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);
  const noWorkspace = <T>(workspaceId: string, fn: () => Promise<T>): Promise<T> => {
    const cls = app.get(ClsService);
    return cls.run(() => {
      cls.set('workspaceId', workspaceId);
      return fn();
    });
  };

  /** Um papel personalizado no workspace A, com as chaves dadas, e a sessão de quem o tem. */
  const comChaves = async (email: string, chaves: string[]): Promise<Session> => {
    const papel = await prisma.raw.role.create({
      data: { workspaceId: wsA.workspaceId, name: `Papel ${email}` },
    });
    await prisma.raw.rolePermission.createMany({
      data: chaves.map((permissionKey) => ({
        workspaceId: wsA.workspaceId,
        roleId: papel.id,
        permissionKey,
      })),
    });
    const user = await createUserFixture(prisma, email);
    await createMembershipFixture(prisma, wsA.workspaceId, user, papel.id);
    return login(email);
  };

  const preparar = (body: unknown, s: Session = owner) =>
    post('/api/clinics/outreach/requests', s, body).expect(200);
  const item = (requestId: string, mudanca: Record<string, unknown> = {}) => ({
    requestId,
    channelId: canal,
    number: NUMERO,
    templateVersionId: versao,
    purposeId: finalidade,
    ...mudanca,
  });
  const previa = (items: unknown[], s: Session = owner) =>
    post('/api/clinics/outreach/preview', s, { items });
  const aprovar = (items: unknown[], s: Session = owner, chave: string = randomUUID()) =>
    post('/api/clinics/outreach/approve', s, { items }, chave);
  const ler = (id: string, s: Session = owner) => get(`/api/clinics/outreach/requests/${id}`, s);

  /** O pedido de confirmação do agendamento, pronto para a prévia. */
  const pedidoDoAgendamento = async (id: string = agendamento): Promise<string> => {
    const res = await preparar({ kind: 'confirmation', targets: [{ appointmentId: id }] });
    const [r] = res.body.items;
    if (!r.ok) throw new Error(`o pedido foi recusado: ${r.reason}`);
    return r.request.id as string;
  };
  /** Prévia e aprovação de um pedido; devolve a mensagem. */
  const aprovado = async (requestId: string, mudanca: Record<string, unknown> = {}) => {
    const p = (await previa([item(requestId, mudanca)]).expect(200)).body.items[0];
    if (!p.ok) throw new Error(`a prévia recusou: ${p.reason}`);
    const r = (
      await aprovar([
        { ...item(requestId, mudanca), expiresAt: p.expiresAt, approvalHash: p.approvalHash },
      ]).expect(200)
    ).body.items[0];
    if (r.state !== 'approved') throw new Error(`recusado: ${r.reason}`);
    return r.messageId as string;
  };
  const drain = async () => {
    for (let i = 0; i < 5; i++) {
      const { delivered } = await app.get(JobsService).dispatchPending();
      if (delivered === 0) break;
    }
  };
  const despacho = (messageId: string) =>
    prisma.raw.messageDispatch.findFirst({ where: { messageId } });
  const pedidoNoBanco = (id: string) =>
    prisma.raw.clinicsOutreachRequest.findFirst({ where: { id } });
  /** Uma finalidade nova, com a versão da confirmação revisada para ela e o consentimento do número. */
  const finalidadeNova = async (
    key: string,
    fields: string[],
    vinculos: Record<string, string>,
  ) => {
    const purposeId = (
      await app.get(ConsentPurposesService).criarVersao('acme', {
        key,
        description: `Finalidade ${key}`,
        category: 'utility',
        fields,
      })
    ).purposeId;
    await post(
      `/api/contacts/${contato}/consents`,
      owner,
      { channelId: canal, number: NUMERO, purposeId, origin: 'in_person' },
      randomUUID(),
    ).expect(201);
    const registro = await app.get(TemplateVersionsService).registrar('acme', {
      channelId: canal,
      name: 'confirmacao_horario',
      language: 'pt_BR',
      vinculos,
    });
    if (registro.resultado !== 'registrada') throw new Error('o template não foi registrado');
    await post(`/api/templates/versions/${registro.versionId}/reviews`, owner, {
      purposeId,
      contentHash: registro.contentHash,
    }).expect(201);
    return { purposeId, versionId: registro.versionId };
  };

  beforeEach(async () => {
    catalogo.limpar();
    meta.templates = [];
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const dono = await createUserFixture(prisma, 'dono@veyra.test');
    authDono = {
      userId: dono,
      email: 'dono@veyra.test',
      membershipId: await createMembershipFixture(prisma, wsA.workspaceId, dono, wsA.roles.owner),
      workspaceId: wsA.workspaceId,
      sessionId: 'teste',
    };
    const donoB = await createUserFixture(prisma, 'dono-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, donoB, wsB.roles.owner);
    await app.get(ClinicsActivationService).enable('acme');
    await app.get(ClinicsActivationService).enable('beta');
    owner = await login('dono@veyra.test');
    ownerB = await login('dono-b@veyra.test');

    const crypto = app.get(CryptoService);
    canal = (
      await prisma.raw.channel.create({
        data: { workspaceId: wsA.workspaceId, type: 'whatsapp', name: 'WhatsApp' },
      })
    ).id;
    await prisma.raw.channelCredential.create({
      data: {
        workspaceId: wsA.workspaceId,
        channelId: canal,
        phoneNumberId: PHONE,
        businessAccountId: WABA,
        tokenCipher: crypto.encrypt('token-ficticio'),
      },
    });

    // o catálogo da clínica e o paciente, pela API, como a clínica os montaria
    servico = (
      await post('/api/clinics/services', owner, {
        name: 'Limpeza de pele',
        durationMin: 60,
      }).expect(201)
    ).body.id;
    profissional = (
      await post('/api/clinics/professionals', owner, { name: 'Bruna Profissional' }).expect(201)
    ).body.id;
    const unidade = (await prisma.raw.clinicsUnit.findFirst({
      where: { workspaceId: wsA.workspaceId },
    }))!.id;
    await request(http)
      .put(`/api/clinics/professionals/${profissional}/profile`)
      .set('Origin', ORIGIN)
      .set('Cookie', owner.cookieHeader)
      .set('x-csrf-token', owner.csrf)
      .send({
        name: 'Bruna Profissional',
        serviceIds: [servico],
        intervals: [1, 2, 3, 4, 5].map((weekday) => ({
          unitId: unidade,
          weekday,
          startMinute: 480,
          endMinute: 1080,
        })),
      })
      .expect(200);
    contato = (
      await post('/api/contacts', owner, { name: 'Ana Ficticia Souza', phones: [NUMERO] }).expect(
        201,
      )
    ).body.id;
    paciente = (await post('/api/clinics/patients', owner, { contactId: contato }).expect(201)).body
      .id;
    dataDoAgendamento = segundaFutura();
    agendamento = (
      await post('/api/clinics/appointments', owner, {
        patientId: paciente,
        professionalId: profissional,
        serviceId: servico,
        date: dataDoAgendamento,
        time: '09:00',
      }).expect(201)
    ).body.id;

    // a finalidade da confirmação, com o conteúdo mínimo, e a versão revisada
    catalogo.publicar(WABA, confirmacao(TEXTO_DA_CONFIRMACAO));
    const pronta = await finalidadeNova(
      'clinics_confirmacao',
      ['contato.primeiro_nome', 'clinics.data', 'clinics.hora'],
      { 'body.1': 'contato.primeiro_nome', 'body.2': 'clinics.data', 'body.3': 'clinics.hora' },
    );
    finalidade = pronta.purposeId;
    versao = pronta.versionId;
  });

  const dataDaMensagem = () => dataDoAgendamento.split('-').reverse().join('/');

  // ── O fluxo ─────────────────────────────────────────────────────────────

  it('o fluxo inteiro: candidato, pedido, prévia com o conteúdo mínimo, aprovação com o corpo neutro, envio e a varredura do texto', async () => {
    const candidatos = (
      await get(
        `/api/clinics/outreach/candidates?kind=confirmation&date=${dataDoAgendamento}&days=1`,
        owner,
      ).expect(200)
    ).body;
    expect(candidatos).toEqual([
      expect.objectContaining({
        appointmentId: agendamento,
        localDate: dataDoAgendamento,
        localStart: '09:00',
        patientName: 'Ana Ficticia Souza',
        numbers: [NUMERO],
        blocked: null,
        request: null,
      }),
    ]);

    const pedido = await pedidoDoAgendamento();
    // repetir o pedido devolve o MESMO rascunho
    expect(await pedidoDoAgendamento()).toBe(pedido);

    const p = (await previa([item(pedido)]).expect(200)).body.items[0];
    expect(p).toMatchObject({
      ok: true,
      text: `Ola Ana, confirma o seu horario em ${dataDaMensagem()} as 09:00?`,
      values: { 'body.1': 'Ana', 'body.2': dataDaMensagem(), 'body.3': '09:00' },
    });
    // o prazo: o início menos duas horas (o limite da origem, abaixo do teto de 24 h)
    const inicio = (await prisma.raw.clinicsAppointment.findFirst({ where: { id: agendamento } }))!
      .startsAt;
    expect(Date.parse(p.expiresAt)).toBeLessThanOrEqual(inicio.getTime() - 2 * 60 * 60_000);
    // o texto mora no pedido, e não no Core
    expect((await pedidoNoBanco(pedido))?.renderedText).toBe(p.text);

    const r = (
      await aprovar([{ ...item(pedido), expiresAt: p.expiresAt, approvalHash: p.approvalHash }])
    ).body.items[0];
    expect(r).toMatchObject({ requestId: pedido, state: 'approved', reason: null });
    expect(JSON.stringify(r)).not.toContain('Ana');
    const mensagem = await prisma.raw.message.findFirst({ where: { id: r.messageId } });
    expect(mensagem?.body).toBe('Mensagem por template');
    expect((await ler(pedido).expect(200)).body).toMatchObject({
      state: 'pending',
      number: NUMERO,
    });

    await drain();
    expect(meta.templates).toEqual([
      expect.objectContaining({
        to: NUMERO,
        params: {
          header: [],
          body: [{ text: 'Ana' }, { text: dataDaMensagem() }, { text: '09:00' }],
        },
      }),
    ]);
    expect((await ler(pedido).expect(200)).body).toMatchObject({ state: 'sent', text: p.text });

    // a varredura apaga o texto do desfecho terminal; repetir não muda nada
    const varredura = app.get(VarreduraDosPedidos);
    expect(await varredura.varrer()).toBe(1);
    expect(await varredura.varrer()).toBe(0);
    const depois = await pedidoNoBanco(pedido);
    expect(depois).toMatchObject({ renderedText: null, activeMark: true });
    expect(depois?.textClearedAt).toBeInstanceOf(Date);
    expect((await ler(pedido).expect(200)).body).toMatchObject({ state: 'sent', text: null });
    // o apagado não volta
    await expect(
      prisma.raw.clinicsOutreachRequest.updateMany({
        where: { id: pedido },
        data: { renderedText: 'de volta' },
      }),
    ).rejects.toThrow(/não volta|text_check/);
  });

  // ── A repetição e a remarcação ──────────────────────────────────────────

  it('enviado bloqueia para sempre: nem um pedido novo nem a aprovação repetida geram outra mensagem', async () => {
    const pedido = await pedidoDoAgendamento();
    const p = (await previa([item(pedido)]).expect(200)).body.items[0];
    const aprovacao = { ...item(pedido), expiresAt: p.expiresAt, approvalHash: p.approvalHash };
    const primeira = (await aprovar([aprovacao]).expect(200)).body.items[0];
    await drain();
    // a mesma aprovação, com outra chave: a mesma mensagem
    const repetida = (await aprovar([aprovacao]).expect(200)).body.items[0];
    expect(repetida).toMatchObject({ state: 'approved', messageId: primeira.messageId });
    // o pedido novo para o mesmo alvo: recusado
    const novo = (
      await preparar({ kind: 'confirmation', targets: [{ appointmentId: agendamento }] })
    ).body.items[0];
    expect(novo).toMatchObject({ ok: false, reason: 'request_exists' });
    // a prévia do pedido já aprovado: não é rascunho
    expect((await previa([item(pedido)]).expect(200)).body.items[0]).toMatchObject({
      ok: false,
      reason: 'request_not_draft',
    });
    expect(await prisma.raw.message.count()).toBe(1);
    expect(meta.templates).toHaveLength(1);
    // uma prévia atrasada, que leu "rascunho" antes da aprovação, não sobrescreve o texto aprovado
    const aprovadoNoPedido = (await pedidoNoBanco(pedido))?.renderedText;
    const linha = (await pedidoNoBanco(pedido))!;
    await noWorkspace(wsA.workspaceId, () =>
      (
        app.get(ClinicsOutreachService) as unknown as {
          gravarTextoDaPrevia(a: AuthContext, p: typeof linha, t: string): Promise<void>;
        }
      ).gravarTextoDaPrevia(authDono, linha, 'outro texto ficticio'),
    );
    expect((await pedidoNoBanco(pedido))?.renderedText).toBe(aprovadoNoPedido);
    // o candidato mostra o bloqueio
    const [candidato] = (
      await get(
        `/api/clinics/outreach/candidates?kind=confirmation&date=${dataDoAgendamento}&days=1`,
        owner,
      ).expect(200)
    ).body;
    expect(candidato).toMatchObject({
      blocked: 'request_exists',
      request: { id: pedido, state: 'sent' },
    });
  });

  it('incerto bloqueia para sempre, e a invalidação mantém a marca dele', async () => {
    const pedido = await pedidoDoAgendamento();
    const messageId = await aprovado(pedido);
    await prisma.raw.messageDispatch.updateMany({
      where: { messageId },
      data: { state: 'unknown_after_dispatch', dispatchedAt: new Date() },
    });
    expect((await ler(pedido).expect(200)).body.state).toBe('uncertain');
    expect(
      (await preparar({ kind: 'confirmation', targets: [{ appointmentId: agendamento }] })).body
        .items[0],
    ).toMatchObject({ ok: false, reason: 'request_exists' });
    // cancelar o agendamento não tira a marca do incerto
    await post(`/api/clinics/appointments/${agendamento}/status`, owner, {
      to: 'canceled',
      cancelReason: 'patient_request',
    }).expect(201);
    expect((await pedidoNoBanco(pedido))?.activeMark).toBe(true);
    expect((await despacho(messageId))?.state).toBe('unknown_after_dispatch');
    // nada mudou para o incerto: a trilha da invalidação não o repete
    expect(
      await prisma.raw.auditLog.count({
        where: { action: 'clinics.outreach.invalidated', entityId: pedido },
      }),
    ).toBe(0);
  });

  it('remarcar invalida o pedido do horário antigo: o despacho é cancelado, a marca sai, e o horário novo exige pedido e aprovação novos', async () => {
    const pedido = await pedidoDoAgendamento();
    const p = (await previa([item(pedido)]).expect(200)).body.items[0];
    const aprovacao = { ...item(pedido), expiresAt: p.expiresAt, approvalHash: p.approvalHash };
    const { messageId } = (await aprovar([aprovacao]).expect(200)).body.items[0];
    await post(`/api/clinics/appointments/${agendamento}/reschedule`, owner, {
      date: dataDoAgendamento,
      time: '10:00',
    }).expect(201);
    expect(await despacho(messageId)).toMatchObject({
      state: 'canceled',
      errorCode: 'origin_invalidated',
    });
    expect(await pedidoNoBanco(pedido)).toMatchObject({ activeMark: null });
    expect((await ler(pedido).expect(200)).body.state).toBe('not_sent');
    const trilha = await prisma.raw.auditLog.findFirst({
      where: { action: 'clinics.outreach.invalidated', entityId: pedido },
    });
    expect(trilha?.after).toMatchObject({ state: 'not_sent', activeMark: null });
    // repetir a aprovação antiga não cria outra mensagem
    expect((await aprovar([aprovacao]).expect(200)).body.items[0]).toMatchObject({
      state: 'approved',
      messageId,
    });
    await drain();
    expect(meta.templates).toEqual([]);
    // o horário novo: outro pedido, que sai com a hora nova
    const novo = await pedidoDoAgendamento();
    expect(novo).not.toBe(pedido);
    const novaMensagem = await aprovado(novo);
    await drain();
    expect((await despacho(novaMensagem))?.state).toBe('sent');
    expect(meta.templates[0].params.body[2]).toEqual({ text: '10:00' });
    // a marca, uma vez tirada, não volta
    await expect(
      prisma.raw.clinicsOutreachRequest.updateMany({
        where: { id: pedido },
        data: { activeMark: true },
      }),
    ).rejects.toThrow(/não volta a contar/);
  });

  it('cancelar, faltar ou atender invalida; confirmar não', async () => {
    const pedido = await pedidoDoAgendamento();
    const messageId = await aprovado(pedido);
    await post(`/api/clinics/appointments/${agendamento}/status`, owner, {
      to: 'confirmed',
    }).expect(201);
    expect((await despacho(messageId))?.state).toBe('reserved');
    expect((await pedidoNoBanco(pedido))?.activeMark).toBe(true);
    await post(`/api/clinics/appointments/${agendamento}/status`, owner, {
      to: 'no_show',
    }).expect(201);
    expect(await despacho(messageId)).toMatchObject({
      state: 'canceled',
      errorCode: 'origin_invalidated',
    });
    expect((await pedidoNoBanco(pedido))?.activeMark).toBeNull();
    // o atendimento também: outro agendamento, outro pedido
    const outro = (
      await post('/api/clinics/appointments', owner, {
        patientId: paciente,
        professionalId: profissional,
        serviceId: servico,
        date: dataDoAgendamento,
        time: '14:00',
      }).expect(201)
    ).body.id;
    const doOutro = await pedidoDoAgendamento(outro);
    await post(`/api/clinics/appointments/${outro}/attendance`, owner, { packageId: null }).expect(
      201,
    );
    expect((await pedidoNoBanco(doOutro))?.activeMark).toBeNull();
    expect((await ler(doOutro).expect(200)).body.state).toBe('not_sent');
  });

  it('o despacho que chega depois da mudança ainda passa pela porta, que diz "não vale"', async () => {
    const pedido = await pedidoDoAgendamento();
    const messageId = await aprovado(pedido);
    // a mudança por fora do caminho que cancela: só a porta pode recusar
    await prisma.raw.clinicsAppointment.updateMany({
      where: { id: agendamento },
      data: { status: 'canceled', cancelReason: 'clinic_request' },
    });
    await drain();
    expect(meta.templates).toEqual([]);
    expect(await despacho(messageId)).toMatchObject({
      state: 'failed_permanent',
      errorCode: 'precondition_failed',
    });
  });

  it.each([
    ['o início mudou por fora', 'inicio'],
    ['a marca do pedido saiu', 'marca'],
    ['o vertical foi desativado', 'desativado'],
  ] as const)('a porta diz "não vale" quando %s, e nada sai', async (_, caso) => {
    const pedido = await pedidoDoAgendamento();
    const messageId = await aprovado(pedido);
    if (caso === 'inicio') {
      const atual = (await prisma.raw.clinicsAppointment.findFirst({
        where: { id: agendamento },
      }))!;
      await prisma.raw.clinicsAppointment.updateMany({
        where: { id: agendamento },
        data: {
          startsAt: new Date(atual.startsAt.getTime() + 60 * 60_000),
          endsAt: new Date(atual.endsAt.getTime() + 60 * 60_000),
        },
      });
    } else if (caso === 'marca') {
      await prisma.raw.clinicsOutreachRequest.updateMany({
        where: { id: pedido },
        data: { activeMark: null },
      });
    } else {
      await app.get(ClinicsActivationService).disable('acme');
    }
    await drain();
    expect(meta.templates).toEqual([]);
    expect(await despacho(messageId)).toMatchObject({
      state: 'failed_permanent',
      errorCode: 'precondition_failed',
    });
  });

  // ── A ordem das travas ──────────────────────────────────────────────────

  it.each(['o estado', 'a remarcação', 'o atendimento', 'o cancelamento do retorno'] as const)(
    'a mudança (%s) pega a `validity:` exclusiva ANTES de qualquer linha',
    async (caminho) => {
      const doRetorno = caminho === 'o cancelamento do retorno';
      const retorno = doRetorno
        ? ((
            await post('/api/clinics/returns', owner, {
              patientId: paciente,
              serviceId: servico,
              dueDate: '2026-01-05',
            }).expect(201)
          ).body.id as string)
        : null;
      const chave = doRetorno
        ? `validity:clinics.return:${retorno}`
        : `validity:clinics.appointment:${agendamento}`;
      const [tabela, linha] = doRetorno
        ? ['ClinicsReturn', retorno]
        : ['ClinicsAppointment', agendamento];
      const acao = () =>
        caminho === 'o estado'
          ? post(`/api/clinics/appointments/${agendamento}/status`, owner, {
              to: 'canceled',
              cancelReason: 'patient_request',
            })
          : caminho === 'a remarcação'
            ? post(`/api/clinics/appointments/${agendamento}/reschedule`, owner, {
                date: dataDoAgendamento,
                time: '10:00',
              })
            : caminho === 'o atendimento'
              ? post(`/api/clinics/appointments/${agendamento}/attendance`, owner, {
                  packageId: null,
                })
              : post(`/api/clinics/returns/${retorno}/cancel`, owner, {
                  reason: 'patient_declined',
                });
      const trava = new Client({ connectionString: TEST_DATABASE_URL });
      await trava.connect();
      try {
        await trava.query('BEGIN');
        // como a guarda de um despacho: a chave do alvo, compartilhada
        await trava.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
          CHAVE.entidade(wsA.workspaceId, chave),
        ]);
        const mudanca = acao().then((r) => r);
        await esperarBloqueadosPor(trava, 1, { descricao: `a mudança (${caminho})` });
        // esperando a trava, a mudança ainda não tocou em linha nenhuma do alvo
        const livre = new Client({ connectionString: TEST_DATABASE_URL });
        await livre.connect();
        try {
          await livre.query('BEGIN');
          await livre.query(`SELECT 1 FROM "${tabela}" WHERE "id" = $1 FOR UPDATE NOWAIT`, [linha]);
          await livre.query('ROLLBACK');
        } finally {
          await livre.end();
        }
        await trava.query('COMMIT');
        expect((await mudanca).status).toBe(201);
      } finally {
        await trava.end();
      }
    },
  );

  it('fumaça: a aprovação e a mudança do mesmo agendamento, juntas, terminam sem impasse e sem envio do que não vale', async () => {
    const pedido = await pedidoDoAgendamento();
    const p = (await previa([item(pedido)]).expect(200)).body.items[0];
    const [aprovacao, mudanca] = await Promise.all([
      aprovar([{ ...item(pedido), expiresAt: p.expiresAt, approvalHash: p.approvalHash }]),
      post(`/api/clinics/appointments/${agendamento}/status`, owner, {
        to: 'canceled',
        cancelReason: 'patient_request',
      }),
    ]);
    expect(mudanca.status).toBe(201);
    expect(aprovacao.status).toBe(200);
    const [r] = aprovacao.body.items;
    // ou a aprovação chegou antes (e o cancelamento a cancelou), ou depois (e foi recusada)
    if (r.state === 'approved') {
      expect(await despacho(r.messageId)).toMatchObject({
        state: 'canceled',
        errorCode: 'origin_invalidated',
      });
    } else {
      expect(r.reason).toBe('precondition_failed');
    }
    await drain();
    expect(meta.templates).toEqual([]);
  });

  // ── O prazo ─────────────────────────────────────────────────────────────

  it('a confirmação a duas horas ou menos do início não é elegível, e o candidato diz por quê', async () => {
    // o horário daqui a uma hora, gravado direto (a agenda exige o expediente)
    const proximo = await prisma.raw.clinicsAppointment.create({
      data: {
        workspaceId: wsA.workspaceId,
        patientId: paciente,
        professionalId: profissional,
        serviceId: servico,
        unitId: (await prisma.raw.clinicsUnit.findFirst({
          where: { workspaceId: wsA.workspaceId },
        }))!.id,
        startsAt: new Date(Date.now() + 60 * 60_000),
        endsAt: new Date(Date.now() + 2 * 60 * 60_000),
        createdByMembershipId: authDono.membershipId as string,
      },
    });
    const res = (await preparar({ kind: 'confirmation', targets: [{ appointmentId: proximo.id }] }))
      .body.items[0];
    expect(res).toMatchObject({ ok: false, reason: 'starts_too_soon' });
    const hoje = (await get(`/api/clinics/outreach/candidates?kind=confirmation&days=2`, owner))
      .body as { appointmentId: string; blocked: string | null }[];
    expect(hoje.find((c) => c.appointmentId === proximo.id)?.blocked).toBe('starts_too_soon');
    expect(await prisma.raw.clinicsOutreachRequest.count()).toBe(0);
  });

  // ── As permissões ───────────────────────────────────────────────────────

  it('preparar, a prévia e a aprovação exigem a leitura E a escrita da agenda; a porta confere as duas antes de consultar', async () => {
    const pedido = await pedidoDoAgendamento();
    const CORE = ['conversations:write', 'contacts:read', 'consents:read'];
    const soEscrita = await comChaves('escrita@veyra.test', [...CORE, 'clinics:schedule:write']);
    await previa([item(pedido)], soEscrita).expect(403);
    await aprovar(
      [{ ...item(pedido), expiresAt: new Date().toISOString(), approvalHash: 'a'.repeat(64) }],
      soEscrita,
    ).expect(403);
    await post('/api/clinics/outreach/requests', soEscrita, {
      kind: 'confirmation',
      targets: [{ appointmentId: agendamento }],
    }).expect(403);
    // a segunda camada: o serviço do Core, chamado sem a rota, confere a porta
    const membership = await prisma.raw.membership.findFirst({
      where: { user: { email: 'escrita@veyra.test' } },
    });
    const semLeitura: AuthContext = { ...authDono, membershipId: membership!.id };
    // a porta não é nem consultada sem as permissões dela
    const consultas = jest.spyOn(app.get(ClinicsOutreachPrecondition), 'check');
    const doCore = await noWorkspace(wsA.workspaceId, () =>
      app.get(EnvioDoNegocioService).previa(
        semLeitura,
        {
          items: [
            {
              originRef: `clinics.outreach:${pedido}`,
              channelId: canal,
              contactId: contato,
              number: NUMERO,
              templateVersionId: versao,
              purposeId: finalidade,
            },
          ],
        },
        'vertical',
      ),
    );
    expect(doCore.items[0]).toMatchObject({ ok: false, reason: 'precondition_unknown' });
    expect(consultas).not.toHaveBeenCalled();
    expect((await pedidoNoBanco(pedido))?.renderedText).toBeNull();
    // o REPLAY: a mesma prévia, já aprovada pelo dono, repetida por quem não
    // tem a leitura da agenda — a permissão vem antes da busca pela aprovação
    const p = (await previa([item(pedido)]).expect(200)).body.items[0];
    const aprovacao = {
      originRef: `clinics.outreach:${pedido}`,
      channelId: canal,
      contactId: contato,
      number: NUMERO,
      templateVersionId: versao,
      purposeId: finalidade,
      expiresAt: p.expiresAt,
      approvalHash: p.approvalHash,
    };
    const dono = await noWorkspace(wsA.workspaceId, () =>
      app.get(EnvioDoNegocioService).aprovar(authDono, { items: [aprovacao] }, 'vertical'),
    );
    expect(dono.items[0]).toMatchObject({ state: 'approved' });
    const replay = await noWorkspace(wsA.workspaceId, () =>
      app.get(EnvioDoNegocioService).aprovar(semLeitura, { items: [aprovacao] }, 'vertical'),
    );
    expect(replay.items[0]).toMatchObject({
      state: 'refused',
      messageId: null,
      reason: 'precondition_unknown',
    });
    // a falha inesperada NA PRÓPRIA conferência de permissão: o fallback do lote
    // não devolve a aprovação existente a quem não tem a permissão
    jest
      .spyOn(app.get(PermissionsService), 'membershipHas')
      .mockRejectedValueOnce(new Error('falha simulada'));
    const comFalha = await noWorkspace(wsA.workspaceId, () =>
      app.get(EnvioDoNegocioService).aprovar(semLeitura, { items: [aprovacao] }, 'vertical'),
    );
    expect(comFalha.items[0]).toMatchObject({
      state: 'refused',
      messageId: null,
      reason: 'not_processed',
    });
  });

  it('a leitura do pedido só com a agenda não mostra o número completo nem o motivo', async () => {
    const pedido = await pedidoDoAgendamento();
    const messageId = await aprovado(pedido);
    await post(
      `/api/contacts/${contato}/stop`,
      owner,
      { number: NUMERO, origin: 'phone' },
      randomUUID(),
    ).expect(201);
    expect((await despacho(messageId))?.errorCode).toBe('stop_requested');
    const soAgenda = await comChaves('agenda@veyra.test', ['clinics:schedule:read']);
    const lido = (await ler(pedido, soAgenda).expect(200)).body;
    expect(lido).toMatchObject({ state: 'not_sent', number: '•••7777', reason: null });
    expect(JSON.stringify(lido)).not.toContain(NUMERO);
    const comTudo = (await ler(pedido).expect(200)).body;
    expect(comTudo).toMatchObject({ number: NUMERO, reason: 'stop_requested' });
    // sem a agenda, nem a leitura
    const semAgenda = await comChaves('crm@veyra.test', ['contacts:read', 'consents:read']);
    await ler(pedido, semAgenda).expect(403);
  });

  // ── A finalidade e o catálogo ───────────────────────────────────────────

  it('a finalidade precisa ser a do tipo, sem campo além do conteúdo mínimo', async () => {
    const pedido = await pedidoDoAgendamento();
    const comNome = await finalidadeNova(
      'clinics_confirmacao',
      ['contato.nome', 'clinics.data', 'clinics.hora'],
      { 'body.1': 'contato.nome', 'body.2': 'clinics.data', 'body.3': 'clinics.hora' },
    );
    expect(
      (
        await previa([
          item(pedido, { purposeId: comNome.purposeId, templateVersionId: comNome.versionId }),
        ]).expect(200)
      ).body.items[0],
    ).toMatchObject({ ok: false, reason: 'purpose_not_allowed' });
    const outra = await finalidadeNova(
      'lembrete',
      ['contato.primeiro_nome', 'clinics.data', 'clinics.hora'],
      { 'body.1': 'contato.primeiro_nome', 'body.2': 'clinics.data', 'body.3': 'clinics.hora' },
    );
    expect(
      (
        await previa([
          item(pedido, { purposeId: outra.purposeId, templateVersionId: outra.versionId }),
        ]).expect(200)
      ).body.items[0],
    ).toMatchObject({ ok: false, reason: 'purpose_not_allowed' });
  });

  it('o texto com o nome de um serviço do catálogo é recusado na prévia (apoio à revisão)', async () => {
    catalogo.publicar(
      WABA,
      confirmacao('Ola {{1}}, confirma a sua limpeza de pele em {{2}} as {{3}}?'),
    );
    const outra = await finalidadeNova(
      'clinics_confirmacao',
      ['contato.primeiro_nome', 'clinics.data', 'clinics.hora'],
      { 'body.1': 'contato.primeiro_nome', 'body.2': 'clinics.data', 'body.3': 'clinics.hora' },
    );
    const pedido = await pedidoDoAgendamento();
    expect(
      (
        await previa([
          item(pedido, { purposeId: outra.purposeId, templateVersionId: outra.versionId }),
        ]).expect(200)
      ).body.items[0],
    ).toMatchObject({ ok: false, reason: 'catalog_name_in_text' });
    expect((await pedidoNoBanco(pedido))?.renderedText).toBeNull();
  });

  it('o catálogo que muda entre a prévia e a aprovação: a aprovação confere o texto exato de agora e recusa', async () => {
    const pedido = await pedidoDoAgendamento();
    const p = (await previa([item(pedido)]).expect(200)).body.items[0];
    expect(p.ok).toBe(true);
    // um serviço novo cujo nome aparece no texto fixo
    await post('/api/clinics/services', owner, { name: 'Horario', durationMin: 30 }).expect(201);
    const r = (
      await aprovar([{ ...item(pedido), expiresAt: p.expiresAt, approvalHash: p.approvalHash }])
    ).body.items[0];
    expect(r).toMatchObject({ state: 'refused', reason: 'catalog_name_in_text' });
    expect(await prisma.raw.message.count()).toBe(0);
  });

  // ── As opções do envio e o transporte (F4.4) ────────────────────────────

  it('as opções do envio: só as versões revisadas para a finalidade do tipo, com o conteúdo mínimo; e o transporte não é o simulado fora de staging', async () => {
    const opcoes = (await get('/api/clinics/outreach/options?kind=confirmation', owner).expect(200))
      .body as { channelId: string; templateVersionId: string; purposeId: string }[];
    expect(opcoes).toEqual([
      expect.objectContaining({
        channelId: canal,
        channelName: 'WhatsApp',
        templateVersionId: versao,
        purposeId: finalidade,
      }),
    ]);
    // a finalidade com o nome inteiro não é opção (o conteúdo mínimo)
    const comNome = await finalidadeNova(
      'clinics_confirmacao',
      ['contato.nome', 'clinics.data', 'clinics.hora'],
      { 'body.1': 'contato.nome', 'body.2': 'clinics.data', 'body.3': 'clinics.hora' },
    );
    const depois = (await get('/api/clinics/outreach/options?kind=confirmation', owner).expect(200))
      .body as { purposeId: string }[];
    expect(depois.some((o) => o.purposeId === comNome.purposeId)).toBe(false);
    // sem finalidade de reativação, nenhuma opção
    expect(
      (await get('/api/clinics/outreach/options?kind=reactivation', owner).expect(200)).body,
    ).toEqual([]);
    // só quem pode enviar vê o cardápio: sem escrever nas conversas, nem com as outras quatro
    const soAgenda = await comChaves('agenda2@veyra.test', ['clinics:schedule:read']);
    await get('/api/clinics/outreach/options?kind=confirmation', soAgenda).expect(403);
    const semEscrita = await comChaves('quatro@veyra.test', [
      'clinics:schedule:read',
      'clinics:schedule:write',
      'contacts:read',
      'consents:read',
    ]);
    await get('/api/clinics/outreach/options?kind=confirmation', semEscrita).expect(403);
    // o cardápio é do workspace: o outro não vê o canal nem a versão daqui (P0),
    // nem com uma finalidade da mesma chave no dele (as consultas seguintes rodam)
    await app.get(ConsentPurposesService).criarVersao('beta', {
      key: 'clinics_confirmacao',
      description: 'Confirmação do outro workspace',
      category: 'utility',
      fields: ['contato.primeiro_nome', 'clinics.data', 'clinics.hora'],
    });
    expect(
      (await get('/api/clinics/outreach/options?kind=confirmation', ownerB).expect(200)).body,
    ).toEqual([]);
    // o transporte destes testes não é o simulado de staging; quem lê a agenda
    // pergunta pela rota do vertical, quem escreve nas conversas, pela do Core
    expect((await get('/api/business-outbound/transport', owner).expect(200)).body).toEqual({
      simulated: false,
    });
    expect((await get('/api/clinics/outreach/transport', soAgenda).expect(200)).body).toEqual({
      simulated: false,
    });
    await get('/api/business-outbound/transport', soAgenda).expect(403);
    const semAgenda = await comChaves('contatos@veyra.test', ['contacts:read']);
    await get('/api/clinics/outreach/transport', semAgenda).expect(403);
  });

  // ── A reativação ────────────────────────────────────────────────────────

  it('a reativação: o retorno vencido é candidato, a mensagem leva só o primeiro nome, e vincular o retorno invalida', async () => {
    catalogo.publicar(WABA, reativacao);
    const purposeId = (
      await app.get(ConsentPurposesService).criarVersao('acme', {
        key: 'clinics_reativacao',
        description: 'Convite para o retorno',
        category: 'marketing',
        fields: ['contato.primeiro_nome'],
      })
    ).purposeId;
    await post(
      `/api/contacts/${contato}/consents`,
      owner,
      { channelId: canal, number: NUMERO, purposeId, origin: 'in_person' },
      randomUUID(),
    ).expect(201);
    const registro = await app.get(TemplateVersionsService).registrar('acme', {
      channelId: canal,
      name: 'reativacao_retorno',
      language: 'pt_BR',
      vinculos: { 'body.1': 'contato.primeiro_nome' },
    });
    if (registro.resultado !== 'registrada') throw new Error('o template não foi registrado');
    await post(`/api/templates/versions/${registro.versionId}/reviews`, owner, {
      purposeId,
      contentHash: registro.contentHash,
    }).expect(201);
    const retorno = (
      await post('/api/clinics/returns', owner, {
        patientId: paciente,
        serviceId: servico,
        dueDate: '2026-01-05',
      }).expect(201)
    ).body.id;
    const candidatos = (
      await get('/api/clinics/outreach/candidates?kind=reactivation', owner).expect(200)
    ).body;
    expect(candidatos).toEqual([
      expect.objectContaining({ returnId: retorno, dueDate: '2026-01-05', blocked: null }),
    ]);
    const [r] = (await preparar({ kind: 'reactivation', targets: [{ returnId: retorno }] })).body
      .items;
    expect(r.ok).toBe(true);
    const doRetorno = { purposeId, templateVersionId: registro.versionId };
    const p = (await previa([item(r.request.id, doRetorno)]).expect(200)).body.items[0];
    expect(p).toMatchObject({ ok: true, text: 'Ola Ana, que tal marcar o seu retorno?' });
    // o prazo da reativação: 24 horas a partir do pedido, no máximo
    expect(Date.parse(p.expiresAt) - Date.parse(r.request.createdAt)).toBeLessThanOrEqual(
      24 * 60 * 60_000,
    );
    const { messageId } = (
      await aprovar([
        { ...item(r.request.id, doRetorno), expiresAt: p.expiresAt, approvalHash: p.approvalHash },
      ]).expect(200)
    ).body.items[0];
    // a confirmação não serve para a reativação, nem o inverso
    const [errado] = (
      await preparar({ kind: 'reactivation', targets: [{ appointmentId: agendamento }] })
    ).body.items;
    expect(errado).toMatchObject({ ok: false, reason: 'target_not_found' });
    // a conversa do paciente existe agora: o Inbox não oferece nem aceita a finalidade da clínica
    const conversa = (await prisma.raw.message.findFirst({ where: { id: messageId } }))!
      .conversationId;
    const opcoes = (
      await get(`/api/business-outbound/options?conversationId=${conversa}`, owner).expect(200)
    ).body as { purposeKey: string }[];
    expect(opcoes.filter((o) => o.purposeKey.startsWith('clinics_'))).toEqual([]);
    expect(
      (
        await post('/api/business-outbound/preview', owner, {
          items: [
            {
              originRef: `conversation:${conversa}`,
              channelId: canal,
              contactId: contato,
              number: NUMERO,
              templateVersionId: registro.versionId,
              purposeId,
            },
          ],
        }).expect(200)
      ).body.items[0],
    ).toMatchObject({ ok: false, reason: 'precondition_unknown' });
    await post(`/api/clinics/returns/${retorno}/link`, owner, {
      appointmentId: agendamento,
    }).expect(201);
    expect(await despacho(messageId)).toMatchObject({
      state: 'canceled',
      errorCode: 'origin_invalidated',
    });
    expect((await pedidoNoBanco(r.request.id))?.activeMark).toBeNull();
  });

  // ── O isolamento ────────────────────────────────────────────────────────

  it('o pedido de um workspace não existe para outro (P0)', async () => {
    const pedido = await pedidoDoAgendamento();
    await ler(pedido, ownerB).expect(404);
    expect((await previa([item(pedido)], ownerB).expect(200)).body.items[0]).toMatchObject({
      ok: false,
      reason: 'request_not_found',
    });
    expect(
      (await preparar({ kind: 'confirmation', targets: [{ appointmentId: agendamento }] }, ownerB))
        .body.items[0],
    ).toMatchObject({ ok: false, reason: 'target_not_found' });
    expect((await pedidoNoBanco(pedido))?.renderedText).toBeNull();
  });

  // ── A varredura ─────────────────────────────────────────────────────────

  it('a varredura apaga o texto do não enviado e do rascunho que deixou de contar, e mantém o pendente', async () => {
    const pendente = await pedidoDoAgendamento();
    await aprovado(pendente);
    const outro = (
      await post('/api/clinics/appointments', owner, {
        patientId: paciente,
        professionalId: profissional,
        serviceId: servico,
        date: dataDoAgendamento,
        time: '15:00',
      }).expect(201)
    ).body.id;
    const rascunho = await pedidoDoAgendamento(outro);
    expect((await previa([item(rascunho)]).expect(200)).body.items[0].ok).toBe(true);
    await post(`/api/clinics/appointments/${outro}/status`, owner, {
      to: 'canceled',
      cancelReason: 'patient_request',
    }).expect(201);
    // a falha transitória ainda dentro do prazo não é terminal
    await prisma.raw.messageDispatch.updateMany({
      where: { message: { conversation: { workspaceId: wsA.workspaceId } } },
      data: { state: 'failed_before_send' },
    });
    expect((await ler(pendente).expect(200)).body.state).toBe('pending');
    expect(await app.get(VarreduraDosPedidos).varrer()).toBe(1);
    expect((await pedidoNoBanco(rascunho))?.renderedText).toBeNull();
    expect((await pedidoNoBanco(pendente))?.renderedText).not.toBeNull();
  });

  /** Um pedido no workspace B, gravado direto, com texto: o que conta, ou o que deixou de contar. */
  const pedidoEmB = async (conta: boolean) => {
    const workspaceId = wsB.workspaceId;
    const dono = (await prisma.raw.membership.findFirst({ where: { workspaceId } }))!;
    const unidade = (await prisma.raw.clinicsUnit.findFirst({ where: { workspaceId } }))!;
    const contatoB = await prisma.raw.contact.create({ data: { workspaceId, name: 'Bia B' } });
    const pacienteB = await prisma.raw.clinicsPatient.create({
      data: { workspaceId, contactId: contatoB.id, createdByMembershipId: dono.id },
    });
    const servicoB = await prisma.raw.clinicsService.create({
      data: { workspaceId, name: 'Servico B', durationMin: 30 },
    });
    const profB = await prisma.raw.clinicsProfessional.create({
      data: { workspaceId, name: 'Prof B' },
    });
    const inicio = new Date(Date.now() + 5 * 24 * 60 * 60_000);
    const ag = await prisma.raw.clinicsAppointment.create({
      data: {
        workspaceId,
        patientId: pacienteB.id,
        professionalId: profB.id,
        serviceId: servicoB.id,
        unitId: unidade.id,
        startsAt: inicio,
        endsAt: new Date(inicio.getTime() + 30 * 60_000),
        createdByMembershipId: dono.id,
      },
    });
    const pedido = await prisma.raw.clinicsOutreachRequest.create({
      data: {
        workspaceId,
        kind: 'confirmation',
        appointmentId: ag.id,
        startsAt: inicio,
        createdByMembershipId: dono.id,
      },
    });
    await prisma.raw.clinicsOutreachRequest.updateMany({
      where: { id: pedido.id },
      data: { renderedText: 'Ola Bia, texto ficticio', ...(conta ? {} : { activeMark: null }) },
    });
    return pedido.id;
  };

  it('a varredura decide e apaga em CADA workspace o que é dele, e a passada que estoura o orçamento é retomada na seguinte', async () => {
    // A: um rascunho com texto (fica) e um que deixou de contar (sai)
    const fica = await pedidoDoAgendamento();
    expect((await previa([item(fica)]).expect(200)).body.items[0].ok).toBe(true);
    const outro = (
      await post('/api/clinics/appointments', owner, {
        patientId: paciente,
        professionalId: profissional,
        serviceId: servico,
        date: dataDoAgendamento,
        time: '16:00',
      }).expect(201)
    ).body.id;
    const saiDeA = await pedidoDoAgendamento(outro);
    await prisma.raw.clinicsOutreachRequest.updateMany({
      where: { id: saiDeA },
      data: { renderedText: 'Ola Ana, texto ficticio', activeMark: null },
    });
    // B: o mesmo par
    const ficaEmB = await pedidoEmB(true);
    const saiDeB = await pedidoEmB(false);
    const varredura = app.get(VarreduraDosPedidos);
    // sem orçamento: um workspace por passada, e a seguinte retoma do próximo
    expect(await varredura.varrer({ orcamentoMs: -1 })).toBe(1);
    expect(await varredura.varrer({ orcamentoMs: -1 })).toBe(1);
    expect(await varredura.varrer({ orcamentoMs: -1 })).toBe(0);
    for (const id of [saiDeA, saiDeB]) {
      expect((await pedidoNoBanco(id))?.renderedText).toBeNull();
    }
    expect((await pedidoNoBanco(fica))?.renderedText).not.toBeNull();
    expect((await pedidoNoBanco(ficaEmB))?.renderedText).toBe('Ola Bia, texto ficticio');
  });

  it('a varredura pagina: com lotes de 1, o rascunho mais antigo não esconde o terminal depois dele, em nenhum workspace', async () => {
    const rascunho = await pedidoDoAgendamento();
    expect((await previa([item(rascunho)]).expect(200)).body.items[0].ok).toBe(true);
    const outro = (
      await post('/api/clinics/appointments', owner, {
        patientId: paciente,
        professionalId: profissional,
        serviceId: servico,
        date: dataDoAgendamento,
        time: '16:00',
      }).expect(201)
    ).body.id;
    const terminal = await pedidoDoAgendamento(outro);
    await prisma.raw.clinicsOutreachRequest.updateMany({
      where: { id: terminal },
      data: { renderedText: 'Ola Ana, texto ficticio', activeMark: null },
    });
    const deB = await pedidoEmB(false);
    expect(
      await app.get(VarreduraDosPedidos).varrer({ workspacesPorLote: 1, pedidosPorLote: 1 }),
    ).toBe(2);
    expect((await pedidoNoBanco(terminal))?.renderedText).toBeNull();
    expect((await pedidoNoBanco(deB))?.renderedText).toBeNull();
    expect((await pedidoNoBanco(rascunho))?.renderedText).not.toBeNull();
  });

  it('o pedido não é apagado — só a exclusão do workspace o leva, em cascata', async () => {
    const pedido = await pedidoDoAgendamento();
    await aprovado(pedido);
    await expect(
      prisma.raw.clinicsOutreachRequest.deleteMany({ where: { id: pedido } }),
    ).rejects.toThrow(/não é apagado/);
    await noWorkspace(wsA.workspaceId, async () => {
      await expect(
        prisma.db.clinicsOutreachRequest.deleteMany({ where: { id: pedido } }),
      ).rejects.toThrow(/não é apagado/);
    });
    await prisma.raw.workspace.delete({ where: { id: wsA.workspaceId } });
    expect(await prisma.raw.clinicsOutreachRequest.count()).toBe(0);
  });
});
