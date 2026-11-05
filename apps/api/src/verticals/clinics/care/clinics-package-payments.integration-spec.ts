import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import request from 'supertest';
import {
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
  CLINICS_RECEPTION_CARE_SYSTEM_KEY,
  horaLocal,
  somarDias,
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

interface Session {
  cookieHeader: string;
  csrf: string;
}

/** Uma segunda-feira (São Paulo, sem horário de verão). */
const SEGUNDA = '2030-11-04';
const CHAVES = ['clinics:payments:read', 'clinics:payments:write', 'clinics:payments:void'];
const ACIMA = /passa do saldo do pacote/;
const CANCELADO = /Pacote cancelado não recebe pagamento novo/;
const JA_ANULADO = /já foi anulado/;

/**
 * F6.1a (ADR-063): pagamentos de pacotes, para Owner e Admin. Dados FICTÍCIOS.
 * As corridas são forçadas como na F5.2a: a primeira transação pausa na
 * auditoria, segurando a trava do pacote (do gatilho), e a segunda é vista
 * esperando a trava (`pg_stat_activity`), nunca por sono.
 */
describe('Clinics — pagamentos de pacotes (integração, F6.1a)', () => {
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
  let admin: Session;
  let recepcao: Session;
  let recepcaoAtendimento: Session;
  let profissional: Session;
  let convidado: Session;
  let ownerB: Session;
  let membroOwner: string;
  let membroAdmin: string;
  let servico: string;
  let ana: string;
  let paciente: string;
  let unitA: string;

  /** o que uma corrida deixa em aberto: soltos no afterEach, ou o jest não sai */
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
  /** Alguma sessão espera uma trava numa instrução sobre a tabela. */
  const alguemEspera = (tabela: string) =>
    ate(async () => {
      const { rows } = await observador.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
        [`%"${tabela}"%`],
      );
      return Number(rows[0].n) > 0;
    }, `alguém esperando a trava em ${tabela}`);
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
  /** Pausa a PRIMEIRA gravação de auditoria da ação: a transação fica aberta, segurando a trava. */
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

  /** A data local de hoje na unidade A, pelo relógio do banco. */
  const hojeNaUnidade = async () => {
    const unidade = await prisma.raw.clinicsUnit.findFirst({ where: { id: unitA } });
    const { rows } = await observador.query<{ agora: Date }>('SELECT now() AS agora');
    return horaLocal(rows[0].agora, unidade!.timezone).data;
  };
  let hoje: string;

  const criarPacote = async (body: Record<string, unknown> = {}) =>
    (
      await post('/api/clinics/packages', owner, {
        patientId: paciente,
        serviceId: servico,
        totalSessions: 3,
        totalPriceCents: 100_000,
        ...body,
      }).expect(201)
    ).body.id as string;
  const registrar = (
    pacote: string,
    body: Record<string, unknown> = {},
    s: Session = owner,
    chave: string | null = randomUUID(),
  ) => {
    const r = post(`/api/clinics/packages/${pacote}/payments`, s);
    if (chave) r.set('Idempotency-Key', chave);
    return r.send({ amountCents: 40_000, receivedOn: hoje, method: 'pix', ...body });
  };
  const anular = (
    pagamento: string,
    s: Session = owner,
    chave: string | null = randomUUID(),
    reason = 'wrong_amount',
  ) => {
    const r = post(`/api/clinics/package-payments/${pagamento}/void`, s);
    if (chave) r.set('Idempotency-Key', chave);
    return r.send({ reason });
  };
  const detalhe = async (pacote: string, s: Session = owner) =>
    (await get(`/api/clinics/packages/${pacote}/payments`, s).expect(200)).body;
  const pagamentos = () => prisma.raw.clinicsPackagePayment.count();
  const anulacoes = () => prisma.raw.clinicsPackagePaymentVoid.count();
  const linhaDoPacote = (id: string) => prisma.raw.clinicsPackage.findFirst({ where: { id } });

  let minuto = 0;
  const atendido = async (packageId: string | null) => {
    const time = `${String(8 + Math.floor(minuto / 60)).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}`;
    minuto += 60;
    const ag = (
      await post('/api/clinics/appointments', owner, {
        patientId: paciente,
        professionalId: ana,
        serviceId: servico,
        date: SEGUNDA,
        time,
      }).expect(201)
    ).body.id as string;
    await post(`/api/clinics/appointments/${ag}/attendance`, owner, { packageId }).expect(201);
    return ag;
  };

  beforeEach(async () => {
    minuto = 0;
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    for (const systemKey of ['owner', 'admin', 'member', 'guest']) {
      const user = await createUserFixture(prisma, `${systemKey}-a@veyra.test`);
      await createMembershipFixture(prisma, wsA.workspaceId, user, wsA.roles[systemKey]);
    }
    const userB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, userB, wsB.roles.owner);
    await app.get(ClinicsActivationService).enable('acme');
    await app.get(ClinicsActivationService).enable('beta');
    for (const [systemKey, email] of [
      [CLINICS_PROFESSIONAL_SYSTEM_KEY, 'prof-a@veyra.test'],
      [CLINICS_RECEPTION_CARE_SYSTEM_KEY, 'recat-a@veyra.test'],
    ]) {
      const papel = await prisma.raw.role.findFirst({
        where: { workspaceId: wsA.workspaceId, systemKey },
      });
      await createMembershipFixture(
        prisma,
        wsA.workspaceId,
        await createUserFixture(prisma, email),
        papel!.id,
      );
    }
    membroOwner = (await prisma.raw.membership.findFirst({
      where: { workspaceId: wsA.workspaceId, roleId: wsA.roles.owner },
    }))!.id;
    membroAdmin = (await prisma.raw.membership.findFirst({
      where: { workspaceId: wsA.workspaceId, roleId: wsA.roles.admin },
    }))!.id;

    owner = await loginAs('owner-a@veyra.test');
    admin = await loginAs('admin-a@veyra.test');
    recepcao = await loginAs('member-a@veyra.test');
    convidado = await loginAs('guest-a@veyra.test');
    profissional = await loginAs('prof-a@veyra.test');
    recepcaoAtendimento = await loginAs('recat-a@veyra.test');
    ownerB = await loginAs('owner-b@veyra.test');
    unitA = (await prisma.raw.clinicsUnit.findFirst({
      where: { workspaceId: wsA.workspaceId },
    }))!.id;
    hoje = await hojeNaUnidade();
    servico = (
      await post('/api/clinics/services', owner, {
        name: 'Limpeza de pele',
        durationMin: 60,
      }).expect(201)
    ).body.id;
    ana = (await post('/api/clinics/professionals', owner, { name: 'Ana Fictícia' }).expect(201))
      .body.id;
    await put(`/api/clinics/professionals/${ana}/profile`, owner, {
      name: 'Ana Fictícia',
      serviceIds: [servico],
      intervals: [1, 2, 3, 4, 5].map((weekday) => ({
        unitId: unitA,
        weekday,
        startMinute: 480,
        endMinute: 1320,
      })),
    }).expect(200);
    const contato = (await post('/api/contacts', owner, { name: 'Paciente Fictícia' }).expect(201))
      .body.id;
    paciente = (await post('/api/clinics/patients', owner, { contactId: contato }).expect(201)).body
      .id;
  });

  // ── Registrar, saldo e estados ──────────────────────────────────────────

  describe('registrar e o saldo', () => {
    it('parcial e integral: o recebido soma, o saldo desce a zero; autoria e instante do banco', async () => {
      const p = await criarPacote();
      const antes = (await observador.query<{ agora: Date }>('SELECT now() AS agora')).rows[0]
        .agora;
      const parcial = await registrar(p, { amountCents: 40_000, method: 'cash' }).expect(201);
      expect(parcial.body).toMatchObject({
        packageId: p,
        amountCents: 40_000,
        currency: 'BRL',
        receivedOn: hoje,
        method: 'cash',
        createdBy: { membershipId: membroOwner },
        void: null,
      });
      expect(parcial.body.createdBy.name).not.toBe('');
      expect(new Date(parcial.body.createdAt).getTime()).toBeGreaterThanOrEqual(
        antes.getTime() - 1000,
      );
      let d = await detalhe(p);
      expect(d.package).toMatchObject({ receivedCents: 40_000, balanceCents: 60_000 });
      expect(d.today).toBe(hoje);
      await registrar(p, { amountCents: 60_000 }, admin).expect(201);
      d = await detalhe(p);
      expect(d.package).toMatchObject({
        receivedCents: 100_000,
        balanceCents: 0,
        serviceName: 'Limpeza de pele',
      });
      expect(d.payments.map((x: { amountCents: number }) => x.amountCents)).toEqual([
        60_000, 40_000,
      ]);
      expect(d.payments[0].createdBy.membershipId).toBe(membroAdmin);
      // a visão financeira não traz sessões, atendimentos nem correções
      expect(Object.keys(d.package).sort()).toEqual(
        [
          'packageId',
          'patientId',
          'serviceId',
          'serviceName',
          'status',
          'totalPriceCents',
          'currency',
          'receivedCents',
          'balanceCents',
          'createdAt',
        ].sort(),
      );
      const lista = (
        await get(`/api/clinics/patients/${paciente}/package-payments`, owner).expect(200)
      ).body;
      expect(lista).toEqual([d.package]);
      // a trilha: o fato e o valor, sem nada do paciente
      const trilha = await prisma.raw.auditLog.findMany({
        where: { action: 'clinics.package.payment_recorded' },
      });
      expect(trilha).toHaveLength(2);
      expect(trilha.find((t) => t.entityId === parcial.body.id)?.after).toEqual({
        packageId: p,
        amountCents: 40_000,
        currency: 'BRL',
        receivedOn: hoje,
        method: 'cash',
      });
    });

    it('acima do saldo: 409, sem efeito; valor zero ou negativo e data inexistente: 400', async () => {
      const p = await criarPacote();
      await registrar(p, { amountCents: 70_000 }).expect(201);
      const r = await registrar(p, { amountCents: 30_001 }).expect(409);
      expect(r.body.message).toMatch(ACIMA);
      for (const amountCents of [0, -1, 1.5]) await registrar(p, { amountCents }).expect(400);
      await registrar(p, { receivedOn: '2026-02-30' }).expect(400);
      await registrar(p, { method: 'boleto' }).expect(400);
      expect(await pagamentos()).toBe(1);
    });

    it('a data futura no fuso da UNIDADE: 400; a mesma data, com a unidade num fuso à frente, é hoje', async () => {
      const p = await criarPacote();
      // UTC−11 e UTC+14: as datas locais sempre diferem
      await prisma.raw.clinicsUnit.updateMany({
        where: { id: unitA },
        data: { timezone: 'Pacific/Pago_Pago' },
      });
      const atras = await hojeNaUnidade();
      const amanha = somarDias(atras, 1);
      const r = await registrar(p, { receivedOn: amanha }).expect(400);
      expect(r.body.message).toMatch(/não pode ser futura/);
      await prisma.raw.clinicsUnit.updateMany({
        where: { id: unitA },
        data: { timezone: 'Pacific/Kiritimati' },
      });
      const frente = await hojeNaUnidade();
      expect(frente > atras).toBe(true);
      // o painel recebe o hoje e o fuso da MESMA unidade (os instantes na hora dela)
      expect(await detalhe(p)).toMatchObject({ today: frente, timezone: 'Pacific/Kiritimati' });
      await registrar(p, { receivedOn: frente, amountCents: 1 }).expect(201);
      await registrar(p, { receivedOn: somarDias(frente, 1), amountCents: 1 }).expect(400);
      // uma data anterior vale
      await registrar(p, { receivedOn: '2026-01-15', amountCents: 1 }).expect(201);
      expect(await pagamentos()).toBe(2);
    });

    it('sem exatamente uma unidade ativa: o painel vem sem hoje e sem fuso, e o registro é recusado (400)', async () => {
      const p = await criarPacote();
      await prisma.raw.clinicsUnit.updateMany({
        where: { id: unitA },
        data: { archivedAt: new Date() },
      });
      expect(await detalhe(p)).toMatchObject({ today: null, timezone: null });
      const r = await registrar(p).expect(400);
      expect(r.body.message).toMatch(/exatamente uma unidade ativa/);
      expect(await pagamentos()).toBe(0);
    });

    it('pacote sem preço: aceita qualquer valor, e o saldo não é calculável', async () => {
      const p = await criarPacote({ totalPriceCents: null });
      await registrar(p, { amountCents: 5_000_000 }).expect(201);
      const d = await detalhe(p);
      expect(d.package).toMatchObject({
        totalPriceCents: null,
        receivedCents: 5_000_000,
        balanceCents: null,
      });
    });

    it('pacote cancelado: recusa registrar (409) e aceita anular; concluído aceita registrar', async () => {
      const p = await criarPacote();
      const pago = (await registrar(p).expect(201)).body.id;
      await post(`/api/clinics/packages/${p}/cancel`, owner).expect(201);
      const r = await registrar(p).expect(409);
      expect(r.body.message).toMatch(CANCELADO);
      await anular(pago).expect(201);
      expect(await pagamentos()).toBe(1);
      const q = await criarPacote({ totalSessions: 1 });
      await atendido(q);
      expect((await linhaDoPacote(q))?.status).toBe('completed');
      await registrar(q).expect(201);
    });

    it('o pagamento e a anulação não mudam o pacote nem as sessões', async () => {
      const p = await criarPacote();
      await atendido(p);
      const antes = await linhaDoPacote(p);
      const atendimentos = await prisma.raw.clinicsAttendance.findMany();
      const pago = (await registrar(p).expect(201)).body.id;
      await anular(pago).expect(201);
      expect(await linhaDoPacote(p)).toEqual(antes);
      expect(await prisma.raw.clinicsAttendance.findMany()).toEqual(atendimentos);
    });
  });

  // ── Anular ──────────────────────────────────────────────────────────────

  describe('anular', () => {
    it('a anulação preserva o original, marca quem e quando, e libera o saldo', async () => {
      const p = await criarPacote();
      const pago = (await registrar(p, { amountCents: 100_000 }).expect(201)).body;
      await registrar(p, { amountCents: 1 }).expect(409);
      const anulado = (await anular(pago.id, admin, randomUUID(), 'duplicate').expect(201)).body;
      expect(anulado).toMatchObject({
        id: pago.id,
        amountCents: 100_000,
        createdBy: { membershipId: membroOwner },
        void: { reason: 'duplicate', voidedBy: { membershipId: membroAdmin } },
      });
      const d = await detalhe(p);
      expect(d.package).toMatchObject({ receivedCents: 0, balanceCents: 100_000 });
      expect(d.payments).toHaveLength(1);
      expect(d.payments[0].void.reason).toBe('duplicate');
      // o certo, depois
      await registrar(p, { amountCents: 90_000 }).expect(201);
      expect((await detalhe(p)).package).toMatchObject({ receivedCents: 90_000 });
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.package.payment_voided' },
      });
      expect(trilha?.after).toEqual({ paymentId: pago.id, packageId: p, reason: 'duplicate' });
    });

    it('anular duas vezes: 409, uma só anulação; motivo fora da lista: 400', async () => {
      const p = await criarPacote();
      const pago = (await registrar(p).expect(201)).body.id;
      await anular(pago).expect(201);
      const r = await anular(pago).expect(409);
      expect(r.body.message).toMatch(JA_ANULADO);
      await anular(pago, owner, randomUUID(), 'refund').expect(400);
      expect(await anulacoes()).toBe(1);
    });

    it('o banco: o pagamento e a anulação não mudam nem são apagados; a anulação é única', async () => {
      const p = await criarPacote();
      const pago = (await registrar(p).expect(201)).body.id;
      await anular(pago).expect(201);
      await expect(
        observador.query(`UPDATE "ClinicsPackagePayment" SET "amountCents" = 1 WHERE id = $1`, [
          pago,
        ]),
      ).rejects.toThrow(/não mudam nem são apagados/);
      await expect(
        observador.query(`DELETE FROM "ClinicsPackagePaymentVoid" WHERE "paymentId" = $1`, [pago]),
      ).rejects.toThrow(/não mudam nem são apagados/);
      await expect(
        observador.query(
          `INSERT INTO "ClinicsPackagePaymentVoid" (id, "workspaceId", "paymentId", reason, "voidedByMembershipId")
           VALUES (gen_random_uuid(), $1, $2, 'duplicate', $3)`,
          [wsA.workspaceId, pago, membroOwner],
        ),
      ).rejects.toThrow(/ClinicsPackagePaymentVoid_workspaceId_paymentId_key/);
      // o client protegido também recusa (append-only), antes do banco
      const cls = app.get(ClsService);
      for (const tentar of [
        () =>
          prisma.db.clinicsPackagePayment.updateMany({
            where: { id: pago },
            data: { amountCents: 2 },
          }),
        () => prisma.db.clinicsPackagePaymentVoid.deleteMany({ where: { paymentId: pago } }),
      ]) {
        await expect(
          cls.run(async () => {
            cls.set('workspaceId', wsA.workspaceId);
            return await tentar();
          }),
        ).rejects.toThrow(/é append-only/);
      }
      expect((await detalhe(p)).payments[0].amountCents).toBe(40_000);
    });
  });

  // ── Concorrência ────────────────────────────────────────────────────────

  describe('concorrência (ordem forçada)', () => {
    it('dois registros simultâneos não passam do preço: o segundo espera a trava do pacote e recebe 409', async () => {
      const p = await criarPacote();
      const { chegou, segue } = pausarNaAuditoria('clinics.package.payment_recorded');
      const primeiro = disparar(registrar(p, { amountCents: 60_000 }));
      await chegou.aberto;
      const segundo = disparar(registrar(p, { amountCents: 60_000 }, admin));
      await alguemEspera('ClinicsPackagePayment');
      segue.abrir();
      expect((await primeiro).status).toBe(201);
      const r = await segundo;
      expect(r.status).toBe(409);
      expect(r.body.message).toMatch(ACIMA);
      expect(await pagamentos()).toBe(1);
      expect((await detalhe(p)).package.receivedCents).toBe(60_000);
    });

    it('duas anulações simultâneas do mesmo pagamento: a segunda espera e recebe 409; uma só', async () => {
      const p = await criarPacote();
      const pago = (await registrar(p).expect(201)).body.id;
      const { chegou, segue } = pausarNaAuditoria('clinics.package.payment_voided');
      const primeira = disparar(anular(pago));
      await chegou.aberto;
      const segunda = disparar(anular(pago, admin));
      await alguemEspera('ClinicsPackagePaymentVoid');
      segue.abrir();
      expect((await primeira).status).toBe(201);
      const r = await segunda;
      expect(r.status).toBe(409);
      expect(r.body.message).toMatch(JA_ANULADO);
      expect(await anulacoes()).toBe(1);
    });
  });

  // ── Repetição ───────────────────────────────────────────────────────────

  describe('a repetição: Idempotency-Key obrigatória', () => {
    it('sem a chave: 400, sem efeito', async () => {
      const p = await criarPacote();
      await registrar(p, {}, owner, null).expect(400);
      expect(await pagamentos()).toBe(0);
      const pago = (await registrar(p).expect(201)).body.id;
      await anular(pago, owner, null).expect(400);
      expect(await anulacoes()).toBe(0);
    });

    it('registrar e anular com a mesma chave: o mesmo resultado, sem duplicar', async () => {
      const p = await criarPacote();
      const chave = randomUUID();
      const primeiro = await registrar(p, {}, owner, chave).expect(201);
      const repetido = await registrar(p, {}, owner, chave).expect(201);
      expect(repetido.headers['idempotent-replay']).toBe('true');
      expect(repetido.body).toEqual(primeiro.body);
      expect(await pagamentos()).toBe(1);
      const chaveDaAnulacao = randomUUID();
      const anulado = await anular(primeiro.body.id, owner, chaveDaAnulacao).expect(201);
      const anuladoDeNovo = await anular(primeiro.body.id, owner, chaveDaAnulacao).expect(201);
      expect(anuladoDeNovo.headers['idempotent-replay']).toBe('true');
      expect(anuladoDeNovo.body).toEqual(anulado.body);
      expect(await anulacoes()).toBe(1);
    });

    it('o replay confere o acesso de AGORA: sem a chave do papel, 403, e o corpo guardado não sai', async () => {
      const p = await criarPacote();
      const chave = randomUUID();
      const primeiro = await registrar(p, {}, admin, chave).expect(201);
      const chaveDaAnulacao = randomUUID();
      await anular(primeiro.body.id, admin, chaveDaAnulacao).expect(201);
      await prisma.raw.rolePermission.deleteMany({
        where: { roleId: wsA.roles.admin, permissionKey: { in: CHAVES } },
      });
      const r = await registrar(p, {}, admin, chave).expect(403);
      expect(JSON.stringify(r.body)).not.toContain(primeiro.body.id);
      expect(r.headers['idempotent-replay']).toBeUndefined();
      const v = await anular(primeiro.body.id, admin, chaveDaAnulacao).expect(403);
      expect(v.headers['idempotent-replay']).toBeUndefined();
      expect(await pagamentos()).toBe(1);
    });
  });

  // ── Permissões, distribuição e isolamento ─────────────────────────────────

  describe('permissões e isolamento', () => {
    it('Owner e Admin sim; Member, "Recepção e atendimento", Profissional e Guest: 403 em tudo', async () => {
      const p = await criarPacote();
      const pago = (await registrar(p).expect(201)).body.id;
      for (const s of [owner, admin]) {
        await get(`/api/clinics/patients/${paciente}/package-payments`, s).expect(200);
        await get(`/api/clinics/packages/${p}/payments`, s).expect(200);
      }
      for (const s of [recepcao, recepcaoAtendimento, profissional, convidado]) {
        await get(`/api/clinics/patients/${paciente}/package-payments`, s).expect(403);
        await get(`/api/clinics/packages/${p}/payments`, s).expect(403);
        await registrar(p, { amountCents: 1 }, s).expect(403);
        await anular(pago, s).expect(403);
      }
      expect(await pagamentos()).toBe(1);
      expect(await anulacoes()).toBe(0);
    });

    it('a distribuição: as três chaves SÓ em Owner e Admin; o livro preenche e a chave revogada não volta', async () => {
      const comChave = async (chave: string) =>
        (
          await prisma.raw.role.findMany({
            where: {
              workspaceId: wsA.workspaceId,
              permissions: { some: { permissionKey: chave } },
            },
            select: { systemKey: true },
          })
        )
          .map((r) => r.systemKey)
          .sort();
      for (const chave of CHAVES) expect(await comChave(chave)).toEqual(['admin', 'owner']);
      // um workspace anterior às chaves: o preenchimento as dá a Owner e Admin
      await prisma.raw.rolePermission.deleteMany({
        where: { workspaceId: wsA.workspaceId, permissionKey: { in: CHAVES } },
      });
      await prisma.raw.permissionBackfill.deleteMany({
        where: { workspaceId: wsA.workspaceId, permissionKey: { in: CHAVES } },
      });
      await get(`/api/clinics/patients/${paciente}/package-payments`, owner).expect(403);
      await app.get(ClinicsActivationService).preencherChavesNovas();
      for (const chave of CHAVES) expect(await comChave(chave)).toEqual(['admin', 'owner']);
      await get(`/api/clinics/patients/${paciente}/package-payments`, owner).expect(200);
      // o workspace tira do Admin: a próxima passada não devolve
      await prisma.raw.rolePermission.deleteMany({
        where: { roleId: wsA.roles.admin, permissionKey: 'clinics:payments:void' },
      });
      await app.get(ClinicsActivationService).preencherChavesNovas();
      expect(await comChave('clinics:payments:void')).toEqual(['owner']);
    });

    it('outro workspace: paciente, pacote e pagamento de A não existem para B (404), e nada muda', async () => {
      const p = await criarPacote();
      const pago = (await registrar(p).expect(201)).body.id;
      await get(`/api/clinics/patients/${paciente}/package-payments`, ownerB).expect(404);
      await get(`/api/clinics/packages/${p}/payments`, ownerB).expect(404);
      await registrar(p, { amountCents: 1 }, ownerB).expect(404);
      await anular(pago, ownerB).expect(404);
      expect(await pagamentos()).toBe(1);
      expect(await anulacoes()).toBe(0);
    });
  });
});
