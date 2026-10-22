import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
  horaLocal,
  somarDias,
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

/**
 * Taxa de faltas (F3.3a; ADR-048 adendo 7, item 7 e aprovação da F3.3). Dados
 * FICTÍCIOS. Os agendamentos são gravados direto no banco, no instante exato,
 * para encostar nos limites do período: o que se testa aqui é a apuração.
 */
describe('Clinics — taxa de faltas (integração, F3.3a)', () => {
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
  // um teste que estoure o timeout do Jest não roda o `finally` a tempo
  afterEach(() => restaurarRelogioDoNode());

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let owner: Session;
  let recepcao: Session;
  let profissional: Session;
  let guest: Session;
  let ownerB: Session;
  let dono: string;
  let unitA: string;
  let fuso: string;
  let servico: string;
  let outroServico: string;
  let ana: string;
  let bia: string;
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
  const post = (path: string, s: Session, body: unknown) =>
    request(http)
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send(body as object);
  const put = (path: string, s: Session, body: unknown) =>
    request(http)
      .put(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send(body as object);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);
  const taxa = (q: string, s: Session = recepcao) => get(`/api/clinics/metrics/no-show?${q}`, s);
  const hojeNoBanco = async (tz: string) =>
    horaLocal(new Date(await agoraNoBanco(prisma)), tz).data;

  /** Um agendamento gravado no instante exato, com o estado dado (30 min). */
  const gravar = async (
    inicio: Date,
    status: 'scheduled' | 'confirmed' | 'arrived' | 'attended' | 'no_show' | 'canceled',
    extra: { unitId?: string; professionalId?: string; serviceId?: string } = {},
  ) =>
    prisma.raw.clinicsAppointment.create({
      data: {
        workspaceId: wsA.workspaceId,
        patientId: paciente,
        professionalId: extra.professionalId ?? ana,
        serviceId: extra.serviceId ?? servico,
        unitId: extra.unitId ?? unitA,
        startsAt: inicio,
        endsAt: new Date(inicio.getTime() + 30 * MINUTO),
        status,
        ...(status === 'canceled' ? { cancelReason: 'patient_request' as const } : {}),
        createdByMembershipId: dono,
      },
    });

  beforeEach(async () => {
    jest.restoreAllMocks();
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
    const userB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, userB, wsB.roles.owner);
    await app.get(ClinicsActivationService).enable('acme');
    await app.get(ClinicsActivationService).enable('beta');
    const papelProfissional = await prisma.raw.role.findFirst({
      where: { workspaceId: wsA.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
    });
    await createMembershipFixture(
      prisma,
      wsA.workspaceId,
      await createUserFixture(prisma, 'prof-a@veyra.test'),
      papelProfissional!.id,
    );
    owner = await loginAs('owner-a@veyra.test');
    recepcao = await loginAs('member-a@veyra.test');
    profissional = await loginAs('prof-a@veyra.test');
    guest = await loginAs('guest-a@veyra.test');
    ownerB = await loginAs('owner-b@veyra.test');
    const unidade = (await prisma.raw.clinicsUnit.findFirst({
      where: { workspaceId: wsA.workspaceId },
    }))!;
    unitA = unidade.id;
    fuso = unidade.timezone;
    servico = (
      await post('/api/clinics/services', owner, {
        name: 'Limpeza de pele',
        durationMin: 30,
      }).expect(201)
    ).body.id;
    outroServico = (
      await post('/api/clinics/services', owner, { name: 'Peeling', durationMin: 30 }).expect(201)
    ).body.id;
    for (const nome of ['Ana Fictícia', 'Bia Fictícia']) {
      const id = (await post('/api/clinics/professionals', owner, { name: nome }).expect(201)).body
        .id as string;
      await put(`/api/clinics/professionals/${id}/profile`, owner, {
        name: nome,
        serviceIds: [servico, outroServico],
        intervals: [1, 2, 3, 4, 5].map((weekday) => ({
          unitId: unitA,
          weekday,
          startMinute: 480,
          endMinute: 1320,
        })),
      }).expect(200);
      if (nome.startsWith('Ana')) ana = id;
      else bia = id;
    }
    const contato = (await post('/api/contacts', owner, { name: 'Paciente Fictícia' }).expect(201))
      .body.id;
    paciente = (await post('/api/clinics/patients', owner, { contactId: contato }).expect(201)).body
      .id;
  });

  it('a definição: "sem dados" (null) só sem atendidos nem faltas; 0 % legítimo; cancelados e passados sem desfecho à parte', async () => {
    // janeiro de 2026: São Paulo sem horário de verão; o período inteiro no passado
    const q = `from=2026-01-05&to=2026-01-12&unitId=${unitA}`;
    expect((await taxa(q).expect(200)).body).toEqual({
      from: '2026-01-05',
      to: '2026-01-12',
      unitId: unitA,
      attended: 0,
      noShow: 0,
      rate: null,
      pendingPast: 0,
      canceled: 0,
    });
    // atendidos e nenhuma falta: 0 %, legítimo (e não "sem dados")
    for (const h of [12, 13, 14]) await gravar(new Date(`2026-01-06T${h}:00:00Z`), 'attended');
    expect((await taxa(q).expect(200)).body).toMatchObject({ attended: 3, noShow: 0, rate: 0 });
    // só canceladas e passadas sem desfecho continuam "sem dados"
    await gravar(new Date('2026-01-07T12:00:00Z'), 'no_show');
    for (const [h, status] of [
      [15, 'canceled'],
      [16, 'canceled'],
      [17, 'scheduled'],
      [18, 'confirmed'],
      [19, 'arrived'],
    ] as const) {
      await gravar(new Date(`2026-01-08T${h}:00:00Z`), status);
    }
    expect((await taxa(q).expect(200)).body).toMatchObject({
      attended: 3,
      noShow: 1,
      rate: 0.25,
      canceled: 2,
      pendingPast: 3,
    });
    const soForaDaConta = `from=2026-01-08&to=2026-01-09&unitId=${unitA}`;
    expect((await taxa(soForaDaConta).expect(200)).body).toMatchObject({
      attended: 0,
      noShow: 0,
      rate: null,
      canceled: 2,
      pendingPast: 3,
    });
  });

  it('os limites são o INÍCIO de cada dia local, `to` exclusivo: dias de 23 h e de 25 h em São Paulo, e a meia-noite repetida de Havana', async () => {
    // 2019-02-16 tem 25 h (a volta do horário de verão repete 23:00–23:59)
    const dentro25 = [
      '2019-02-16T02:00:00Z', // 00:00 local do dia 16, o primeiro instante
      '2019-02-17T02:30:00Z', // 23:30 local do dia 16, na SEGUNDA ocorrência
    ];
    const fora25 = [
      '2019-02-16T01:59:00Z', // 23:59 local do dia 15
      '2019-02-17T03:00:00Z', // 00:00 local do dia 17: o limite exclusivo
    ];
    // 2018-11-04 tem 23 h, e a meia-noite caiu no pulo (o dia começa à 01:00)
    const dentro23 = [
      '2018-11-04T03:00:00Z', // 01:00 local, o primeiro instante
      '2018-11-05T01:59:00Z', // 23:59 local do dia 4
    ];
    const fora23 = [
      '2018-11-04T02:59:00Z', // 23:59 local do dia 3
      '2018-11-05T02:00:00Z', // 00:00 local do dia 5: o limite exclusivo
    ];
    // "falta" sai da regra de sobreposição: instantes vizinhos do mesmo profissional
    for (const t of [...dentro25, ...fora25, ...dentro23, ...fora23]) {
      await gravar(new Date(t), 'no_show');
    }
    expect(
      (await taxa(`from=2019-02-16&to=2019-02-17&unitId=${unitA}`).expect(200)).body,
    ).toMatchObject({ noShow: 2 });
    expect(
      (await taxa(`from=2019-02-17&to=2019-02-18&unitId=${unitA}`).expect(200)).body,
    ).toMatchObject({ noShow: 1 });
    expect(
      (await taxa(`from=2018-11-04&to=2018-11-05&unitId=${unitA}`).expect(200)).body,
    ).toMatchObject({ noShow: 2 });
    expect(
      (await taxa(`from=2018-11-05&to=2018-11-06&unitId=${unitA}`).expect(200)).body,
    ).toMatchObject({ noShow: 1 });
    expect(
      (await taxa(`from=2018-11-03&to=2018-11-04&unitId=${unitA}`).expect(200)).body,
    ).toMatchObject({ noShow: 1 });
    // Havana, 2025-11-02: a meia-noite se repete; o dia começa na PRIMEIRA
    const havana = await prisma.raw.clinicsUnit.create({
      data: {
        workspaceId: wsA.workspaceId,
        name: 'Unidade Havana (fictícia)',
        timezone: 'America/Havana',
      },
    });
    await gravar(new Date('2025-11-02T04:00:00Z'), 'no_show', { unitId: havana.id }); // 00:00, 1ª
    await gravar(new Date('2025-11-02T05:10:00Z'), 'no_show', { unitId: havana.id }); // 00:10, 2ª
    await gravar(new Date('2025-11-02T03:59:00Z'), 'no_show', { unitId: havana.id }); // 23:59 do dia 1
    expect(
      (await taxa(`from=2025-11-02&to=2025-11-03&unitId=${havana.id}`).expect(200)).body,
    ).toMatchObject({ noShow: 2 });
    expect(
      (await taxa(`from=2025-11-01&to=2025-11-02&unitId=${havana.id}`).expect(200)).body,
    ).toMatchObject({ noShow: 1 });
    // Samoa pulou 2011-12-30 inteiro: o período que começa nele é vazio, e o que
    // o atravessa vai do dia 29 ao 31 (24 h)
    const apia = await prisma.raw.clinicsUnit.create({
      data: {
        workspaceId: wsA.workspaceId,
        name: 'Unidade Apia (fictícia)',
        timezone: 'Pacific/Apia',
      },
    });
    await gravar(new Date('2011-12-30T09:00:00Z'), 'no_show', { unitId: apia.id }); // 23:00 do dia 29
    await gravar(new Date('2011-12-30T09:59:00Z'), 'no_show', { unitId: apia.id }); // 23:59 do dia 29
    await gravar(new Date('2011-12-30T10:00:00Z'), 'no_show', { unitId: apia.id }); // 00:00 do dia 31
    expect(
      (await taxa(`from=2011-12-30&to=2011-12-31&unitId=${apia.id}`).expect(200)).body,
    ).toMatchObject({ noShow: 0, rate: null });
    expect(
      (await taxa(`from=2011-12-29&to=2011-12-31&unitId=${apia.id}`).expect(200)).body,
    ).toMatchObject({ noShow: 2 });
    expect(
      (await taxa(`from=2011-12-31&to=2012-01-01&unitId=${apia.id}`).expect(200)).body,
    ).toMatchObject({ noShow: 1 });
  });

  it('"passado" é pelo relógio do BANCO, uma leitura por operação: o Node deslocado para os dois lados não muda os passados sem desfecho', async () => {
    const agora = await agoraNoBanco(prisma);
    await gravar(new Date(agora - 30 * MINUTO), 'scheduled');
    await gravar(new Date(agora + 30 * MINUTO), 'scheduled', { professionalId: bia });
    const hoje = await hojeNoBanco(fuso);
    const q = `from=${somarDias(hoje, -1)}&to=${somarDias(hoje, 2)}&unitId=${unitA}`;
    const leituras = jest.spyOn(relogio, 'agoraDoBanco');
    expect((await taxa(q).expect(200)).body.pendingPast).toBe(1);
    expect(leituras).toHaveBeenCalledTimes(1);
    for (const desvio of [2 * HORA, -2 * HORA]) {
      await comRelogioDoNode(desvio, async () => {
        const s = await loginAs('member-a@veyra.test');
        expect((await taxa(q, s).expect(200)).body.pendingPast).toBe(1);
      });
    }
  });

  it('recorte por profissional e por serviço; só agregados, com o DTO estrito', async () => {
    await gravar(new Date('2026-01-06T12:00:00Z'), 'attended');
    await gravar(new Date('2026-01-06T12:00:00Z'), 'no_show', { professionalId: bia });
    await gravar(new Date('2026-01-06T13:00:00Z'), 'no_show', { serviceId: outroServico });
    // outra unidade, no MESMO período: não entra na conta de A
    const filial = await prisma.raw.clinicsUnit.create({
      data: { workspaceId: wsA.workspaceId, name: 'Filial (fictícia)', timezone: fuso },
    });
    await gravar(new Date('2026-01-06T15:00:00Z'), 'no_show', { unitId: filial.id });
    await gravar(new Date('2026-01-06T16:00:00Z'), 'attended', { unitId: filial.id });
    expect(
      (await taxa(`from=2026-01-05&to=2026-01-12&unitId=${filial.id}`).expect(200)).body,
    ).toMatchObject({ attended: 1, noShow: 1, rate: 0.5 });
    const base = `from=2026-01-05&to=2026-01-12&unitId=${unitA}`;
    const tudo = (await taxa(base).expect(200)).body;
    expect(Object.keys(tudo).sort()).toEqual(
      ['attended', 'canceled', 'from', 'noShow', 'pendingPast', 'rate', 'to', 'unitId'].sort(),
    );
    expect(tudo).toMatchObject({ attended: 1, noShow: 2 });
    expect((await taxa(`${base}&professionalId=${bia}`).expect(200)).body).toMatchObject({
      attended: 0,
      noShow: 1,
      rate: 1,
    });
    expect((await taxa(`${base}&serviceId=${outroServico}`).expect(200)).body).toMatchObject({
      attended: 0,
      noShow: 1,
    });
  });

  it('validação: período invertido ou vazio, mais de 366 dias, data inexistente, filtro fora da lista; sem unidade com duas ativas', async () => {
    await taxa(`from=2026-01-12&to=2026-01-05&unitId=${unitA}`).expect(400);
    await taxa(`from=2026-01-05&to=2026-01-05&unitId=${unitA}`).expect(400);
    await taxa(`from=2025-01-01&to=2026-01-03&unitId=${unitA}`).expect(400);
    // exatamente 366 dias: aceito
    await taxa(`from=2024-01-01&to=2025-01-01&unitId=${unitA}`).expect(200);
    await taxa(`from=2026-02-30&to=2026-03-05&unitId=${unitA}`).expect(400);
    await taxa(`from=2026-01-05&to=2026-01-12&patientId=${paciente}`).expect(400);
    // uma unidade ativa: a unidade é opcional
    await taxa('from=2026-01-05&to=2026-01-12').expect(200);
    await prisma.raw.clinicsUnit.create({
      data: { workspaceId: wsA.workspaceId, name: 'Filial (fictícia)', timezone: fuso },
    });
    await taxa('from=2026-01-05&to=2026-01-12').expect(400);
    // a unidade ARQUIVADA, informada, continua valendo (o histórico dela);
    // sem a unidade e sem nenhuma ativa, 400
    await gravar(new Date('2026-01-06T12:00:00Z'), 'no_show');
    await prisma.raw.clinicsUnit.updateMany({
      where: { workspaceId: wsA.workspaceId },
      data: { archivedAt: new Date('2026-01-20T00:00:00Z') },
    });
    expect(
      (await taxa(`from=2026-01-05&to=2026-01-12&unitId=${unitA}`).expect(200)).body,
    ).toMatchObject({ noShow: 1 });
    await taxa('from=2026-01-05&to=2026-01-12').expect(400);
  });

  it('RBAC: da agenda (a recepção e o profissional); o guest não', async () => {
    const q = `from=2026-01-05&to=2026-01-12&unitId=${unitA}`;
    await taxa(q, recepcao).expect(200);
    await taxa(q, profissional).expect(200);
    await taxa(q, guest).expect(403);
  });

  it('P0: o workspace B não conta nada de A, nem com a unidade de A', async () => {
    await gravar(new Date('2026-01-06T12:00:00Z'), 'no_show');
    const q = 'from=2026-01-05&to=2026-01-12';
    await taxa(`${q}&unitId=${unitA}`, ownerB).expect(404);
    // o profissional e o serviço de A, pedidos por B: zeros, como um id inexistente
    expect(
      (await taxa(`${q}&professionalId=${ana}&serviceId=${servico}`, ownerB).expect(200)).body,
    ).toMatchObject({ attended: 0, noShow: 0, rate: null });
    expect((await taxa(q, ownerB).expect(200)).body).toMatchObject({
      attended: 0,
      noShow: 0,
      rate: null,
      pendingPast: 0,
      canceled: 0,
    });
    expect((await taxa(`${q}&unitId=${unitA}`).expect(200)).body.noShow).toBe(1);
  });
});
