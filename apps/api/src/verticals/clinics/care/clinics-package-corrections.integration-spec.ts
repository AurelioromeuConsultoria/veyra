import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import request from 'supertest';
import { CLINICS_PROFESSIONAL_SYSTEM_KEY } from '@veyra/contracts/verticals/clinics';
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
import { ClinicsPackageCorrectionsService } from './clinics-package-corrections.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

/** Uma segunda-feira (São Paulo, sem horário de verão). */
const SEGUNDA = '2030-11-04';
const MUDOU = /O consumo deste atendimento mudou/;

/**
 * F5.2a (ADR-059): a correção do consumo de pacote de um atendimento
 * registrado. Dados FICTÍCIOS. As corridas são forçadas como na F3.1: a
 * primeira transação pausa na auditoria, segurando o que travou, e a segunda é
 * comprovadamente vista esperando a trava (`pg_stat_activity`), nunca por sono.
 */
describe('Clinics — correção de um consumo de pacote (integração, F5.2a)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let observador: Client;

  /** os gatilhos SÓ DE TESTE: apagados também aqui, para sobreviver a uma rodada interrompida */
  const apagarGatilhosDeTeste = async () => {
    for (const nome of ['teste_pausa_entre_pacotes', 'teste_move_consumo']) {
      await observador.query(`DROP TRIGGER IF EXISTS "${nome}" ON "ClinicsPackage"`);
      await observador.query(`DROP FUNCTION IF EXISTS "${nome}"()`);
    }
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
    observador = new Client({ connectionString: TEST_DATABASE_URL });
    await observador.connect();
    await apagarGatilhosDeTeste();
  });
  afterAll(async () => {
    await observador.end();
    await app.close();
  });

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let owner: Session;
  let recepcao: Session;
  let convidado: Session;
  let profissional: Session;
  let ownerB: Session;
  let membroOwner: string;
  let membroProfissional: string;
  let papelProfissional: string;
  let servico: string;
  let outroServico: string;
  let ana: string;
  let paciente: string;
  let outroPaciente: string;

  /** o que uma corrida deixa em aberto: soltos no afterEach, ou o jest não sai */
  let portoes: (() => void)[] = [];
  let pendentes: Promise<unknown>[] = [];
  let trava: Client | null = null;
  afterEach(async () => {
    for (const abrir of portoes) abrir();
    portoes = [];
    if (trava) {
      await trava.end().catch(() => undefined);
      trava = null;
    }
    await Promise.allSettled(pendentes);
    pendentes = [];
    await apagarGatilhosDeTeste();
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
  /** Alguma sessão espera uma trava numa instrução sobre a tabela. */
  const alguemEspera = (tabela: 'ClinicsPackage' | 'ClinicsAppointment') =>
    ate(async () => {
      const { rows } = await observador.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
        [`%"${tabela}"%`],
      );
      return Number(rows[0].n) > 0;
    }, `alguém esperando a trava de ${tabela}`);

  /** Dispara sem esperar, guardando para o afterEach. */
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
    jest.spyOn(audit, 'record').mockImplementation(async (db, ws, action, input) => {
      if (action === acao && primeira) {
        primeira = false;
        chegou.abrir();
        await segue.aberto;
      }
      return real(db, ws, action, input);
    });
    return { chegou, segue };
  }

  let minuto = 0;
  const agendar = async (body: Record<string, unknown> = {}) => {
    const hora = 8 + Math.floor(minuto / 60);
    const time = `${String(hora).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}`;
    minuto += 60;
    return (
      await post('/api/clinics/appointments', owner, {
        patientId: paciente,
        professionalId: ana,
        serviceId: servico,
        date: SEGUNDA,
        time,
        ...body,
      }).expect(201)
    ).body.id as string;
  };
  const criarPacote = async (body: Record<string, unknown> = {}) =>
    (
      await post('/api/clinics/packages', owner, {
        patientId: paciente,
        serviceId: servico,
        totalSessions: 3,
        ...body,
      }).expect(201)
    ).body.id as string;
  const atender = (agendamento: string, packageId: string | null = null) =>
    post(`/api/clinics/appointments/${agendamento}/attendance`, owner, { packageId });
  /** Um atendimento registrado, já com a escolha do registro. */
  const atendido = async (packageId: string | null = null) => {
    const ag = await agendar();
    await atender(ag, packageId).expect(201);
    return ag;
  };
  const corrigir = (
    agendamento: string,
    body: { expectedRevision: number; packageId: string | null; reason?: string },
    s: Session = owner,
    chave: string | null = randomUUID(),
  ) => {
    const r = post(`/api/clinics/appointments/${agendamento}/attendance/package-correction`, s);
    if (chave) r.set('Idempotency-Key', chave);
    return r.send({ reason: 'wrong_choice', ...body });
  };
  const pacote = (id: string) => prisma.raw.clinicsPackage.findFirst({ where: { id } });
  const consumo = async (agendamento: string) => {
    const a = await prisma.raw.clinicsAttendance.findFirst({
      where: { appointmentId: agendamento },
    });
    return {
      original: a?.packageId ?? null,
      vigente: a?.currentPackageId ?? null,
      revisao: a?.consumptionRevision,
    };
  };
  const correcoes = () => prisma.raw.clinicsPackageCorrection.count();
  /** A igualdade, também conferida pelo banco no COMMIT: consumidas = atendimentos com o consumo vigente. */
  const igualdadeVale = async () => {
    const { rows } = await observador.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "ClinicsPackage" p
        WHERE p."consumedSessions" <> (SELECT count(*) FROM "ClinicsAttendance" a
                                         WHERE a."workspaceId" = p."workspaceId"
                                           AND a."currentPackageId" = p."id")`,
    );
    return Number(rows[0].n) === 0;
  };

  beforeEach(async () => {
    minuto = 0;
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    for (const systemKey of ['owner', 'member', 'guest']) {
      const user = await createUserFixture(prisma, `${systemKey}-a@veyra.test`);
      await createMembershipFixture(prisma, wsA.workspaceId, user, wsA.roles[systemKey]);
    }
    const userB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, userB, wsB.roles.owner);
    await app.get(ClinicsActivationService).enable('acme');
    await app.get(ClinicsActivationService).enable('beta');
    papelProfissional = (await prisma.raw.role.findFirst({
      where: { workspaceId: wsA.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
    }))!.id;
    const prof = await createUserFixture(prisma, 'prof-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, prof, papelProfissional);
    membroOwner = (await prisma.raw.membership.findFirst({
      where: { workspaceId: wsA.workspaceId, roleId: wsA.roles.owner },
    }))!.id;
    membroProfissional = (await prisma.raw.membership.findFirst({
      where: { workspaceId: wsA.workspaceId, roleId: papelProfissional },
    }))!.id;

    owner = await loginAs('owner-a@veyra.test');
    recepcao = await loginAs('member-a@veyra.test');
    convidado = await loginAs('guest-a@veyra.test');
    profissional = await loginAs('prof-a@veyra.test');
    ownerB = await loginAs('owner-b@veyra.test');
    const unitA = (await prisma.raw.clinicsUnit.findFirst({
      where: { workspaceId: wsA.workspaceId },
    }))!.id;
    servico = (
      await post('/api/clinics/services', owner, {
        name: 'Limpeza de pele',
        durationMin: 60,
      }).expect(201)
    ).body.id;
    outroServico = (
      await post('/api/clinics/services', owner, { name: 'Peeling', durationMin: 60 }).expect(201)
    ).body.id;
    ana = (await post('/api/clinics/professionals', owner, { name: 'Ana Fictícia' }).expect(201))
      .body.id;
    await put(`/api/clinics/professionals/${ana}/profile`, owner, {
      name: 'Ana Fictícia',
      serviceIds: [servico, outroServico],
      intervals: [1, 2, 3, 4, 5].map((weekday) => ({
        unitId: unitA,
        weekday,
        startMinute: 480,
        endMinute: 1320,
      })),
    }).expect(200);
    // D8 (ADR-061): o Profissional dos testes é a Ana — só os atendimentos dela
    await put(`/api/clinics/professionals/${ana}/account`, owner, {
      membershipId: (await prisma.raw.membership.findFirst({
        where: { user: { email: 'prof-a@veyra.test' } },
      }))!.id,
    }).expect(200);
    const contato = (await post('/api/contacts', owner, { name: 'Paciente Fictícia' }).expect(201))
      .body.id;
    paciente = (await post('/api/clinics/patients', owner, { contactId: contato }).expect(201)).body
      .id;
    const outro = (await post('/api/contacts', owner, { name: 'Outra Fictícia' }).expect(201)).body
      .id;
    outroPaciente = (await post('/api/clinics/patients', owner, { contactId: outro }).expect(201))
      .body.id;
  });

  // ── As três formas e os estados ─────────────────────────────────────────

  describe('as três formas e os estados do pacote', () => {
    it('do pacote para avulso: a sessão volta, a escolha original fica, e o atendimento, o agendamento e os retornos não mudam', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      const antes = await prisma.raw.clinicsAttendance.findFirst({
        where: { appointmentId: ag },
      });
      const res = await corrigir(ag, { expectedRevision: 0, packageId: null }).expect(201);
      expect(res.body).toMatchObject({
        appointmentId: ag,
        fromPackageId: p,
        toPackageId: null,
        revision: 1,
        reason: 'wrong_choice',
        correctedByMembershipId: membroOwner,
      });
      expect(await consumo(ag)).toEqual({ original: p, vigente: null, revisao: 1 });
      expect(await pacote(p)).toMatchObject({ consumedSessions: 0, status: 'active' });
      // o atendimento é o mesmo, e o agendamento continua atendido
      const depois = await prisma.raw.clinicsAttendance.findFirst({ where: { appointmentId: ag } });
      expect([depois?.id, depois?.completedAt, depois?.recordedByMembershipId]).toEqual([
        antes?.id,
        antes?.completedAt,
        antes?.recordedByMembershipId,
      ]);
      expect((await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } }))?.status).toBe(
        'attended',
      );
      // a leitura do atendimento traz o vigente, a escolha original e a revisão
      expect(
        (await get(`/api/clinics/appointments/${ag}/attendance`, owner).expect(200)).body,
      ).toMatchObject({ packageId: null, originalPackageId: p, consumptionRevision: 1 });
      // a trilha: ids, motivo, revisão e, de cada pacote, as consumidas e o estado
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.package.consumption_corrected' },
      });
      expect(trilha?.before).toEqual({
        fromPackage: { consumedSessions: 1, status: 'active' },
        toPackage: null,
      });
      expect(trilha?.after).toEqual({
        attendanceId: antes?.id,
        fromPackageId: p,
        toPackageId: null,
        reason: 'wrong_choice',
        revision: 1,
        fromPackage: { consumedSessions: 0, status: 'active' },
        toPackage: null,
      });
      expect(await igualdadeVale()).toBe(true);
    });

    it('de avulso para o pacote: consome como o registro, e a última sessão o conclui na mesma transação, com a trilha', async () => {
      const p = await criarPacote({ totalSessions: 1 });
      const ag = await atendido(null);
      await corrigir(ag, { expectedRevision: 0, packageId: p }).expect(201);
      expect(await consumo(ag)).toEqual({ original: null, vigente: p, revisao: 1 });
      expect(await pacote(p)).toMatchObject({ consumedSessions: 1, status: 'completed' });
      expect(
        await prisma.raw.auditLog.count({
          where: { action: 'clinics.package.completed', entityId: p },
        }),
      ).toBe(1);
      expect(await igualdadeVale()).toBe(true);
    });

    it('de P CONCLUÍDO para Q: P volta a ativo, sem encerramento, e Q consome', async () => {
      const p = await criarPacote({ totalSessions: 1 });
      const q = await criarPacote({ totalSessions: 2 });
      const ag = await atendido(p);
      expect((await pacote(p))?.status).toBe('completed');
      await corrigir(ag, { expectedRevision: 0, packageId: q }).expect(201);
      expect(await pacote(p)).toMatchObject({
        consumedSessions: 0,
        status: 'active',
        closedAt: null,
      });
      expect(await pacote(q)).toMatchObject({ consumedSessions: 1, status: 'active' });
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.package.consumption_corrected' },
      });
      expect(trilha?.before).toEqual({
        fromPackage: { consumedSessions: 1, status: 'completed' },
        toPackage: { consumedSessions: 0, status: 'active' },
      });
      expect(await igualdadeVale()).toBe(true);
    });

    it('a matriz de estados: de P CANCELADO para Q (P continua cancelado, Q consome) e de P CONCLUÍDO para avulso (P volta a ativo)', async () => {
      const cancelado = await criarPacote();
      const q = await criarPacote();
      const a1 = await atendido(cancelado);
      await post(`/api/clinics/packages/${cancelado}/cancel`, owner).expect(201);
      await corrigir(a1, { expectedRevision: 0, packageId: q }).expect(201);
      expect(await pacote(cancelado)).toMatchObject({ consumedSessions: 0, status: 'canceled' });
      expect(await pacote(q)).toMatchObject({ consumedSessions: 1, status: 'active' });
      const concluido = await criarPacote({ totalSessions: 1 });
      const a2 = await atendido(concluido);
      await corrigir(a2, { expectedRevision: 0, packageId: null }).expect(201);
      expect(await pacote(concluido)).toMatchObject({
        consumedSessions: 0,
        status: 'active',
        closedAt: null,
      });
      expect(await igualdadeVale()).toBe(true);
    });

    it('do pacote CANCELADO para avulso: a sessão volta, e o pacote CONTINUA cancelado', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      await post(`/api/clinics/packages/${p}/cancel`, owner).expect(201);
      const fechado = (await pacote(p))?.closedAt;
      await corrigir(ag, { expectedRevision: 0, packageId: null }).expect(201);
      expect(await pacote(p)).toMatchObject({
        consumedSessions: 0,
        status: 'canceled',
        closedAt: fechado,
      });
      expect(await igualdadeVale()).toBe(true);
    });

    it('para um pacote concluído ou cancelado: 409, e NADA muda — nem a devolução ao pacote de origem', async () => {
      const p = await criarPacote();
      const concluido = await criarPacote({ totalSessions: 1 });
      await atendido(concluido);
      const cancelado = await criarPacote();
      await post(`/api/clinics/packages/${cancelado}/cancel`, owner).expect(201);
      const ag = await atendido(p);
      const r1 = await corrigir(ag, { expectedRevision: 0, packageId: concluido }).expect(409);
      expect(r1.body.message).toMatch(
        /Pacote concluído: não há sessões a consumir; nada foi corrigido/,
      );
      const r2 = await corrigir(ag, { expectedRevision: 0, packageId: cancelado }).expect(409);
      expect(r2.body.message).toMatch(/Pacote cancelado: nada foi corrigido/);
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 0 });
      expect((await pacote(p))?.consumedSessions).toBe(1);
      expect(await correcoes()).toBe(0);
      expect(
        await prisma.raw.auditLog.count({
          where: { action: 'clinics.package.consumption_corrected' },
        }),
      ).toBe(0);
      expect(await igualdadeVale()).toBe(true);
    });

    it('pacote de outro paciente ou serviço: 400; de outro workspace: 404; o mesmo consumo: 400 — nada muda', async () => {
      const p = await criarPacote();
      const deOutroPaciente = await criarPacote({ patientId: outroPaciente });
      const deOutroServico = await criarPacote({ serviceId: outroServico });
      const contatoB = (await post('/api/contacts', ownerB, { name: 'B' }).expect(201)).body.id;
      const pacienteB = (
        await post('/api/clinics/patients', ownerB, { contactId: contatoB }).expect(201)
      ).body.id;
      const servicoB = (
        await post('/api/clinics/services', ownerB, { name: 'S', durationMin: 30 }).expect(201)
      ).body.id;
      const deB = (
        await post('/api/clinics/packages', ownerB, {
          patientId: pacienteB,
          serviceId: servicoB,
          totalSessions: 2,
        }).expect(201)
      ).body.id;
      const ag = await atendido(p);
      for (const outro of [deOutroPaciente, deOutroServico]) {
        const r = await corrigir(ag, { expectedRevision: 0, packageId: outro }).expect(400);
        expect(r.body.message).toMatch(/O pacote é de outro paciente ou de outro serviço/);
      }
      const r404 = await corrigir(ag, { expectedRevision: 0, packageId: deB }).expect(404);
      expect(r404.body.message).toMatch(/Pacote não encontrado/);
      const igual = await corrigir(ag, { expectedRevision: 0, packageId: p }).expect(400);
      expect(igual.body.message).toMatch(/O consumo escolhido já é o deste atendimento/);
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 0 });
      expect(await correcoes()).toBe(0);
      expect(await igualdadeVale()).toBe(true);
    });

    it('corrigir uma correção (A → B → A) é outra correção, com a revisão seguinte; "escolha errada" vale para ela', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      await corrigir(ag, { expectedRevision: 0, packageId: null }).expect(201);
      const volta = await corrigir(ag, { expectedRevision: 1, packageId: p }).expect(201);
      expect(volta.body).toMatchObject({ fromPackageId: null, toPackageId: p, revision: 2 });
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 2 });
      expect((await pacote(p))?.consumedSessions).toBe(1);
      expect(await correcoes()).toBe(2);
      expect(await igualdadeVale()).toBe(true);
    });

    it('"pacote cadastrado depois do atendimento": só de avulso para um pacote criado DEPOIS do registro; fora disso, 400', async () => {
      const antigo = await criarPacote();
      const ag = await atendido(null);
      const novo = await criarPacote();
      const late = { reason: 'package_registered_late' };
      const r1 = await corrigir(ag, { expectedRevision: 0, packageId: antigo, ...late }).expect(
        400,
      );
      expect(r1.body.message).toMatch(/O pacote já existia quando o atendimento foi registrado/);
      const r2 = await corrigir(ag, { expectedRevision: 0, packageId: null, ...late }).expect(400);
      expect(r2.body.message).toMatch(/só vale de avulso para um pacote/);
      expect(await correcoes()).toBe(0);
      await corrigir(ag, { expectedRevision: 0, packageId: novo, ...late }).expect(201);
      expect(await consumo(ag)).toEqual({ original: null, vigente: novo, revisao: 1 });
      // de pacote para outro, nunca
      const r3 = await corrigir(ag, { expectedRevision: 1, packageId: antigo, ...late }).expect(
        400,
      );
      expect(r3.body.message).toMatch(/só vale de avulso para um pacote/);
      expect(await igualdadeVale()).toBe(true);
    });

    it('depois da correção, repetir o REGISTRO original continua comparando com a escolha original: o mesmo pedido devolve o registro, sem consumir; outra escolha, 409', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      await corrigir(ag, { expectedRevision: 0, packageId: null }).expect(201);
      const repetido = await atender(ag, p);
      expect(repetido.status).toBeLessThan(300);
      expect(repetido.body).toMatchObject({ packageId: null, originalPackageId: p });
      const r = await atender(ag, null).expect(409);
      expect(r.body.message).toMatch(/já foi registrado com outra escolha/);
      expect((await pacote(p))?.consumedSessions).toBe(0);
      expect(await consumo(ag)).toEqual({ original: p, vigente: null, revisao: 1 });
    });

    it('atendimento não registrado: 404; agendamento inexistente: 404', async () => {
      const ag = await agendar();
      const r = await corrigir(ag, { expectedRevision: 0, packageId: null }).expect(404);
      expect(r.body.message).toMatch(/Atendimento não registrado/);
      const r2 = await corrigir(randomUUID(), { expectedRevision: 0, packageId: null }).expect(404);
      expect(r2.body.message).toMatch(/Agendamento não encontrado/);
    });
  });

  // ── A repetição: a revisão e a Idempotency-Key ───────────────────────────

  describe('a repetição: a revisão do consumo e a Idempotency-Key', () => {
    it('sem Idempotency-Key: 400, sem efeito', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      const r = await corrigir(ag, { expectedRevision: 0, packageId: null }, owner, null).expect(
        400,
      );
      expect(r.body.message).toMatch(/Idempotency-Key obrigatória/);
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 0 });
    });

    it('a mesma chave e o mesmo pedido: devolve a correção ORIGINAL, sem executar de novo — mesmo depois de outra correção', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      const chave = randomUUID();
      const primeira = await corrigir(
        ag,
        { expectedRevision: 0, packageId: null },
        owner,
        chave,
      ).expect(201);
      const repetida = await corrigir(
        ag,
        { expectedRevision: 0, packageId: null },
        owner,
        chave,
      ).expect(201);
      expect(repetida.headers['idempotent-replay']).toBe('true');
      expect(repetida.body).toEqual(primeira.body);
      expect(await correcoes()).toBe(1);
      expect((await pacote(p))?.consumedSessions).toBe(0);
      // outra pessoa corrige depois (de volta ao pacote)
      await corrigir(ag, { expectedRevision: 1, packageId: p }, profissional).expect(201);
      const tardia = await corrigir(
        ag,
        { expectedRevision: 0, packageId: null },
        owner,
        chave,
      ).expect(201);
      expect(tardia.headers['idempotent-replay']).toBe('true');
      expect(tardia.body).toEqual(primeira.body);
      expect(await correcoes()).toBe(2);
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 2 });
      expect(await igualdadeVale()).toBe(true);
    });

    it('chave NOVA com a revisão velha: 409, sem efeito — inclusive em A → B → A, quando o vigente voltou a ser o que a pessoa viu', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      await corrigir(ag, { expectedRevision: 0, packageId: null }).expect(201);
      await corrigir(ag, { expectedRevision: 1, packageId: p }).expect(201);
      // o vigente é P de novo, como na revisão 0, mas a revisão é outra
      const r = await corrigir(ag, { expectedRevision: 0, packageId: null }).expect(409);
      expect(r.body.message).toMatch(MUDOU);
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 2 });
      expect(await correcoes()).toBe(2);
    });

    it('dois atores, a MESMA chave e o mesmo corpo: o segundo recebe 409, nunca a correção do primeiro; a autoria fica com quem executou', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      const chave = randomUUID();
      const doOwner = await corrigir(
        ag,
        { expectedRevision: 0, packageId: null },
        owner,
        chave,
      ).expect(201);
      const doProf = await corrigir(
        ag,
        { expectedRevision: 0, packageId: null },
        profissional,
        chave,
      ).expect(409);
      expect(doProf.body.id).toBeUndefined();
      expect(doProf.body.message).toMatch(/Idempotency-Key já usada para uma requisição diferente/);
      expect(await correcoes()).toBe(1);
      expect(
        (await prisma.raw.clinicsPackageCorrection.findFirst({ where: { id: doOwner.body.id } }))
          ?.correctedByMembershipId,
      ).toBe(membroOwner);
    });

    it('dois atores, pedidos iguais com chaves próprias, em sequência: o segundo recebe 409 pela revisão, e a autoria é do primeiro', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      await corrigir(ag, { expectedRevision: 0, packageId: null }, profissional).expect(201);
      const r = await corrigir(ag, { expectedRevision: 0, packageId: null }, owner).expect(409);
      expect(r.body.message).toMatch(MUDOU);
      const unica = await prisma.raw.clinicsPackageCorrection.findMany({});
      expect(unica.map((c) => c.correctedByMembershipId)).toEqual([membroProfissional]);
    });

    it('o replay reconfere o acesso de AGORA: quem perdeu a leitura do atendimento recebe 403, e o corpo guardado não sai', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      const chave = randomUUID();
      const primeira = await corrigir(
        ag,
        { expectedRevision: 0, packageId: null },
        profissional,
        chave,
      ).expect(201);
      await prisma.raw.rolePermission.deleteMany({
        where: { roleId: papelProfissional, permissionKey: 'clinics:care:read' },
      });
      const r = await corrigir(
        ag,
        { expectedRevision: 0, packageId: null },
        profissional,
        chave,
      ).expect(403);
      expect(JSON.stringify(r.body)).not.toContain(primeira.body.id);
      expect(r.headers['idempotent-replay']).toBeUndefined();
      expect(await correcoes()).toBe(1);
    });
  });

  // ── Permissões e isolamento ──────────────────────────────────────────────

  describe('permissões e isolamento', () => {
    it('a recepção (só agenda) e o convidado: 403 na correção e nas sessões; o profissional (care:write + care:read) corrige', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      for (const s of [recepcao, convidado]) {
        await corrigir(ag, { expectedRevision: 0, packageId: null }, s).expect(403);
        await get(`/api/clinics/packages/${p}/sessions`, s).expect(403);
      }
      expect(await correcoes()).toBe(0);
      const r = await corrigir(ag, { expectedRevision: 0, packageId: null }, profissional).expect(
        201,
      );
      expect(r.body.correctedByMembershipId).toBe(membroProfissional);
    });

    it('a regra de leitura mora no SERVIÇO: chamado direto, sem `care:read` no papel, recusa antes de qualquer efeito', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      const cls = app.get(ClsService);
      const servico = app.get(ClinicsPackageCorrectionsService);
      const membroRecepcao = (await prisma.raw.membership.findFirst({
        where: { workspaceId: wsA.workspaceId, roleId: wsA.roles.member },
      }))!.id;
      await expect(
        cls.run(async () => {
          cls.set('workspaceId', wsA.workspaceId);
          cls.set('roleId', wsA.roles.member);
          return await servico.correct(
            { workspaceId: wsA.workspaceId, membershipId: membroRecepcao } as never,
            ag,
            { expectedRevision: 0, packageId: null, reason: 'wrong_choice' },
          );
        }),
      ).rejects.toThrow(/Corrigir o consumo exige a leitura do atendimento/);
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 0 });
      expect(await correcoes()).toBe(0);
    });

    it('quem ESCREVE atendimento sem LER (papel customizado) repete o próprio registro avulso depois de uma correção e NÃO vê o pacote vigente', async () => {
      const papel = await prisma.raw.role.create({
        data: { workspaceId: wsA.workspaceId, name: 'Escreve sem ler (fictício)' },
      });
      await prisma.raw.rolePermission.createMany({
        // com o alcance "todos" (ADR-061): o teste é da LEITURA, não do vínculo
        data: [
          'clinics:care:write',
          'clinics:care:all',
          'clinics:schedule:read',
          'clinics:catalog:read',
        ].map((permissionKey) => ({
          workspaceId: wsA.workspaceId,
          roleId: papel.id,
          permissionKey,
        })),
      });
      const user = await createUserFixture(prisma, 'sem-leitura-a@veyra.test');
      await createMembershipFixture(prisma, wsA.workspaceId, user, papel.id);
      const semLeitura = await loginAs('sem-leitura-a@veyra.test');
      const p = await criarPacote();
      const ag = await agendar();
      await post(`/api/clinics/appointments/${ag}/attendance`, semLeitura, {
        packageId: null,
      }).expect(201);
      await corrigir(ag, { expectedRevision: 0, packageId: p }).expect(201);
      const repetido = (
        await post(`/api/clinics/appointments/${ag}/attendance`, semLeitura, { packageId: null })
      ).body;
      expect(JSON.stringify(repetido)).not.toContain(p);
      expect(
        ['packageId', 'originalPackageId', 'consumptionRevision'].some((k) => k in repetido),
      ).toBe(false);
      // a correção, para ele, não existe: 403
      await corrigir(ag, { expectedRevision: 1, packageId: null }, semLeitura).expect(403);
    });

    it('outro workspace: o agendamento e o pacote de A não existem para B (404), e nada muda', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      await corrigir(ag, { expectedRevision: 0, packageId: null }, ownerB).expect(404);
      await get(`/api/clinics/packages/${p}/sessions`, ownerB).expect(404);
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 0 });
    });

    it('as sessões do pacote: quem o consome agora e as correções que tiraram ou puseram uma sessão nele', async () => {
      const p = await criarPacote();
      const q = await criarPacote();
      const a1 = await atendido(p);
      const a2 = await atendido(p);
      await corrigir(a1, { expectedRevision: 0, packageId: q }).expect(201);
      const sessoes = (await get(`/api/clinics/packages/${p}/sessions`, profissional).expect(200))
        .body;
      expect(sessoes.sessions.map((s: { appointmentId: string }) => s.appointmentId)).toEqual([a2]);
      expect(
        sessoes.corrections.map((c: { fromPackageId: string; toPackageId: string }) => [
          c.fromPackageId,
          c.toPackageId,
        ]),
      ).toEqual([[p, q]]);
      const deQ = (await get(`/api/clinics/packages/${q}/sessions`, owner).expect(200)).body;
      expect(deQ.sessions.map((s: { appointmentId: string }) => s.appointmentId)).toEqual([a1]);
      expect(deQ.corrections).toHaveLength(1);
    });
  });

  // ── Concorrência, com a ordem forçada ────────────────────────────────────

  describe('concorrência (ordem forçada)', () => {
    it('duas correções do mesmo atendimento: a segunda espera o agendamento e recebe 409, sem efeito', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      const pausa = pausarNaAuditoria('clinics.package.consumption_corrected');
      const primeira = disparar(
        corrigir(ag, { expectedRevision: 0, packageId: null }).then((r) => r),
      );
      await pausa.chegou.aberto;
      const segunda = disparar(
        corrigir(ag, { expectedRevision: 0, packageId: null }, profissional).then((r) => r),
      );
      try {
        await alguemEspera('ClinicsAppointment');
      } finally {
        pausa.segue.abrir();
      }
      expect((await primeira).status).toBe(201);
      const r = await segunda;
      expect(r.status).toBe(409);
      expect(r.body.message).toMatch(MUDOU);
      expect(
        (await prisma.raw.clinicsPackageCorrection.findMany({})).map(
          (c) => c.correctedByMembershipId,
        ),
      ).toEqual([membroOwner]);
      expect(await consumo(ag)).toEqual({ original: p, vigente: null, revisao: 1 });
      expect((await pacote(p))?.consumedSessions).toBe(0);
      expect(await igualdadeVale()).toBe(true);
    });

    it('correções CRUZADAS entre dois pacotes (A1 e A2 trocam de pacote): os pacotes são travados em ordem de id — com a primeira pausada ENTRE os dois, a segunda espera sem segurar nada, e as duas concluem sem deadlock', async () => {
      const ids = [await criarPacote(), await criarPacote()].sort();
      const [menor, maior] = ids;
      const a1 = await atendido(menor);
      const a2 = await atendido(maior);
      // a pausa entre os dois pacotes: um gatilho SÓ DESTE TESTE, depois do UPDATE
      // do pacote menor, espera uma trava consultiva que o teste segura
      trava = new Client({ connectionString: TEST_DATABASE_URL });
      await trava.connect();
      await trava.query('SELECT pg_advisory_lock(4242, 1)');
      await observador.query(`
        CREATE FUNCTION "teste_pausa_entre_pacotes"() RETURNS trigger AS $$
        BEGIN
          IF NEW."id" = '${menor}' THEN PERFORM pg_advisory_xact_lock(4242, 1); END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await observador.query(`
        CREATE TRIGGER "teste_pausa_entre_pacotes" AFTER UPDATE ON "ClinicsPackage"
          FOR EACH ROW EXECUTE FUNCTION "teste_pausa_entre_pacotes"()`);
      const espera = (evento: string) =>
        ate(async () => {
          const { rows } = await observador.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND wait_event = $1`,
            [evento],
          );
          return Number(rows[0].n) > 0;
        }, `alguém esperando ${evento}`);
      // A1 (menor → maior) trava o menor e para antes do maior
      const primeira = disparar(
        corrigir(a1, { expectedRevision: 0, packageId: maior }).then((r) => r),
      );
      await espera('advisory');
      // A2 (maior → menor): na ordem de id, pede o MENOR primeiro e espera sem
      // segurar o maior; fora da ordem, seguraria o maior e o deadlock viria
      const segunda = disparar(
        corrigir(a2, { expectedRevision: 0, packageId: menor }, profissional).then((r) => r),
      );
      await espera('transactionid');
      await trava.query('SELECT pg_advisory_unlock(4242, 1)');
      expect((await primeira).status).toBe(201);
      expect((await segunda).status).toBe(201);
      expect(await consumo(a1)).toEqual({ original: menor, vigente: maior, revisao: 1 });
      expect(await consumo(a2)).toEqual({ original: maior, vigente: menor, revisao: 1 });
      expect((await pacote(menor))?.consumedSessions).toBe(1);
      expect((await pacote(maior))?.consumedSessions).toBe(1);
      expect(await igualdadeVale()).toBe(true);
    });

    it('a correção e o registro disputando a ÚLTIMA sessão de Q, nas duas ordens: quem chega primeiro leva; o outro recebe 409, sem efeito', async () => {
      // correção primeiro
      const q1 = await criarPacote({ totalSessions: 1 });
      const avulso1 = await atendido(null);
      const novo1 = await agendar();
      const pausa1 = pausarNaAuditoria('clinics.package.consumption_corrected');
      const c1 = disparar(corrigir(avulso1, { expectedRevision: 0, packageId: q1 }).then((r) => r));
      await pausa1.chegou.aberto;
      const r1 = disparar(atender(novo1, q1).then((r) => r));
      try {
        await alguemEspera('ClinicsPackage');
      } finally {
        pausa1.segue.abrir();
      }
      expect((await c1).status).toBe(201);
      expect((await r1).status).toBe(409);
      expect((await pacote(q1))?.status).toBe('completed');
      expect(await prisma.raw.clinicsAttendance.count({ where: { appointmentId: novo1 } })).toBe(0);
      jest.restoreAllMocks();

      // registro primeiro
      const p2 = await criarPacote();
      const q2 = await criarPacote({ totalSessions: 1 });
      const deP = await atendido(p2);
      const novo2 = await agendar();
      const pausa2 = pausarNaAuditoria('clinics.attendance.recorded');
      const r2 = disparar(atender(novo2, q2).then((r) => r));
      await pausa2.chegou.aberto;
      const c2 = disparar(corrigir(deP, { expectedRevision: 0, packageId: q2 }).then((r) => r));
      try {
        await alguemEspera('ClinicsPackage');
      } finally {
        pausa2.segue.abrir();
      }
      expect((await r2).status).toBe(201);
      const recusa = await c2;
      expect(recusa.status).toBe(409);
      expect(recusa.body.message).toMatch(/Pacote concluído/);
      // nada da correção ficou: nem a devolução a P
      expect(await consumo(deP)).toEqual({ original: p2, vigente: p2, revisao: 0 });
      expect((await pacote(p2))?.consumedSessions).toBe(1);
      expect(await igualdadeVale()).toBe(true);
    });

    it('a correção e o CANCELAMENTO do pacote de origem, nas duas ordens: a sessão volta, e o cancelado continua cancelado', async () => {
      // correção primeiro: devolve com P ativo; o cancelamento comita depois
      const p1 = await criarPacote();
      const a1 = await atendido(p1);
      const pausa1 = pausarNaAuditoria('clinics.package.consumption_corrected');
      const c1 = disparar(corrigir(a1, { expectedRevision: 0, packageId: null }).then((r) => r));
      await pausa1.chegou.aberto;
      const k1 = disparar(post(`/api/clinics/packages/${p1}/cancel`, owner).then((r) => r));
      try {
        await alguemEspera('ClinicsPackage');
      } finally {
        pausa1.segue.abrir();
      }
      expect((await c1).status).toBe(201);
      expect((await k1).status).toBe(201);
      expect(await pacote(p1)).toMatchObject({ consumedSessions: 0, status: 'canceled' });
      jest.restoreAllMocks();

      // cancelamento primeiro: a devolução chega a um pacote cancelado
      const p2 = await criarPacote();
      const a2 = await atendido(p2);
      const pausa2 = pausarNaAuditoria('clinics.package.canceled');
      const k2 = disparar(post(`/api/clinics/packages/${p2}/cancel`, owner).then((r) => r));
      await pausa2.chegou.aberto;
      const c2 = disparar(corrigir(a2, { expectedRevision: 0, packageId: null }).then((r) => r));
      try {
        await alguemEspera('ClinicsPackage');
      } finally {
        pausa2.segue.abrir();
      }
      expect((await k2).status).toBe(201);
      expect((await c2).status).toBe(201);
      expect(await pacote(p2)).toMatchObject({ consumedSessions: 0, status: 'canceled' });
      expect(await igualdadeVale()).toBe(true);
    });

    it('a correção e o CANCELAMENTO do pacote de destino, nas duas ordens: o consumo vale se veio antes; depois do cancelamento, 409 sem efeito', async () => {
      const q1 = await criarPacote();
      const a1 = await atendido(null);
      const pausa1 = pausarNaAuditoria('clinics.package.consumption_corrected');
      const c1 = disparar(corrigir(a1, { expectedRevision: 0, packageId: q1 }).then((r) => r));
      await pausa1.chegou.aberto;
      const k1 = disparar(post(`/api/clinics/packages/${q1}/cancel`, owner).then((r) => r));
      try {
        await alguemEspera('ClinicsPackage');
      } finally {
        pausa1.segue.abrir();
      }
      expect((await c1).status).toBe(201);
      expect((await k1).status).toBe(201);
      expect(await pacote(q1)).toMatchObject({ consumedSessions: 1, status: 'canceled' });
      jest.restoreAllMocks();

      const q2 = await criarPacote();
      const a2 = await atendido(null);
      const pausa2 = pausarNaAuditoria('clinics.package.canceled');
      const k2 = disparar(post(`/api/clinics/packages/${q2}/cancel`, owner).then((r) => r));
      await pausa2.chegou.aberto;
      const c2 = disparar(corrigir(a2, { expectedRevision: 0, packageId: q2 }).then((r) => r));
      try {
        await alguemEspera('ClinicsPackage');
      } finally {
        pausa2.segue.abrir();
      }
      expect((await k2).status).toBe(201);
      const r = await c2;
      expect(r.status).toBe(409);
      expect(r.body.message).toMatch(/Pacote cancelado: nada foi corrigido/);
      expect(await consumo(a2)).toEqual({ original: null, vigente: null, revisao: 0 });
      expect(await pacote(q2)).toMatchObject({ consumedSessions: 0, status: 'canceled' });
      expect(await igualdadeVale()).toBe(true);
    });

    it('a correção e a CONCLUSÃO de P pela última sessão: com o registro primeiro, P conclui e a correção o reabre; com a correção primeiro, P fica ativo', async () => {
      const p1 = await criarPacote({ totalSessions: 2 });
      const a1 = await atendido(p1);
      const ultima1 = await agendar();
      const pausa1 = pausarNaAuditoria('clinics.attendance.recorded');
      const r1 = disparar(atender(ultima1, p1).then((r) => r));
      await pausa1.chegou.aberto;
      const c1 = disparar(corrigir(a1, { expectedRevision: 0, packageId: null }).then((r) => r));
      try {
        await alguemEspera('ClinicsPackage');
      } finally {
        pausa1.segue.abrir();
      }
      expect((await r1).status).toBe(201);
      expect((await c1).status).toBe(201);
      expect(await pacote(p1)).toMatchObject({
        consumedSessions: 1,
        status: 'active',
        closedAt: null,
      });
      jest.restoreAllMocks();

      const p2 = await criarPacote({ totalSessions: 2 });
      const a2 = await atendido(p2);
      const ultima2 = await agendar();
      const pausa2 = pausarNaAuditoria('clinics.package.consumption_corrected');
      const c2 = disparar(corrigir(a2, { expectedRevision: 0, packageId: null }).then((r) => r));
      await pausa2.chegou.aberto;
      const r2 = disparar(atender(ultima2, p2).then((r) => r));
      try {
        await alguemEspera('ClinicsPackage');
      } finally {
        pausa2.segue.abrir();
      }
      expect((await c2).status).toBe(201);
      expect((await r2).status).toBe(201);
      expect(await pacote(p2)).toMatchObject({ consumedSessions: 1, status: 'active' });
      expect(await igualdadeVale()).toBe(true);
    });
  });

  // ── As regras do banco ───────────────────────────────────────────────────

  describe('o caminho dos gatilhos e o vínculo do retorno', () => {
    it('a correção e o VÍNCULO de um retorno ao mesmo agendamento atendido: o vínculo espera o agendamento, e os dois concluem — o retorno é cumprido pelo mesmo atendimento, com o consumo corrigido', async () => {
      const p = await criarPacote();
      const retorno = (
        await post('/api/clinics/returns', owner, {
          patientId: paciente,
          serviceId: servico,
          dueDate: '2030-12-01',
        }).expect(201)
      ).body.id as string;
      // o atendimento vem DEPOIS da criação do retorno: só ele o cumpre (F3.2)
      const ag = await atendido(p);
      const pausa = pausarNaAuditoria('clinics.package.consumption_corrected');
      const correcao = disparar(
        corrigir(ag, { expectedRevision: 0, packageId: null }).then((r) => r),
      );
      await pausa.chegou.aberto;
      const vinculo = disparar(
        post(`/api/clinics/returns/${retorno}/link`, owner, { appointmentId: ag }).then((r) => r),
      );
      try {
        await alguemEspera('ClinicsAppointment');
      } finally {
        pausa.segue.abrir();
      }
      expect((await correcao).status).toBe(201);
      expect((await vinculo).status).toBeLessThan(300);
      const a = (await prisma.raw.clinicsAttendance.findFirst({ where: { appointmentId: ag } }))!;
      expect(await prisma.raw.clinicsReturn.findFirst({ where: { id: retorno } })).toMatchObject({
        status: 'done',
        fulfilledByAttendanceId: a.id,
      });
      expect(await consumo(ag)).toEqual({ original: p, vigente: null, revisao: 1 });
      expect(await igualdadeVale()).toBe(true);
    });
  });

  describe('as regras do banco', () => {
    it('o consumo vigente e a revisão só mudam por uma correção; a correção não muda nem é apagada; a cascata do workspace a leva', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      const id = (await prisma.raw.clinicsAttendance.findFirst({ where: { appointmentId: ag } }))!
        .id;
      await expect(
        observador.query(
          `UPDATE "ClinicsAttendance" SET "currentPackageId" = NULL WHERE "id" = $1`,
          [id],
        ),
      ).rejects.toThrow(/O consumo de um atendimento só muda por uma correção registrada/);
      await expect(
        observador.query(
          `UPDATE "ClinicsAttendance" SET "consumptionRevision" = 1 WHERE "id" = $1`,
          [id],
        ),
      ).rejects.toThrow(/O consumo de um atendimento só muda por uma correção registrada/);
      await corrigir(ag, { expectedRevision: 0, packageId: null }).expect(201);
      await expect(
        observador.query(
          `UPDATE "ClinicsPackageCorrection" SET "reason" = 'package_registered_late'`,
        ),
      ).rejects.toThrow(/Uma correção de consumo não muda nem é apagada/);
      await expect(observador.query(`DELETE FROM "ClinicsPackageCorrection"`)).rejects.toThrow(
        /Uma correção de consumo não muda nem é apagada/,
      );
      expect(await correcoes()).toBe(1);
      await prisma.raw.workspace.deleteMany({ where: { id: wsA.workspaceId } });
      expect(await correcoes()).toBe(0);
    });

    it('uma correção fora da revisão ou do vigente é recusada pelo banco; a devolução sem correção, pela igualdade no COMMIT', async () => {
      const p = await criarPacote();
      const outroPacote = await criarPacote();
      const ag = await atendido(p);
      const a = (await prisma.raw.clinicsAttendance.findFirst({ where: { appointmentId: ag } }))!;
      const ap = (await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } }))!;
      const inserir = (from: string | null, revision: number) =>
        observador.query(
          `INSERT INTO "ClinicsPackageCorrection" ("id","workspaceId","attendanceId","appointmentId",
             "patientId","serviceId","unitId","fromPackageId","toPackageId","revision","reason",
             "correctedByMembershipId")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NULL, $8, 'wrong_choice', $9)`,
          [
            wsA.workspaceId,
            a.id,
            ag,
            ap.patientId,
            ap.serviceId,
            ap.unitId,
            from,
            revision,
            membroOwner,
          ],
        );
      await expect(inserir(p, 2)).rejects.toThrow(/não parte da revisão vigente do consumo/);
      await expect(inserir(outroPacote, 1)).rejects.toThrow(
        /A correção não parte do consumo vigente/,
      );
      // de avulso para avulso nem chega ao gatilho: o CHECK da tabela recusa antes
      await expect(inserir(null, 1)).rejects.toThrow(/ClinicsPackageCorrection_change_check/);
      // a correção certa, mas sem devolver a sessão: o COMMIT recusa
      await expect(inserir(p, 1)).rejects.toThrow(/não batem com os atendimentos que o consomem/);
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 0 });
      expect(await correcoes()).toBe(0);
    });

    it('"pacote cadastrado depois": o GATILHO recusa o pacote que já existia, mesmo com a sessão consumida na mesma transação', async () => {
      const antigo = await criarPacote();
      const ag = await atendido(null);
      const a = (await prisma.raw.clinicsAttendance.findFirst({ where: { appointmentId: ag } }))!;
      const ap = (await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } }))!;
      await observador.query('BEGIN');
      try {
        await observador.query(
          `UPDATE "ClinicsPackage" SET "consumedSessions" = "consumedSessions" + 1 WHERE "id" = $1`,
          [antigo],
        );
        await expect(
          observador.query(
            `INSERT INTO "ClinicsPackageCorrection" ("id","workspaceId","attendanceId","appointmentId",
               "patientId","serviceId","unitId","fromPackageId","toPackageId","revision","reason",
               "correctedByMembershipId")
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NULL, $7, 1, 'package_registered_late', $8)`,
            [wsA.workspaceId, a.id, ag, ap.patientId, ap.serviceId, ap.unitId, antigo, membroOwner],
          ),
        ).rejects.toThrow(/O pacote já existia no registro do atendimento/);
      } finally {
        await observador.query('ROLLBACK');
      }
      expect(await consumo(ag)).toEqual({ original: null, vigente: null, revisao: 0 });
      expect((await pacote(antigo))?.consumedSessions).toBe(0);
    });

    it('uma correção DESCARTADA (`ON CONFLICT DO NOTHING`, id repetido) não move o consumo: com a sessão devolvida, o COMMIT recusa, e nada muda', async () => {
      const p = await criarPacote();
      const outro = await atendido(p);
      const existente = (
        await corrigir(outro, { expectedRevision: 0, packageId: null }).expect(201)
      ).body.id as string;
      const ag = await atendido(p);
      const a = (await prisma.raw.clinicsAttendance.findFirst({ where: { appointmentId: ag } }))!;
      const ap = (await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } }))!;
      await observador.query('BEGIN');
      let erro: unknown = null;
      try {
        await observador.query(
          `UPDATE "ClinicsPackage" SET "consumedSessions" = "consumedSessions" - 1 WHERE "id" = $1`,
          [p],
        );
        await observador.query(
          `INSERT INTO "ClinicsPackageCorrection" ("id","workspaceId","attendanceId","appointmentId",
             "patientId","serviceId","unitId","fromPackageId","toPackageId","revision","reason",
             "correctedByMembershipId")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 1, 'wrong_choice', $9)
           ON CONFLICT DO NOTHING`,
          [
            existente,
            wsA.workspaceId,
            a.id,
            ag,
            ap.patientId,
            ap.serviceId,
            ap.unitId,
            p,
            membroOwner,
          ],
        );
        await observador.query('COMMIT');
      } catch (e) {
        erro = e;
        await observador.query('ROLLBACK');
      }
      expect(String(erro)).toMatch(/não batem com os atendimentos que o consomem/);
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 0 });
      expect(await correcoes()).toBe(1);
      expect(await igualdadeVale()).toBe(true);
    });

    it('um gatilho que tentasse mover o consumo no nível 2, SEM a linha da correção, é recusado pelo guarda do atendimento', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      const id = (await prisma.raw.clinicsAttendance.findFirst({ where: { appointmentId: ag } }))!
        .id;
      // SÓ DESTE TESTE: ao cancelar o pacote, um gatilho "estranho" tenta tirar
      // o consumo do atendimento por dentro (nível 2 de gatilhos)
      await observador.query(`
        CREATE FUNCTION "teste_move_consumo"() RETURNS trigger AS $$
        BEGIN
          UPDATE "ClinicsAttendance" SET "currentPackageId" = NULL,
                 "consumptionRevision" = "consumptionRevision" + 1
           WHERE "id" = '${id}';
          RETURN NULL;
        END $$ LANGUAGE plpgsql`);
      await observador.query(`
        CREATE TRIGGER "teste_move_consumo" AFTER UPDATE ON "ClinicsPackage"
          FOR EACH ROW EXECUTE FUNCTION "teste_move_consumo"()`);
      await expect(
        observador.query(`UPDATE "ClinicsPackage" SET "status" = 'canceled' WHERE "id" = $1`, [p]),
      ).rejects.toThrow(/O consumo de um atendimento só muda por uma correção registrada/);
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 0 });
      expect((await pacote(p))?.status).toBe('active');
    });

    it('o atendimento não é apagado (a igualdade não vê exclusão), nem junto com a devolução da sessão; a cascata do workspace o leva', async () => {
      const p = await criarPacote();
      const ag = await atendido(p);
      await expect(
        observador.query(`DELETE FROM "ClinicsAttendance" WHERE "appointmentId" = $1`, [ag]),
      ).rejects.toThrow(/Um registro de atendimento não é apagado/);
      await observador.query('BEGIN');
      try {
        await observador.query(
          `UPDATE "ClinicsPackage" SET "consumedSessions" = "consumedSessions" - 1 WHERE "id" = $1`,
          [p],
        );
        await expect(
          observador.query(`DELETE FROM "ClinicsAttendance" WHERE "appointmentId" = $1`, [ag]),
        ).rejects.toThrow(/Um registro de atendimento não é apagado/);
      } finally {
        await observador.query('ROLLBACK');
      }
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 0 });
      expect(await igualdadeVale()).toBe(true);
      await prisma.raw.workspace.deleteMany({ where: { id: wsA.workspaceId } });
      expect(
        await prisma.raw.clinicsAttendance.count({ where: { workspaceId: wsA.workspaceId } }),
      ).toBe(0);
    });

    it('um atendimento inserido com pacote SEM a sessão consumida é recusado no COMMIT (a igualdade confere também a inserção)', async () => {
      const p = await criarPacote();
      const ag = await agendar();
      const ap = (await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } }))!;
      await expect(
        observador.query(
          `INSERT INTO "ClinicsAttendance" ("id","workspaceId","appointmentId","professionalId",
             "completedAt","recordedByMembershipId","packageId","createdAt")
           VALUES (gen_random_uuid(), $1, $2, $3, now(), $4, $5, now())`,
          [wsA.workspaceId, ag, ap.professionalId, membroOwner, p],
        ),
      ).rejects.toThrow(/não batem com os atendimentos que o consomem/);
      expect(await prisma.raw.clinicsAttendance.count({ where: { appointmentId: ag } })).toBe(0);
    });

    it('a criação do pacote é do banco, mesmo que quem insere mande outra', async () => {
      const { rows } = await observador.query<{ recente: boolean }>(
        `INSERT INTO "ClinicsPackage" ("id","workspaceId","patientId","serviceId","totalSessions",
           "currency","createdByMembershipId","createdAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 3, 'BRL', $4, '2000-01-01T00:00:00')
         RETURNING "createdAt" > (now() AT TIME ZONE 'UTC') - interval '1 minute' AS recente`,
        [wsA.workspaceId, paciente, servico, membroOwner],
      );
      expect(rows).toEqual([{ recente: true }]);
    });

    it('"pacote cadastrado depois" compara com o REGISTRO do atendimento (relógio do banco), e não com o `createdAt` que o Node manda', async () => {
      const ag = await agendar();
      const ap = (await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } }))!;
      // um atendimento cujo `createdAt` (o do Node) está no FUTURO; o
      // `recordedAt` é o do banco, agora
      await observador.query(
        `INSERT INTO "ClinicsAttendance" ("id","workspaceId","appointmentId","professionalId",
           "completedAt","recordedByMembershipId","packageId","createdAt")
         VALUES (gen_random_uuid(), $1, $2, $3, now(), $4, NULL, now() + interval '1 day')`,
        [wsA.workspaceId, ag, ap.professionalId, membroOwner],
      );
      const depois = await criarPacote();
      // criado depois do REGISTRO: vale, embora seja "antes" do createdAt do Node
      await corrigir(ag, {
        expectedRevision: 0,
        packageId: depois,
        reason: 'package_registered_late',
      }).expect(201);
      expect(await consumo(ag)).toEqual({ original: null, vigente: depois, revisao: 1 });
    });

    it('o instante da correção é do banco, mesmo que quem insere mande outro', async () => {
      const q = await criarPacote();
      const ag = await atendido(null);
      const a = (await prisma.raw.clinicsAttendance.findFirst({ where: { appointmentId: ag } }))!;
      const ap = (await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } }))!;
      await observador.query('BEGIN');
      try {
        await observador.query(
          `UPDATE "ClinicsPackage" SET "consumedSessions" = "consumedSessions" + 1 WHERE "id" = $1`,
          [q],
        );
        await observador.query(
          `INSERT INTO "ClinicsPackageCorrection" ("id","workspaceId","attendanceId","appointmentId",
             "patientId","serviceId","unitId","fromPackageId","toPackageId","revision","reason",
             "correctedByMembershipId","createdAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NULL, $7, 1, 'wrong_choice', $8,
                   '2000-01-01T00:00:00Z')`,
          [wsA.workspaceId, a.id, ag, ap.patientId, ap.serviceId, ap.unitId, q, membroOwner],
        );
        await observador.query('COMMIT');
      } catch (e) {
        await observador.query('ROLLBACK');
        throw e;
      }
      const { rows } = await observador.query<{ recente: boolean }>(
        `SELECT "createdAt" > now() - interval '1 minute' AS recente FROM "ClinicsPackageCorrection"`,
      );
      expect(rows).toEqual([{ recente: true }]);
      expect(await igualdadeVale()).toBe(true);
    });

    it('o código ANTERIOR à migration registra sobre o schema novo: o atendimento nasce com o vigente igual à escolha e a revisão 0, e a correção funciona sobre ele', async () => {
      const p = await criarPacote();
      const ag = await agendar();
      // as instruções do registro como o código anterior as escrevia, sem as
      // colunas novas: o `+1` e o atendimento, numa transação
      const ap = (await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } }))!;
      await observador.query('BEGIN');
      try {
        await observador.query(
          `UPDATE "ClinicsAppointment" SET "status" = 'attended' WHERE "id" = $1`,
          [ag],
        );
        await observador.query(
          `UPDATE "ClinicsPackage" SET "consumedSessions" = "consumedSessions" + 1 WHERE "id" = $1`,
          [p],
        );
        await observador.query(
          `INSERT INTO "ClinicsAttendance" ("id","workspaceId","appointmentId","professionalId",
             "completedAt","recordedByMembershipId","packageId","createdAt")
           VALUES (gen_random_uuid(), $1, $2, $3, now(), $4, $5, now())`,
          [wsA.workspaceId, ag, ap.professionalId, membroOwner, p],
        );
        await observador.query('COMMIT');
      } catch (erro) {
        await observador.query('ROLLBACK');
        throw erro;
      }
      expect(await consumo(ag)).toEqual({ original: p, vigente: p, revisao: 0 });
      expect(await igualdadeVale()).toBe(true);
      await corrigir(ag, { expectedRevision: 0, packageId: null }).expect(201);
      expect(await consumo(ag)).toEqual({ original: p, vigente: null, revisao: 1 });
    });
  });
});
