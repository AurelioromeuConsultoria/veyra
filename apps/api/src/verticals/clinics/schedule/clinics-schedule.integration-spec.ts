import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
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
import { esperarBloqueadosPor } from '../../../../test/integration/locks';
import { ClinicsActivationService } from '../clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
/** A escolha explícita de avulso (ajuste A1): sem ela, o registro é recusado. */
const AVULSO = { packageId: null };

interface Session {
  cookieHeader: string;
  csrf: string;
}

/** Uma segunda-feira (São Paulo, sem horário de verão). A agenda aceita datas passadas. */
const SEGUNDA = '2030-11-04';
/**
 * Em 2025 (passado, com a base de fusos já fixa), Nova York adiantou em 9/mar
 * às 02:00 e atrasou em 2/nov às 02:00 — os dois domingos.
 */
const NY_PULO = '2025-03-09';
const NY_REPETE = '2025-11-02';

/** Uma segunda-feira ao menos uma semana à frente de HOJE, para o que depende de "futuro". */
function segundaFutura(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Agenda e registro de atendimento (F2.2, ADR-048 adendo 4). Dados FICTÍCIOS.
 * O catálogo nasce pela própria API, como a clínica o montaria.
 */
describe('Clinics — agenda e atendimento (integração, F2.2)', () => {
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

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let owner: Session;
  let unitA: string;
  let servico: string;
  let ana: string;
  let paciente: string;

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
  // ações sem corpo (o registro de atendimento exige a escolha desde o A1): um
  // helper que sempre manda `{}` esconderia a rota que recusa a ausência
  const send = (method: 'post' | 'patch' | 'put', path: string, s: Session, body?: unknown) => {
    const r = request(http)
      [method](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    return body === undefined ? r : r.send(body as object);
  };
  const post = (path: string, s: Session, body?: unknown) => send('post', path, s, body);
  const patch = (path: string, s: Session, body?: unknown) => send('patch', path, s, body);
  const put = (path: string, s: Session, body?: unknown) => send('put', path, s, body);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

  /** Perfil inteiro de um profissional: serviços e expediente na unidade A. */
  const perfil = (
    id: string,
    name: string,
    serviceIds: string[],
    faixas: [number, number, number][],
    s: Session = owner,
  ) =>
    put(`/api/clinics/professionals/${id}/profile`, s, {
      name,
      serviceIds,
      intervals: faixas.map(([weekday, startMinute, endMinute]) => ({
        unitId: unitA,
        weekday,
        startMinute,
        endMinute,
      })),
    }).expect(200);
  /** Segunda a sexta, 08:00–18:00. */
  const COMERCIAL: [number, number, number][] = [1, 2, 3, 4, 5].map((d) => [d, 480, 1080]);

  const novoProfissional = async (name: string, servicos = [servico]) => {
    const id = (await post('/api/clinics/professionals', owner, { name }).expect(201)).body.id;
    await perfil(id, name, servicos, COMERCIAL);
    return id as string;
  };
  const novoPaciente = async (name: string) => {
    const contato = (await post('/api/contacts', owner, { name }).expect(201)).body.id;
    return (await post('/api/clinics/patients', owner, { contactId: contato }).expect(201)).body
      .id as string;
  };
  const agendar = (body: Record<string, unknown> = {}, s: Session = owner) =>
    post('/api/clinics/appointments', s, {
      patientId: paciente,
      professionalId: ana,
      serviceId: servico,
      date: SEGUNDA,
      time: '09:00',
      ...body,
    });
  const status = (id: string, body: Record<string, unknown>, s: Session = owner) =>
    post(`/api/clinics/appointments/${id}/status`, s, body);
  const dia = (date: string, s: Session = owner) =>
    get(`/api/clinics/appointments?date=${date}`, s).expect(200);

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    for (const systemKey of ['owner', 'member', 'guest']) {
      const user = await createUserFixture(prisma, `${systemKey}-a@veyra.test`);
      await createMembershipFixture(prisma, wsA.workspaceId, user, wsA.roles[systemKey]);
    }
    const ownerB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, ownerB, wsB.roles.owner);
    await app.get(ClinicsActivationService).enable('acme');
    const papelProfissional = await prisma.raw.role.findFirst({
      where: { workspaceId: wsA.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
    });
    const prof = await createUserFixture(prisma, 'prof-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, prof, papelProfissional!.id);

    owner = await loginAs('owner-a@veyra.test');
    unitA = (await prisma.raw.clinicsUnit.findFirst({ where: { workspaceId: wsA.workspaceId } }))!
      .id;
    servico = (
      await post('/api/clinics/services', owner, {
        name: 'Limpeza de pele',
        durationMin: 60,
      }).expect(201)
    ).body.id;
    ana = await novoProfissional('Ana Fictícia');
    paciente = await novoPaciente('Paciente Fictícia');
  });

  // ── Agendar ───────────────────────────────────────────────────────────────

  describe('agendar', () => {
    it('instantes no fuso da unidade, fim pela duração do serviço, e o dia mostra o paciente só pelo nome', async () => {
      const criado = (await agendar().expect(201)).body;
      expect(criado).toMatchObject({
        patientName: 'Paciente Fictícia',
        professionalName: 'Ana Fictícia',
        serviceName: 'Limpeza de pele',
        startsAt: '2030-11-04T12:00:00.000Z', // 09:00 em São Paulo (UTC−3)
        endsAt: '2030-11-04T13:00:00.000Z',
        localDate: SEGUNDA,
        localStart: '09:00',
        localEnd: '10:00',
        status: 'scheduled',
        cancelReason: null,
      });
      expect((await dia(SEGUNDA)).body).toEqual([
        expect.objectContaining({ id: criado.id, attendanceId: null }),
      ]);
      expect((await dia('2030-11-05')).body).toEqual([]);
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.appointment.created' },
      });
      expect(trilha!.after).toEqual({
        patientId: paciente,
        professionalId: ana,
        serviceId: servico,
        unitId: unitA,
        startsAt: '2030-11-04T12:00:00.000Z',
        endsAt: '2030-11-04T13:00:00.000Z',
        status: 'scheduled',
      });
    });

    it('regras: catálogo ativo, profissional habilitado, expediente na hora local, paciente existente e contrato', async () => {
      const outroServico = (
        await post('/api/clinics/services', owner, { name: 'Peeling', durationMin: 30 }).expect(201)
      ).body.id;
      await agendar({ serviceId: outroServico }).expect(400); // não habilitado
      await agendar({ time: '07:30' }).expect(400); // antes do expediente
      await agendar({ time: '17:30' }).expect(400); // termina 18:30, depois do expediente
      await agendar({ time: '17:00' }).expect(201); // termina 18:00 exatamente: cabe
      await agendar({ date: '2030-11-09' }).expect(400); // sábado
      await agendar({ patientId: randomUUID() }).expect(404);
      await agendar({ time: '09:03' }).expect(400); // passos de 5 minutos
      await agendar({ date: '2030-02-30' }).expect(400); // data inexistente
      await agendar({ date: '1999-11-01' }).expect(400); // fora da faixa de anos
      await agendar({ status: 'attended' }).expect(400); // campo fora do contrato

      await post(`/api/clinics/services/${servico}/archive`, owner).expect(201);
      await agendar({ time: '11:00' }).expect(400); // serviço arquivado
      await post(`/api/clinics/services/${servico}/unarchive`, owner).expect(201);
      await post(`/api/clinics/professionals/${ana}/archive`, owner).expect(201);
      await agendar({ time: '11:00' }).expect(400); // profissional arquivado
    });

    it('duração REGISTRADA: mudar o serviço não altera o compromisso; remarcar a conserva; trocar de serviço recalcula', async () => {
      const criado = (await agendar().expect(201)).body;
      await patch(`/api/clinics/services/${servico}`, owner, { durationMin: 90 }).expect(200);
      expect(
        (await prisma.raw.clinicsAppointment.findFirst({ where: { id: criado.id } }))!.endsAt,
      ).toEqual(new Date('2030-11-04T13:00:00Z'));

      const remarcado = (
        await post(`/api/clinics/appointments/${criado.id}/reschedule`, owner, {
          date: SEGUNDA,
          time: '14:00',
        }).expect(201)
      ).body;
      expect(remarcado).toMatchObject({ localStart: '14:00', localEnd: '15:00' }); // 60, não 90

      const curto = (
        await post('/api/clinics/services', owner, { name: 'Avaliação', durationMin: 30 }).expect(
          201,
        )
      ).body.id;
      await perfil(ana, 'Ana Fictícia', [servico, curto], COMERCIAL);
      const trocado = (
        await post(`/api/clinics/appointments/${criado.id}/reschedule`, owner, {
          date: SEGUNDA,
          time: '15:00',
          serviceId: curto,
        }).expect(201)
      ).body;
      expect(trocado).toMatchObject({ serviceId: curto, localStart: '15:00', localEnd: '15:30' });
    });
  });

  // ── Concorrência e sobreposição ───────────────────────────────────────────

  describe('o banco barra sobreposição', () => {
    it('N agendamentos SIMULTÂNEOS no mesmo horário e profissional: exatamente um, os outros 409 (nunca 500)', async () => {
      const pacientes = await Promise.all(
        [1, 2, 3, 4, 5, 6].map((n) => novoPaciente(`Paciente ${n}`)),
      );
      const respostas = await Promise.all(pacientes.map((p) => agendar({ patientId: p })));
      const codigos = respostas.map((r) => r.status).sort();
      expect(codigos).toEqual([201, 409, 409, 409, 409, 409]);
      for (const r of respostas.filter((x) => x.status === 409)) {
        expect(r.body.message).toBe('Horário já ocupado para este profissional');
      }
      expect(await prisma.raw.clinicsAppointment.count()).toBe(1);
    });

    it('profissionais diferentes no mesmo horário convivem; cancelar libera o horário; vizinho não sobrepõe', async () => {
      const bia = await novoProfissional('Bia Fictícia');
      const primeiro = (await agendar().expect(201)).body;
      await agendar({ professionalId: bia }).expect(201);
      await agendar({ time: '09:30' }).expect(409); // sobreposição parcial
      await agendar({ time: '10:00' }).expect(201); // começa quando o outro termina

      await status(primeiro.id, { to: 'canceled', cancelReason: 'patient_request' }).expect(201);
      await agendar().expect(201); // o horário voltou a estar livre
    });

    it('remarcar para um horário ocupado: 409, e o agendamento fica como estava', async () => {
      const a = (await agendar().expect(201)).body;
      const b = (await agendar({ time: '11:00' }).expect(201)).body;
      const res = await post(`/api/clinics/appointments/${b.id}/reschedule`, owner, {
        date: SEGUNDA,
        time: '09:30',
      }).expect(409);
      expect(res.body.message).toBe('Horário já ocupado para este profissional');
      expect(
        (await prisma.raw.clinicsAppointment.findFirst({ where: { id: b.id } }))!.startsAt,
      ).toEqual(new Date('2030-11-04T14:00:00Z'));
      expect(a.id).not.toBe(b.id);
    });
  });

  // ── Transições ────────────────────────────────────────────────────────────

  describe('transições', () => {
    /** Leva um agendamento NOVO (num horário só dele) ao estado pedido, pelo caminho do produto. */
    const DIAS = ['2030-11-04', '2030-11-05', '2030-11-06', '2030-11-07', '2030-11-08'];
    let vaga = 0;
    const emEstado = async (estado: string) => {
      const n = vaga++;
      const hora = `${String(8 + Math.floor(n / DIAS.length)).padStart(2, '0')}:00`;
      const id = (await agendar({ date: DIAS[n % DIAS.length], time: hora }).expect(201)).body.id;
      if (estado === 'confirmed' || estado === 'arrived')
        await status(id, { to: 'confirmed' }).expect(201);
      if (estado === 'arrived') await status(id, { to: 'arrived' }).expect(201);
      if (estado === 'canceled') {
        await status(id, { to: 'canceled', cancelReason: 'patient_request' }).expect(201);
      }
      if (estado === 'no_show') await status(id, { to: 'no_show' }).expect(201);
      if (estado === 'attended')
        await post(`/api/clinics/appointments/${id}/attendance`, owner, AVULSO).expect(201);
      return id as string;
    };
    const PERMITIDAS: Record<string, string[]> = {
      confirmed: ['scheduled'],
      arrived: ['confirmed'],
      canceled: ['scheduled', 'confirmed'],
      no_show: ['scheduled', 'confirmed'],
    };
    const ESTADOS = ['scheduled', 'confirmed', 'arrived', 'canceled', 'no_show', 'attended'];

    it.each(ESTADOS)('a matriz inteira de transições a partir de `%s`', async (origem) => {
      for (const destino of ['confirmed', 'arrived', 'canceled', 'no_show']) {
        const id = await emEstado(origem);
        const corpo =
          destino === 'canceled'
            ? { to: destino, cancelReason: 'clinic_request' }
            : { to: destino };
        const esperado = PERMITIDAS[destino].includes(origem) ? 201 : 409;
        const res = await status(id, corpo);
        expect({ origem, destino, codigo: res.status }).toEqual({
          origem,
          destino,
          codigo: esperado,
        });
        const final = (await prisma.raw.clinicsAppointment.findFirst({ where: { id } }))!.status;
        expect(final).toBe(esperado === 201 ? destino : origem);
      }
    });

    it('corrida: uma confirmação comita enquanto o cancelamento espera — a trilha registra `confirmed`, não o que foi visto antes', async () => {
      const id = await emEstado('scheduled');
      const trava = new Client({ connectionString: TEST_DATABASE_URL });
      await trava.connect();
      let pedido: Promise<request.Response> | undefined;
      try {
        await trava.query('BEGIN');
        await trava.query(
          `UPDATE "ClinicsAppointment" SET "status" = 'confirmed' WHERE "id" = $1`,
          [id],
        );
        let respondeu: number | null = null;
        pedido = status(id, { to: 'canceled', cancelReason: 'clinic_request' }).then((res) => {
          respondeu = res.status;
          return res;
        });
        await esperarBloqueadosPor(trava, 1, {
          descricao: 'cancelamento esperando a linha do agendamento',
          aCadaTentativa: () => {
            if (respondeu !== null)
              throw new Error(`o cancelamento respondeu ${respondeu} sem esperar`);
          },
        });
        await trava.query('COMMIT');
        expect((await pedido).status).toBe(201);
      } finally {
        await trava.end();
        await pedido?.catch(() => undefined);
      }
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.appointment.status_changed', entityId: id },
        orderBy: { createdAt: 'desc' },
      });
      expect(trilha!.before).toEqual({ status: 'confirmed', cancelReason: null });
    });

    it('a trilha registra o estado que a transição DE FATO substituiu', async () => {
      const id = await emEstado('confirmed');
      await status(id, { to: 'canceled', cancelReason: 'clinic_request' }).expect(201);
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.appointment.status_changed', entityId: id },
        orderBy: { createdAt: 'desc' },
      });
      expect(trilha!.before).toEqual({ status: 'confirmed', cancelReason: null });
      expect(trilha!.after).toEqual({ status: 'canceled', cancelReason: 'clinic_request' });
    });

    it('scheduled → confirmed → arrived; e as que não existem são recusadas', async () => {
      const id = (await agendar().expect(201)).body.id;
      // chegada só depois de confirmar; o motivo vem em português, com os estados da tela
      expect((await status(id, { to: 'arrived' }).expect(409)).body.message).toBe(
        'Transição inválida: Marcado → Chegou',
      );
      expect((await status(id, { to: 'confirmed' }).expect(201)).body.status).toBe('confirmed');
      expect((await status(id, { to: 'arrived' }).expect(201)).body.status).toBe('arrived');
      await status(id, { to: 'confirmed' }).expect(409);
      await status(id, { to: 'canceled', cancelReason: 'clinic_request' }).expect(409);
      await status(id, { to: 'no_show' }).expect(409);
      await status(id, { to: 'attended' }).expect(400); // só o atendimento leva a `attended`
    });

    it('cancelar exige motivo da lista fechada; falta a partir de confirmado; remarcar cancelado é 409', async () => {
      const a = (await agendar().expect(201)).body.id;
      await status(a, { to: 'canceled' }).expect(400);
      await status(a, { to: 'canceled', cancelReason: 'outro' }).expect(400);
      await status(a, { to: 'confirmed', cancelReason: 'patient_request' }).expect(400);
      const cancelado = (
        await status(a, { to: 'canceled', cancelReason: 'professional_unavailable' }).expect(201)
      ).body;
      expect(cancelado).toMatchObject({
        status: 'canceled',
        cancelReason: 'professional_unavailable',
      });
      await post(`/api/clinics/appointments/${a}/reschedule`, owner, {
        date: SEGUNDA,
        time: '10:00',
      }).expect(409);

      const b = (await agendar({ time: '11:00' }).expect(201)).body.id;
      await status(b, { to: 'confirmed' }).expect(201);
      expect((await status(b, { to: 'no_show' }).expect(201)).body.status).toBe('no_show');
      await status(randomUUID(), { to: 'confirmed' }).expect(404);
    });

    it('remarcar um confirmado volta para `scheduled` (a confirmação era do horário antigo)', async () => {
      const id = (await agendar().expect(201)).body.id;
      await status(id, { to: 'confirmed' }).expect(201);
      const remarcado = (
        await post(`/api/clinics/appointments/${id}/reschedule`, owner, {
          date: SEGUNDA,
          time: '13:00',
        }).expect(201)
      ).body;
      expect(remarcado.status).toBe('scheduled');
    });
  });

  // ── Registro de atendimento ───────────────────────────────────────────────

  describe('registro de atendimento', () => {
    it('leva o agendamento a `attended` na mesma transação; repetir devolve o mesmo registro e audita uma vez', async () => {
      const id = (await agendar().expect(201)).body.id;
      const primeiro = (
        await post(`/api/clinics/appointments/${id}/attendance`, owner, AVULSO).expect(201)
      ).body;
      expect(primeiro).toMatchObject({ appointmentId: id, professionalId: ana });
      const segundo = (
        await post(`/api/clinics/appointments/${id}/attendance`, owner, AVULSO).expect(201)
      ).body;
      expect(segundo.id).toBe(primeiro.id);
      expect((await prisma.raw.clinicsAppointment.findFirst({ where: { id } }))!.status).toBe(
        'attended',
      );
      expect(
        await prisma.raw.auditLog.count({ where: { action: 'clinics.attendance.recorded' } }),
      ).toBe(1);
      expect(
        (await get(`/api/clinics/appointments/${id}/attendance`, owner).expect(200)).body,
      ).toEqual(primeiro);
      // o horário continua ocupado por quem foi atendido
      await agendar({ patientId: await novoPaciente('Outra') }).expect(409);
    });

    it('registros SIMULTÂNEOS resultam em um só', async () => {
      const id = (await agendar().expect(201)).body.id;
      const respostas = await Promise.all(
        [1, 2, 3, 4, 5].map(() =>
          post(`/api/clinics/appointments/${id}/attendance`, owner, AVULSO),
        ),
      );
      expect(respostas.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(respostas.map((r) => r.body.id)).size).toBe(1);
      expect(await prisma.raw.clinicsAttendance.count()).toBe(1);
    });

    it('rollback: se a gravação falha, nem o registro nem o `attended` ficam', async () => {
      const id = (await agendar().expect(201)).body.id;
      const audit = app.get(AuditService);
      const real = audit.record.bind(audit);
      const espia = jest
        .spyOn(audit, 'record')
        .mockImplementation(async (db, ws, action, input) => {
          if (action === 'clinics.attendance.recorded') throw new Error('falha simulada');
          return real(db, ws, action, input);
        });
      try {
        await post(`/api/clinics/appointments/${id}/attendance`, owner, AVULSO).expect(500);
      } finally {
        espia.mockRestore();
      }
      expect((await prisma.raw.clinicsAppointment.findFirst({ where: { id } }))!.status).toBe(
        'scheduled',
      );
      expect(await prisma.raw.clinicsAttendance.count()).toBe(0);
    });

    it('a partir de `arrived` registra; `no_show` não aceita (409)', async () => {
      const chegou = (await agendar().expect(201)).body.id;
      await status(chegou, { to: 'confirmed' }).expect(201);
      await status(chegou, { to: 'arrived' }).expect(201);
      await post(`/api/clinics/appointments/${chegou}/attendance`, owner, AVULSO).expect(201);
      const faltou = (await agendar({ time: '11:00' }).expect(201)).body.id;
      await status(faltou, { to: 'no_show' }).expect(201);
      expect(
        (await post(`/api/clinics/appointments/${faltou}/attendance`, owner, AVULSO).expect(409))
          .body.message,
      ).toBe('Agendamento com estado Faltou não aceita registro de atendimento');
    });

    it('cancelado não aceita atendimento (409); agendamento inexistente, 404; sem registro, 404', async () => {
      const id = (await agendar().expect(201)).body.id;
      await get(`/api/clinics/appointments/${id}/attendance`, owner).expect(404);
      await status(id, { to: 'canceled', cancelReason: 'scheduling_error' }).expect(201);
      await post(`/api/clinics/appointments/${id}/attendance`, owner, AVULSO).expect(409);
      await post(`/api/clinics/appointments/${randomUUID()}/attendance`, owner, AVULSO).expect(404);
    });
  });

  // ── Permissões ────────────────────────────────────────────────────────────

  describe('permissões', () => {
    it('recepção marca e lê, mas não registra nem lê atendimento — e a agenda OMITE o vínculo no servidor', async () => {
      const recepcao = await loginAs('member-a@veyra.test');
      const id = (await agendar({}, recepcao).expect(201)).body.id;
      await status(id, { to: 'confirmed' }, recepcao).expect(201);
      await post(`/api/clinics/appointments/${id}/attendance`, recepcao, AVULSO).expect(403);
      await post(`/api/clinics/appointments/${id}/attendance`, owner, AVULSO).expect(201);
      await get(`/api/clinics/appointments/${id}/attendance`, recepcao).expect(403);
      const lista = (await dia(SEGUNDA, recepcao)).body;
      expect(lista).toHaveLength(1);
      expect(lista[0]).not.toHaveProperty('attendanceId');
      expect(lista[0].status).toBe('attended');
    });

    it('`Profissional` lê a agenda e registra atendimento, mas não marca, remarca nem muda estado, e não lê o CRM', async () => {
      const id = (await agendar().expect(201)).body.id;
      const prof = await loginAs('prof-a@veyra.test');
      expect((await dia(SEGUNDA, prof)).body[0]).toMatchObject({
        id,
        patientName: 'Paciente Fictícia',
        attendanceId: null,
      });
      await agendar({ time: '11:00' }, prof).expect(403);
      await post(`/api/clinics/appointments/${id}/reschedule`, prof, {
        date: SEGUNDA,
        time: '11:00',
      }).expect(403);
      await status(id, { to: 'confirmed' }, prof).expect(403);
      await post(`/api/clinics/appointments/${id}/attendance`, prof, AVULSO).expect(201);
      await get(`/api/clinics/appointments/${id}/attendance`, prof).expect(200);
      await get('/api/contacts', prof).expect(403);
    });

    it('Guest e workspace sem o Clinics: 403; chave presente com o Clinics desativado: 404 (caso residual)', async () => {
      const guest = await loginAs('guest-a@veyra.test');
      await get(`/api/clinics/appointments?date=${SEGUNDA}`, guest).expect(403);
      const donoB = await loginAs('owner-b@veyra.test');
      await get(`/api/clinics/appointments?date=${SEGUNDA}`, donoB).expect(403);
      const id = (await agendar().expect(201)).body.id;
      await app.get(ClinicsActivationService).disable('acme');
      // a desativação revoga as sessões (401) e as chaves (403 numa sessão nova)
      await get(`/api/clinics/appointments?date=${SEGUNDA}`, owner).expect(401);
      const nova = await loginAs('owner-a@veyra.test');
      await get(`/api/clinics/appointments?date=${SEGUNDA}`, nova).expect(403);
      // chave posta por fora do produto: o vertical inativo responde 404, sem efeito
      for (const permissionKey of ['clinics:schedule:read', 'clinics:schedule:write']) {
        await prisma.raw.rolePermission.create({
          data: { workspaceId: wsA.workspaceId, roleId: wsA.roles.owner, permissionKey },
        });
      }
      const s = await loginAs('owner-a@veyra.test');
      await get(`/api/clinics/appointments?date=${SEGUNDA}`, s).expect(404);
      await status(id, { to: 'confirmed' }, s).expect(404);
      expect((await prisma.raw.clinicsAppointment.findFirst({ where: { id } }))!.status).toBe(
        'scheduled',
      );
    });
  });

  // ── Isolamento ────────────────────────────────────────────────────────────

  describe('isolamento', () => {
    it('P0: B (com o Clinics ativo) não vê nem mexe na agenda de A, nem por ids de A no corpo ou na consulta', async () => {
      const id = (await agendar().expect(201)).body.id;
      await post(`/api/clinics/appointments/${id}/attendance`, owner, AVULSO).expect(201);
      await app.get(ClinicsActivationService).enable('beta');
      const donoB = await loginAs('owner-b@veyra.test');
      expect((await dia(SEGUNDA, donoB)).body).toEqual([]);
      await get(`/api/clinics/appointments?date=${SEGUNDA}&unitId=${unitA}`, donoB).expect(404);
      expect(
        (
          await get(
            `/api/clinics/appointments?date=${SEGUNDA}&professionalId=${ana}`,
            donoB,
          ).expect(200)
        ).body,
      ).toEqual([]);
      await status(id, { to: 'confirmed' }, donoB).expect(404);
      await post(`/api/clinics/appointments/${id}/reschedule`, donoB, {
        date: SEGUNDA,
        time: '10:00',
      }).expect(404);
      await post(`/api/clinics/appointments/${id}/attendance`, donoB, AVULSO).expect(404);
      await get(`/api/clinics/appointments/${id}/attendance`, donoB).expect(404);
      await agendar({}, donoB).expect(404); // o paciente de A não existe para B
      // paciente PRÓPRIO de B, com profissional e serviço de A: 404
      const contatoB = (await post('/api/contacts', donoB, { name: 'Contato B' }).expect(201)).body
        .id;
      const pacienteB = (
        await post('/api/clinics/patients', donoB, { contactId: contatoB }).expect(201)
      ).body.id;
      await agendar({ patientId: pacienteB }, donoB).expect(404);
      expect(
        await prisma.raw.clinicsAppointment.count({ where: { workspaceId: wsB.workspaceId } }),
      ).toBe(0);
    });

    it('FKs compostas: cada referência de outro workspace é recusada pelo banco, UMA de cada vez', async () => {
      const id = (await agendar().expect(201)).body.id;
      await app.get(ClinicsActivationService).enable('beta');
      const wsBId = wsB.workspaceId;
      const membroA = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsA.workspaceId },
      });
      const membroB = await prisma.raw.membership.findFirst({ where: { workspaceId: wsBId } });
      const unidadeB = await prisma.raw.clinicsUnit.findFirst({ where: { workspaceId: wsBId } });
      const contatoB = await prisma.raw.contact.create({ data: { workspaceId: wsBId, name: 'B' } });
      const pacienteB = await prisma.raw.clinicsPatient.create({
        data: { workspaceId: wsBId, contactId: contatoB.id, createdByMembershipId: membroB!.id },
      });
      const profB = await prisma.raw.clinicsProfessional.create({
        data: { workspaceId: wsBId, name: 'B' },
      });
      const servB = await prisma.raw.clinicsService.create({
        data: { workspaceId: wsBId, name: 'B', durationMin: 30 },
      });
      const agB = await prisma.raw.clinicsAppointment.create({
        data: {
          workspaceId: wsBId,
          patientId: pacienteB.id,
          professionalId: profB.id,
          serviceId: servB.id,
          unitId: unidadeB!.id,
          startsAt: new Date('2030-12-02T12:00:00Z'),
          endsAt: new Date('2030-12-02T12:30:00Z'),
          createdByMembershipId: membroB!.id,
        },
      });
      // agendamento em A com TUDO de A, menos a coluna testada
      const base = {
        workspaceId: wsA.workspaceId,
        patientId: paciente,
        professionalId: ana,
        serviceId: servico,
        unitId: unitA,
        startsAt: new Date('2030-12-03T12:00:00Z'),
        endsAt: new Date('2030-12-03T13:00:00Z'),
        createdByMembershipId: membroA!.id,
      };
      for (const cruzada of [
        { patientId: pacienteB.id },
        { professionalId: profB.id },
        { serviceId: servB.id },
        { unitId: unidadeB!.id },
        { createdByMembershipId: membroB!.id },
      ]) {
        await expect(
          prisma.raw.clinicsAppointment.create({ data: { ...base, ...cruzada } }),
        ).rejects.toMatchObject({ code: 'P2003' });
      }
      await expect(prisma.raw.clinicsAppointment.create({ data: base })).resolves.toBeTruthy();
      // atendimento em A com tudo de A (um agendamento AINDA sem registro), menos a coluna testada
      const semRegistro = (await agendar({ time: '15:00' }).expect(201)).body.id;
      const baseAt = {
        workspaceId: wsA.workspaceId,
        appointmentId: semRegistro,
        professionalId: ana,
        completedAt: new Date(),
        recordedByMembershipId: membroA!.id,
      };
      for (const cruzada of [
        { appointmentId: agB.id },
        { professionalId: profB.id },
        { recordedByMembershipId: membroB!.id },
      ]) {
        await expect(
          prisma.raw.clinicsAttendance.create({ data: { ...baseAt, ...cruzada } }),
        ).rejects.toMatchObject({ code: 'P2003' });
      }
      await expect(prisma.raw.clinicsAttendance.create({ data: baseAt })).resolves.toBeTruthy();
      expect(id).toBeTruthy();
    });

    it('excluir o WORKSPACE leva agenda e atendimento em cascata, passando pelas FKs NO ACTION', async () => {
      const id = (await agendar().expect(201)).body.id;
      await post(`/api/clinics/appointments/${id}/attendance`, owner, AVULSO).expect(201);
      await prisma.raw.workspace.deleteMany({ where: { id: wsA.workspaceId } });
      expect(await prisma.raw.clinicsAppointment.count()).toBe(0);
      expect(await prisma.raw.clinicsAttendance.count()).toBe(0);
    });
  });

  // ── Fuso e mudança de horário ─────────────────────────────────────────────

  describe('fuso da unidade e mudança de horário (Nova York, fictício)', () => {
    beforeEach(async () => {
      await patch(`/api/clinics/units/${unitA}`, owner, { timezone: 'America/New_York' }).expect(
        200,
      );
      // domingo de madrugada, para cair nas mudanças de horário
      await perfil(ana, 'Ana Fictícia', [servico], [...COMERCIAL, [7, 0, 240]]);
    });

    it('o PULO da primavera: 02:30 não existe, 400 com o motivo', async () => {
      const res = await agendar({ date: NY_PULO, time: '02:30' }).expect(400);
      expect(res.body.message).toBe('Horário inexistente nesse dia por mudança de fuso');
    });

    it('a hora que SE REPETE: 400 pedindo utcOffset; com ele, as duas 01:30 são horários distintos', async () => {
      const ambigua = await agendar({ date: NY_REPETE, time: '01:30' }).expect(400);
      expect(ambigua.body.message).toBe(
        'Horário ambíguo por mudança de fuso: informe utcOffset (-04:00 ou -05:00)',
      );
      const antes = (
        await agendar({ date: NY_REPETE, time: '01:30', utcOffset: '-04:00' }).expect(201)
      ).body;
      const depois = (
        await agendar({
          date: NY_REPETE,
          time: '01:30',
          utcOffset: '-05:00',
          patientId: await novoPaciente('Segunda Fictícia'),
        }).expect(201)
      ).body;
      expect([antes.startsAt, depois.startsAt]).toEqual([
        '2025-11-02T05:30:00.000Z',
        '2025-11-02T06:30:00.000Z',
      ]);
      // as duas aparecem no dia local, ambas às 01:30 na leitura da unidade
      const lista = (await dia(NY_REPETE)).body;
      expect(lista.map((a: { localStart: string }) => a.localStart)).toEqual(['01:30', '01:30']);
      await agendar({ date: NY_REPETE, time: '01:30', utcOffset: '-03:00' }).expect(400);
    });

    it('atravessar o pulo: 01:30 + 60 min termina às 03:30 locais — cabe até as 04:00, não até as 03:00', async () => {
      const criado = (await agendar({ date: NY_PULO, time: '01:30' }).expect(201)).body;
      expect(criado).toMatchObject({ localStart: '01:30', localEnd: '03:30' });
      await status(criado.id, { to: 'canceled', cancelReason: 'scheduling_error' }).expect(201);
      await perfil(ana, 'Ana Fictícia', [servico], [...COMERCIAL, [7, 0, 180]]);
      await agendar({ date: NY_PULO, time: '01:30' }).expect(400);
    });

    it('corrida com a mudança de fuso: quem agenda ESPERA a trava da unidade e calcula com o fuso que comitou', async () => {
      // volta a São Paulo para o teste mudar para Nova York no meio do agendamento
      await patch(`/api/clinics/units/${unitA}`, owner, { timezone: 'America/Sao_Paulo' }).expect(
        200,
      );
      const trava = new Client({ connectionString: TEST_DATABASE_URL });
      await trava.connect();
      let pedido: Promise<request.Response> | undefined;
      try {
        await trava.query('BEGIN');
        await trava.query(
          `UPDATE "ClinicsUnit" SET "timezone" = 'America/New_York', "updatedAt" = now() WHERE "id" = $1`,
          [unitA],
        );
        let respondeu: number | null = null;
        pedido = agendar().then((res) => {
          respondeu = res.status;
          return res;
        });
        await esperarBloqueadosPor(trava, 1, {
          descricao: 'agendamento esperando a trava da unidade',
          aCadaTentativa: () => {
            if (respondeu !== null)
              throw new Error(`o agendamento respondeu ${respondeu} sem esperar`);
          },
        });
        await trava.query('COMMIT');
        const criado = (await pedido).body;
        // 09:00 em Nova York (UTC−5 em novembro), não em São Paulo (UTC−3)
        expect(criado).toMatchObject({ startsAt: '2030-11-04T14:00:00.000Z', localStart: '09:00' });
      } finally {
        await trava.end();
        await pedido?.catch(() => undefined);
      }
    });

    it('mudar o fuso da unidade com agendamento FUTURO ativo: 409; sem ele, pode', async () => {
      const id = (await agendar({ date: segundaFutura() }).expect(201)).body.id;
      const res = await patch(`/api/clinics/units/${unitA}`, owner, {
        timezone: 'America/Sao_Paulo',
      }).expect(409);
      expect(res.body.message).toMatch(/agendamentos futuros/);
      await status(id, { to: 'canceled', cancelReason: 'clinic_request' }).expect(201);
      await patch(`/api/clinics/units/${unitA}`, owner, { timezone: 'America/Sao_Paulo' }).expect(
        200,
      );
    });
  });

  // ── Fronteira ─────────────────────────────────────────────────────────────

  it('fronteira: nada da agenda nem do atendimento vai para entidades do Core nem para o outbox', async () => {
    const contar = async () => ({
      tarefas: await prisma.raw.task.count(),
      atividades: await prisma.raw.activity.count(),
      notificacoes: await prisma.raw.notification.count(),
      eventos: await prisma.raw.outboxEvent.count(),
    });
    const antes = await contar();
    const id = (await agendar().expect(201)).body.id;
    await status(id, { to: 'confirmed' }).expect(201);
    await post(`/api/clinics/appointments/${id}/reschedule`, owner, {
      date: SEGUNDA,
      time: '10:00',
    }).expect(201);
    await post(`/api/clinics/appointments/${id}/attendance`, owner, AVULSO).expect(201);
    expect(await contar()).toEqual(antes);
    // e a trilha só tem ids, status, instantes e motivo — nenhum nome
    const trilhas = await prisma.raw.auditLog.findMany({
      where: { entityType: { in: ['clinicsAppointment', 'clinicsAttendance'] } },
    });
    expect(JSON.stringify(trilhas)).not.toMatch(/Fictícia|Limpeza/);
  });
});
