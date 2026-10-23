import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import {
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
  horaLocal,
  somarDias,
} from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../../audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import * as relogio from '../../../prisma/relogio-do-banco';
import { createTestApp } from '../../../../test/integration/app';
import {
  agoraNoBanco,
  comRelogioDoNode,
  restaurarRelogioDoNode,
} from '../../../../test/integration/clock';
import { esperarBloqueadosPor } from '../../../../test/integration/locks';
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

interface Session {
  cookieHeader: string;
  csrf: string;
}

/** Uma segunda-feira futura, e uma passada (São Paulo, sem horário de verão). */
const SEGUNDA = '2030-11-04';
const PASSADA = '2025-11-03';

const NAO_PODE_CUMPRIR = 'Este agendamento não pode cumprir este retorno';
const MUDOU =
  'O retorno mudou enquanto o pedido era feito; nada foi alterado. Atualize e tente de novo';
const HORA = 3_600_000;
const ENCERRADO = 'Este retorno já foi encerrado; nada foi alterado';
/** O que só `clinics:care:read` recebe (autorização de campo). */
const SO_ATENDIMENTO = ['origin', 'originAttendanceId', 'cancelReason', 'createdAt'];

function portao() {
  let abrir!: () => void;
  const aberto = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { aberto, abrir };
}

/**
 * F3.2 do ADR-048 (adendo 7): retornos no Clinics. Dados FICTÍCIOS. Concluir é
 * comprovar um atendimento (a prova é o registro do agendamento vinculado);
 * encerrar sem atendimento é cancelar. As corridas são forçadas: a primeira
 * transação pausa na auditoria segurando as travas, e a segunda é vista
 * esperando (`pg_stat_activity`, lida por um observador sem transação aberta).
 */
describe('Clinics — retornos (integração, F3.2)', () => {
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

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let owner: Session;
  let recepcao: Session;
  let profissional: Session;
  let ownerB: Session;
  let dono: string;
  let mRecepcao: string;
  let mProfissional: string;
  let mGuest: string;
  let unitA: string;
  let fuso: string;
  /** com intervalo de 30 dias: o atendimento gera retorno */
  let servico: string;
  /** sem intervalo */
  let outroServico: string;
  let ana: string;
  let paciente: string;
  let outroPaciente: string;

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
  // sem `body`, a requisição vai SEM corpo, como o `api.post(path)` da tela nas
  // ações sem corpo (o registro de atendimento exige a escolha desde o A1)
  const enviar = (method: 'post' | 'put', path: string, s: Session, body?: unknown) => {
    const r = request(http)
      [method](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    return body === undefined ? r : r.send(body as object);
  };
  const post = (path: string, s: Session, body?: unknown) => enviar('post', path, s, body);
  const put = (path: string, s: Session, body?: unknown) => enviar('put', path, s, body);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

  const ate = async (condicao: () => Promise<boolean>, descricao: string) => {
    for (let i = 0; i < 400; i++) {
      if (await condicao()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`não aconteceu: ${descricao}`);
  };
  /** Alguma sessão está esperando uma trava numa instrução sobre a tabela. */
  const alguemEspera = (tabela: string) =>
    ate(async () => {
      const { rows } = await observador.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
        [`%"${tabela}"%`],
      );
      return Number(rows[0].n) > 0;
    }, `alguém esperando a trava de ${tabela}`);

  const novoPaciente = async (name: string, s: Session = owner) => {
    const contato = (await post('/api/contacts', s, { name }).expect(201)).body.id;
    return (await post('/api/clinics/patients', s, { contactId: contato }).expect(201)).body
      .id as string;
  };
  let minuto = 0;
  /** Um agendamento novo (horários distintos, para não colidir). */
  const agendar = async (body: Record<string, unknown> = {}) => {
    const hora = 8 + Math.floor(minuto / 60);
    const time = `${String(hora).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}`;
    minuto += 60;
    return (
      await post('/api/clinics/appointments', owner, {
        patientId: paciente,
        professionalId: ana,
        serviceId: servico,
        unitId: unitA,
        date: SEGUNDA,
        time,
        ...body,
      }).expect(201)
    ).body.id as string;
  };
  /** Registra o atendimento avulso, com a escolha explícita (ajuste A1). */
  const atender = (agendamento: string, s: Session = owner) =>
    post(`/api/clinics/appointments/${agendamento}/attendance`, s, { packageId: null });
  const criarRetorno = async (body: Record<string, unknown> = {}, s: Session = profissional) =>
    (
      await post('/api/clinics/returns', s, {
        patientId: paciente,
        serviceId: servico,
        unitId: unitA,
        dueDate: '2030-12-01',
        ...body,
      }).expect(201)
    ).body as { id: string };
  const vincular = (id: string, appointmentId: string, s: Session = recepcao) =>
    post(`/api/clinics/returns/${id}/link`, s, { appointmentId });
  const cancelar = (id: string, reason: string, s: Session = recepcao) =>
    post(`/api/clinics/returns/${id}/cancel`, s, { reason });
  const atribuir = (id: string, membershipId: string | null, s: Session = recepcao) =>
    post(`/api/clinics/returns/${id}/assign`, s, { membershipId });
  const retorno = (id: string) => prisma.raw.clinicsReturn.findFirst({ where: { id } });
  const automaticoDe = async (agendamento: string) => {
    const registro = await prisma.raw.clinicsAttendance.findFirst({
      where: { appointmentId: agendamento },
    });
    return prisma.raw.clinicsReturn.findFirst({ where: { originAttendanceId: registro!.id } });
  };
  const estadoDo = async (agendamento: string) =>
    (await prisma.raw.clinicsAppointment.findFirst({ where: { id: agendamento } }))?.status;
  const trilhas = (action: string) =>
    prisma.raw.auditLog.findMany({ where: { workspaceId: wsA.workspaceId, action } });
  /** "Hoje" na data local de um fuso, pelo relógio do BANCO. */
  const hojeNoBanco = async (tz: string) =>
    horaLocal(new Date(await agoraNoBanco(prisma)), tz).data;
  /** O dia útil (seg–sex) mais próximo, para trás ou para a frente, de `dia`. */
  const diaUtil = (dia: string, passo: 1 | -1) => {
    let d = somarDias(dia, passo);
    while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = somarDias(d, passo);
    return d;
  };
  /**
   * Outra transação muda o retorno e SEGURA a linha; o pedido começa (e, sem a
   * trava antes da leitura, leria a versão antiga); ela comita; o pedido termina.
   */
  const comMudancaConcorrente = async <T>(
    mudanca: string,
    params: unknown[],
    pedido: () => Promise<T>,
  ): Promise<T> => {
    await observador.query('BEGIN');
    try {
      await observador.query(mudanca, params);
      let respondeu = false;
      const emCurso = pedido().finally(() => {
        respondeu = true;
      });
      await esperarBloqueadosPor(observador, 1, {
        descricao: 'o pedido sobre o retorno',
        aCadaTentativa: () => {
          if (respondeu) throw new Error('o pedido respondeu sem esperar a trava do retorno');
        },
      });
      await observador.query('COMMIT');
      return await emCurso;
    } catch (erro) {
      await observador.query('ROLLBACK').catch(() => undefined);
      throw erro;
    }
  };

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

  beforeEach(async () => {
    jest.restoreAllMocks();
    minuto = 0;
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const ids: Record<string, string> = {};
    for (const systemKey of ['owner', 'member', 'guest']) {
      const user = await createUserFixture(prisma, `${systemKey}-a@veyra.test`);
      ids[systemKey] = await createMembershipFixture(
        prisma,
        wsA.workspaceId,
        user,
        wsA.roles[systemKey],
      );
    }
    dono = ids.owner;
    mRecepcao = ids.member;
    mGuest = ids.guest;
    const userB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, userB, wsB.roles.owner);
    await app.get(ClinicsActivationService).enable('acme');
    await app.get(ClinicsActivationService).enable('beta');
    const papelProfissional = await prisma.raw.role.findFirst({
      where: { workspaceId: wsA.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
    });
    const prof = await createUserFixture(prisma, 'prof-a@veyra.test');
    mProfissional = await createMembershipFixture(
      prisma,
      wsA.workspaceId,
      prof,
      papelProfissional!.id,
    );

    owner = await loginAs('owner-a@veyra.test');
    recepcao = await loginAs('member-a@veyra.test');
    profissional = await loginAs('prof-a@veyra.test');
    ownerB = await loginAs('owner-b@veyra.test');
    const unidade = (await prisma.raw.clinicsUnit.findFirst({
      where: { workspaceId: wsA.workspaceId },
    }))!;
    unitA = unidade.id;
    fuso = unidade.timezone;
    servico = (
      await post('/api/clinics/services', owner, {
        name: 'Limpeza de pele',
        durationMin: 60,
        returnIntervalDays: 30,
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
    paciente = await novoPaciente('Paciente Fictícia');
    outroPaciente = await novoPaciente('Outra Paciente Fictícia');
  });

  // ── Criação ──────────────────────────────────────────────────────────────

  describe('a criação', () => {
    it('AUTOMÁTICA no atendimento de serviço com intervalo: pendente, sem responsável, vencendo na data local + intervalo; sem intervalo, nada; a repetição não duplica', async () => {
      const ag = await agendar();
      await atender(ag).expect(201);
      const r = await automaticoDe(ag);
      expect(r).toMatchObject({
        status: 'pending',
        assigneeMembershipId: null,
        appointmentId: null,
        patientId: paciente,
        serviceId: servico,
        unitId: unitA,
        createdByMembershipId: dono,
      });
      expect(r!.dueDate.toISOString().slice(0, 10)).toBe(somarDias(await hojeNoBanco(fuso), 30));
      // a repetição do registro não cria outro retorno
      await atender(ag).expect(201);
      expect(await prisma.raw.clinicsReturn.count()).toBe(1);
      expect(await trilhas('clinics.return.created')).toHaveLength(1);
      // serviço sem intervalo: nenhum retorno
      await atender(await agendar({ serviceId: outroServico })).expect(201);
      expect(await prisma.raw.clinicsReturn.count()).toBe(1);
    });

    it('o VENCIMENTO automático vem do relógio do banco (o `recordedAt`): o Node do outro lado da meia-noite local não o muda', async () => {
      try {
        // a unidade num fuso ao meio-dia local do banco (veja o teste do "vencido")
        const horaUtc = new Date(await agoraNoBanco(prisma)).getUTCHours();
        const d = 12 - horaUtc;
        const tz = d === 0 ? 'Etc/GMT' : d > 0 ? `Etc/GMT-${d}` : `Etc/GMT+${-d}`;
        const minuto = horaLocal(new Date(await agoraNoBanco(prisma)), tz).minutoDoDia;
        const desvios = [(24 * 60 - minuto) * 60_000 + 6 * HORA, -(minuto * 60_000 + 6 * HORA)];
        for (const desvio of desvios) {
          const ag = await agendar();
          // o fuso da unidade muda depois do agendamento: o registro não depende dele
          await prisma.raw.clinicsUnit.updateMany({ where: { id: unitA }, data: { timezone: tz } });
          await comRelogioDoNode(desvio, async () => {
            expect(horaLocal(new Date(), tz).data).not.toBe(await hojeNoBanco(tz));
            const s = await loginAs('owner-a@veyra.test');
            await atender(ag, s).expect(201);
          });
          await prisma.raw.clinicsUnit.updateMany({
            where: { id: unitA },
            data: { timezone: fuso },
          });
          const r = await automaticoDe(ag);
          expect(r!.dueDate.toISOString().slice(0, 10)).toBe(somarDias(await hojeNoBanco(tz), 30));
        }
      } finally {
        restaurarRelogioDoNode();
      }
    });

    it('MANUAL só com care:write; o intervalo do serviço vai de 1 a 365; serviço arquivado não aceita retorno novo', async () => {
      const r = await criarRetorno({ dueDate: '2030-12-10' });
      expect((await retorno(r.id))?.originAttendanceId).toBeNull();
      await post('/api/clinics/returns', recepcao, {
        patientId: paciente,
        serviceId: servico,
        dueDate: '2030-12-10',
      }).expect(403);
      await post('/api/clinics/services', owner, {
        name: 'X',
        durationMin: 30,
        returnIntervalDays: 0,
      }).expect(400);
      await post('/api/clinics/services', owner, {
        name: 'X',
        durationMin: 30,
        returnIntervalDays: 366,
      }).expect(400);
      await post(`/api/clinics/services/${outroServico}/archive`, owner).expect(201);
      await post('/api/clinics/returns', profissional, {
        patientId: paciente,
        serviceId: outroServico,
        dueDate: '2030-12-10',
      }).expect(409);
    });
  });

  // ── Conclusão ────────────────────────────────────────────────────────────

  describe('concluir é comprovar o atendimento', () => {
    it('vincular consulta FUTURA não conclui; o registro de atendimento dela conclui, com a prova e a trilha, uma vez só', async () => {
      const r = await criarRetorno();
      const ag = await agendar({ serviceId: servico });
      const v = await vincular(r.id, ag).expect(201);
      expect(v.body).toMatchObject({ status: 'pending', appointment: { id: ag } });
      expect(await trilhas('clinics.return.completed')).toHaveLength(0);
      await atender(ag).expect(201);
      const registro = await prisma.raw.clinicsAttendance.findFirst({
        where: { appointmentId: ag },
      });
      const depois = await retorno(r.id);
      expect(depois).toMatchObject({ status: 'done', fulfilledByAttendanceId: registro!.id });
      expect(depois!.closedAt).not.toBeNull();
      // a repetição do registro não conclui de novo
      await atender(ag).expect(201);
      expect(await trilhas('clinics.return.completed')).toHaveLength(1);
    });

    it('vincular consulta JÁ ATENDIDA conclui na mesma transação, com o registro dela como prova e a trilha', async () => {
      const r = await criarRetorno();
      const ag = await agendar({ serviceId: servico });
      await atender(ag).expect(201);
      const registro = await prisma.raw.clinicsAttendance.findFirst({
        where: { appointmentId: ag },
      });
      const v = await vincular(r.id, ag).expect(201);
      expect(v.body.status).toBe('done');
      expect(await retorno(r.id)).toMatchObject({
        status: 'done',
        appointmentId: ag,
        fulfilledByAttendanceId: registro!.id,
        closedByMembershipId: mRecepcao,
      });
      expect(await trilhas('clinics.return.linked')).toHaveLength(1);
      expect(await trilhas('clinics.return.completed')).toHaveLength(1);
      // o mesmo pedido de novo: o mesmo estado, sem trilha nova
      await vincular(r.id, ag).expect(201);
      expect(await trilhas('clinics.return.linked')).toHaveLength(1);
    });

    it('a prova é registrada DEPOIS da criação: nem o atendimento que GEROU o retorno (consulta no futuro, registrada antes do horário), nem um registro anterior a um retorno manual o concluem', async () => {
      // a paciente chegou cedo: o registro sai antes do horário e gera o retorno
      const origem = await agendar();
      await atender(origem).expect(201);
      const auto = await automaticoDe(origem);
      expect((await vincular(auto!.id, origem).expect(409)).body.message).toBe(NAO_PODE_CUMPRIR);
      expect((await retorno(auto!.id))?.status).toBe('pending');
      // registro antecipado de Y, e só DEPOIS o retorno manual: Y não o cumpre
      const y = await agendar({ serviceId: outroServico });
      await atender(y).expect(201);
      const manual = await criarRetorno({ serviceId: outroServico });
      expect((await vincular(manual.id, y).expect(409)).body.message).toBe(NAO_PODE_CUMPRIR);
      expect((await retorno(manual.id))?.status).toBe('pending');
    });

    it('agendamento vinculado CANCELADO: o retorno segue pendente, com o vínculo visível, até alguém trocar', async () => {
      const r = await criarRetorno();
      const ag = await agendar();
      await vincular(r.id, ag).expect(201);
      await post(`/api/clinics/appointments/${ag}/status`, owner, {
        to: 'canceled',
        cancelReason: 'patient_request',
      }).expect(201);
      const lido = (await get(`/api/clinics/returns/${r.id}`, recepcao).expect(200)).body;
      expect(lido).toMatchObject({
        status: 'pending',
        appointment: { id: ag, status: 'canceled' },
      });
      const outro = await agendar();
      await vincular(r.id, outro).expect(201);
      expect((await retorno(r.id))?.appointmentId).toBe(outro);
    });

    it('sem casamento implícito: o atendimento de um agendamento NÃO vinculado, mesmo paciente e serviço, não conclui o retorno pendente', async () => {
      const r = await criarRetorno();
      await atender(await agendar({ serviceId: servico })).expect(201);
      expect((await retorno(r.id))?.status).toBe('pending');
    });
  });

  // ── Vínculo ──────────────────────────────────────────────────────────────

  describe('o vínculo', () => {
    it('recusa: outro paciente, serviço ou unidade (400 com o motivo); cancelado, falta ou a origem (409 neutro, o mesmo); agendamento que já cumpre outro retorno (409)', async () => {
      const r = await criarRetorno();
      await vincular(r.id, await agendar({ patientId: outroPaciente })).expect(400);
      await vincular(r.id, await agendar({ serviceId: outroServico })).expect(400);
      // outra unidade: um agendamento real dela, pelo banco
      const outraUnidade = await prisma.raw.clinicsUnit.create({
        data: { workspaceId: wsA.workspaceId, name: 'Filial', timezone: fuso },
      });
      const base = (await prisma.raw.clinicsAppointment.findFirst({
        where: { id: await agendar() },
      }))!;
      const naFilial = await prisma.raw.clinicsAppointment.create({
        data: {
          workspaceId: wsA.workspaceId,
          patientId: paciente,
          professionalId: ana,
          serviceId: servico,
          unitId: outraUnidade.id,
          startsAt: new Date('2030-11-05T15:00:00Z'),
          endsAt: new Date('2030-11-05T16:00:00Z'),
          createdByMembershipId: base.createdByMembershipId,
        },
      });
      expect((await vincular(r.id, naFilial.id).expect(400)).body.message).toBe(
        'O agendamento é de outra unidade',
      );
      const cancelado = await agendar();
      await post(`/api/clinics/appointments/${cancelado}/status`, owner, {
        to: 'canceled',
        cancelReason: 'patient_request',
      }).expect(201);
      const falta = await agendar();
      await post(`/api/clinics/appointments/${falta}/status`, owner, { to: 'no_show' }).expect(201);
      for (const ag of [cancelado, falta]) {
        expect((await vincular(r.id, ag).expect(409)).body.message).toBe(NAO_PODE_CUMPRIR);
      }
      // o atendimento de origem (anterior à criação do retorno automático)
      const origem = await agendar({ date: PASSADA });
      await atender(origem).expect(201);
      const auto = await automaticoDe(origem);
      expect((await vincular(auto!.id, origem).expect(409)).body.message).toBe(NAO_PODE_CUMPRIR);
      // um agendamento cumpre no máximo um retorno
      const outro = await criarRetorno();
      const ag = await agendar();
      await vincular(r.id, ag).expect(201);
      expect((await vincular(outro.id, ag).expect(409)).body.message).toBe(
        'Este agendamento já está vinculado a outro retorno',
      );
      expect((await retorno(r.id))?.status).toBe('pending');
    });

    it('troca e desvincula enquanto pendente; encerrado não aceita vínculo', async () => {
      const r = await criarRetorno();
      const a1 = await agendar();
      const a2 = await agendar();
      await vincular(r.id, a1).expect(201);
      await vincular(r.id, a2).expect(201);
      expect((await retorno(r.id))?.appointmentId).toBe(a2);
      // o anterior ficou livre
      const outro = await criarRetorno();
      await vincular(outro.id, a1).expect(201);
      await post(`/api/clinics/returns/${r.id}/unlink`, recepcao).expect(201);
      expect((await retorno(r.id))?.appointmentId).toBeNull();
      await cancelar(r.id, 'patient_declined').expect(201);
      expect((await vincular(r.id, a2).expect(409)).body.message).toBe(ENCERRADO);
    });

    it('a remarcação respeita o vínculo: trocar o serviço é 409, e nada muda; o horário é livre', async () => {
      const r = await criarRetorno();
      const ag = await agendar();
      await vincular(r.id, ag).expect(201);
      const antes = await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } });
      const recusa = await post(`/api/clinics/appointments/${ag}/reschedule`, owner, {
        date: SEGUNDA,
        time: '20:00',
        serviceId: outroServico,
      }).expect(409);
      expect(recusa.body.message).toMatch(/vinculado a um retorno/);
      expect(recusa.body.message).not.toMatch(/horário|cedo/);
      const depois = await prisma.raw.clinicsAppointment.findFirst({ where: { id: ag } });
      expect([depois?.serviceId, depois?.startsAt]).toEqual([antes?.serviceId, antes?.startsAt]);
      await post(`/api/clinics/appointments/${ag}/reschedule`, owner, {
        date: SEGUNDA,
        time: '20:00',
      }).expect(201);
      expect((await retorno(r.id))?.appointmentId).toBe(ag);
    });

    it('variar APENAS o início não sonda a criação: o vínculo e a remarcação respondem igual antes e depois dela, perto e longe', async () => {
      const r = await criarRetorno();
      const hoje = await hojeNoBanco(fuso);
      // longe e perto, antes e depois da criação (que acabou de acontecer)
      const dias = [PASSADA, diaUtil(hoje, -1), diaUtil(hoje, 1), SEGUNDA];
      const respostas: unknown[] = [];
      for (const date of dias) {
        const ag = await agendar({ date, time: '09:00' });
        const v = await vincular(r.id, ag);
        respostas.push([v.status, v.body.status, v.body.message]);
        await post(`/api/clinics/returns/${r.id}/unlink`, recepcao).expect(201);
      }
      expect(respostas).toEqual(dias.map(() => [201, 'pending', undefined]));
      // a remarcação de um agendamento vinculado: para trás e para a frente da criação
      const ag = await agendar({ date: SEGUNDA, time: '10:00' });
      await vincular(r.id, ag).expect(201);
      const remarcacoes: number[] = [];
      for (const date of [PASSADA, diaUtil(hoje, -1), diaUtil(hoje, 1), SEGUNDA]) {
        remarcacoes.push(
          (await post(`/api/clinics/appointments/${ag}/reschedule`, owner, { date, time: '11:00' }))
            .status,
        );
      }
      expect(remarcacoes).toEqual([201, 201, 201, 201]);
      expect(await retorno(r.id)).toMatchObject({ status: 'pending', appointmentId: ag });
      // e o banco aceita o vínculo a um início anterior à criação: nada a sondar nele
      const antigo = await agendar({ date: PASSADA, time: '12:00' });
      await post(`/api/clinics/returns/${r.id}/unlink`, recepcao).expect(201);
      await observador.query(`UPDATE "ClinicsReturn" SET "appointmentId" = $2 WHERE "id" = $1`, [
        r.id,
        antigo,
      ]);
      expect((await retorno(r.id))?.appointmentId).toBe(antigo);
    });

    it('agendamento que já cumpre OUTRO retorno: a mesma recusa, antes da prova, seja o registro dele anterior ou posterior à criação (não sonda)', async () => {
      // X cumpre R2 e foi registrado ANTES da criação de R1; X2 cumpre R3 e foi
      // registrado DEPOIS. Conferir a prova antes do vínculo alheio daria duas
      // respostas diferentes, sem mudar nada
      const r2 = await criarRetorno();
      const x = await agendar();
      await vincular(r2.id, x).expect(201);
      await atender(x).expect(201);
      const r1 = await criarRetorno();
      const r3 = await criarRetorno();
      const x2 = await agendar();
      await vincular(r3.id, x2).expect(201);
      await atender(x2).expect(201);
      expect([(await retorno(r2.id))?.status, (await retorno(r3.id))?.status]).toEqual([
        'done',
        'done',
      ]);
      // e um agendamento ainda não atendido, vinculado a um retorno pendente
      const r4 = await criarRetorno();
      const y = await agendar();
      await vincular(r4.id, y).expect(201);
      const respostas = [];
      for (const ag of [x, x2, y]) {
        const v = await vincular(r1.id, ag);
        respostas.push([v.status, v.body.message]);
      }
      expect(respostas).toEqual(
        [x, x2, y].map(() => [409, 'Este agendamento já está vinculado a outro retorno']),
      );
      expect(await retorno(r1.id)).toMatchObject({ status: 'pending', appointmentId: null });
      expect(await trilhas('clinics.return.linked')).toHaveLength(3);
    });

    it('a CONSEQUÊNCIA registrada: o agendamento iniciado antes da criação cumpre o retorno se o atendimento for registrado DEPOIS; registrado antes, não', async () => {
      // iniciado antes, registrado depois: conclui (o sistema comprova a ordem
      // dos REGISTROS, não a da visita física — hipótese do protótipo)
      const r = await criarRetorno();
      const antes = await agendar({ date: PASSADA });
      await vincular(r.id, antes).expect(201);
      await atender(antes).expect(201);
      expect((await retorno(r.id))?.status).toBe('done');
      // iniciado antes e registrado ANTES da criação: não conclui (409 neutro)
      const cedo = await agendar({ date: PASSADA });
      await atender(cedo).expect(201);
      const manual = await criarRetorno();
      expect((await vincular(manual.id, cedo).expect(409)).body.message).toBe(NAO_PODE_CUMPRIR);
      expect((await retorno(manual.id))?.status).toBe('pending');
    });
  });

  // ── Candidatos ao vínculo (F3.3a) ───────────────────────────────────────

  describe('os candidatos ao vínculo (F3.3a)', () => {
    const candidatos = (id: string, q = '', s: Session = recepcao) =>
      get(`/api/clinics/returns/${id}/candidates${q ? `?${q}` : ''}`, s);
    const ids = async (id: string, q = '') =>
      ((await candidatos(id, q).expect(200)).body.items as { id: string }[]).map((i) => i.id);

    it('só critérios VISÍVEIS: a lista não depende da prova nem da origem, e cada item traz só id, início, estado e profissional', async () => {
      const antes = await criarRetorno(); // criado ANTES dos atendimentos
      const x0 = await agendar();
      await atender(x0).expect(201); // origem de um automático
      const depois = await criarRetorno(); // criado ENTRE os atendimentos
      const x1 = await agendar();
      await atender(x1).expect(201);
      const y = await agendar();
      const ocupado = await agendar();
      await vincular((await criarRetorno()).id, ocupado).expect(201);
      const cancelado = await agendar();
      await post(`/api/clinics/appointments/${cancelado}/status`, owner, {
        to: 'canceled',
        cancelReason: 'patient_request',
      }).expect(201);
      const falta = await agendar();
      await post(`/api/clinics/appointments/${falta}/status`, owner, { to: 'no_show' }).expect(201);
      await agendar({ serviceId: outroServico });
      await agendar({ patientId: outroPaciente });
      // o mesmo paciente e serviço, noutra UNIDADE: fora da lista
      const filial = await prisma.raw.clinicsUnit.create({
        data: { workspaceId: wsA.workspaceId, name: 'Filial', timezone: fuso },
      });
      const modelo = (await prisma.raw.clinicsAppointment.findFirst({ where: { id: y } }))!;
      await prisma.raw.clinicsAppointment.create({
        data: {
          workspaceId: wsA.workspaceId,
          patientId: paciente,
          professionalId: ana,
          serviceId: servico,
          unitId: filial.id,
          startsAt: new Date('2030-11-05T15:00:00Z'),
          endsAt: new Date('2030-11-05T16:00:00Z'),
          createdByMembershipId: modelo.createdByMembershipId,
        },
      });
      const automatico = await automaticoDe(x0);
      // a mesma lista para o retorno anterior, o posterior e o de ORIGEM de x0
      const esperado = [x0, x1, y];
      expect(await ids(antes.id)).toEqual(esperado);
      expect(await ids(depois.id)).toEqual(esperado);
      expect(await ids(automatico!.id)).toEqual(esperado);
      const pagina = (await candidatos(depois.id).expect(200)).body;
      expect(pagina.nextCursor).toBeNull();
      for (const item of pagina.items) {
        expect(Object.keys(item).sort()).toEqual(['id', 'professionalName', 'startsAt', 'status']);
      }
      expect(pagina.items.map((i: { status: string }) => i.status)).toEqual([
        'attended',
        'attended',
        'scheduled',
      ]);
      // seleção, não garantia: o vínculo reconfere (x0 é anterior a `depois`)
      expect((await vincular(depois.id, x0).expect(409)).body.message).toBe(NAO_PODE_CUMPRIR);
      expect((await vincular(automatico!.id, x0).expect(409)).body.message).toBe(NAO_PODE_CUMPRIR);
    });

    it('paginada por início e id, sem truncamento silencioso; `from` em data local da unidade; cursor e limite inválidos dão 400', async () => {
      const r = await criarRetorno();
      const passado = await agendar({ date: PASSADA });
      const futuros = [];
      for (let i = 0; i < 4; i++) futuros.push(await agendar());
      // um EMPATE no início (outro profissional, o mesmo horário do segundo):
      // a ordem desempata pelo id, e a paginação não pula nenhum dos dois
      const base = (await prisma.raw.clinicsAppointment.findFirst({
        where: { id: futuros[1] },
      }))!;
      const outraProf = await prisma.raw.clinicsProfessional.create({
        data: { workspaceId: wsA.workspaceId, name: 'Bia Fictícia' },
      });
      const empate = await prisma.raw.clinicsAppointment.create({
        data: {
          workspaceId: wsA.workspaceId,
          patientId: paciente,
          professionalId: outraProf.id,
          serviceId: servico,
          unitId: unitA,
          startsAt: base.startsAt,
          endsAt: base.endsAt,
          createdByMembershipId: base.createdByMembershipId,
        },
      });
      const doisNoMesmoInicio = [futuros[1], empate.id].sort();
      futuros.splice(1, 1, ...doisNoMesmoInicio);
      const todos = [passado, ...futuros];
      const vistos: string[] = [];
      let cursor: string | null = null;
      let paginas = 0;
      do {
        const q: string = `limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const pagina = (await candidatos(r.id, q).expect(200)).body as {
          items: { id: string }[];
          nextCursor: string | null;
        };
        vistos.push(...pagina.items.map((i) => i.id));
        cursor = pagina.nextCursor;
        paginas += 1;
      } while (cursor && paginas < 10);
      expect(vistos).toEqual(todos);
      expect(paginas).toBe(6);
      // e com páginas de 2, os mesmos, na mesma ordem
      const deDois = (await candidatos(r.id, 'limit=2').expect(200)).body;
      expect(deDois.items.map((i: { id: string }) => i.id)).toEqual(todos.slice(0, 2));
      expect(deDois.nextCursor).not.toBeNull();
      expect(await ids(r.id, 'from=2030-01-01')).toEqual(futuros);
      // `from` é o início do DIA LOCAL da unidade (São Paulo, −03:00): 22:00 do
      // dia 3 (01:00Z do dia 4) fica fora de `from=2030-11-04`
      const vespera = await prisma.raw.clinicsAppointment.create({
        data: {
          workspaceId: wsA.workspaceId,
          patientId: paciente,
          professionalId: ana,
          serviceId: servico,
          unitId: unitA,
          startsAt: new Date('2030-11-04T01:00:00Z'),
          endsAt: new Date('2030-11-04T01:30:00Z'),
          createdByMembershipId: (await prisma.raw.clinicsAppointment.findFirst({
            where: { id: passado },
          }))!.createdByMembershipId,
        },
      });
      expect(await ids(r.id, 'from=2030-11-04')).not.toContain(vespera.id);
      expect(await ids(r.id, 'from=2030-11-03')).toContain(vespera.id);
      await candidatos(r.id, 'cursor=nao-e-um-cursor').expect(400);
      // forjados, com a forma certa: id que não é UUID e instante fora da faixa
      const forjar = (partes: unknown[]) =>
        encodeURIComponent(Buffer.from(JSON.stringify(partes)).toString('base64url'));
      await candidatos(
        r.id,
        `cursor=${forjar(['2030-11-04T11:00:00.000Z', '-'.repeat(36)])}`,
      ).expect(400);
      await candidatos(r.id, `cursor=${forjar(['-271821-04-20T00:00:00.000Z', r.id])}`).expect(400);
      await candidatos(r.id, `cursor=${forjar(['2030-11-04', r.id])}`).expect(400);
      // o ano 0000 passa no formato, mas o Postgres não tem ano zero
      await candidatos(r.id, `cursor=${forjar(['0000-01-01T00:00:00.000Z', r.id])}`).expect(400);
      await candidatos(r.id, 'limit=51').expect(400);
      await candidatos(r.id, 'limit=0').expect(400);
      await candidatos(r.id, 'from=2030-02-30').expect(400);
      await candidatos(r.id, `patientId=${paciente}`).expect(400);
    });

    it('as permissões de VINCULAR; o retorno encerrado dá 409; o workspace B não lista os de A', async () => {
      const r = await criarRetorno();
      await agendar();
      await candidatos(r.id, '', recepcao).expect(200);
      await candidatos(r.id, '', profissional).expect(200);
      await candidatos(r.id, '', await loginAs('guest-a@veyra.test')).expect(403);
      // lê a agenda, mas não age sobre retornos: não lista candidatos
      const papel = await prisma.raw.role.create({
        data: { workspaceId: wsA.workspaceId, name: 'Só lê a agenda (fictício)' },
      });
      await prisma.raw.rolePermission.create({
        data: {
          workspaceId: wsA.workspaceId,
          roleId: papel.id,
          permissionKey: 'clinics:schedule:read',
        },
      });
      await createMembershipFixture(
        prisma,
        wsA.workspaceId,
        await createUserFixture(prisma, 'so-le-a@veyra.test'),
        papel.id,
      );
      await candidatos(r.id, '', await loginAs('so-le-a@veyra.test')).expect(403);
      await candidatos(r.id, '', ownerB).expect(404);
      await cancelar(r.id, 'patient_declined').expect(201);
      expect((await candidatos(r.id).expect(409)).body.message).toBe(ENCERRADO);
    });
  });

  // ── Cancelamento ─────────────────────────────────────────────────────────

  describe('o cancelamento', () => {
    it('o motivo define a permissão, conferida ANTES da origem: a recepção recebe 403 para os motivos clínicos, também num retorno automático', async () => {
      const ag = await agendar();
      await atender(ag).expect(201);
      const auto = await automaticoDe(ag);
      // 403, não 409: a condição de origem nem é consultada para ela
      await cancelar(auto!.id, 'created_in_error').expect(403);
      await cancelar(auto!.id, 'not_needed').expect(403);
      expect((await retorno(auto!.id))?.status).toBe('pending');
      // o profissional pode, mas "criado por engano" não se aplica ao automático
      expect(
        (await cancelar(auto!.id, 'created_in_error', profissional).expect(409)).body.message,
      ).toBe('Este motivo não se aplica a este retorno');
      await cancelar(auto!.id, 'not_needed', profissional).expect(201);
      const manual = await criarRetorno();
      await cancelar(manual.id, 'created_in_error', profissional).expect(201);
      const outro = await criarRetorno();
      await cancelar(outro.id, 'patient_unreachable').expect(201);
    });

    it('a repetição pelo mesmo autor e motivo é idempotente; outro motivo, outro autor ou retorno concluído: 409 neutro, sem alterar nada', async () => {
      const r = await criarRetorno();
      const ag = await agendar();
      await vincular(r.id, ag).expect(201);
      await cancelar(r.id, 'patient_declined').expect(201);
      // o cancelamento libera o agendamento
      expect((await retorno(r.id))?.appointmentId).toBeNull();
      await cancelar(r.id, 'patient_declined').expect(201);
      expect(await trilhas('clinics.return.canceled')).toHaveLength(1);
      expect((await cancelar(r.id, 'patient_unreachable').expect(409)).body.message).toBe(
        ENCERRADO,
      );
      // outro autor com o MESMO motivo: o mesmo 409 (não revela o motivo dela)
      expect((await cancelar(r.id, 'patient_declined', owner).expect(409)).body.message).toBe(
        ENCERRADO,
      );
      expect(await retorno(r.id)).toMatchObject({
        status: 'canceled',
        cancelReason: 'patient_declined',
        closedByMembershipId: mRecepcao,
      });
      const feito = await criarRetorno();
      const a2 = await agendar();
      await vincular(feito.id, a2).expect(201);
      await atender(a2).expect(201);
      expect((await cancelar(feito.id, 'patient_declined').expect(409)).body.message).toBe(
        ENCERRADO,
      );
      expect((await retorno(feito.id))?.status).toBe('done');
    });
  });

  describe('a repetição do cancelamento e a permissão viva', () => {
    it('a repetição só é idempotente com a permissão do motivo AINDA válida: perdida, é 403, e nada muda', async () => {
      const r = await criarRetorno();
      await cancelar(r.id, 'not_needed', profissional).expect(201);
      await cancelar(r.id, 'not_needed', profissional).expect(201);
      // o papel perde care:write; a sessão continua válida (só o motivo cai)
      const papel = (await prisma.raw.membership.findFirst({ where: { id: mProfissional } }))!
        .roleId;
      await prisma.raw.rolePermission.deleteMany({
        where: { roleId: papel, permissionKey: 'clinics:care:write' },
      });
      await cancelar(r.id, 'not_needed', profissional).expect(403);
      expect(await retorno(r.id)).toMatchObject({
        status: 'canceled',
        cancelReason: 'not_needed',
        closedByMembershipId: mProfissional,
      });
      expect(await trilhas('clinics.return.canceled')).toHaveLength(1);
    });
  });

  // ── Atribuição ───────────────────────────────────────────────────────────

  describe('a atribuição', () => {
    it('só membro ATIVO que vê a lista e pode agir; recusa neutra e única; ser responsável não concede nada; "sem acesso" na leitura', async () => {
      const r = await criarRetorno();
      await atribuir(r.id, mProfissional).expect(201);
      // sem schedule:read (guest): a mesma recusa de quem foi suspenso
      const semPermissao = await atribuir(r.id, mGuest).expect(400);
      expect(semPermissao.body.message).toBe('Este membro não pode ser responsável por retornos');
      await prisma.raw.membership.updateMany({
        where: { id: mRecepcao },
        data: { status: 'suspended' },
      });
      const suspensa = await atribuir(r.id, mRecepcao, owner).expect(400);
      expect(suspensa.body.message).toBe(semPermissao.body.message);
      // escreve a agenda, mas NÃO a lê (papel customizado): não vê a lista, não é responsável
      const papel = await prisma.raw.role.create({
        data: { workspaceId: wsA.workspaceId, name: 'Escreve a agenda sem ler (fictício)' },
      });
      await prisma.raw.rolePermission.create({
        data: {
          workspaceId: wsA.workspaceId,
          roleId: papel.id,
          permissionKey: 'clinics:schedule:write',
        },
      });
      const semLeitura = await createMembershipFixture(
        prisma,
        wsA.workspaceId,
        await createUserFixture(prisma, 'sem-leitura-a@veyra.test'),
        papel.id,
      );
      expect((await atribuir(r.id, semLeitura, owner).expect(400)).body.message).toBe(
        semPermissao.body.message,
      );
      // membro de outro workspace: inexistente aqui
      const deB = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsB.workspaceId },
      });
      await atribuir(r.id, deB!.id, owner).expect(404);
      // a membership VIVA: suspensa, o responsável aparece "sem acesso"
      await prisma.raw.membership.updateMany({
        where: { id: mRecepcao },
        data: { status: 'active' },
      });
      const outro = await criarRetorno();
      await atribuir(outro.id, mRecepcao, owner).expect(201);
      await prisma.raw.membership.updateMany({
        where: { id: mRecepcao },
        data: { status: 'suspended' },
      });
      expect(
        (await get(`/api/clinics/returns/${outro.id}`, owner).expect(200)).body.assignee,
      ).toMatchObject({
        membershipId: mRecepcao,
        hasAccess: false,
      });
      // o responsável perde o acesso: aparece como "sem acesso", para reatribuir
      await prisma.raw.membership.updateMany({
        where: { id: mProfissional },
        data: { roleId: wsA.roles.guest },
      });
      const lido = (await get(`/api/clinics/returns/${r.id}`, owner).expect(200)).body;
      expect(lido.assignee).toMatchObject({ membershipId: mProfissional, hasAccess: false });
      // e não lê nada por ser o responsável
      await get(`/api/clinics/returns/${r.id}`, profissional).expect(403);
      await atribuir(r.id, null, owner).expect(201);
      expect((await retorno(r.id))?.assigneeMembershipId).toBeNull();
    });

    it('o seletor traz só os candidatos operacionais, só com id e nome, e não abre a lista de membros a quem não tem members:read', async () => {
      const lista = (await get('/api/clinics/returns/assignees', recepcao).expect(200)).body as {
        membershipId: string;
        name: string;
      }[];
      expect(lista.map((c) => c.membershipId).sort()).toEqual(
        [dono, mRecepcao, mProfissional].sort(),
      );
      for (const c of lista) expect(Object.keys(c).sort()).toEqual(['membershipId', 'name']);
      // o Profissional não tem members:read: a lista de membros do Core segue
      // fechada para ele, e o seletor (só candidatos, só id e nome) funciona
      await get('/api/members', profissional).expect(403);
      await get('/api/clinics/returns/assignees', profissional).expect(200);
      // quem não age sobre retornos não usa o seletor
      await get('/api/clinics/returns/assignees', await loginAs('guest-a@veyra.test')).expect(403);
    });
  });

  // ── Projeção e filtros ───────────────────────────────────────────────────

  describe('a projeção e os filtros', () => {
    it('quem tem só a agenda não recebe origem, motivo nem criação — o cancelado aparece só como cancelado; care:read recebe', async () => {
      const ag = await agendar();
      await atender(ag).expect(201);
      const auto = await automaticoDe(ag);
      await cancelar(auto!.id, 'not_needed', profissional).expect(201);
      const manual = await criarRetorno();
      for (const s of [recepcao]) {
        const lista = (await get('/api/clinics/returns', s).expect(200)).body as Record<
          string,
          unknown
        >[];
        expect(lista).toHaveLength(2);
        for (const item of lista) {
          for (const campo of SO_ATENDIMENTO) expect(item).not.toHaveProperty(campo);
        }
        expect(lista.find((i) => i.id === auto!.id)?.status).toBe('canceled');
        expect(JSON.stringify(lista)).not.toContain('not_needed');
      }
      const doProfissional = (
        await get(`/api/clinics/returns/${auto!.id}`, profissional).expect(200)
      ).body;
      expect(doProfissional).toMatchObject({ origin: 'automatic', cancelReason: 'not_needed' });
      expect(
        (await get(`/api/clinics/returns/${manual.id}`, profissional).expect(200)).body.origin,
      ).toBe('manual');
    });

    it('filtros permitidos (estado, vencido, unidade, vencimento, responsável, paciente) e recusa de filtro fora da lista', async () => {
      const hoje = await hojeNoBanco(fuso);
      const ontem = somarDias(hoje, -1);
      const amanha = somarDias(hoje, 1);
      const vencido = await criarRetorno({ dueDate: ontem });
      const emDia = await criarRetorno({ dueDate: amanha, assigneeMembershipId: mRecepcao });
      const outro = await criarRetorno({ dueDate: ontem, patientId: outroPaciente });
      await cancelar(outro.id, 'patient_declined').expect(201);
      const ids = async (q: string) =>
        (
          (await get(`/api/clinics/returns?${q}`, recepcao).expect(200)).body as { id: string }[]
        ).map((i) => i.id);
      expect(await ids('overdue=true')).toEqual([vencido.id]);
      expect((await ids('overdue=false')).sort()).toEqual([emDia.id, outro.id].sort());
      expect(await ids('status=canceled')).toEqual([outro.id]);
      expect(await ids(`assignee=${mRecepcao}`)).toEqual([emDia.id]);
      expect((await ids('assignee=none')).sort()).toEqual([vencido.id, outro.id].sort());
      expect(await ids(`patientId=${outroPaciente}`)).toEqual([outro.id]);
      expect(await ids(`dueFrom=${amanha}`)).toEqual([emDia.id]);
      expect(await ids(`unitId=${unitA}&status=pending`)).toEqual([vencido.id, emDia.id]);
      const lido = (await get(`/api/clinics/returns/${vencido.id}`, recepcao).expect(200)).body;
      expect(lido.overdue).toBe(true);
      // filtro fora da lista: a origem não é consultável, nem por filtro
      await get('/api/clinics/returns?origin=manual', recepcao).expect(400);
      await get('/api/clinics/returns?orderBy=createdAt', recepcao).expect(400);
    });

    describe('o "vencido" é do relógio do BANCO', () => {
      // um teste que estoure o timeout do Jest não roda o `finally` a tempo
      afterEach(() => restaurarRelogioDoNode());

      it('o Node adiantado ou atrasado, atravessando a meia-noite local nos dois sentidos, não muda o filtro nem a projeção', async () => {
        // a unidade num fuso em que o banco está perto do MEIO-DIA local: a
        // data do banco não vira durante o teste
        const horaUtc = new Date(await agoraNoBanco(prisma)).getUTCHours();
        const deslocamento = 12 - horaUtc;
        const tz =
          deslocamento === 0
            ? 'Etc/GMT'
            : deslocamento > 0
              ? `Etc/GMT-${deslocamento}`
              : `Etc/GMT+${-deslocamento}`;
        const unidade = await prisma.raw.clinicsUnit.create({
          data: { workspaceId: wsA.workspaceId, name: 'Unidade do fuso (fictícia)', timezone: tz },
        });
        const hoje = await hojeNoBanco(tz);
        const ontem = somarDias(hoje, -1);
        const amanha = somarDias(hoje, 1);
        const porDia: Record<string, string> = {};
        for (const dueDate of [ontem, hoje, amanha]) {
          porDia[dueDate] = (await criarRetorno({ unitId: unidade.id, dueDate })).id;
        }
        // os desvios saem dos minutos do banco desde a meia-noite local: o Node
        // cai às ~06:00 de amanhã e às ~18:00 de ontem, com 6 h de folga ou mais
        const minuto = horaLocal(new Date(await agoraNoBanco(prisma)), tz).minutoDoDia;
        const adiante = (24 * 60 - minuto) * 60_000 + 6 * HORA;
        const atras = -(minuto * 60_000 + 6 * HORA);
        for (const desvio of [adiante, atras]) {
          await comRelogioDoNode(desvio, async () => {
            // o Node está do OUTRO lado da meia-noite local; o banco, não
            expect(horaLocal(new Date(), tz).data).toBe(desvio > 0 ? amanha : ontem);
            expect(await hojeNoBanco(tz)).toBe(hoje);
            const s = await loginAs('member-a@veyra.test');
            const lista = (await get(`/api/clinics/returns?unitId=${unidade.id}`, s).expect(200))
              .body as { id: string; dueDate: string; overdue: boolean }[];
            expect(Object.fromEntries(lista.map((i) => [i.dueDate, i.overdue]))).toEqual({
              [ontem]: true,
              [hoje]: false,
              [amanha]: false,
            });
            const ids = async (q: string) =>
              (
                (await get(`/api/clinics/returns?unitId=${unidade.id}&${q}`, s).expect(200))
                  .body as { id: string }[]
              ).map((i) => i.id);
            expect(await ids('overdue=true')).toEqual([porDia[ontem]]);
            expect(await ids('overdue=false')).toEqual([porDia[hoje], porDia[amanha]]);
            for (const [dia, vencido] of [
              [ontem, true],
              [hoje, false],
            ] as const) {
              expect(
                (await get(`/api/clinics/returns/${porDia[dia]}`, s).expect(200)).body.overdue,
              ).toBe(vencido);
            }
          });
        }
      });

      it('UMA leitura do relógio do banco por operação: o filtro e a projeção usam o mesmo "hoje"', async () => {
        const r = await criarRetorno({ dueDate: somarDias(await hojeNoBanco(fuso), -1) });
        const leituras = jest.spyOn(relogio, 'agoraDoBanco');
        const contar = async (caminho: string) => {
          leituras.mockClear();
          await get(caminho, recepcao).expect(200);
          return leituras.mock.calls.length;
        };
        expect(await contar('/api/clinics/returns?overdue=true')).toBe(1);
        expect(await contar('/api/clinics/returns?overdue=false')).toBe(1);
        expect(await contar('/api/clinics/returns')).toBe(1);
        expect(await contar(`/api/clinics/returns/${r.id}`)).toBe(1);
      });
    });
  });

  // ── Banco ────────────────────────────────────────────────────────────────

  describe('o banco garante', () => {
    it('concluir exige a PROVA do registro do mesmo agendamento; o rótulo `attended` não basta', async () => {
      const r = await criarRetorno();
      const ag = await agendar();
      await vincular(r.id, ag).expect(201);
      // sem a prova
      await expect(
        observador.query(
          `UPDATE "ClinicsReturn" SET "status" = 'done', "closedByMembershipId" = $2 WHERE "id" = $1`,
          [r.id, dono],
        ),
      ).rejects.toThrow(/não pode cumprir|ClinicsReturn_status_check/);
      // com o registro de OUTRO agendamento
      const outro = await agendar();
      await atender(outro).expect(201);
      const alheio = await prisma.raw.clinicsAttendance.findFirst({
        where: { appointmentId: outro },
      });
      await expect(
        observador.query(
          `UPDATE "ClinicsReturn" SET "status" = 'done', "fulfilledByAttendanceId" = $2,
             "closedByMembershipId" = $3 WHERE "id" = $1`,
          [r.id, alheio!.id, dono],
        ),
      ).rejects.toThrow(/ClinicsReturn_fulfilledBy_fkey/);
      // só o rótulo, sem registro
      await observador.query(
        `UPDATE "ClinicsAppointment" SET "status" = 'attended' WHERE "id" = $1`,
        [ag],
      );
      await expect(
        observador.query(
          `UPDATE "ClinicsReturn" SET "status" = 'done', "closedByMembershipId" = $2 WHERE "id" = $1`,
          [r.id, dono],
        ),
      ).rejects.toThrow(/não pode cumprir|ClinicsReturn_status_check/);
      // o que só o CHECK confere: cancelado sem motivo
      await expect(
        observador.query(
          `UPDATE "ClinicsReturn" SET "status" = 'canceled', "appointmentId" = NULL,
             "closedByMembershipId" = $2 WHERE "id" = $1`,
          [r.id, dono],
        ),
      ).rejects.toThrow(/ClinicsReturn_status_check/);
      expect((await retorno(r.id))?.status).toBe('pending');
    });

    it('o instante da prova (`recordedAt`) não se forja: forçado pelo banco no INSERT e imutável depois', async () => {
      const ag = await agendar();
      const antes = new Date();
      await observador.query(
        `INSERT INTO "ClinicsAttendance" ("id","workspaceId","appointmentId","professionalId",
           "completedAt","recordedByMembershipId","recordedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, now(), $4, '2000-01-01T00:00:00Z')`,
        [wsA.workspaceId, ag, ana, dono],
      );
      const registro = await prisma.raw.clinicsAttendance.findFirst({
        where: { appointmentId: ag },
      });
      expect(registro!.recordedAt.getTime()).toBeGreaterThan(antes.getTime() - 60_000);
      await expect(
        observador.query(
          `UPDATE "ClinicsAttendance" SET "recordedAt" = now() + interval '1 day' WHERE "id" = $1`,
          [registro!.id],
        ),
      ).rejects.toThrow(/não muda/);
    });

    it('se o banco recusar a prova no registro de atendimento (relógio recuando), o registro inteiro volta, com 409', async () => {
      const r = await criarRetorno();
      const ag = await agendar();
      await vincular(r.id, ag).expect(201);
      // simula o relógio recuando: a criação do retorno vai para o futuro. O
      // gatilho é desligado e religado DENTRO de uma transação (DDL é
      // transacional): nenhuma outra sessão o vê desligado, e um processo
      // morto no meio não deixa a base de teste sem a guarda.
      await observador.query('BEGIN');
      try {
        await observador.query('ALTER TABLE "ClinicsReturn" DISABLE TRIGGER "ClinicsReturn_guard"');
        await observador.query(
          `UPDATE "ClinicsReturn" SET "createdAt" = now() + interval '1 day' WHERE "id" = $1`,
          [r.id],
        );
        await observador.query('ALTER TABLE "ClinicsReturn" ENABLE TRIGGER "ClinicsReturn_guard"');
        await observador.query('COMMIT');
      } catch (erro) {
        await observador.query('ROLLBACK');
        throw erro;
      }
      const recusa = await atender(ag).expect(409);
      expect(recusa.body.message).toMatch(/não foi registrado/);
      expect(await estadoDo(ag)).toBe('scheduled');
      expect(await prisma.raw.clinicsAttendance.count({ where: { appointmentId: ag } })).toBe(0);
      expect((await retorno(r.id))?.status).toBe('pending');
    });

    it('a prova não é o atendimento de origem nem um registro anterior à criação, pelo banco', async () => {
      // o atendimento de origem como prova: o CHECK recusa
      const origem = await agendar();
      await atender(origem).expect(201);
      const auto = await automaticoDe(origem);
      await expect(
        observador.query(
          `UPDATE "ClinicsReturn" SET "appointmentId" = $2, "status" = 'done',
             "fulfilledByAttendanceId" = "originAttendanceId", "closedByMembershipId" = $3
           WHERE "id" = $1`,
          [auto!.id, origem, dono],
        ),
      ).rejects.toThrow(/ClinicsReturn_fulfilled_not_origin_check|não pode cumprir/);
      // um registro anterior à criação de um retorno manual: o gatilho recusa
      const y = await agendar();
      await atender(y).expect(201);
      const registroY = await prisma.raw.clinicsAttendance.findFirst({
        where: { appointmentId: y },
      });
      const manual = await criarRetorno();
      await expect(
        observador.query(
          `UPDATE "ClinicsReturn" SET "appointmentId" = $2, "status" = 'done',
             "fulfilledByAttendanceId" = $3, "closedByMembershipId" = $4 WHERE "id" = $1`,
          [manual.id, y, registroY!.id, dono],
        ),
      ).rejects.toThrow(/não pode cumprir/);
      expect((await retorno(manual.id))?.status).toBe('pending');
    });

    it('recusa: nascer fora de pendente, mudar o imutável (mesmo junto de um caminho legítimo), mexer no encerrado, vincular a atendido mantendo pendente, e "criado por engano" com origem', async () => {
      const r = await criarRetorno();
      const ag = await agendar();
      const fixos = [wsA.workspaceId, paciente, servico, unitA, dono];
      await expect(
        observador.query(
          `INSERT INTO "ClinicsReturn" ("id","workspaceId","patientId","serviceId","unitId","dueDate",
             "createdByMembershipId","status","closedAt","closedByMembershipId","cancelReason")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, '2030-12-01', $5, 'canceled', now(), $5, 'patient_declined')`,
          fixos,
        ),
      ).rejects.toThrow(/nasce pendente/);
      // imutável junto de um vínculo legítimo
      await expect(
        observador.query(
          `UPDATE "ClinicsReturn" SET "dueDate" = '2031-01-01', "appointmentId" = $2 WHERE "id" = $1`,
          [r.id, ag],
        ),
      ).rejects.toThrow(/imutáveis/);
      await expect(
        observador.query(`UPDATE "ClinicsReturn" SET "patientId" = $2 WHERE "id" = $1`, [
          r.id,
          outroPaciente,
        ]),
      ).rejects.toThrow(/imutáveis/);
      // atendido mantendo pendente
      const atendido = await agendar();
      await atender(atendido).expect(201);
      await expect(
        observador.query(`UPDATE "ClinicsReturn" SET "appointmentId" = $2 WHERE "id" = $1`, [
          r.id,
          atendido,
        ]),
      ).rejects.toThrow(/não pode cumprir/);
      // o caminho legítimo passa
      await observador.query(`UPDATE "ClinicsReturn" SET "appointmentId" = $2 WHERE "id" = $1`, [
        r.id,
        ag,
      ]);
      // encerrado não muda
      await cancelar(r.id, 'patient_declined').expect(201);
      await expect(
        observador.query(`UPDATE "ClinicsReturn" SET "assigneeMembershipId" = $2 WHERE "id" = $1`, [
          r.id,
          dono,
        ]),
      ).rejects.toThrow(/não muda mais/);
      // "criado por engano" com origem
      const origem = await agendar();
      await atender(origem).expect(201);
      const auto = await automaticoDe(origem);
      await expect(
        observador.query(
          `UPDATE "ClinicsReturn" SET "status" = 'canceled', "cancelReason" = 'created_in_error',
             "closedByMembershipId" = $2 WHERE "id" = $1`,
          [auto!.id, dono],
        ),
      ).rejects.toThrow(/ClinicsReturn_created_in_error_check/);
    });

    it('o vínculo cruzado de workspace é recusado pela FK composta, e a exclusão do workspace leva os retornos em cascata', async () => {
      const r = await criarRetorno();
      const pacienteB = await novoPaciente('Paciente B', ownerB);
      const servicoB = (
        await post('/api/clinics/services', ownerB, { name: 'Serviço B', durationMin: 60 }).expect(
          201,
        )
      ).body.id;
      const unidadeB = (await prisma.raw.clinicsUnit.findFirst({
        where: { workspaceId: wsB.workspaceId },
      }))!;
      const donoB = (await prisma.raw.membership.findFirst({
        where: { workspaceId: wsB.workspaceId },
      }))!;
      const profB = await prisma.raw.clinicsProfessional.create({
        data: { workspaceId: wsB.workspaceId, name: 'Prof B' },
      });
      const agB = await prisma.raw.clinicsAppointment.create({
        data: {
          workspaceId: wsB.workspaceId,
          patientId: pacienteB,
          professionalId: profB.id,
          serviceId: servicoB,
          unitId: unidadeB.id,
          startsAt: new Date('2030-11-05T15:00:00Z'),
          endsAt: new Date('2030-11-05T16:00:00Z'),
          createdByMembershipId: donoB.id,
        },
      });
      await expect(
        observador.query(`UPDATE "ClinicsReturn" SET "appointmentId" = $2 WHERE "id" = $1`, [
          r.id,
          agB.id,
        ]),
      ).rejects.toThrow(/não pode cumprir|ClinicsReturn_appointment_fkey/);
      await vincular(r.id, agB.id).expect(404);
      await prisma.raw.workspace.delete({ where: { id: wsA.workspaceId } });
      expect(
        await prisma.raw.clinicsReturn.count({ where: { workspaceId: wsA.workspaceId } }),
      ).toBe(0);
    });
  });

  // ── Corridas ─────────────────────────────────────────────────────────────

  describe('as corridas, com a ordem forçada', () => {
    it('ATENDIMENTO primeiro: o retorno é concluído e o cancelamento, que esperou a trava, é recusado', async () => {
      const r = await criarRetorno();
      const ag = await agendar();
      await vincular(r.id, ag).expect(201);
      const pausa = pausarNaAuditoria('clinics.return.completed');
      const registro = atender(ag).then((x) => x);
      await pausa.chegou.aberto;
      const cancelamento = cancelar(r.id, 'patient_declined').then((x) => x);
      await alguemEspera('ClinicsReturn');
      pausa.segue.abrir();
      expect((await registro).status).toBe(201);
      expect((await cancelamento).status).toBe(409);
      expect((await retorno(r.id))?.status).toBe('done');
    });

    it('CANCELAMENTO primeiro: o retorno fica cancelado; o atendimento, que esperou a trava, acontece e não o conclui', async () => {
      const r = await criarRetorno();
      const ag = await agendar();
      await vincular(r.id, ag).expect(201);
      const pausa = pausarNaAuditoria('clinics.return.canceled');
      const cancelamento = cancelar(r.id, 'patient_declined').then((x) => x);
      await pausa.chegou.aberto;
      const registro = atender(ag).then((x) => x);
      await alguemEspera('ClinicsReturn');
      pausa.segue.abrir();
      expect((await cancelamento).status).toBe(201);
      expect((await registro).status).toBe(201);
      expect(await retorno(r.id)).toMatchObject({
        status: 'canceled',
        fulfilledByAttendanceId: null,
      });
      expect(await estadoDo(ag)).toBe('attended');
    });

    it('TROCA entre dois agendamentos × atendimento do anterior, nas duas ordens: as travas em ordem de id e a releitura do vínculo', async () => {
      // a troca primeiro: o atendimento do anterior espera e não conclui nada
      const r1 = await criarRetorno();
      const a1 = await agendar();
      const b1 = await agendar();
      await vincular(r1.id, a1).expect(201);
      let pausa = pausarNaAuditoria('clinics.return.linked');
      const troca = vincular(r1.id, b1).then((x) => x);
      await pausa.chegou.aberto;
      const registro = atender(a1).then((x) => x);
      await alguemEspera('ClinicsAppointment');
      pausa.segue.abrir();
      expect((await troca).status).toBe(201);
      expect((await registro).status).toBe(201);
      expect(await retorno(r1.id)).toMatchObject({ status: 'pending', appointmentId: b1 });
      jest.restoreAllMocks();
      // o atendimento primeiro: a troca espera, relê o vínculo e é recusada
      const r2 = await criarRetorno();
      const a2 = await agendar();
      const b2 = await agendar();
      await vincular(r2.id, a2).expect(201);
      pausa = pausarNaAuditoria('clinics.return.completed');
      const registro2 = atender(a2).then((x) => x);
      await pausa.chegou.aberto;
      const troca2 = vincular(r2.id, b2).then((x) => x);
      await alguemEspera('ClinicsAppointment');
      pausa.segue.abrir();
      expect((await registro2).status).toBe(201);
      // a troca relê o retorno travado: já encerrado pelo atendimento
      expect((await troca2).body.message).toBe(ENCERRADO);
      expect((await troca2).status).toBe(409);
      expect(await retorno(r2.id)).toMatchObject({ status: 'done', appointmentId: a2 });
    });

    it('duas TROCAS simultâneas do mesmo retorno: a segunda espera, relê o vínculo e é recusada, sem sobrescrever a primeira', async () => {
      const r = await criarRetorno();
      const a = await agendar();
      const b = await agendar();
      const c = await agendar();
      await vincular(r.id, a).expect(201);
      const pausa = pausarNaAuditoria('clinics.return.linked');
      const primeira = vincular(r.id, b).then((x) => x);
      await pausa.chegou.aberto;
      const segunda = vincular(r.id, c).then((x) => x);
      await alguemEspera('ClinicsAppointment');
      pausa.segue.abrir();
      expect((await primeira).status).toBe(201);
      expect((await segunda).status).toBe(409);
      expect((await retorno(r.id))?.appointmentId).toBe(b);
    });

    it('a trilha do CANCELAMENTO registra o vínculo efetivamente removido: o vínculo trocado depois da leitura inicial', async () => {
      const r = await criarRetorno();
      const a1 = await agendar();
      const a2 = await agendar();
      await vincular(r.id, a1).expect(201);
      const resposta = await comMudancaConcorrente(
        `UPDATE "ClinicsReturn" SET "appointmentId" = $2 WHERE "id" = $1`,
        [r.id, a2],
        () => cancelar(r.id, 'patient_declined').then((x) => x),
      );
      expect(resposta.status).toBe(201);
      const [trilha] = await trilhas('clinics.return.canceled');
      expect(trilha.before).toEqual({ appointmentId: a2 });
      expect(trilha.after).toMatchObject({ status: 'canceled', appointmentId: null });
      expect(await retorno(r.id)).toMatchObject({ status: 'canceled', appointmentId: null });
      // o removido ficou livre para outro retorno
      await vincular((await criarRetorno()).id, a2).expect(201);
    });

    it('VÍNCULO com o retorno mudado por outra escrita: a mesma resposta para um candidato com prova posterior e um com prova anterior (não sonda)', async () => {
      // X0 foi registrado ANTES da criação de R; X1, DEPOIS. Os dois livres
      const x0 = await agendar();
      await atender(x0).expect(201);
      const r = await criarRetorno();
      const y = await agendar();
      const z = await agendar();
      await vincular(r.id, y).expect(201);
      const x1 = await agendar();
      await atender(x1).expect(201);
      const respostas = [];
      // a outra escrita troca o vínculo (Y → Z, depois Z → Y) e segura a linha
      for (const [candidato, novo] of [
        [x1, z],
        [x0, y],
      ]) {
        const v = await comMudancaConcorrente(
          `UPDATE "ClinicsReturn" SET "appointmentId" = $2 WHERE "id" = $1`,
          [r.id, novo],
          () => vincular(r.id, candidato).then((x) => x),
        );
        respostas.push([v.status, v.body.message]);
      }
      expect(respostas).toEqual([
        [409, MUDOU],
        [409, MUDOU],
      ]);
      expect(await retorno(r.id)).toMatchObject({ status: 'pending', appointmentId: y });
      expect(await trilhas('clinics.return.completed')).toHaveLength(0);
    });

    it('o MESMO vínculo feito por outra escrita no meio do pedido: idempotente (201), sem trilha nova', async () => {
      const r = await criarRetorno();
      const y = await agendar();
      const x = await agendar();
      await vincular(r.id, y).expect(201);
      const v = await comMudancaConcorrente(
        `UPDATE "ClinicsReturn" SET "appointmentId" = $2 WHERE "id" = $1`,
        [r.id, x],
        () => vincular(r.id, x).then((res) => res),
      );
      expect(v.status).toBe(201);
      expect(v.body).toMatchObject({ status: 'pending', appointment: { id: x } });
      // só a trilha do primeiro vínculo (Y): a escrita concorrente foi direta no banco
      expect(await trilhas('clinics.return.linked')).toHaveLength(1);
    });

    it('a trilha da ATRIBUIÇÃO registra o responsável efetivamente substituído', async () => {
      const r = await criarRetorno();
      const resposta = await comMudancaConcorrente(
        `UPDATE "ClinicsReturn" SET "assigneeMembershipId" = $2 WHERE "id" = $1`,
        [r.id, mProfissional],
        () => atribuir(r.id, dono).then((x) => x),
      );
      expect(resposta.status).toBe(201);
      const [trilha] = await trilhas('clinics.return.assigned');
      expect(trilha.before).toEqual({ assigneeMembershipId: mProfissional });
      expect(trilha.after).toEqual({ assigneeMembershipId: dono });
      expect((await retorno(r.id))?.assigneeMembershipId).toBe(dono);
    });

    it('dois retornos disputando o MESMO agendamento: um vincula, o outro espera e recebe 409', async () => {
      const r1 = await criarRetorno();
      const r2 = await criarRetorno();
      const ag = await agendar();
      const pausa = pausarNaAuditoria('clinics.return.linked');
      const primeiro = vincular(r1.id, ag).then((x) => x);
      await pausa.chegou.aberto;
      const segundo = vincular(r2.id, ag).then((x) => x);
      await alguemEspera('ClinicsAppointment');
      pausa.segue.abrir();
      expect((await primeiro).status).toBe(201);
      expect((await segundo).status).toBe(409);
      expect((await retorno(r2.id))?.appointmentId).toBeNull();
    });
  });

  // ── Isolamento ───────────────────────────────────────────────────────────

  describe('o isolamento', () => {
    it('P0: o workspace B não lê, não vincula, não cancela nem atribui retorno de A', async () => {
      const r = await criarRetorno();
      const ag = await agendar();
      await get(`/api/clinics/returns/${r.id}`, ownerB).expect(404);
      expect((await get('/api/clinics/returns', ownerB).expect(200)).body).toEqual([]);
      await vincular(r.id, ag, ownerB).expect(404);
      await cancelar(r.id, 'patient_declined', ownerB).expect(404);
      await atribuir(r.id, null, ownerB).expect(404);
      expect(await retorno(r.id)).toMatchObject({ status: 'pending', appointmentId: null });
    });

    it('P0: um retorno de B não vincula agendamento de A (404), e nada muda nos dois lados', async () => {
      const agA = await agendar();
      const pacienteB = await novoPaciente('Paciente B', ownerB);
      const servicoB = (
        await post('/api/clinics/services', ownerB, { name: 'Serviço B', durationMin: 60 }).expect(
          201,
        )
      ).body.id;
      const rB = (
        await post('/api/clinics/returns', ownerB, {
          patientId: pacienteB,
          serviceId: servicoB,
          dueDate: '2030-12-01',
        }).expect(201)
      ).body.id as string;
      const antesA = await prisma.raw.clinicsAppointment.findFirst({ where: { id: agA } });
      expect((await vincular(rB, agA, ownerB).expect(404)).body.message).toBe(
        'Agendamento não encontrado',
      );
      expect(await retorno(rB)).toMatchObject({ status: 'pending', appointmentId: null });
      expect(await prisma.raw.clinicsAppointment.findFirst({ where: { id: agA } })).toEqual(antesA);
      expect(await prisma.raw.clinicsReturn.count({ where: { appointmentId: agA } })).toBe(0);
    });
  });
});
