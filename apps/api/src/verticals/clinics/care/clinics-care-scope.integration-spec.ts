import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import {
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
  CLINICS_RECEPTION_CARE_SYSTEM_KEY,
} from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../../audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { createTestApp } from '../../../../test/integration/app';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../../test/integration/fixtures';
import { TEST_DATABASE_URL } from '../../../../test/integration/db-url';
import { resetDb } from '../../../../test/integration/harness';
import { ClinicsActivationService } from '../clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const SEGUNDA = '2030-11-04';
const OUTRO = /Este atendimento é de outro profissional/;
const SEM_VINCULO = /não está vinculada a um profissional ativo/;

interface Session {
  cookieHeader: string;
  csrf: string;
}

/**
 * F5.3a (ADR-061, D8): o `Profissional` lê, registra e corrige só os PRÓPRIOS
 * atendimentos; o pacote é do paciente e o saldo reflete todos; sem vínculo,
 * nenhum acesso clínico; o alcance "todos" é a chave `clinics:care:all`,
 * preenchida pelo livro nos papéis que já existiam. Dados FICTÍCIOS. A troca
 * concorrente do profissional é forçada como na F3.1: a primeira transação
 * pausa na auditoria, segurando o que travou, e a segunda é vista esperando a
 * trava (`pg_stat_activity`), nunca por sono.
 */
describe('Clinics — o alcance clínico do profissional (integração, F5.3a)', () => {
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

  let ws: WorkspaceFixture;
  let owner: Session;
  let profAna: Session;
  let profBia: Session;
  let profSemVinculo: Session;
  let servico: string;
  let servicoComRetorno: string;
  let ana: string;
  let bia: string;
  let paciente: string;
  let papelProfissional: string;
  let membroAna: string;

  let portoes: (() => void)[] = [];
  let pendentes: Promise<unknown>[] = [];
  afterEach(async () => {
    for (const abrir of portoes) abrir();
    portoes = [];
    await Promise.allSettled(pendentes);
    pendentes = [];
    jest.restoreAllMocks();
  });

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
  const post = (path: string, s: Session, body?: unknown) => {
    const r = request(http)
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    return body === undefined ? r : r.send(body as object);
  };
  const put = (path: string, s: Session, body: unknown) =>
    request(http)
      .put(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send(body as object);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

  const ate = async (condicao: () => Promise<boolean>, descricao: string) => {
    for (let i = 0; i < 400; i++) {
      if (await condicao()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`não aconteceu: ${descricao}`);
  };
  /** Alguma sessão espera uma trava (de linha ou consultiva). */
  const alguemEspera = () =>
    ate(async () => {
      const { rows } = await observador.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`,
      );
      return Number(rows[0].n) > 0;
    }, 'alguém esperando uma trava');
  const disparar = <T>(p: PromiseLike<T>): Promise<T> => {
    const promessa = Promise.resolve(p);
    pendentes.push(promessa);
    return promessa;
  };
  function portao() {
    let abrir!: () => void;
    const aberto = new Promise<void>((resolve) => {
      abrir = resolve;
    });
    portoes.push(abrir);
    return { aberto, abrir };
  }
  /** Pausa a PRIMEIRA gravação de auditoria da ação: a transação fica aberta, segurando o que travou. */
  function pausarNaAuditoria(acao: string) {
    const audit = app.get(AuditService);
    const real = audit.record.bind(audit);
    const chegou = portao();
    const segue = portao();
    let primeira = true;
    jest.spyOn(audit, 'record').mockImplementation(async (db, w, action, input) => {
      if (action === acao && primeira) {
        primeira = false;
        chegou.abrir();
        await segue.aberto;
      }
      return real(db, w, action, input);
    });
    return { chegou, segue };
  }

  let minuto = 0;
  const agendar = async (professionalId: string, serviceId = servico) => {
    const hora = 8 + Math.floor(minuto / 60);
    const time = `${String(hora).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}`;
    minuto += 60;
    return (
      await post('/api/clinics/appointments', owner, {
        patientId: paciente,
        professionalId,
        serviceId,
        date: SEGUNDA,
        time,
      }).expect(201)
    ).body.id as string;
  };
  const atender = (ag: string, s: Session, packageId: string | null = null) =>
    post(`/api/clinics/appointments/${ag}/attendance`, s, { packageId });
  const corrigir = (
    ag: string,
    s: Session,
    body: { expectedRevision: number; packageId: string | null },
    chave = randomUUID(),
  ) =>
    post(`/api/clinics/appointments/${ag}/attendance/package-correction`, s)
      .set('Idempotency-Key', chave)
      .send({ reason: 'wrong_choice', ...body });
  const criarPacote = async () =>
    (
      await post('/api/clinics/packages', owner, {
        patientId: paciente,
        serviceId: servico,
        totalSessions: 5,
      }).expect(201)
    ).body.id as string;
  const vincular = (professionalId: string, membershipId: string | null) =>
    put(`/api/clinics/professionals/${professionalId}/account`, owner, { membershipId }).expect(
      200,
    );
  const membro = async (email: string) =>
    (await prisma.raw.membership.findFirst({ where: { user: { email } } }))!.id;

  beforeEach(async () => {
    minuto = 0;
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    ws = await createWorkspaceFixture(prisma, 'acme');
    for (const systemKey of ['owner', 'admin', 'member']) {
      const user = await createUserFixture(prisma, `${systemKey}@veyra.test`);
      await createMembershipFixture(prisma, ws.workspaceId, user, ws.roles[systemKey]);
    }
    await app.get(ClinicsActivationService).enable('acme');
    papelProfissional = (await prisma.raw.role.findFirst({
      where: { workspaceId: ws.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
    }))!.id;
    for (const nome of ['prof-ana', 'prof-bia', 'prof-solto']) {
      const user = await createUserFixture(prisma, `${nome}@veyra.test`);
      await createMembershipFixture(prisma, ws.workspaceId, user, papelProfissional);
    }
    owner = await loginAs('owner@veyra.test');
    profAna = await loginAs('prof-ana@veyra.test');
    profBia = await loginAs('prof-bia@veyra.test');
    profSemVinculo = await loginAs('prof-solto@veyra.test');
    const unidade = (await prisma.raw.clinicsUnit.findFirst({
      where: { workspaceId: ws.workspaceId },
    }))!.id;
    servico = (
      await post('/api/clinics/services', owner, { name: 'Limpeza', durationMin: 60 }).expect(201)
    ).body.id;
    servicoComRetorno = (
      await post('/api/clinics/services', owner, {
        name: 'Peeling',
        durationMin: 60,
        returnIntervalDays: 30,
      }).expect(201)
    ).body.id;
    const perfil = (serviceIds: string[]) => ({
      serviceIds,
      intervals: [1, 2, 3, 4, 5].map((weekday) => ({
        unitId: unidade,
        weekday,
        startMinute: 480,
        endMinute: 1320,
      })),
    });
    ana = (await post('/api/clinics/professionals', owner, { name: 'Ana Fictícia' }).expect(201))
      .body.id;
    bia = (await post('/api/clinics/professionals', owner, { name: 'Bia Fictícia' }).expect(201))
      .body.id;
    await put(`/api/clinics/professionals/${ana}/profile`, owner, {
      name: 'Ana Fictícia',
      ...perfil([servico, servicoComRetorno]),
    }).expect(200);
    await put(`/api/clinics/professionals/${bia}/profile`, owner, {
      name: 'Bia Fictícia',
      ...perfil([servico, servicoComRetorno]),
    }).expect(200);
    membroAna = await membro('prof-ana@veyra.test');
    await vincular(ana, membroAna);
    await vincular(bia, await membro('prof-bia@veyra.test'));
    const contato = (await post('/api/contacts', owner, { name: 'Paciente Fictícia' }).expect(201))
      .body.id;
    paciente = (await post('/api/clinics/patients', owner, { contactId: contato }).expect(201)).body
      .id;
  });

  it('a agenda: o atendimento alheio não sai nem como id, e cada horário diz se está no alcance', async () => {
    const deAna = await agendar(ana);
    const deBia = await agendar(bia);
    const marcadoDeBia = await agendar(bia);
    await atender(deAna, profAna).expect(201);
    await atender(deBia, profBia).expect(201);
    const doDia = async (s: Session) =>
      (await get(`/api/clinics/appointments?date=${SEGUNDA}`, s).expect(200)).body as {
        id: string;
        attendanceId?: string | null;
        careInScope?: boolean;
      }[];
    const visto = (lista: Awaited<ReturnType<typeof doDia>>, id: string) =>
      lista.find((a) => a.id === id)!;
    const daAna = await doDia(profAna);
    expect(visto(daAna, deAna)).toMatchObject({ careInScope: true });
    expect(visto(daAna, deAna).attendanceId).toEqual(expect.any(String));
    // a agenda operacional de todos continua visível; o clínico alheio, não
    expect(visto(daAna, deBia)).toMatchObject({ attendanceId: null, careInScope: false });
    expect(visto(daAna, marcadoDeBia)).toMatchObject({ attendanceId: null, careInScope: false });
    // o Owner (alcance "todos") vê os dois
    const doOwner = await doDia(owner);
    expect(visto(doOwner, deBia)).toMatchObject({ careInScope: true });
    expect(visto(doOwner, deBia).attendanceId).toEqual(expect.any(String));
    // sem vínculo: nenhum atendimento no alcance
    const solto = await doDia(profSemVinculo);
    expect(solto.every((a) => a.careInScope === false && a.attendanceId === null)).toBe(true);
  });

  it('o acesso direto: ler e registrar o alheio é 403 sem efeito; sem vínculo, 403 em tudo o que é clínico', async () => {
    const deBia = await agendar(bia);
    const atendidoDeBia = await agendar(bia);
    await atender(atendidoDeBia, profBia).expect(201);
    const p = await criarPacote();
    // ler o atendimento alheio: 403, sem nenhum dado
    const lido = await get(`/api/clinics/appointments/${atendidoDeBia}/attendance`, profAna).expect(
      403,
    );
    expect(lido.body.message).toMatch(OUTRO);
    expect(JSON.stringify(lido.body)).not.toMatch(/packageId|completedAt/);
    // registrar o horário alheio: 403, e o agendamento continua marcado, sem atendimento
    expect((await atender(deBia, profAna, p).expect(403)).body.message).toMatch(OUTRO);
    const depois = await prisma.raw.clinicsAppointment.findFirst({ where: { id: deBia } });
    expect(depois?.status).toBe('scheduled');
    expect(await prisma.raw.clinicsAttendance.count({ where: { appointmentId: deBia } })).toBe(0);
    expect(
      (await prisma.raw.clinicsPackage.findFirst({ where: { id: p } }))?.consumedSessions,
    ).toBe(0);
    // repetir o registro alheio também não devolve o registro de outra pessoa
    expect((await atender(atendidoDeBia, profAna).expect(403)).body.message).toMatch(OUTRO);
    // sem vínculo: nada clínico, nem pacote
    for (const r of [
      get(`/api/clinics/packages?patientId=${paciente}`, profSemVinculo),
      get(`/api/clinics/packages/${p}`, profSemVinculo),
      get(`/api/clinics/packages/${p}/sessions`, profSemVinculo),
      get(`/api/clinics/appointments/${atendidoDeBia}/attendance`, profSemVinculo),
      atender(deBia, profSemVinculo),
    ]) {
      expect((await r.expect(403)).body.message).toMatch(SEM_VINCULO);
    }
    // desfeito o vínculo, o acesso clínico some
    await vincular(bia, null);
    expect(
      (await get(`/api/clinics/packages?patientId=${paciente}`, profBia).expect(403)).body.message,
    ).toMatch(SEM_VINCULO);
  });

  it('a correção: a alheia é 403 sem efeito; o replay de quem perdeu o vínculo é 403, sem o corpo guardado', async () => {
    const p = await criarPacote();
    const deAna = await agendar(ana);
    const deBia = await agendar(bia);
    await atender(deAna, profAna, p).expect(201);
    await atender(deBia, profBia, p).expect(201);
    expect(
      (await corrigir(deBia, profAna, { expectedRevision: 0, packageId: null }).expect(403)).body
        .message,
    ).toMatch(OUTRO);
    expect(await prisma.raw.clinicsPackageCorrection.count()).toBe(0);
    // a própria: corrige, e o replay com a mesma chave devolve a mesma
    const chave = randomUUID();
    const feita = await corrigir(
      deAna,
      profAna,
      { expectedRevision: 0, packageId: null },
      chave,
    ).expect(201);
    // perdeu o vínculo: o replay não devolve a correção guardada
    await vincular(ana, null);
    const replay = await corrigir(
      deAna,
      profAna,
      { expectedRevision: 0, packageId: null },
      chave,
    ).expect(403);
    expect(JSON.stringify(replay.body)).not.toContain(feita.body.id);
  });

  it('as sessões do pacote: só as próprias, sem linha nem id alheio; o saldo reflete todas', async () => {
    const p = await criarPacote();
    const deAna = await agendar(ana);
    const deBia = await agendar(bia);
    const outraDeBia = await agendar(bia);
    await atender(deAna, profAna, p).expect(201);
    await atender(deBia, profBia, p).expect(201);
    // uma correção alheia que tocou o pacote: avulso → pacote
    await atender(outraDeBia, profBia, null).expect(201);
    await corrigir(outraDeBia, profBia, { expectedRevision: 0, packageId: p }).expect(201);
    const daAna = (await get(`/api/clinics/packages/${p}/sessions`, profAna).expect(200)).body;
    expect(daAna.sessions.map((s: { appointmentId: string }) => s.appointmentId)).toEqual([deAna]);
    expect(daAna.corrections).toEqual([]);
    const texto = JSON.stringify(daAna);
    for (const alheio of [deBia, outraDeBia, bia]) expect(texto).not.toContain(alheio);
    // o saldo é do pacote: reflete as três sessões
    const lista = (await get(`/api/clinics/packages?patientId=${paciente}`, profAna).expect(200))
      .body;
    expect(lista[0]).toMatchObject({ id: p, consumedSessions: 3, remainingSessions: 2 });
    // o Owner vê tudo
    const doOwner = (await get(`/api/clinics/packages/${p}/sessions`, owner).expect(200)).body;
    expect(doOwner.sessions).toHaveLength(3);
    expect(doOwner.corrections).toHaveLength(1);
  });

  it('os retornos: o id do atendimento alheio não sai; a decisão clínica sobre ele (não necessário) é 403', async () => {
    const deAna = await agendar(ana, servicoComRetorno);
    const deBia = await agendar(bia, servicoComRetorno);
    const daAna = (await atender(deAna, profAna).expect(201)).body.id as string;
    const daBia = (await atender(deBia, profBia).expect(201)).body.id as string;
    const lista = (await get(`/api/clinics/returns?patientId=${paciente}`, profAna).expect(200))
      .body as { origin?: string; originAttendanceId?: string | null }[];
    expect(lista).toHaveLength(2);
    expect(lista.filter((r) => r.originAttendanceId === daAna)).toHaveLength(1);
    expect(JSON.stringify(lista)).not.toContain(daBia);
    expect(lista.filter((r) => r.origin === undefined)).toHaveLength(1);
    // a decisão clínica sobre o retorno do atendimento da Bia: 403, sem efeito
    const dela = await prisma.raw.clinicsReturn.findFirst({ where: { originAttendanceId: daBia } });
    expect(
      (
        await post(`/api/clinics/returns/${dela!.id}/cancel`, profAna, {
          reason: 'not_needed',
        }).expect(403)
      ).body.message,
    ).toMatch(OUTRO);
    expect((await prisma.raw.clinicsReturn.findFirst({ where: { id: dela!.id } }))?.status).toBe(
      'pending',
    );
    // sobre o próprio, pode
    const meu = await prisma.raw.clinicsReturn.findFirst({ where: { originAttendanceId: daAna } });
    await post(`/api/clinics/returns/${meu!.id}/cancel`, profAna, { reason: 'not_needed' }).expect(
      201,
    );
    // sem vínculo, nenhuma decisão clínica
    expect(
      (
        await post(`/api/clinics/returns/${dela!.id}/cancel`, profSemVinculo, {
          reason: 'not_needed',
        }).expect(403)
      ).body.message,
    ).toMatch(SEM_VINCULO);
  });

  describe('a troca do profissional (a cobertura), concorrente com o registro', () => {
    it('a remarcação para Bia vence: o registro de Ana, que esperava a trava, é recusado sem efeito', async () => {
      const ag = await agendar(ana);
      const pausa = pausarNaAuditoria('clinics.appointment.rescheduled');
      const remarcacao = disparar(
        post(`/api/clinics/appointments/${ag}/reschedule`, owner, {
          date: SEGUNDA,
          time: '20:00',
          professionalId: bia,
        }),
      );
      await pausa.chegou.aberto;
      const registro = disparar(atender(ag, profAna));
      await alguemEspera();
      pausa.segue.abrir();
      expect((await remarcacao).status).toBe(201);
      const r = await registro;
      expect(r.status).toBe(403);
      expect(r.body.message).toMatch(OUTRO);
      const depois = await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } });
      expect(depois).toMatchObject({ professionalId: bia, status: 'scheduled' });
      expect(await prisma.raw.clinicsAttendance.count({ where: { appointmentId: ag } })).toBe(0);
    });

    it('o registro de Ana vence: a remarcação é recusada, e o histórico não muda de dono', async () => {
      const ag = await agendar(ana);
      const pausa = pausarNaAuditoria('clinics.attendance.recorded');
      const registro = disparar(atender(ag, profAna));
      await pausa.chegou.aberto;
      const remarcacao = disparar(
        post(`/api/clinics/appointments/${ag}/reschedule`, owner, {
          date: SEGUNDA,
          time: '20:00',
          professionalId: bia,
        }),
      );
      await alguemEspera();
      pausa.segue.abrir();
      expect((await registro).status).toBe(201);
      expect((await remarcacao).status).toBe(409);
      expect(
        await prisma.raw.clinicsAttendance.findFirst({ where: { appointmentId: ag } }),
      ).toMatchObject({ professionalId: ana });
      expect(await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } })).toMatchObject({
        professionalId: ana,
        status: 'attended',
      });
    });

    it('a remarcação troca o profissional antes do atendimento, com habilitação e trilha; depois, recusa', async () => {
      const ag = await agendar(ana);
      await post(`/api/clinics/appointments/${ag}/reschedule`, owner, {
        date: SEGUNDA,
        time: '21:00',
        professionalId: bia,
      }).expect(201);
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.appointment.rescheduled', entityId: ag },
      });
      expect(trilha?.before).toMatchObject({ professionalId: ana });
      expect(trilha?.after).toMatchObject({ professionalId: bia });
      // quem não está habilitado para o serviço: 400
      const carla = (
        await post('/api/clinics/professionals', owner, { name: 'Carla Fictícia' }).expect(201)
      ).body.id;
      await post(`/api/clinics/appointments/${ag}/reschedule`, owner, {
        date: SEGUNDA,
        time: '21:00',
        professionalId: carla,
      }).expect(400);
      // depois do atendimento, a troca é recusada pelo estado
      await atender(ag, profBia).expect(201);
      await post(`/api/clinics/appointments/${ag}/reschedule`, owner, {
        date: SEGUNDA,
        time: '21:00',
        professionalId: ana,
      }).expect(409);
    });
  });

  describe('a cobertura DEPOIS da chegada: trocar só o profissional de um horário "chegou"', () => {
    const chegou = async (professionalId: string) => {
      const ag = await agendar(professionalId);
      // a chegada parte de "confirmado"
      await post(`/api/clinics/appointments/${ag}/status`, owner, { to: 'confirmed' }).expect(201);
      await post(`/api/clinics/appointments/${ag}/status`, owner, { to: 'arrived' }).expect(201);
      return ag;
    };
    const trocar = (ag: string, professionalId: string, s: Session = owner) =>
      post(`/api/clinics/appointments/${ag}/professional`, s, { professionalId });

    it('a troca vence: o registro de Ana, que esperava, é recusado; Bia registra e o histórico é dela; só o profissional mudou', async () => {
      const ag = await chegou(ana);
      const antes = await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } });
      const pausa = pausarNaAuditoria('clinics.appointment.professional_changed');
      const troca = disparar(trocar(ag, bia));
      await pausa.chegou.aberto;
      const registro = disparar(atender(ag, profAna));
      await alguemEspera();
      pausa.segue.abrir();
      expect((await troca).status).toBe(201);
      const r = await registro;
      expect(r.status).toBe(403);
      expect(r.body.message).toMatch(OUTRO);
      const depois = await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } });
      // só o profissional mudou: estado, horário, serviço e paciente ficam
      expect(depois).toMatchObject({
        professionalId: bia,
        status: 'arrived',
        startsAt: antes!.startsAt,
        endsAt: antes!.endsAt,
        serviceId: antes!.serviceId,
        patientId: antes!.patientId,
      });
      expect(await prisma.raw.clinicsAttendance.count({ where: { appointmentId: ag } })).toBe(0);
      // quem efetivamente atendeu registra, e o histórico é dela
      await atender(ag, profBia).expect(201);
      expect(
        await prisma.raw.clinicsAttendance.findFirst({ where: { appointmentId: ag } }),
      ).toMatchObject({ professionalId: bia });
      // a trilha: o anterior, o novo e quem trocou
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.appointment.professional_changed', entityId: ag },
      });
      expect(trilha?.before).toMatchObject({ professionalId: ana, status: 'arrived' });
      expect(trilha?.after).toMatchObject({ professionalId: bia, status: 'arrived' });
      expect(trilha).toMatchObject({
        actorType: 'user',
        actorMembershipId: await membro('owner@veyra.test'),
      });
    });

    it('o registro vence: a troca, que esperava, é recusada, e o histórico continua de Ana', async () => {
      const ag = await chegou(ana);
      const pausa = pausarNaAuditoria('clinics.attendance.recorded');
      const registro = disparar(atender(ag, profAna));
      await pausa.chegou.aberto;
      const troca = disparar(trocar(ag, bia));
      await alguemEspera();
      pausa.segue.abrir();
      expect((await registro).status).toBe(201);
      const t = await troca;
      expect(t.status).toBe(409);
      expect(t.body.message).toMatch(/já foi registrado/);
      expect(
        await prisma.raw.clinicsAttendance.findFirst({ where: { appointmentId: ag } }),
      ).toMatchObject({ professionalId: ana });
      expect(await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } })).toMatchObject({
        professionalId: ana,
        status: 'attended',
      });
    });

    it('as verificações: só "chegou"; o mesmo profissional; o não habilitado; e só quem gere a agenda', async () => {
      const marcado = await agendar(ana);
      expect((await trocar(marcado, bia).expect(409)).body.message).toMatch(/use a remarcação/);
      const ag = await chegou(ana);
      await trocar(ag, ana).expect(400);
      const carla = (
        await post('/api/clinics/professionals', owner, { name: 'Carla Fictícia' }).expect(201)
      ).body.id;
      await trocar(ag, carla).expect(400);
      // o Profissional não gere a agenda
      await trocar(ag, bia, profAna).expect(403);
      expect(await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } })).toMatchObject({
        professionalId: ana,
      });
    });
  });

  describe('a chave `clinics:care:all` nos papéis que já existiam, pelo livro', () => {
    const papelDe = async (systemKey: string) =>
      (await prisma.raw.role.findFirst({ where: { workspaceId: ws.workspaceId, systemKey } }))!.id;
    const tem = async (roleId: string) =>
      (await prisma.raw.rolePermission.count({
        where: { roleId, permissionKey: 'clinics:care:all' },
      })) === 1;
    /** um workspace ativado ANTES da chave: sem ela nos papéis e sem o livro */
    const comoAntes = async () => {
      await prisma.raw.rolePermission.deleteMany({
        where: { workspaceId: ws.workspaceId, permissionKey: 'clinics:care:all' },
      });
      await prisma.raw.permissionBackfill.deleteMany({ where: { workspaceId: ws.workspaceId } });
    };

    it('preenche Owner, Admin e "Recepção e atendimento" (com o pré-requisito); nunca Profissional nem Member; uma vez só', async () => {
      await app.get(ClinicsActivationService).syncRoles('acme');
      await comoAntes();
      const preencher = () => app.get(ClinicsActivationService).preencherChavesNovas();
      expect(await preencher()).toBe(3);
      for (const k of ['owner', 'admin', CLINICS_RECEPTION_CARE_SYSTEM_KEY]) {
        expect(await tem(await papelDe(k))).toBe(true);
      }
      for (const k of [CLINICS_PROFESSIONAL_SYSTEM_KEY, 'member']) {
        expect(await tem(await papelDe(k))).toBe(false);
      }
      expect(
        await prisma.raw.auditLog.count({
          where: { workspaceId: ws.workspaceId, action: 'role.permission_backfilled' },
        }),
      ).toBe(3);
      expect(
        await prisma.raw.permissionBackfill.count({ where: { workspaceId: ws.workspaceId } }),
      ).toBe(3);
      // de novo: nada muda
      expect(await preencher()).toBe(0);
    });

    it('a revogação depois do preenchimento, ou da ativação, não é desfeita; sem o pré-requisito, nada', async () => {
      // a ativação já registrou no livro: revogar do Admin é definitivo
      const admin = await papelDe('admin');
      await prisma.raw.rolePermission.deleteMany({
        where: { roleId: admin, permissionKey: 'clinics:care:all' },
      });
      expect(await app.get(ClinicsActivationService).preencherChavesNovas()).toBe(0);
      expect(await tem(admin)).toBe(false);
      // sem `clinics:care:read`, o papel não recebe o alcance "todos"
      await comoAntes();
      const owner = await papelDe('owner');
      await prisma.raw.rolePermission.deleteMany({
        where: { roleId: owner, permissionKey: 'clinics:care:read' },
      });
      await app.get(ClinicsActivationService).preencherChavesNovas();
      expect(await tem(owner)).toBe(false);
      expect(await tem(admin)).toBe(true);
    });

    it('o papel avaliado sem o pré-requisito não recebe o alcance quando ganhar `care:read` depois', async () => {
      await comoAntes();
      const owner = await papelDe('owner');
      await prisma.raw.rolePermission.deleteMany({
        where: { roleId: owner, permissionKey: 'clinics:care:read' },
      });
      await app.get(ClinicsActivationService).preencherChavesNovas();
      await prisma.raw.rolePermission.create({
        data: { workspaceId: ws.workspaceId, roleId: owner, permissionKey: 'clinics:care:read' },
      });
      await app.get(ClinicsActivationService).preencherChavesNovas();
      expect(await tem(owner)).toBe(false);
    });

    it('o papel criado pela sincronização entra no livro: a revogação depois não é desfeita', async () => {
      await prisma.raw.role.deleteMany({
        where: { workspaceId: ws.workspaceId, systemKey: CLINICS_RECEPTION_CARE_SYSTEM_KEY },
      });
      await app.get(ClinicsActivationService).syncRoles('acme');
      const combinado = await papelDe(CLINICS_RECEPTION_CARE_SYSTEM_KEY);
      expect(await tem(combinado)).toBe(true);
      await prisma.raw.rolePermission.deleteMany({
        where: { roleId: combinado, permissionKey: 'clinics:care:all' },
      });
      await app.get(ClinicsActivationService).preencherChavesNovas();
      expect(await tem(combinado)).toBe(false);
    });

    it('vincular uma conta a um profissional exige o alcance "todos": sem ele, quem gere o catálogo não se dá o histórico alheio', async () => {
      const papel = await prisma.raw.role.create({
        data: { workspaceId: ws.workspaceId, name: 'Gestão do catálogo (fictício)' },
      });
      await prisma.raw.rolePermission.createMany({
        data: [
          'clinics:catalog:read',
          'clinics:catalog:manage',
          'members:read',
          'clinics:schedule:read',
          'clinics:care:read',
        ].map((permissionKey) => ({
          workspaceId: ws.workspaceId,
          roleId: papel.id,
          permissionKey,
        })),
      });
      const user = await createUserFixture(prisma, 'gestor@veyra.test');
      const gestor = await createMembershipFixture(prisma, ws.workspaceId, user, papel.id);
      const sessao = await loginAs('gestor@veyra.test');
      await put(`/api/clinics/professionals/${bia}/account`, sessao, {
        membershipId: gestor,
      }).expect(403);
      expect(
        (await prisma.raw.clinicsProfessional.findFirst({ where: { id: bia } }))?.membershipId,
      ).not.toBe(gestor);
    });
  });
});
