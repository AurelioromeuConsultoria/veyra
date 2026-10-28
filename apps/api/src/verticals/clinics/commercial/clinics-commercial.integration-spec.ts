import type { INestApplication } from '@nestjs/common';
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
  type SendOutcome,
} from '../../../channels/meta.transport';
import { CryptoService } from '../../../common/crypto.service';
import { ConsentPurposesService } from '../../../consents/consent-purposes.service';
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
import { ClinicsActivationService } from '../clinics-activation.service';

/**
 * F4.3 (ADR-048 adendos 8 e 10): o instante da confirmação, o vínculo com o
 * deal e as métricas do envio. Os exemplos aprovados do adendo 8 (7.2 e 7.3)
 * são casos de teste. Catálogo e transporte falsos; nomes, números e datas
 * FICTÍCIOS.
 */

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const WABA = '1001';
const PHONE = '100000000000001';

interface Session {
  cookieHeader: string;
  csrf: string;
}

class MetaFalsa implements MetaTransport {
  enviados = 0;
  async sendText(): Promise<SendOutcome> {
    return { ok: true, externalId: 'wamid.TEXTO' };
  }
  async sendTemplate(): Promise<SendOutcome> {
    this.enviados += 1;
    return { ok: true, externalId: `wamid.${this.enviados}` };
  }
  async fetchMedia(): Promise<FetchOutcome> {
    return { ok: false, failure: { status: 400 } };
  }
}

const template = (id: string, name: string, texto: string): TemplateDaMeta => ({
  id,
  name,
  language: 'pt_BR',
  status: 'APPROVED',
  category: 'UTILITY',
  parameterFormat: 'POSITIONAL',
  components: [{ type: 'BODY', text: texto }],
});

/** Uma segunda-feira ao menos uma semana à frente de hoje. */
function segundaFutura(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

/** Meio-dia LOCAL de São Paulo (UTC−3, sem horário de verão) de uma data. */
const meioDia = (data: string) => new Date(`${data}T12:00:00-03:00`);

describe('F4.3 — o vínculo com o deal e as métricas do envio (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
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
  });
  afterAll(async () => {
    await app.close();
  });

  /** Clientes que seguram trava: soltos no fim de cada teste, mesmo no erro. */
  const abertos: Client[] = [];
  const emCurso: Promise<unknown>[] = [];
  afterEach(async () => {
    for (const c of abertos.splice(0)) await c.end().catch(() => undefined);
    await Promise.allSettled(emCurso.splice(0));
  });

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let owner: Session;
  let ownerB: Session;
  let dono: string;
  let canal: string;
  let unidade: string;
  let servico: string;
  let profissional: string;
  let confirmacao: { purposeId: string; versionId: string };
  let reativacao: { purposeId: string; versionId: string };
  let dataFutura: string;

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
    metodo: 'post' | 'put' | 'delete',
    path: string,
    s: Session,
    body: unknown = {},
    chave?: string,
  ) => {
    const r = request(http)
      [metodo](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    return (chave ? r.set('Idempotency-Key', chave) : r).send(body as object);
  };
  const post = (path: string, s: Session, body: unknown = {}, chave?: string) =>
    enviar('post', path, s, body, chave);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

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

  /** Um paciente com um número inventado e os consentimentos das duas finalidades. */
  const novoPaciente = async (nome: string, numero: string) => {
    const contato = (
      await post('/api/contacts', owner, { name: nome, phones: [numero] }).expect(201)
    ).body.id as string;
    const paciente = (
      await post('/api/clinics/patients', owner, { contactId: contato }).expect(201)
    ).body.id as string;
    for (const purposeId of [confirmacao.purposeId, reativacao.purposeId]) {
      await post(
        `/api/contacts/${contato}/consents`,
        owner,
        { channelId: canal, number: numero, purposeId, origin: 'in_person' },
        randomUUID(),
      ).expect(201);
    }
    return { contato, paciente, numero };
  };
  const agendar = async (paciente: string, time: string, date: string = dataFutura) =>
    (
      await post('/api/clinics/appointments', owner, {
        patientId: paciente,
        professionalId: profissional,
        serviceId: servico,
        date,
        time,
      }).expect(201)
    ).body.id as string;
  /** Um agendamento gravado direto, com as datas que o exemplo pede. */
  const agendamentoEm = async (
    paciente: string,
    inicio: Date,
    criadoEm: Date,
    status: 'attended' | 'no_show' | 'scheduled' = 'attended',
  ) =>
    (
      await prisma.raw.clinicsAppointment.create({
        data: {
          workspaceId: wsA.workspaceId,
          patientId: paciente,
          professionalId: profissional,
          serviceId: servico,
          unitId: unidade,
          startsAt: inicio,
          endsAt: new Date(inicio.getTime() + 60 * 60_000),
          status,
          createdAt: criadoEm,
          createdByMembershipId: dono,
        },
      })
    ).id;

  /** O fluxo inteiro da F4.2: pedido, prévia, aprovação e o despacho; devolve a mensagem. */
  const enviarPedido = async (
    kind: 'confirmation' | 'reactivation',
    alvo: { appointmentId: string } | { returnId: string },
    numero: string,
    { drenar = true }: { drenar?: boolean } = {},
  ) => {
    const [preparado] = (
      await post('/api/clinics/outreach/requests', owner, { kind, targets: [alvo] }).expect(200)
    ).body.items;
    if (!preparado.ok) throw new Error(`pedido recusado: ${preparado.reason}`);
    const escolhas = kind === 'confirmation' ? confirmacao : reativacao;
    const item = {
      requestId: preparado.request.id,
      channelId: canal,
      number: numero,
      templateVersionId: escolhas.versionId,
      purposeId: escolhas.purposeId,
    };
    const [p] = (await post('/api/clinics/outreach/preview', owner, { items: [item] }).expect(200))
      .body.items;
    if (!p.ok) throw new Error(`prévia recusada: ${p.reason}`);
    const [r] = (
      await post(
        '/api/clinics/outreach/approve',
        owner,
        { items: [{ ...item, expiresAt: p.expiresAt, approvalHash: p.approvalHash }] },
        randomUUID(),
      ).expect(200)
    ).body.items;
    if (r.state !== 'approved') throw new Error(`aprovação recusada: ${r.reason}`);
    if (drenar) {
      for (let i = 0; i < 5; i++) {
        const { delivered } = await app.get(JobsService).dispatchPending();
        if (delivered === 0) break;
      }
    }
    return { requestId: preparado.request.id as string, messageId: r.messageId as string };
  };
  const despacho = (messageId: string) =>
    prisma.raw.messageDispatch.findFirst({ where: { messageId } });
  const novoDeal = async (titulo: string, contato: string | null, criadoEm?: Date) => {
    const pipeline = (await prisma.raw.pipeline.findFirst({
      where: { workspaceId: wsA.workspaceId },
      include: { stages: true },
    }))!;
    return (
      await prisma.raw.deal.create({
        data: {
          workspaceId: wsA.workspaceId,
          pipelineId: pipeline.id,
          stageId: pipeline.stages[0].id,
          title: titulo,
          contactId: contato,
          position: 1024,
          ...(criadoEm ? { createdAt: criadoEm } : {}),
        },
      })
    ).id;
  };
  /** O vínculo gravado direto (o agendamento ainda não atendido, como exige o gatilho). */
  const vincularDireto = (appointmentId: string, dealId: string) =>
    prisma.raw.clinicsAppointmentDeal.create({
      data: { workspaceId: wsA.workspaceId, appointmentId, dealId, linkedByMembershipId: dono },
    });
  /** Um cliente do banco SEM gatilhos de usuário: só para simular registros antigos. */
  const semGatilhos = async (sql: string, params: unknown[]) => {
    const c = new Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(sql, params);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
  };

  beforeEach(async () => {
    catalogo.limpar();
    meta.enviados = 0;
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const user = await createUserFixture(prisma, 'dono@veyra.test');
    dono = await createMembershipFixture(prisma, wsA.workspaceId, user, wsA.roles.owner);
    const userB = await createUserFixture(prisma, 'dono-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, userB, wsB.roles.owner);
    await app.get(ClinicsActivationService).enable('acme');
    await app.get(ClinicsActivationService).enable('beta');
    owner = await login('dono@veyra.test');
    ownerB = await login('dono-b@veyra.test');
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
        tokenCipher: app.get(CryptoService).encrypt('token-ficticio'),
      },
    });
    unidade = (await prisma.raw.clinicsUnit.findFirst({ where: { workspaceId: wsA.workspaceId } }))!
      .id;
    servico = (
      await post('/api/clinics/services', owner, {
        name: 'Limpeza de pele',
        durationMin: 60,
      }).expect(201)
    ).body.id;
    profissional = (
      await post('/api/clinics/professionals', owner, { name: 'Bruna Profissional' }).expect(201)
    ).body.id;
    await enviar('put', `/api/clinics/professionals/${profissional}/profile`, owner, {
      name: 'Bruna Profissional',
      serviceIds: [servico],
      intervals: [1, 2, 3, 4, 5].map((weekday) => ({
        unitId: unidade,
        weekday,
        startMinute: 480,
        endMinute: 1080,
      })),
    }).expect(200);
    // as finalidades com o conteúdo mínimo e as versões revisadas
    catalogo.publicar(
      WABA,
      template('5001', 'confirmacao_horario', 'Ola {{1}}, confirma em {{2}} as {{3}}?'),
    );
    catalogo.publicar(
      WABA,
      template('5002', 'reativacao_retorno', 'Ola {{1}}, que tal marcar o seu retorno?'),
    );
    const finalidade = async (
      key: string,
      fields: string[],
      name: string,
      vinculos: Record<string, string>,
    ) => {
      const purposeId = (
        await app
          .get(ConsentPurposesService)
          .criarVersao('acme', { key, description: key, category: 'utility', fields })
      ).purposeId;
      const registro = await app
        .get(TemplateVersionsService)
        .registrar('acme', { channelId: canal, name, language: 'pt_BR', vinculos });
      if (registro.resultado !== 'registrada') throw new Error('template não registrado');
      await post(`/api/templates/versions/${registro.versionId}/reviews`, owner, {
        purposeId,
        contentHash: registro.contentHash,
      }).expect(201);
      return { purposeId, versionId: registro.versionId };
    };
    confirmacao = await finalidade(
      'clinics_confirmacao',
      ['contato.primeiro_nome', 'clinics.data', 'clinics.hora'],
      'confirmacao_horario',
      { 'body.1': 'contato.primeiro_nome', 'body.2': 'clinics.data', 'body.3': 'clinics.hora' },
    );
    reativacao = await finalidade(
      'clinics_reativacao',
      ['contato.primeiro_nome'],
      'reativacao_retorno',
      { 'body.1': 'contato.primeiro_nome' },
    );
    dataFutura = segundaFutura();
  });

  // ── O instante da confirmação ───────────────────────────────────────────

  it('o `confirmedAt`: o relógio do banco na confirmação; chegou, atendido e falta não apagam; a remarcação zera; só o gatilho escreve', async () => {
    const { paciente } = await novoPaciente('Ana Ficticia', '+5511988880001');
    const ag = await agendar(paciente, '09:00');
    const ler = () => prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } });
    expect(await ler()).toMatchObject({ confirmedAt: null, confirmationTracked: true });
    await post(`/api/clinics/appointments/${ag}/status`, owner, { to: 'confirmed' }).expect(201);
    const confirmado = (await ler())!.confirmedAt;
    expect(confirmado).toBeInstanceOf(Date);
    // ninguém além do gatilho escreve: a tentativa direta é ignorada
    await prisma.raw.clinicsAppointment.updateMany({
      where: { id: ag },
      data: { confirmedAt: new Date('2001-01-01T00:00:00Z'), confirmationTracked: false },
    });
    expect(await ler()).toMatchObject({ confirmedAt: confirmado, confirmationTracked: true });
    await post(`/api/clinics/appointments/${ag}/status`, owner, { to: 'arrived' }).expect(201);
    await post(`/api/clinics/appointments/${ag}/attendance`, owner, { packageId: null }).expect(
      201,
    );
    expect(await ler()).toMatchObject({ status: 'attended', confirmedAt: confirmado });
    // a falta também preserva; a remarcação zera
    const outro = await agendar(paciente, '11:00');
    await post(`/api/clinics/appointments/${outro}/status`, owner, { to: 'confirmed' }).expect(201);
    await post(`/api/clinics/appointments/${outro}/reschedule`, owner, {
      date: dataFutura,
      time: '13:00',
    }).expect(201);
    expect(await prisma.raw.clinicsAppointment.findFirst({ where: { id: outro } })).toMatchObject({
      status: 'scheduled',
      confirmedAt: null,
    });
    await post(`/api/clinics/appointments/${outro}/status`, owner, { to: 'confirmed' }).expect(201);
    await post(`/api/clinics/appointments/${outro}/status`, owner, { to: 'no_show' }).expect(201);
    expect(
      (await prisma.raw.clinicsAppointment.findFirst({ where: { id: outro } }))!.confirmedAt,
    ).toBeInstanceOf(Date);
  });

  // ── O vínculo com o deal ────────────────────────────────────────────────

  it('o vínculo: um deal por agendamento, do mesmo contato, com trilha; trocar e desvincular antes do atendimento', async () => {
    const { contato, paciente } = await novoPaciente('Ana Ficticia', '+5511988880001');
    const outro = await novoPaciente('Bia Ficticia', '+5511988880002');
    const ag = await agendar(paciente, '09:00');
    const d1 = await novoDeal('Pacote facial', contato);
    const d2 = await novoDeal('Pacote corporal', contato);
    const deOutro = await novoDeal('Outro contato', outro.contato);
    const opcoes = (await get(`/api/clinics/appointments/${ag}/deal-options`, owner).expect(200))
      .body as { id: string }[];
    expect(opcoes.map((o) => o.id).sort()).toEqual([d1, d2].sort());
    expect((await get(`/api/clinics/appointments/${ag}/deal`, owner).expect(200)).body).toEqual({
      appointmentId: ag,
      dealId: null,
      dealTitle: null,
      valid: null,
    });
    await enviar('put', `/api/clinics/appointments/${ag}/deal`, owner, { dealId: deOutro }).expect(
      400,
    );
    await enviar('put', `/api/clinics/appointments/${ag}/deal`, owner, { dealId: d1 }).expect(200);
    // repetir não muda nem audita de novo
    await enviar('put', `/api/clinics/appointments/${ag}/deal`, owner, { dealId: d1 }).expect(200);
    const trocado = (
      await enviar('put', `/api/clinics/appointments/${ag}/deal`, owner, { dealId: d2 }).expect(200)
    ).body;
    expect(trocado).toMatchObject({ dealId: d2, dealTitle: 'Pacote corporal', valid: true });
    // vários agendamentos no mesmo deal
    const ag2 = await agendar(paciente, '11:00');
    await enviar('put', `/api/clinics/appointments/${ag2}/deal`, owner, { dealId: d2 }).expect(200);
    await post(`/api/clinics/appointments/${ag2}/deal/unlink`, owner).expect(200);
    const trilha = await prisma.raw.auditLog.findMany({
      where: { action: { startsWith: 'clinics.appointment.deal_' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(trilha.map((t) => [t.action, t.before, t.after])).toEqual([
      ['clinics.appointment.deal_linked', null, { appointmentId: ag, dealId: d1 }],
      [
        'clinics.appointment.deal_linked',
        { appointmentId: ag, dealId: d1 },
        { appointmentId: ag, dealId: d2 },
      ],
      ['clinics.appointment.deal_linked', null, { appointmentId: ag2, dealId: d2 }],
      ['clinics.appointment.deal_unlinked', { appointmentId: ag2, dealId: d2 }, null],
    ]);
    // depois do atendimento, o vínculo não muda — nem pela API, nem direto
    await post(`/api/clinics/appointments/${ag}/attendance`, owner, { packageId: null }).expect(
      201,
    );
    await enviar('put', `/api/clinics/appointments/${ag}/deal`, owner, { dealId: d1 }).expect(409);
    await post(`/api/clinics/appointments/${ag}/deal/unlink`, owner).expect(409);
    await expect(
      prisma.raw.clinicsAppointmentDeal.deleteMany({ where: { appointmentId: ag } }),
    ).rejects.toThrow(/não muda depois do atendimento/);
  });

  it('a corrida com o registro do atendimento: a mudança do vínculo espera e é recusada depois dele', async () => {
    const { contato, paciente } = await novoPaciente('Ana Ficticia', '+5511988880001');
    const ag = await agendar(paciente, '09:00');
    const deal = await novoDeal('Pacote facial', contato);
    // o atendimento em curso: a linha do agendamento travada, já `attended`
    const atendimento = new Client({ connectionString: TEST_DATABASE_URL });
    abertos.push(atendimento);
    await atendimento.connect();
    await atendimento.query('BEGIN');
    await atendimento.query(
      `UPDATE "ClinicsAppointment" SET "status" = 'attended' WHERE "id" = $1`,
      [ag],
    );
    const mudanca = enviar('put', `/api/clinics/appointments/${ag}/deal`, owner, {
      dealId: deal,
    }).then((r) => r);
    emCurso.push(mudanca);
    await esperarBloqueadosPor(atendimento, 1, { descricao: 'a mudança do vínculo' });
    await atendimento.query('COMMIT');
    expect((await mudanca).status).toBe(409);
    expect(await prisma.raw.clinicsAppointmentDeal.count()).toBe(0);
  });

  it('o gatilho serializa qualquer caminho com o atendimento em curso: o vínculo gravado direto espera e é recusado', async () => {
    const { contato, paciente } = await novoPaciente('Ana Ficticia', '+5511988880001');
    const ag = await agendar(paciente, '09:00');
    const deal = await novoDeal('Pacote facial', contato);
    const atendimento = new Client({ connectionString: TEST_DATABASE_URL });
    abertos.push(atendimento);
    await atendimento.connect();
    await atendimento.query('BEGIN');
    await atendimento.query(
      `UPDATE "ClinicsAppointment" SET "status" = 'attended' WHERE "id" = $1`,
      [ag],
    );
    // outro caminho, fora do serviço (sem a trava dele): só o gatilho protege
    const direto = new Client({ connectionString: TEST_DATABASE_URL });
    abertos.push(direto);
    await direto.connect();
    const vinculo = direto
      .query(
        `INSERT INTO "ClinicsAppointmentDeal" ("id","workspaceId","appointmentId","dealId","linkedByMembershipId")
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), wsA.workspaceId, ag, deal, dono],
      )
      .then(
        () => 'gravou',
        (erro: Error) => erro.message,
      );
    emCurso.push(vinculo);
    await esperarBloqueadosPor(atendimento, 1, { descricao: 'o vínculo gravado direto' });
    await atendimento.query('COMMIT');
    expect(await vinculo).toMatch(/não muda depois do atendimento/);
    expect(await prisma.raw.clinicsAppointmentDeal.count()).toBe(0);
  });

  it('o deal que mudou de contato: a referência fica, mas não é vínculo válido; o deal vinculado não é excluído; o workspace inteiro é', async () => {
    const { contato, paciente } = await novoPaciente('Ana Ficticia', '+5511988880001');
    const outro = await novoPaciente('Bia Ficticia', '+5511988880002');
    const ag = await agendar(paciente, '09:00');
    const deal = await novoDeal('Pacote facial', contato);
    await enviar('put', `/api/clinics/appointments/${ag}/deal`, owner, { dealId: deal }).expect(
      200,
    );
    await prisma.raw.deal.updateMany({ where: { id: deal }, data: { contactId: outro.contato } });
    expect((await get(`/api/clinics/appointments/${ag}/deal`, owner).expect(200)).body).toEqual({
      appointmentId: ag,
      dealId: deal,
      dealTitle: null,
      valid: false,
    });
    const excluir = await enviar('delete', `/api/deals/${deal}`, owner).expect(409);
    expect(excluir.body.message).toBe('Registro em uso por outros dados');
    // o estado final normal: o agendamento atendido, com o vínculo que a guarda
    // não deixa mais mudar — a exclusão do workspace inteiro o leva mesmo assim
    await post(`/api/clinics/appointments/${ag}/attendance`, owner, { packageId: null }).expect(
      201,
    );
    await prisma.raw.workspace.delete({ where: { id: wsA.workspaceId } });
    expect(await prisma.raw.clinicsAppointmentDeal.count()).toBe(0);
  });

  it('as permissões e o isolamento do vínculo', async () => {
    const { contato, paciente } = await novoPaciente('Ana Ficticia', '+5511988880001');
    const ag = await agendar(paciente, '09:00');
    const deal = await novoDeal('Pacote facial', contato);
    const soAgenda = await comChaves('agenda@veyra.test', ['clinics:schedule:read']);
    await get(`/api/clinics/appointments/${ag}/deal`, soAgenda).expect(403);
    const leitura = await comChaves('leitura@veyra.test', [
      'clinics:schedule:read',
      'pipelines:read',
    ]);
    await get(`/api/clinics/appointments/${ag}/deal`, leitura).expect(200);
    await get(`/api/clinics/appointments/${ag}/deal-options`, leitura).expect(403);
    await enviar('put', `/api/clinics/appointments/${ag}/deal`, leitura, { dealId: deal }).expect(
      403,
    );
    // o agendamento de A não existe para B, em nenhuma rota
    await get(`/api/clinics/appointments/${ag}/deal`, ownerB).expect(404);
    await get(`/api/clinics/appointments/${ag}/deal-options`, ownerB).expect(404);
    await enviar('put', `/api/clinics/appointments/${ag}/deal`, ownerB, { dealId: deal }).expect(
      404,
    );
    await post(`/api/clinics/appointments/${ag}/deal/unlink`, ownerB).expect(404);
    // o agendamento do PRÓPRIO B com o deal de A: o deal não existe para B
    const ws = wsB.workspaceId;
    const membroB = (await prisma.raw.membership.findFirst({ where: { workspaceId: ws } }))!;
    const contatoB = await prisma.raw.contact.create({ data: { workspaceId: ws, name: 'Bia B' } });
    const pacienteB = await prisma.raw.clinicsPatient.create({
      data: { workspaceId: ws, contactId: contatoB.id, createdByMembershipId: membroB.id },
    });
    const servicoB = await prisma.raw.clinicsService.create({
      data: { workspaceId: ws, name: 'Servico B', durationMin: 30 },
    });
    const profB = await prisma.raw.clinicsProfessional.create({
      data: { workspaceId: ws, name: 'Prof B' },
    });
    const inicioB = new Date(Date.now() + 5 * 86_400_000);
    const agB = await prisma.raw.clinicsAppointment.create({
      data: {
        workspaceId: ws,
        patientId: pacienteB.id,
        professionalId: profB.id,
        serviceId: servicoB.id,
        unitId: (await prisma.raw.clinicsUnit.findFirst({ where: { workspaceId: ws } }))!.id,
        startsAt: inicioB,
        endsAt: new Date(inicioB.getTime() + 30 * 60_000),
        createdByMembershipId: membroB.id,
      },
    });
    await enviar('put', `/api/clinics/appointments/${agB.id}/deal`, ownerB, {
      dealId: deal,
    }).expect(404);
    expect(await prisma.raw.clinicsAppointmentDeal.count()).toBe(0);
    // as métricas de B com a unidade e o pipeline de A: não existem para B
    const pipelineA = (await prisma.raw.pipeline.findFirst({
      where: { workspaceId: wsA.workspaceId },
    }))!;
    await get(
      `/api/clinics/metrics/confirmation?from=2030-11-01&to=2030-12-01&unitId=${unidade}`,
      ownerB,
    ).expect(404);
    await get(
      `/api/clinics/metrics/conversion?from=2030-11-01&to=2030-12-01&pipelineId=${pipelineA.id}`,
      ownerB,
    ).expect(404);
  });

  // ── O funil da confirmação (7.1) ────────────────────────────────────────

  it('o funil: os grupos pelo horário final, a entrega e a resposta sem dados até o recibo do provedor, a confirmação com cobertura parcial e a falta por grupo', async () => {
    const { paciente, numero } = await novoPaciente('Ana Ficticia', '+5511988880001');
    // outra pessoa, outra conversa: a resposta numa conversa vale para todo envio
    // anterior a ela na MESMA conversa, pela definição do adendo 8
    const segunda = await novoPaciente('Bia Ficticia', '+5511988880002');
    const a1 = await agendar(paciente, '09:00');
    const a2 = await agendar(segunda.paciente, '10:00');
    const a3 = await agendar(paciente, '11:00');
    const a4 = await agendar(paciente, '13:00');
    const a5 = await agendar(paciente, '14:00');
    const a6 = await agendar(paciente, '15:00');
    const a7 = await agendar(paciente, '17:00');
    const e1 = await enviarPedido('confirmation', { appointmentId: a1 }, numero);
    await enviarPedido('confirmation', { appointmentId: a2 }, segunda.numero);
    const e3 = await enviarPedido('confirmation', { appointmentId: a3 }, numero, { drenar: false });
    await prisma.raw.messageDispatch.updateMany({
      where: { messageId: e3.messageId },
      data: { state: 'unknown_after_dispatch', dispatchedAt: new Date() },
    });
    await enviarPedido('confirmation', { appointmentId: a6 }, numero);
    // a7 aprovado e ainda sem desfecho: à parte, fora dos três grupos
    await enviarPedido('confirmation', { appointmentId: a7 }, numero, { drenar: false });
    // a6 remarcado DEPOIS do envio: o enviado é de um horário anterior
    await post(`/api/clinics/appointments/${a6}/reschedule`, owner, {
      date: dataFutura,
      time: '16:00',
    }).expect(201);
    await post(`/api/clinics/appointments/${a5}/status`, owner, {
      to: 'canceled',
      cancelReason: 'patient_request',
    }).expect(201);
    // a equipe confirma a1 depois do envio; a2 é um registro antigo, sem rastreio
    await post(`/api/clinics/appointments/${a1}/status`, owner, { to: 'confirmed' }).expect(201);
    await semGatilhos(
      `UPDATE "ClinicsAppointment" SET "confirmationTracked" = false WHERE "id" = $1`,
      [a2],
    );
    const periodo = `from=${dataFutura}&to=${new Date(Date.parse(`${dataFutura}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}`;
    const funil = async (s: Session = owner) =>
      (await get(`/api/clinics/metrics/confirmation?${periodo}`, s).expect(200)).body;

    let r = await funil();
    expect(r).toMatchObject({
      base: 6,
      canceled: 1,
      sent: 2,
      sentForEarlierSlot: 1,
      pending: 1,
      uncertain: 1,
      // sem recibo do provedor (o transporte falso): sem dados, nunca zero
      delivered: { status: 'no_data', count: null, reason: 'no_provider_confirmation' },
      responded: { status: 'no_data', count: null, reason: 'no_provider_confirmation' },
      // a1 conhecido e confirmado depois do envio; a2 sem rastreio: parcial
      confirmedByTeam: {
        status: 'partial',
        count: 1,
        known: 1,
        total: 2,
        reason: 'confirmation_time_unknown',
      },
    });

    // o recibo de entrega de a1 e a resposta do paciente na conversa dele
    const enviado = (await despacho(e1.messageId))!;
    const mensagem = (await prisma.raw.message.findFirst({ where: { id: e1.messageId } }))!;
    await prisma.raw.messageStatusEvent.create({
      data: {
        workspaceId: wsA.workspaceId,
        messageId: e1.messageId,
        status: 'delivered',
        occurredAt: new Date(),
      },
    });
    await prisma.raw.message.create({
      data: {
        workspaceId: wsA.workspaceId,
        conversationId: mensagem.conversationId,
        channelId: canal,
        direction: 'inbound',
        authorType: 'contact',
        body: 'Confirmo',
        createdAt: new Date(enviado.dispatchedAt!.getTime() + 60_000),
      },
    });
    r = await funil();
    expect(r.delivered).toEqual({
      status: 'partial',
      count: 1,
      known: 1,
      total: 2,
      reason: 'no_provider_confirmation',
    });
    expect(r.responded).toMatchObject({ status: 'partial', count: 1, known: 1, total: 2 });
    // a falta por grupo: associação, pela regra da F3.3a
    await prisma.raw.clinicsAppointment.updateMany({
      where: { id: a1 },
      data: { status: 'attended' },
    });
    await prisma.raw.clinicsAppointment.updateMany({
      where: { id: a2 },
      data: { status: 'no_show' },
    });
    await prisma.raw.clinicsAppointment.updateMany({
      where: { id: a3 },
      data: { status: 'attended' },
    });
    await prisma.raw.clinicsAppointment.updateMany({
      where: { id: a4 },
      data: { status: 'no_show' },
    });
    r = await funil();
    expect(r.noShowBySendGroup).toEqual({
      sent: { attended: 1, noShow: 1, rate: 0.5 },
      uncertain: { attended: 1, noShow: 0, rate: 0 },
      notSent: { attended: 0, noShow: 1, rate: 1 },
    });
    // a confirmação da equipe continua depois do atendimento
    expect(r.confirmedByTeam).toMatchObject({ count: 1 });

    // sem `conversations:read`, a resposta é omitida (nunca zero)
    const soAgenda = await comChaves('agenda@veyra.test', ['clinics:schedule:read']);
    expect((await funil(soAgenda)).responded).toMatchObject({
      status: 'omitted',
      count: null,
      reason: 'no_conversation_access',
    });
    // a conversa que vira RAI (ou passa a outro contato) não é resposta do
    // paciente: "não respondeu" para QUALQUER leitor — o Owner e quem não lê a
    // RAI veem o mesmo, e a existência dela não aparece (C13)
    const semRai = await comChaves('conversas@veyra.test', [
      'clinics:schedule:read',
      'conversations:read',
    ]);
    expect((await funil(semRai)).responded).toMatchObject({ status: 'partial', count: 1 });
    await prisma.raw.conversation.updateMany({
      where: { id: mensagem.conversationId },
      data: { senderStatus: 'unidentified', contactId: null },
    });
    for (const s of [semRai, owner]) {
      expect((await funil(s)).responded).toMatchObject({ status: 'partial', count: 0, known: 1 });
    }
    // a conversa ainda identificada, mas de OUTRO contato: também não conta
    await prisma.raw.conversation.updateMany({
      where: { id: mensagem.conversationId },
      data: { senderStatus: 'identified', contactId: segunda.contato },
    });
    for (const s of [semRai, owner]) {
      expect((await funil(s)).responded).toMatchObject({ status: 'partial', count: 0, known: 1 });
    }
  });

  it('a resposta é da conversa do número: uma resposta depois de dois envios conta para os dois; a base vazia é sem dados', async () => {
    const { paciente, numero } = await novoPaciente('Ana Ficticia', '+5511988880001');
    const a1 = await agendar(paciente, '09:00');
    const a2 = await agendar(paciente, '10:00');
    const e1 = await enviarPedido('confirmation', { appointmentId: a1 }, numero);
    const e2 = await enviarPedido('confirmation', { appointmentId: a2 }, numero);
    const mensagem = (await prisma.raw.message.findFirst({ where: { id: e2.messageId } }))!;
    for (const m of [e1.messageId, e2.messageId]) {
      await prisma.raw.messageStatusEvent.create({
        data: {
          workspaceId: wsA.workspaceId,
          messageId: m,
          status: 'delivered',
          occurredAt: new Date(),
        },
      });
    }
    const depois = (await despacho(e2.messageId))!.dispatchedAt!;
    await prisma.raw.message.create({
      data: {
        workspaceId: wsA.workspaceId,
        conversationId: mensagem.conversationId,
        channelId: canal,
        direction: 'inbound',
        authorType: 'contact',
        body: 'Ok',
        createdAt: new Date(depois.getTime() + 60_000),
      },
    });
    const amanha = new Date(Date.parse(`${dataFutura}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const r = (
      await get(`/api/clinics/metrics/confirmation?from=${dataFutura}&to=${amanha}`, owner).expect(
        200,
      )
    ).body;
    expect(r.responded).toEqual({ status: 'complete', count: 2, known: 2, total: 2, reason: null });
    // um período sem agendamento: a taxa é indefinida, e não 0
    const vazio = (
      await get('/api/clinics/metrics/confirmation?from=2030-11-01&to=2030-11-02', owner).expect(
        200,
      )
    ).body;
    expect(vazio.delivered).toEqual({
      status: 'no_data',
      count: null,
      known: 0,
      total: 0,
      reason: 'empty_base',
    });
  });

  // ── A conversão (7.2): os exemplos aprovados do adendo 8 ────────────────

  it('a conversão de novembro de 2030: os seis exemplos do adendo 8, mais o vínculo inválido', async () => {
    const pacientes = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) =>
        novoPaciente(`Paciente ${i} Ficticia`, `+55119888800${10 + i}`),
      ),
    );
    const deal = (i: number, data: string) =>
      novoDeal(`Deal ${i}`, pacientes[i - 1].contato, meioDia(data));
    const atendido = async (
      i: number,
      dealId: string,
      criado: string,
      inicio: string,
      status: 'attended' | 'no_show' = 'attended',
    ) => {
      // um horário por exemplo (de 06:00 a 18:00 locais): o mesmo
      // profissional não se sobrepõe
      const ag = await agendamentoEm(
        pacientes[i - 1].paciente,
        new Date(
          meioDia(inicio).getTime() + (2 * i - 8 + (status === 'no_show' ? 1 : 0)) * 3_600_000,
        ),
        meioDia(criado),
        'scheduled',
      );
      await vincularDireto(ag, dealId);
      await prisma.raw.clinicsAppointment.updateMany({ where: { id: ag }, data: { status } });
    };
    // 1: criado 05/11, atendido 20/11 — converte
    await atendido(1, await deal(1, '2030-11-03'), '2030-11-05', '2030-11-20');
    // 2: atendido 15/02 (104 dias) — fora da janela
    await atendido(2, await deal(2, '2030-11-03'), '2030-11-05', '2031-02-15');
    // 3: deal de 28/10 — não entra em novembro
    await atendido(3, await deal(3, '2030-10-28'), '2030-10-30', '2030-11-10');
    // 4: uma falta e um atendido em 01/12 — converte pelo atendido
    const d4 = await deal(4, '2030-11-03');
    await atendido(4, d4, '2030-11-04', '2030-11-10', 'no_show');
    await atendido(4, d4, '2030-11-05', '2030-12-01');
    // 5: o agendamento é de 01/11, anterior ao deal — não converte
    await atendido(5, await deal(5, '2030-11-03'), '2030-11-01', '2030-11-10');
    // 6: nenhum agendamento
    await deal(6, '2030-11-03');
    // 7: o deal mudou de contato depois do vínculo — não é vínculo válido
    const d7 = await deal(7, '2030-11-03');
    await atendido(7, d7, '2030-11-05', '2030-11-20');
    await prisma.raw.deal.updateMany({
      where: { id: d7 },
      data: { contactId: pacientes[0].contato },
    });
    // os limites das datas LOCAIS (São Paulo, UTC−3):
    // 8: o deal de 31/10 às 23:30 locais (já 01/11 em UTC) — não entra em novembro
    await novoDeal('Deal 8', pacientes[7].contato, new Date('2030-10-31T23:30:00-03:00'));
    // 9 e 10: deals de 03/11; a janela vai até 01/02 local, exclusivo
    const noLimite = async (i: number, inicio: string) => {
      const d = await novoDeal(`Deal ${i}`, pacientes[i - 1].contato, meioDia('2030-11-03'));
      const ag = await agendamentoEm(
        pacientes[i - 1].paciente,
        new Date(inicio),
        meioDia('2030-11-05'),
        'scheduled',
      );
      await vincularDireto(ag, d);
      await prisma.raw.clinicsAppointment.updateMany({
        where: { id: ag },
        data: { status: 'attended' },
      });
    };
    // 9: começa 00:30 de 01/02 local — fora; 10: 23:30 de 31/01 local (01/02 em UTC) — dentro
    await noLimite(9, '2031-02-01T00:30:00-03:00');
    await noLimite(10, '2031-01-31T23:30:00-03:00');
    const pipeline = (await prisma.raw.pipeline.findFirst({
      where: { workspaceId: wsA.workspaceId },
    }))!;
    const conversao = (
      await get(
        `/api/clinics/metrics/conversion?from=2030-11-01&to=2030-12-01&pipelineId=${pipeline.id}`,
        owner,
      ).expect(200)
    ).body;
    expect(conversao).toMatchObject({
      windowDays: 90,
      base: 8,
      converted: 3,
      rate: 3 / 8,
      // a janela de novembro vai até 01/03/2031: em apuração
      status: 'open',
    });
    // sem `pipelines:read`, a conversão não é lida
    const soAgenda = await comChaves('agenda@veyra.test', ['clinics:schedule:read']);
    await get(
      `/api/clinics/metrics/conversion?from=2030-11-01&to=2030-12-01&pipelineId=${pipeline.id}`,
      soAgenda,
    ).expect(403);
  });

  // ── A reativação (7.3): os exemplos aprovados do adendo 8 ───────────────

  it('a reativação: os cinco exemplos do adendo 8 em novembro de 2030, e o quinto também em outubro', async () => {
    const pacientes = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7].map((i) =>
        novoPaciente(`Paciente ${i} Ficticia`, `+55119888800${20 + i}`),
      ),
    );
    /** Uma reativação ENVIADA ao paciente, com o instante do envio do exemplo. */
    const reativado = async (i: number, enviadoEm: string) => {
      const retorno = (
        await post('/api/clinics/returns', owner, {
          patientId: pacientes[i - 1].paciente,
          serviceId: servico,
          dueDate: '2026-01-05',
        }).expect(201)
      ).body.id as string;
      const { requestId, messageId } = await enviarPedido(
        'reactivation',
        { returnId: retorno },
        pacientes[i - 1].numero,
      );
      expect((await despacho(messageId))?.state).toBe('sent');
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId },
        data: { dispatchedAt: meioDia(enviadoEm) },
      });
      // o pedido nasce pouco antes do envio, como na realidade (a reativação
      // vale 24 horas): a criação é imutável, então só sem os gatilhos
      await semGatilhos(`UPDATE "ClinicsOutreachRequest" SET "createdAt" = $1 WHERE "id" = $2`, [
        new Date(meioDia(enviadoEm).getTime() - 60 * 60_000),
        requestId,
      ]);
    };
    const atendido = (i: number, criado: string, inicio: string) =>
      agendamentoEm(pacientes[i - 1].paciente, meioDia(inicio), meioDia(criado));
    // 1: enviada 05/11; criado 07/11, atendido 20/11 — conta
    await reativado(1, '2030-11-05');
    await atendido(1, '2030-11-07', '2030-11-20');
    // 2: enviadas 05/11 e 20/11; criado 22/11, atendido 30/11 — conta uma vez
    await reativado(2, '2030-11-05');
    await reativado(2, '2030-11-20');
    await atendido(2, '2030-11-22', '2030-11-30');
    // 3: criado 01/11, antes da âncora — não conta
    await reativado(3, '2030-11-05');
    await atendido(3, '2030-11-01', '2030-11-10');
    // 4: atendido 10/01 (66 dias) — não conta
    await reativado(4, '2030-11-05');
    await atendido(4, '2030-11-10', '2031-01-10');
    // 5: enviadas 28/10 e 03/11; criado 05/11, atendido 12/11 — âncora em 03/11
    await reativado(5, '2030-10-28');
    await reativado(5, '2030-11-03');
    await atendido(5, '2030-11-05', '2030-11-12');
    // 6: a reativação de 07/11 ficou incerta — grupo próprio, fora da base
    await reativado(6, '2030-11-07');
    await prisma.raw.messageDispatch.updateMany({
      where: { dispatchedAt: meioDia('2030-11-07') },
      data: { state: 'unknown_after_dispatch' },
    });
    // 7: o limite do período — criado em 31/10 às 23:00 e enviado em 01/11 ao
    // meio-dia (dentro das 24 horas): conta em novembro, nunca em outubro
    await reativado(7, '2030-11-01');
    const pedido7 = (await prisma.raw.clinicsOutreachRequest.findFirst({
      where: { kind: 'reactivation', return: { patientId: pacientes[6].paciente } },
    }))!;
    await semGatilhos(`UPDATE "ClinicsOutreachRequest" SET "createdAt" = $1 WHERE "id" = $2`, [
      new Date('2030-10-31T23:00:00-03:00'),
      pedido7.id,
    ]);
    const de = (from: string, to: string) =>
      get(`/api/clinics/metrics/reactivation?from=${from}&to=${to}`, owner).expect(200);
    expect((await de('2030-11-01', '2030-12-01')).body).toMatchObject({
      windowDays: 60,
      // os cinco exemplos e o sétimo, sem retorno
      base: 6,
      uncertain: 1,
      returned: 3,
      rate: 3 / 6,
      status: 'open',
    });
    // o mesmo paciente também conta em outubro, com a âncora em 28/10
    expect((await de('2030-10-01', '2030-11-01')).body).toMatchObject({ base: 1, returned: 1 });
  });
});
