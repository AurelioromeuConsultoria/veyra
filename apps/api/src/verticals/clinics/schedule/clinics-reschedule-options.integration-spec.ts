import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  CLINICS_OCCUPYING_STATUSES,
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
  type ClinicsRescheduleOptionsDto,
} from '@veyra/contracts/verticals/clinics';
import { PrismaService } from '../../../prisma/prisma.service';
import * as relogio from '../../../prisma/relogio-do-banco';
import { createTestApp } from '../../../../test/integration/app';
import {
  agoraNoBanco,
  comRelogioDoNode,
  restaurarRelogioDoNode,
} from '../../../../test/integration/clock';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../../test/integration/fixtures';
import { resetDb } from '../../../../test/integration/harness';
import { ClinicsActivationService } from '../clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const MINUTO = 60_000;
const HORA = 60 * MINUTO;

interface Session {
  cookieHeader: string;
  csrf: string;
}

/** Segunda a sexta de 4 a 8/11/2030 (São Paulo, UTC−3, sem horário de verão). */
const SEGUNDA = '2030-11-04';
const QUARTA = '2030-11-06';
const SEXTA = '2030-11-08';
/** Instante UTC de uma hora local de São Paulo (UTC−3). */
const sp = (data: string, hora: string) =>
  new Date(Date.parse(`${data}T${hora}:00-03:00`)).toISOString();

/**
 * A sugestão "Remarcar" sem IA (ADR-062 adendo 1, parte B): os próximos inícios
 * livres de um agendamento, pela MESMA regra da remarcação (expediente,
 * sobreposição do EXCLUDE, duração registrada, fuso da unidade), a partir de
 * agora pelo RELÓGIO DO BANCO. O "agora" é fixado com o `agoraDoBanco`
 * simulado onde a conta precisa ser exata; os testes do relógio usam o real.
 * Dados FICTÍCIOS.
 */
describe('Clinics — opções de remarcação (integração, ADR-062 adendo 1, parte B)', () => {
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
  afterEach(() => {
    jest.restoreAllMocks();
    restaurarRelogioDoNode();
  });

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let owner: Session;
  let unitA: string;
  let servico: string;
  let ana: string;
  let bia: string;
  let paciente: string;
  let outro: string;
  let donoA: string;

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
  const send = (method: 'post' | 'put', path: string, s: Session, body?: unknown) => {
    const r = request(http)
      [method](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    return body === undefined ? r : r.send(body as object);
  };
  const post = (path: string, s: Session, body?: unknown) => send('post', path, s, body);
  const put = (path: string, s: Session, body?: unknown) => send('put', path, s, body);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);
  const opcoesDe = (id: string, s: Session = owner, query = '') =>
    get(`/api/clinics/appointments/${id}/reschedule-options${query}`, s);
  const opcoes = async (id: string, query = '', s: Session = owner) =>
    (await opcoesDe(id, s, query).expect(200)).body as ClinicsRescheduleOptionsDto;
  /** O relógio do banco fixado num instante (só a leitura da aplicação). */
  const agoraEm = (iso: string) =>
    jest.spyOn(relogio, 'agoraDoBanco').mockResolvedValue(new Date(iso));

  /** Segunda a sexta, 08:00–18:00, na unidade A. */
  const COMERCIAL = [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    startMinute: 480,
    endMinute: 1080,
  }));
  const perfil = (id: string, name: string, intervals: typeof COMERCIAL) =>
    put(`/api/clinics/professionals/${id}/profile`, owner, {
      name,
      serviceIds: [servico],
      intervals: intervals.map((i) => ({ unitId: unitA, ...i })),
    }).expect(200);
  const novoProfissional = async (name: string) => {
    const id = (await post('/api/clinics/professionals', owner, { name }).expect(201)).body
      .id as string;
    await perfil(id, name, COMERCIAL);
    return id;
  };
  const novoPaciente = async (name: string) => {
    const contato = (await post('/api/contacts', owner, { name }).expect(201)).body.id;
    return (await post('/api/clinics/patients', owner, { contactId: contato }).expect(201)).body
      .id as string;
  };
  const agendar = async (body: Record<string, unknown>) =>
    (
      await post('/api/clinics/appointments', owner, {
        patientId: paciente,
        professionalId: ana,
        serviceId: servico,
        date: QUARTA,
        time: '10:00',
        ...body,
      }).expect(201)
    ).body.id as string;
  /** Um horário posto direto no banco (fora do expediente, no passado, outro estado). */
  const noBanco = (startsAt: string, minutos = 60, extra: Record<string, unknown> = {}) =>
    prisma.raw.clinicsAppointment.create({
      data: {
        workspaceId: wsA.workspaceId,
        patientId: paciente,
        professionalId: ana,
        serviceId: servico,
        unitId: unitA,
        startsAt: new Date(startsAt),
        endsAt: new Date(Date.parse(startsAt) + minutos * MINUTO),
        createdByMembershipId: donoA,
        ...extra,
      },
    });
  const inicios = (dto: ClinicsRescheduleOptionsDto) =>
    dto.options.map((o) => `${o.localDate} ${o.localStart}`);

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
    donoA = (await prisma.raw.membership.findFirst({
      where: { workspaceId: wsA.workspaceId, user: { email: 'owner-a@veyra.test' } },
    }))!.id;
    unitA = (await prisma.raw.clinicsUnit.findFirst({ where: { workspaceId: wsA.workspaceId } }))!
      .id;
    servico = (
      await post('/api/clinics/services', owner, {
        name: 'Limpeza de pele',
        durationMin: 60,
      }).expect(201)
    ).body.id;
    ana = await novoProfissional('Ana Fictícia');
    bia = await novoProfissional('Bia Fictícia');
    paciente = await novoPaciente('Paciente Fictícia');
    outro = await novoPaciente('Outra Pessoa Fictícia');
  });

  it('a partir de agora, dentro do expediente, sem sobrepor horário de OUTRO paciente; o cancelado libera', async () => {
    const id = await agendar({});
    // outra paciente com a Ana às 10:00 de segunda; uma terceira, cancelada, às 11:00
    await agendar({ patientId: outro, date: SEGUNDA, time: '10:00' });
    const cancelado = await agendar({ patientId: outro, date: SEGUNDA, time: '11:00' });
    await post(`/api/clinics/appointments/${cancelado}/status`, owner, {
      to: 'canceled',
      cancelReason: 'patient_request',
    }).expect(201);
    // a Bia ocupada às 11:00 não muda a agenda da Ana
    await agendar({ patientId: outro, professionalId: bia, date: SEGUNDA, time: '11:00' });
    agoraEm(sp(SEGUNDA, '09:10'));
    const dto = await opcoes(id);
    // 09:15 a 10:45 terminariam depois das 10:00 da outra paciente
    expect(inicios(dto)).toEqual([`${SEGUNDA} 11:00`, `${SEGUNDA} 11:15`, `${SEGUNDA} 11:30`]);
    expect(dto).toMatchObject({
      appointmentId: id,
      professionalId: ana,
      unitId: unitA,
      timezone: 'America/Sao_Paulo',
      durationMin: 60,
    });
    expect(dto.options[0]).toEqual({
      startsAt: sp(SEGUNDA, '11:00'),
      endsAt: sp(SEGUNDA, '12:00'),
      localDate: SEGUNDA,
      localStart: '11:00',
      localEnd: '12:00',
    });
    // nenhum dado de paciente na resposta
    expect(JSON.stringify(dto)).not.toMatch(/Fictícia|patient/i);
    // o limite
    expect(inicios(await opcoes(id, '?limit=5'))).toEqual([
      `${SEGUNDA} 11:00`,
      `${SEGUNDA} 11:15`,
      `${SEGUNDA} 11:30`,
      `${SEGUNDA} 11:45`,
      `${SEGUNDA} 12:00`,
    ]);
    expect(inicios(await opcoes(id, '?limit=1'))).toEqual([`${SEGUNDA} 11:00`]);
    for (const ruim of ['?limit=0', '?limit=6', '?limit=x', '?outro=1']) {
      await opcoesDe(id, owner, ruim).expect(400);
    }
  });

  it('o fim do expediente e o fim de semana: o atendimento precisa caber; pula sábado e domingo', async () => {
    const id = await agendar({});
    agoraEm(sp(SEGUNDA, '16:50'));
    // 17:00–18:00 cabe; 17:15 terminaria às 18:15
    expect(inicios(await opcoes(id))).toEqual([
      `${SEGUNDA} 17:00`,
      '2030-11-05 08:00',
      '2030-11-05 08:15',
    ]);
    // sexta no fim do dia, para um horário da semana seguinte
    const seguinte = await agendar({ date: '2030-11-12' });
    agoraEm(sp(SEXTA, '17:30'));
    expect(inicios(await opcoes(seguinte))).toEqual([
      '2030-11-11 08:00',
      '2030-11-11 08:15',
      '2030-11-11 08:30',
    ]);
  });

  it('a duração REGISTRADA, a que a remarcação conserva; o horário atual não é sugerido', async () => {
    // 45 minutos registrados, embora o serviço tenha 60
    const id = (await noBanco(sp(QUARTA, '10:00'), 45)).id;
    agoraEm(sp(SEGUNDA, '16:50'));
    const dto = await opcoes(id);
    expect(dto.durationMin).toBe(45);
    // com 45 min, 17:15 termina às 18:00 e cabe
    expect(inicios(dto)).toEqual([`${SEGUNDA} 17:00`, `${SEGUNDA} 17:15`, '2030-11-05 08:00']);
    expect(dto.options.map((o) => [o.localStart, o.localEnd])).toEqual([
      ['17:00', '17:45'],
      ['17:15', '18:00'],
      ['08:00', '08:45'],
    ]);
    // a véspera do próprio horário: o início atual (quarta 10:00) fica de fora,
    // mas os vizinhos que o sobrepõem valem (a remarcação move o próprio)
    agoraEm(sp(QUARTA, '09:40'));
    expect(inicios(await opcoes(id))).toEqual([
      `${QUARTA} 09:45`,
      `${QUARTA} 10:15`,
      `${QUARTA} 10:30`,
    ]);
  });

  it('o fuso da UNIDADE: os inícios e os rótulos na hora local dela', async () => {
    // Manaus, UTC−4 o ano todo
    await prisma.raw.clinicsUnit.updateMany({
      where: { id: unitA },
      data: { timezone: 'America/Manaus' },
    });
    const id = (await noBanco('2030-11-06T14:00:00Z')).id;
    // 09:10 em Manaus (10:10 em São Paulo)
    agoraEm('2030-11-04T13:10:00Z');
    const dto = await opcoes(id);
    expect(dto.timezone).toBe('America/Manaus');
    expect(dto.options.map((o) => [o.startsAt, o.localDate, o.localStart])).toEqual([
      ['2030-11-04T13:15:00.000Z', SEGUNDA, '09:15'],
      ['2030-11-04T13:30:00.000Z', SEGUNDA, '09:30'],
      ['2030-11-04T13:45:00.000Z', SEGUNDA, '09:45'],
    ]);
  });

  it('a hora que se repete na mudança de horário sai com o deslocamento, e a remarcação aceita a opção como veio', async () => {
    // Nova York: o horário de verão acaba no domingo 3/11/2030 (01:00–02:00 se repete)
    await prisma.raw.clinicsUnit.updateMany({
      where: { id: unitA },
      data: { timezone: 'America/New_York' },
    });
    await perfil(ana, 'Ana Fictícia', [
      ...COMERCIAL,
      { weekday: 7, startMinute: 0, endMinute: 240 },
    ]);
    const id = (await noBanco('2030-11-05T15:00:00Z', 30)).id;
    // 01:10 EDT (−04:00)
    agoraEm('2030-11-03T05:10:00Z');
    const dto = await opcoes(id, '?limit=5');
    expect(dto.options.map((o) => [o.localStart, o.utcOffset, o.startsAt])).toEqual([
      ['01:15', '-04:00', '2030-11-03T05:15:00.000Z'],
      ['01:30', '-04:00', '2030-11-03T05:30:00.000Z'],
      ['01:45', '-04:00', '2030-11-03T05:45:00.000Z'],
      ['01:00', '-05:00', '2030-11-03T06:00:00.000Z'],
      ['01:15', '-05:00', '2030-11-03T06:15:00.000Z'],
    ]);
    jest.restoreAllMocks();
    const escolhida = dto.options[3];
    const remarcado = (
      await post(`/api/clinics/appointments/${id}/reschedule`, owner, {
        date: escolhida.localDate,
        time: escolhida.localStart,
        utcOffset: escolhida.utcOffset,
      }).expect(201)
    ).body;
    expect([remarcado.startsAt, remarcado.endsAt]).toEqual([escolhida.startsAt, escolhida.endsAt]);
  });

  it('a opção sugerida é aceita pela remarcação; tomada por outra pessoa no meio do caminho, 409 pelo banco', async () => {
    const id = await agendar({});
    const dto = await (async () => {
      agoraEm(sp(SEGUNDA, '09:10'));
      return opcoes(id);
    })();
    jest.restoreAllMocks();
    const [primeira] = dto.options;
    expect(primeira.localStart).toBe('09:15');
    // outra paciente toma a primeira (09:15–10:15)
    await agendar({ patientId: outro, date: primeira.localDate, time: primeira.localStart });
    const recusa = await post(`/api/clinics/appointments/${id}/reschedule`, owner, {
      date: primeira.localDate,
      time: primeira.localStart,
    }).expect(409);
    expect(recusa.body.message).toBe('Horário já ocupado para este profissional');
    // a lista recarregada já não oferece nada que a sobreponha
    agoraEm(sp(SEGUNDA, '09:10'));
    const recarregada = await opcoes(id);
    jest.restoreAllMocks();
    expect(inicios(recarregada)).toEqual([
      `${SEGUNDA} 10:15`,
      `${SEGUNDA} 10:30`,
      `${SEGUNDA} 10:45`,
    ]);
    const nova = recarregada.options[0];
    const feito = (
      await post(`/api/clinics/appointments/${id}/reschedule`, owner, {
        date: nova.localDate,
        time: nova.localStart,
      }).expect(201)
    ).body;
    expect([feito.startsAt, feito.endsAt]).toEqual([nova.startsAt, nova.endsAt]);
  });

  it('só agendamento remarcável: cancelado, faltou, chegou e atendido respondem 409 com a mensagem da remarcação', async () => {
    agoraEm(sp(SEGUNDA, '09:10'));
    const estados = ['canceled', 'no_show', 'arrived', 'attended'] as const;
    for (const [indice, status] of estados.entries()) {
      // os que ocupam não dividem o horário: um por hora (10:00, 11:00, ...)
      const id = (
        await noBanco(sp(QUARTA, `1${indice}:00`), 60, {
          status,
          ...(status === 'canceled' ? { cancelReason: 'patient_request' } : {}),
        })
      ).id;
      const res = await opcoesDe(id).expect(409);
      expect(res.body.message).toBe('Só agendamento marcado ou confirmado pode ser remarcado');
    }
    // confirmado vale
    const confirmado = await agendar({ time: '15:00' });
    await post(`/api/clinics/appointments/${confirmado}/status`, owner, { to: 'confirmed' }).expect(
      201,
    );
    expect((await opcoes(confirmado)).options).toHaveLength(3);
  });

  it('passado ou em curso, pelo relógio do BANCO: 409', async () => {
    // pelo relógio real: um horário de 2020
    const antigo = (await noBanco('2020-01-06T12:00:00Z')).id;
    const res = await opcoesDe(antigo).expect(409);
    expect(res.body.message).toBe(
      'Este horário já começou: a sugestão de remarcação é só para agendamento futuro',
    );
    // começando exatamente agora (pelo banco simulado) também não
    const id = await agendar({});
    agoraEm(sp(QUARTA, '10:00'));
    await opcoesDe(id).expect(409);
    agoraEm(sp(QUARTA, '09:59'));
    await opcoesDe(id).expect(200);
  });

  it('o "agora" é o do BANCO, uma leitura por pedido: o Node deslocado não muda o começo das opções', async () => {
    // a Ana trabalha o dia inteiro, todos os dias: sempre há opção logo depois de agora
    await perfil(
      ana,
      'Ana Fictícia',
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })),
    );
    // 15 minutos: o último passo do dia (23:45) termina às 24:00 e cabe
    const id = (await noBanco('2030-11-06T13:00:00Z', 15)).id;
    const leituras = jest.spyOn(relogio, 'agoraDoBanco');
    await opcoes(id);
    expect(leituras).toHaveBeenCalledTimes(1);
    for (const desvio of [2 * HORA, -2 * HORA]) {
      await comRelogioDoNode(desvio, async () => {
        // a sessão nasce no relógio deslocado, como a de quem usa o app
        const s = await loginAs('owner-a@veyra.test');
        const antes = await agoraNoBanco(prisma);
        const dto = await opcoes(id, '', s);
        const primeira = Date.parse(dto.options[0].startsAt);
        // depois de agora (o Node atrasado não traz o passado) e no próximo
        // passo de 15 min (o Node adiantado não pula horas livres), com folga
        expect(primeira).toBeGreaterThan(antes);
        expect(primeira - antes).toBeLessThanOrEqual(15 * MINUTO + MINUTO);
      });
    }
  });

  it('isolamento: o agendamento de outro workspace é o mesmo 404 do inexistente', async () => {
    await app.get(ClinicsActivationService).enable('beta');
    const id = await agendar({});
    const ownerB = await loginAs('owner-b@veyra.test');
    const alheio = await opcoesDe(id, ownerB).expect(404);
    const inexistente = await opcoesDe('3f9b1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e99', ownerB).expect(404);
    expect(alheio.body).toEqual(inexistente.body);
    expect(alheio.body.message).toBe('Agendamento não encontrado');
    // id malformado não chega ao serviço
    await opcoesDe('nao-e-uuid').expect(400);
  });

  it('permissão: quem lê a agenda (recepção e Profissional) vê; quem não lê, 403', async () => {
    const id = await agendar({});
    agoraEm(sp(SEGUNDA, '09:10'));
    for (const email of ['member-a@veyra.test', 'prof-a@veyra.test']) {
      expect((await opcoes(id, '', await loginAs(email))).options).toHaveLength(3);
    }
    const leituras = jest.spyOn(relogio, 'agoraDoBanco');
    leituras.mockClear();
    await opcoesDe(id, await loginAs('guest-a@veyra.test')).expect(403);
    // recusado antes do serviço: nem o relógio é lido
    expect(leituras).not.toHaveBeenCalled();
  });

  it('os estados que ocupam são os do EXCLUDE do banco', async () => {
    const [{ definicao }] = await prisma.raw.$queryRawUnsafe<{ definicao: string }[]>(
      `SELECT pg_get_constraintdef(oid) AS definicao FROM pg_constraint
        WHERE conname = 'ClinicsAppointment_no_overlap'`,
    );
    const noBancoOcupam = [...definicao.matchAll(/'(\w+)'::/g)].map((m) => m[1]).sort();
    expect(noBancoOcupam).toEqual([...CLINICS_OCCUPYING_STATUSES].sort());
  });
});
