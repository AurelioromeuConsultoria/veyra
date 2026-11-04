import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CLINICS_PROFESSIONAL_SYSTEM_KEY } from '@veyra/contracts/verticals/clinics';
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
import { resetDb } from '../../../../test/integration/harness';
import { ClinicsActivationService } from '../clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const AVULSO = { packageId: null };

interface Session {
  cookieHeader: string;
  csrf: string;
}

/** A semana de 4 a 10/11/2030, de segunda a domingo (São Paulo, UTC−3, sem horário de verão). */
const SEGUNDA = '2030-11-04';
const SEXTA = '2030-11-08';
const DOMINGO = '2030-11-10';

type Horario = {
  id: string;
  patientId: string;
  unitId: string;
  localDate: string;
  localStart: string;
  startsAt: string;
  attendanceId?: string | null;
  careInScope?: boolean;
};

/**
 * A agenda por paciente e por intervalo (ADR-062 adendo 1, A1): a MESMA rota
 * do dia, com a mesma chave (`clinics:schedule:read`) e o mesmo recorte de
 * campo. Dados FICTÍCIOS.
 */
describe('Clinics — agenda por paciente e por intervalo (integração, ADR-062 adendo 1)', () => {
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
  const lista = async (query: string, s: Session = owner) =>
    (await get(`/api/clinics/appointments?${query}`, s).expect(200)).body as Horario[];

  /** Segunda a sexta, 08:00–18:00, na unidade A. */
  const COMERCIAL = [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    startMinute: 480,
    endMinute: 1080,
  }));
  const novoProfissional = async (name: string) => {
    const id = (await post('/api/clinics/professionals', owner, { name }).expect(201)).body
      .id as string;
    await put(`/api/clinics/professionals/${id}/profile`, owner, {
      name,
      serviceIds: [servico],
      intervals: COMERCIAL.map((i) => ({ unitId: unitA, ...i })),
    }).expect(200);
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
        date: SEGUNDA,
        time: '09:00',
        ...body,
      }).expect(201)
    ).body.id as string;
  /** Um horário posto direto no banco: as bordas do dia local fogem do expediente. */
  const noBanco = (startsAt: string, extra: Record<string, unknown> = {}) =>
    prisma.raw.clinicsAppointment.create({
      data: {
        workspaceId: wsA.workspaceId,
        patientId: paciente,
        professionalId: ana,
        serviceId: servico,
        unitId: unitA,
        startsAt: new Date(startsAt),
        endsAt: new Date(Date.parse(startsAt) + 30 * 60_000),
        createdByMembershipId: donoA,
        ...extra,
      },
    });

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

  it('o intervalo: as duas pontas pelo dia LOCAL da unidade, em ordem de início', async () => {
    const sexta = await agendar({ date: SEXTA, time: '10:00' });
    const segunda = await agendar({ time: '09:00', professionalId: bia });
    // domingo 22:00 local = segunda 01:00 UTC: é do domingo, dentro da semana
    const domingoTarde = (await noBanco('2030-11-11T01:00:00Z')).id;
    // fora, por um passo: domingo anterior 23:00 local e a segunda seguinte 00:30 local
    await noBanco('2030-11-04T02:00:00Z');
    await noBanco('2030-11-11T03:30:00Z');
    const semana = await lista(`from=${SEGUNDA}&to=${DOMINGO}`);
    expect(semana.map((a) => a.id)).toEqual([segunda, sexta, domingoTarde]);
    expect(semana.map((a) => [a.localDate, a.localStart])).toEqual([
      [SEGUNDA, '09:00'],
      [SEXTA, '10:00'],
      [DOMINGO, '22:00'],
    ]);
    // o profissional estreita o intervalo
    expect(
      (await lista(`from=${SEGUNDA}&to=${DOMINGO}&professionalId=${bia}`)).map((a) => a.id),
    ).toEqual([segunda]);
    // um intervalo de um dia é o mesmo que o dia
    expect((await lista(`from=${SEXTA}&to=${SEXTA}`)).map((a) => a.id)).toEqual(
      (await lista(`date=${SEXTA}`)).map((a) => a.id),
    );
  });

  it('o paciente: só os horários DELE, no dia e no intervalo, e combinado com o profissional', async () => {
    const dele = await agendar({ time: '09:00' });
    const deleNaSexta = await agendar({ date: SEXTA, time: '15:00', professionalId: bia });
    const deOutro = await agendar({ time: '11:00', patientId: outro });
    expect(
      (await lista(`patientId=${paciente}&from=${SEGUNDA}&to=${DOMINGO}`)).map((a) => a.id),
    ).toEqual([dele, deleNaSexta]);
    expect((await lista(`patientId=${paciente}&date=${SEGUNDA}`)).map((a) => a.id)).toEqual([dele]);
    expect(
      (await lista(`patientId=${outro}&from=${SEGUNDA}&to=${DOMINGO}`)).every(
        (a) => a.patientId === outro,
      ),
    ).toBe(true);
    expect((await lista(`patientId=${outro}&date=${SEGUNDA}`)).map((a) => a.id)).toEqual([deOutro]);
    expect(
      (
        await lista(`patientId=${paciente}&professionalId=${bia}&from=${SEGUNDA}&to=${DOMINGO}`)
      ).map((a) => a.id),
    ).toEqual([deleNaSexta]);
  });

  it('o paciente sem unidade: todas as unidades do workspace, cada horário no fuso da sua', async () => {
    const aqui = await agendar({ time: '09:00' });
    // uma segunda unidade ATIVA, em Nova York (UTC−5 depois de 3/11/2030)
    const ny = await prisma.raw.clinicsUnit.create({
      data: { workspaceId: wsA.workspaceId, name: 'Unidade NY', timezone: 'America/New_York' },
    });
    const la = (await noBanco('2030-11-05T15:00:00Z', { unitId: ny.id })).id;
    const historico = await lista(`patientId=${paciente}&from=${SEGUNDA}&to=${DOMINGO}`);
    expect(historico.map((a) => [a.id, a.unitId, a.localDate, a.localStart])).toEqual([
      [aqui, unitA, SEGUNDA, '09:00'],
      [la, ny.id, '2030-11-05', '10:00'],
    ]);
    // com a unidade, só ela
    expect(
      (await lista(`patientId=${paciente}&unitId=${ny.id}&from=${SEGUNDA}&to=${DOMINGO}`)).map(
        (a) => a.id,
      ),
    ).toEqual([la]);
    // sem paciente e sem unidade, com duas ativas, a rota pede a unidade (como antes)
    const recusa = await get(
      `/api/clinics/appointments?from=${SEGUNDA}&to=${DOMINGO}`,
      owner,
    ).expect(400);
    expect(recusa.body.message).toBe('Informe a unidade');
  });

  it('o limite: até 31 dias contando as duas pontas; acima, 400 sem consulta', async () => {
    const id = await agendar({ time: '09:00' });
    expect((await lista(`from=2030-11-01&to=2030-12-01`)).map((a) => a.id)).toEqual([id]);
    const recusa = await get(
      '/api/clinics/appointments?from=2030-11-01&to=2030-12-02',
      owner,
    ).expect(400);
    expect(recusa.body.issues).toEqual([{ path: 'to', message: 'O intervalo vai até 31 dias' }]);
  });

  it('a forma do período: exatamente uma — dia OU início e fim, nesta ordem, em datas que existem', async () => {
    const recusas: [string, string][] = [
      [`from=${DOMINGO}&to=${SEGUNDA}`, 'O fim vem antes do início'],
      [`date=${SEGUNDA}&from=${SEGUNDA}&to=${DOMINGO}`, 'Use date ou from e to, não os dois'],
      [`date=${SEGUNDA}&to=${DOMINGO}`, 'Use date ou from e to, não os dois'],
      [`from=${SEGUNDA}`, 'Informe date, ou from e to'],
      [`to=${DOMINGO}`, 'Informe date, ou from e to'],
      [`patientId=${paciente}`, 'Informe date, ou from e to'],
      ['', 'Informe date, ou from e to'],
      [`from=2030-02-30&to=${DOMINGO}`, 'Data inexistente'],
      [`from=${SEGUNDA}&to=2030-11-4`, 'Use AAAA-MM-DD'],
      [`from=${SEGUNDA}&to=${DOMINGO}&patientId=nao-e-uuid`, 'Invalid UUID'],
    ];
    for (const [query, mensagem] of recusas) {
      const r = await get(`/api/clinics/appointments?${query}`, owner).expect(400);
      expect({
        query,
        mensagens: (r.body.issues as { message: string }[]).map((i) => i.message),
      }).toEqual({
        query,
        mensagens: expect.arrayContaining([expect.stringContaining(mensagem)]),
      });
    }
  });

  it('o teto do intervalo: até 2000 horários; acima, a rota RECUSA (422) em vez de cortar', async () => {
    // horários de 1 minuto, a cada 2, a partir da segunda 00:00 local (UTC−3)
    const inicio = Date.parse(`${SEGUNDA}T03:00:00Z`);
    const horario = (i: number) => ({
      workspaceId: wsA.workspaceId,
      patientId: paciente,
      professionalId: ana,
      serviceId: servico,
      unitId: unitA,
      startsAt: new Date(inicio + i * 120_000),
      endsAt: new Date(inicio + i * 120_000 + 60_000),
      createdByMembershipId: donoA,
    });
    await prisma.raw.clinicsAppointment.createMany({
      data: Array.from({ length: 2000 }, (_, i) => horario(i)),
    });
    expect(await lista(`from=${SEGUNDA}&to=${DOMINGO}`)).toHaveLength(2000);
    await prisma.raw.clinicsAppointment.create({ data: horario(2000) });
    const recusa = await get(
      `/api/clinics/appointments?from=${SEGUNDA}&to=${DOMINGO}`,
      owner,
    ).expect(422);
    expect(recusa.body.message).toMatch(/mais de 2000 horários/);
  });

  it('o recorte de campo: sem `clinics:care:read`, nem o vínculo nem o alcance saem, em nenhuma forma', async () => {
    const id = await agendar({ time: '09:00' });
    await post(`/api/clinics/appointments/${id}/attendance`, owner, AVULSO).expect(201);
    const doOwner = await lista(`patientId=${paciente}&from=${SEGUNDA}&to=${DOMINGO}`);
    expect(doOwner[0].attendanceId).toEqual(expect.any(String));
    expect(doOwner[0].careInScope).toBe(true);
    const recepcao = await loginAs('member-a@veyra.test');
    for (const query of [
      `from=${SEGUNDA}&to=${DOMINGO}`,
      `patientId=${paciente}&from=${SEGUNDA}&to=${DOMINGO}`,
      `patientId=${paciente}&date=${SEGUNDA}`,
    ]) {
      const visto = await lista(query, recepcao);
      expect(visto).toHaveLength(1);
      expect(visto[0]).not.toHaveProperty('attendanceId');
      expect(visto[0]).not.toHaveProperty('careInScope');
      expect(JSON.stringify(visto)).not.toContain(doOwner[0].attendanceId as string);
    }
    // o Guest não lê a agenda: 403 também no intervalo e por paciente
    const guest = await loginAs('guest-a@veyra.test');
    await get(`/api/clinics/appointments?from=${SEGUNDA}&to=${DOMINGO}`, guest).expect(403);
    await get(`/api/clinics/appointments?patientId=${paciente}&date=${SEGUNDA}`, guest).expect(403);
  });

  it('o alcance clínico (D8) no intervalo: o atendimento de outro profissional não sai nem como id', async () => {
    const membroProf = (await prisma.raw.membership.findFirst({
      where: { user: { email: 'prof-a@veyra.test' } },
    }))!.id;
    await put(`/api/clinics/professionals/${ana}/account`, owner, {
      membershipId: membroProf,
    }).expect(200);
    const deAna = await agendar({ time: '09:00' });
    const deBia = await agendar({ time: '09:00', professionalId: bia, patientId: outro });
    await post(`/api/clinics/appointments/${deAna}/attendance`, owner, AVULSO).expect(201);
    await post(`/api/clinics/appointments/${deBia}/attendance`, owner, AVULSO).expect(201);
    const prof = await loginAs('prof-a@veyra.test');
    const visto = await lista(`from=${SEGUNDA}&to=${DOMINGO}`, prof);
    const de = (id: string) => visto.find((a) => a.id === id)!;
    expect(de(deAna).careInScope).toBe(true);
    expect(de(deAna).attendanceId).toEqual(expect.any(String));
    expect(de(deBia)).toMatchObject({ careInScope: false, attendanceId: null });
    expect(await lista(`patientId=${outro}&from=${SEGUNDA}&to=${DOMINGO}`, prof)).toEqual([
      expect.objectContaining({ id: deBia, careInScope: false, attendanceId: null }),
    ]);
  });

  it('P0: B (com o Clinics ativo) não vê o intervalo nem o paciente de A, e A não vê os de B', async () => {
    const deA = await agendar({ time: '09:00' });
    await app.get(ClinicsActivationService).enable('beta');
    const donoB = await loginAs('owner-b@veyra.test');
    // B consulta com os ids de A: vazio, ou 404 para a unidade de A
    expect(await lista(`from=${SEGUNDA}&to=${DOMINGO}`, donoB)).toEqual([]);
    expect(await lista(`patientId=${paciente}&from=${SEGUNDA}&to=${DOMINGO}`, donoB)).toEqual([]);
    expect(await lista(`patientId=${paciente}&date=${SEGUNDA}`, donoB)).toEqual([]);
    expect(
      await lista(
        `patientId=${paciente}&professionalId=${ana}&from=${SEGUNDA}&to=${DOMINGO}`,
        donoB,
      ),
    ).toEqual([]);
    await get(
      `/api/clinics/appointments?patientId=${paciente}&unitId=${unitA}&from=${SEGUNDA}&to=${DOMINGO}`,
      donoB,
    ).expect(404);
    // um horário de B, no mesmo período: A não o vê, nem pelo id do paciente de B
    const wsBId = wsB.workspaceId;
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
    const deB = await prisma.raw.clinicsAppointment.create({
      data: {
        workspaceId: wsBId,
        patientId: pacienteB.id,
        professionalId: profB.id,
        serviceId: servB.id,
        unitId: unidadeB!.id,
        startsAt: new Date('2030-11-05T13:00:00Z'),
        endsAt: new Date('2030-11-05T13:30:00Z'),
        createdByMembershipId: membroB!.id,
      },
    });
    expect((await lista(`from=${SEGUNDA}&to=${DOMINGO}`)).map((a) => a.id)).toEqual([deA]);
    expect(await lista(`patientId=${pacienteB.id}&from=${SEGUNDA}&to=${DOMINGO}`)).toEqual([]);
    expect((await lista(`from=${SEGUNDA}&to=${DOMINGO}`, donoB)).map((a) => a.id)).toEqual([
      deB.id,
    ]);
  });
});
