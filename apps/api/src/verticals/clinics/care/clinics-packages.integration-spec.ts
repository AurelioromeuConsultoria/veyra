import type { INestApplication } from '@nestjs/common';
import { request as pedidoCru } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
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

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

/** Uma segunda-feira (São Paulo, sem horário de verão). */
const SEGUNDA = '2030-11-04';

function portao() {
  let abrir!: () => void;
  const aberto = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { aberto, abrir };
}

/**
 * F3.1 do ADR-048 (adendo 7): pacote de sessões e consumo explícito no
 * registro de atendimento. Dados FICTÍCIOS. As corridas são forçadas: a
 * primeira transação pausa depois de travar a linha do pacote, e a segunda é
 * comprovadamente vista esperando a trava (`pg_stat_activity`), nunca por sono.
 */
describe('Clinics — pacote de sessões e consumo no atendimento (integração, F3.1)', () => {
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
  let servico: string;
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
  // sem `body`, a requisição vai SEM corpo, como o `api.post(path)` da tela: o
  // helper que sempre mandava `{}` escondeu a regressão da b48/b49
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
  /** Alguma sessão está esperando uma trava numa instrução sobre o pacote. */
  const alguemEsperaOPacote = () =>
    ate(async () => {
      const { rows } = await observador.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%ClinicsPackage%'`,
      );
      return Number(rows[0].n) > 0;
    }, 'alguém esperando a trava do pacote');

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
        date: SEGUNDA,
        time,
        ...body,
      }).expect(201)
    ).body.id as string;
  };
  const criarPacote = async (body: Record<string, unknown> = {}, s: Session = owner) =>
    (
      await post('/api/clinics/packages', s, {
        patientId: paciente,
        serviceId: servico,
        totalSessions: 3,
        ...body,
      }).expect(201)
    ).body as {
      id: string;
      consumedSessions: number;
      remainingSessions: number;
      totalPriceCents: number | null;
      currency: string;
      status: string;
    };
  const atender = (agendamento: string, packageId?: string | null, s: Session = owner) =>
    post(
      `/api/clinics/appointments/${agendamento}/attendance`,
      s,
      packageId === undefined ? {} : { packageId },
    );
  const pacote = (id: string) => prisma.raw.clinicsPackage.findFirst({ where: { id } });
  const estadoDo = async (agendamento: string) =>
    (await prisma.raw.clinicsAppointment.findFirst({ where: { id: agendamento } }))?.status;
  /** A igualdade que o caminho único de escrita sustenta: consumidas = atendimentos vinculados. */
  const igualdadeVale = async () => {
    const { rows } = await observador.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "ClinicsPackage" p
        WHERE p."consumedSessions" <> (SELECT count(*) FROM "ClinicsAttendance" a
                                         WHERE a."workspaceId" = p."workspaceId"
                                           AND a."packageId" = p."id")`,
    );
    return Number(rows[0].n) === 0;
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
    for (const systemKey of ['owner', 'member', 'guest']) {
      const user = await createUserFixture(prisma, `${systemKey}-a@veyra.test`);
      await createMembershipFixture(prisma, wsA.workspaceId, user, wsA.roles[systemKey]);
    }
    const userB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, userB, wsB.roles.owner);
    await app.get(ClinicsActivationService).enable('acme');
    await app.get(ClinicsActivationService).enable('beta');
    const papelProfissional = await prisma.raw.role.findFirst({
      where: { workspaceId: wsA.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
    });
    const prof = await createUserFixture(prisma, 'prof-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, prof, papelProfissional!.id);

    owner = await loginAs('owner-a@veyra.test');
    recepcao = await loginAs('member-a@veyra.test');
    profissional = await loginAs('prof-a@veyra.test');
    ownerB = await loginAs('owner-b@veyra.test');
    const unitA = (await prisma.raw.clinicsUnit.findFirst({
      where: { workspaceId: wsA.workspaceId },
    }))!.id;
    servico = (
      await post('/api/clinics/services', owner, {
        name: 'Limpeza de pele',
        durationMin: 60,
        priceCents: 15000,
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

  // ── O pacote ──────────────────────────────────────────────────────────────

  describe('o pacote', () => {
    it('nasce ativo com zero consumidas; o preço é o TOTAL digitado, e ausente é "não informado" (null), nunca zero; a moeda vem do serviço', async () => {
      const semPreco = await criarPacote();
      expect(semPreco).toMatchObject({
        consumedSessions: 0,
        remainingSessions: 3,
        totalPriceCents: null,
        currency: 'BRL',
        status: 'active',
      });
      const comPreco = await criarPacote({ totalPriceCents: 39000 });
      expect(comPreco.totalPriceCents).toBe(39000);
      // o zero só existe quando digitado
      const zero = await criarPacote({ totalPriceCents: 0 });
      expect(zero.totalPriceCents).toBe(0);
      // a trilha registra só que existe preço, nunca o valor
      const trilhas = await prisma.raw.auditLog.findMany({
        where: { workspaceId: wsA.workspaceId, action: 'clinics.package.created' },
        orderBy: { createdAt: 'asc' },
      });
      expect(trilhas.map((t) => (t.after as Record<string, unknown>).hasPrice)).toEqual([
        false,
        true,
        true,
      ]);
      expect(JSON.stringify(trilhas.map((t) => t.after))).not.toContain('39000');
    });

    it('regras da criação: paciente e serviço existentes, serviço ativo, total de 1 a 100, sem campo a mais', async () => {
      await post('/api/clinics/packages', owner, {
        patientId: paciente,
        serviceId: servico,
        totalSessions: 0,
      }).expect(400);
      await post('/api/clinics/packages', owner, {
        patientId: paciente,
        serviceId: servico,
        totalSessions: 101,
      }).expect(400);
      await post('/api/clinics/packages', owner, {
        patientId: paciente,
        serviceId: servico,
        totalSessions: 2,
        consumedSessions: 1,
      }).expect(400);
      await post('/api/clinics/packages', owner, {
        patientId: '00000000-0000-4000-8000-000000000000',
        serviceId: servico,
        totalSessions: 2,
      }).expect(404);
      await post(`/api/clinics/services/${outroServico}/archive`, owner).expect(201);
      await post('/api/clinics/packages', owner, {
        patientId: paciente,
        serviceId: outroServico,
        totalSessions: 2,
      }).expect(409);
    });
  });

  // ── O consumo ─────────────────────────────────────────────────────────────

  describe('o consumo explícito no registro de atendimento', () => {
    it('com o pacote: consome UMA sessão, na mesma transação, com o vínculo e a trilha; sem ele, o atendimento é avulso', async () => {
      const p = await criarPacote({ totalSessions: 2 });
      const comPacote = await agendar();
      const r = await atender(comPacote, p.id).expect(201);
      expect(r.body.packageId).toBe(p.id);
      expect((await pacote(p.id))?.consumedSessions).toBe(1);
      const avulso = await agendar();
      expect((await atender(avulso).expect(201)).body.packageId).toBeNull();
      expect((await pacote(p.id))?.consumedSessions).toBe(1);
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.attendance.recorded', entityId: r.body.id },
      });
      expect((trilha?.after as Record<string, unknown>).packageId).toBe(p.id);
      expect(await igualdadeVale()).toBe(true);
    });

    it('a ÚLTIMA sessão conclui o pacote na mesma instrução; depois, ele recusa consumo (409) sem registrar atendimento', async () => {
      const p = await criarPacote({ totalSessions: 1 });
      await atender(await agendar(), p.id).expect(201);
      const depois = await pacote(p.id);
      expect([depois?.status, depois?.consumedSessions, depois?.closedAt]).toEqual([
        'completed',
        1,
        expect.any(Date),
      ]);
      // a conclusão entra na trilha do pacote, uma vez
      const conclusoes = await prisma.raw.auditLog.findMany({
        where: { action: 'clinics.package.completed', entityId: p.id },
      });
      expect(conclusoes.map((t) => (t.after as Record<string, unknown>).status)).toEqual([
        'completed',
      ]);
      const outro = await agendar();
      await atender(outro, p.id).expect(409);
      expect(await estadoDo(outro)).toBe('scheduled');
      expect(await prisma.raw.clinicsAttendance.count({ where: { appointmentId: outro } })).toBe(0);
      expect(await igualdadeVale()).toBe(true);
    });

    it('pacote de OUTRO paciente ou de OUTRO serviço: 400; inexistente: 404 — nada é registrado', async () => {
      const deOutroPaciente = await criarPacote({ patientId: outroPaciente });
      const deOutroServico = await criarPacote({ serviceId: outroServico });
      const ag = await agendar();
      await atender(ag, deOutroPaciente.id).expect(400);
      await atender(ag, deOutroServico.id).expect(400);
      await atender(ag, '00000000-0000-4000-8000-000000000000').expect(404);
      expect(await estadoDo(ag)).toBe('scheduled');
      expect(await prisma.raw.clinicsAttendance.count()).toBe(0);
      expect((await pacote(deOutroPaciente.id))?.consumedSessions).toBe(0);
    });

    it('pacote CANCELADO recusa consumo (409), e o atendimento não é registrado', async () => {
      const p = await criarPacote();
      await post(`/api/clinics/packages/${p.id}/cancel`, owner).expect(201);
      const ag = await agendar();
      await atender(ag, p.id).expect(409);
      expect(await estadoDo(ag)).toBe('scheduled');
      expect(await prisma.raw.clinicsAttendance.count()).toBe(0);
    });

    it('ROLLBACK: uma falha depois do incremento desfaz tudo — nem atendimento, nem vínculo, nem incremento, nem trilha, nem o `attended`', async () => {
      const p = await criarPacote();
      const ag = await agendar();
      const audit = app.get(AuditService);
      const real = audit.record.bind(audit);
      jest.spyOn(audit, 'record').mockImplementation(async (db, ws, action, input) => {
        if (action === 'clinics.attendance.recorded') throw new Error('falha simulada');
        return real(db, ws, action, input);
      });
      await atender(ag, p.id).expect(500);
      jest.restoreAllMocks();
      expect((await pacote(p.id))?.consumedSessions).toBe(0);
      expect(await estadoDo(ag)).toBe('scheduled');
      expect(await prisma.raw.clinicsAttendance.count()).toBe(0);
      expect(
        await prisma.raw.auditLog.count({ where: { action: 'clinics.attendance.recorded' } }),
      ).toBe(0);
      expect(await igualdadeVale()).toBe(true);
    });
  });

  // ── O transporte do corpo (HTTP real) ─────────────────────────────────────

  describe('o transporte do corpo, por HTTP real (ADR-048 adendo 7, ajustes da liberação)', () => {
    type Resposta = { status: number; corpo: string; conexao?: string };
    /**
     * Um POST pelo transporte REAL, com os cabeçalhos exatos: `Content-Length`
     * calculado, ou `chunked` (que o supertest não manda), e o corpo em bytes.
     */
    const cru = (
      agendamento: string,
      opcoes: { headers?: Record<string, string>; corpo?: string; chunked?: boolean } = {},
    ) =>
      new Promise<Resposta>((resolve, reject) => {
        const headers: Record<string, string> = {
          Origin: ORIGIN,
          Cookie: owner.cookieHeader,
          'x-csrf-token': owner.csrf,
          ...opcoes.headers,
        };
        if (opcoes.chunked) headers['Transfer-Encoding'] = 'chunked';
        else headers['Content-Length'] = String(Buffer.byteLength(opcoes.corpo ?? ''));
        const r = pedidoCru(
          {
            host: '127.0.0.1',
            port: (http.address() as AddressInfo).port,
            method: 'POST',
            path: `/api/clinics/appointments/${agendamento}/attendance`,
            headers,
          },
          (res) => {
            let corpo = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => (corpo += c));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, corpo, conexao: res.headers.connection }),
            );
          },
        );
        r.on('error', reject);
        if (opcoes.corpo) r.write(opcoes.corpo);
        r.end();
      });
    const json = { 'Content-Type': 'application/json' };
    /** Nenhum efeito: nem atendimento, nem transição, nem consumo, nem trilha de sucesso. */
    const semEfeito = async (agendamento: string, antes: unknown, pacoteId: string) => {
      expect(await estadoDo(agendamento)).toBe(antes);
      expect(await prisma.raw.clinicsAttendance.count()).toBe(0);
      expect((await pacote(pacoteId))?.consumedSessions).toBe(0);
      expect(
        await prisma.raw.auditLog.count({
          where: {
            action: { in: ['clinics.attendance.recorded', 'clinics.package.completed'] },
          },
        }),
      ).toBe(0);
    };

    it('VAZIO de verdade, por `Content-Length: 0` (a tela) ou por `chunked` sem nenhum byte (um proxy): avulso, sem consumo', async () => {
      const p = await criarPacote();
      const pelaTela = await agendar();
      const peloProxy = await agendar();
      const a = await cru(pelaTela);
      expect(a.status).toBe(201);
      expect(JSON.parse(a.corpo).packageId).toBeNull();
      const b = await cru(peloProxy, { chunked: true });
      expect(b.status).toBe(201);
      expect(JSON.parse(b.corpo).packageId).toBeNull();
      expect((await pacote(p.id))?.consumedSessions).toBe(0);
      const registros = await prisma.raw.clinicsAttendance.findMany({
        where: { appointmentId: { in: [pelaTela, peloProxy] } },
      });
      expect(registros.map((r) => r.packageId)).toEqual([null, null]);
      expect(await igualdadeVale()).toBe(true);
    });

    it('`chunked` COM bytes e sem `Content-Type` — inclusive a escolha de um pacote, ou um byte só — é recusado (415), sem efeito nenhum', async () => {
      const p = await criarPacote();
      const ag = await agendar();
      const antes = await estadoDo(ag);
      const escolha = await cru(ag, { chunked: true, corpo: JSON.stringify({ packageId: p.id }) });
      expect(escolha.status).toBe(415);
      expect(escolha.corpo).not.toContain(p.id);
      // o resto do corpo não foi lido: a conexão não serve para outro pedido
      expect(escolha.conexao).toBe('close');
      expect((await cru(ag, { chunked: true, corpo: ' ' })).status).toBe(415);
      await semEfeito(ag, antes, p.id);
    });

    it('a conexão que CAI depois dos cabeçalhos `chunked`, sem byte nenhum, não prova o vazio: nada é registrado', async () => {
      const p = await criarPacote();
      const ag = await agendar();
      const antes = await estadoDo(ag);
      await new Promise<void>((resolve, reject) => {
        const s = connect((http.address() as AddressInfo).port, '127.0.0.1', () => {
          s.write(
            `POST /api/clinics/appointments/${ag}/attendance HTTP/1.1\r\n` +
              `Host: 127.0.0.1\r\nOrigin: ${ORIGIN}\r\nCookie: ${owner.cookieHeader}\r\n` +
              `x-csrf-token: ${owner.csrf}\r\nTransfer-Encoding: chunked\r\n\r\n`,
          );
          // a camada já está esperando o corpo; o cliente some sem o `0\r\n\r\n`
          setTimeout(() => {
            s.destroy();
            resolve();
          }, 100);
        });
        s.on('error', reject);
      });
      // aceitar a queda como vazio registraria em poucos ms; a janela dá folga
      await new Promise((r) => setTimeout(r, 1000));
      await semEfeito(ag, antes, p.id);
      // e o mesmo agendamento segue aceitando o pedido vazio de verdade
      expect((await cru(ag)).status).toBe(201);
    });

    it('JSON válido com o pacote, pelo transporte real (com `Content-Length` ou `chunked`): consumo explícito', async () => {
      const p = await criarPacote();
      const ag1 = await agendar();
      const ag2 = await agendar();
      const comTamanho = await cru(ag1, {
        headers: json,
        corpo: JSON.stringify({ packageId: p.id }),
      });
      expect(comTamanho.status).toBe(201);
      expect(JSON.parse(comTamanho.corpo).packageId).toBe(p.id);
      const emPedacos = await cru(ag2, {
        headers: json,
        chunked: true,
        corpo: JSON.stringify({ packageId: p.id }),
      });
      expect(emPedacos.status).toBe(201);
      expect((await pacote(p.id))?.consumedSessions).toBe(2);
      expect(await igualdadeVale()).toBe(true);
    });

    it('corpo inválido ou de tipo não suportado: recusado, sem efeito nenhum; depois, o pedido válido passa', async () => {
      const p = await criarPacote();
      const ag = await agendar();
      const antes = await estadoDo(ag);
      const escolha = JSON.stringify({ packageId: p.id });
      // JSON inválido: o parser recusa (400)
      expect((await cru(ag, { headers: json, corpo: '{"packageId":' })).status).toBe(400);
      expect((await cru(ag, { headers: json, corpo: 'null' })).status).toBe(400);
      // JSON que fere o contrato: o pipe recusa (400)
      expect(
        (await cru(ag, { headers: json, corpo: JSON.stringify({ packageId: p.id, sessao: 1 }) }))
          .status,
      ).toBe(400);
      expect((await cru(ag, { headers: json, corpo: '{"packageId":"nao-e-uuid"}' })).status).toBe(
        400,
      );
      // tipo que ninguém interpreta: 415
      for (const tipo of ['text/plain', 'application/x-www-form-urlencoded', 'application/xml']) {
        expect((await cru(ag, { headers: { 'Content-Type': tipo }, corpo: escolha })).status).toBe(
          415,
        );
      }
      // bytes sem tipo nenhum, com tamanho declarado: 415
      expect((await cru(ag, { corpo: escolha })).status).toBe(415);
      await semEfeito(ag, antes, p.id);
      // o agendamento ficou intacto: o pedido válido registra e consome
      expect((await cru(ag, { headers: json, corpo: escolha })).status).toBe(201);
      expect((await pacote(p.id))?.consumedSessions).toBe(1);
    });
  });

  // ── A repetição ───────────────────────────────────────────────────────────

  describe('a repetição', () => {
    it('o MESMO pedido devolve o registro existente, sem novo consumo — também com o pacote já concluído', async () => {
      const p = await criarPacote({ totalSessions: 1 });
      const ag = await agendar();
      const primeiro = (await atender(ag, p.id).expect(201)).body;
      expect((await pacote(p.id))?.status).toBe('completed');
      const repetido = (await atender(ag, p.id).expect(201)).body;
      expect(repetido.id).toBe(primeiro.id);
      expect((await pacote(p.id))?.consumedSessions).toBe(1);
      expect(await igualdadeVale()).toBe(true);
    });

    it('o id do pacote em MAIÚSCULAS é o mesmo pedido: a repetição devolve o registro, sem 409 nem novo consumo', async () => {
      const p = await criarPacote();
      const ag = await agendar();
      const primeiro = (await atender(ag, p.id.toUpperCase()).expect(201)).body;
      expect(primeiro.packageId).toBe(p.id);
      expect((await atender(ag, p.id.toUpperCase()).expect(201)).body.id).toBe(primeiro.id);
      expect((await atender(ag, p.id).expect(201)).body.id).toBe(primeiro.id);
      expect((await pacote(p.id))?.consumedSessions).toBe(1);
      expect(await igualdadeVale()).toBe(true);
    });

    it('o MESMO pedido funciona também com o pacote cancelado depois', async () => {
      const p = await criarPacote();
      const ag = await agendar();
      const primeiro = (await atender(ag, p.id).expect(201)).body;
      await post(`/api/clinics/packages/${p.id}/cancel`, owner).expect(201);
      expect((await atender(ag, p.id).expect(201)).body.id).toBe(primeiro.id);
      expect((await pacote(p.id))?.consumedSessions).toBe(1);
    });

    it('escolha DIFERENTE é 409, sem aplicar nada: avulso → pacote, pacote → avulso e pacote → outro pacote', async () => {
      const p1 = await criarPacote();
      const p2 = await criarPacote();
      const avulso = await agendar();
      await atender(avulso).expect(201);
      await atender(avulso, p1.id).expect(409);
      const comPacote = await agendar();
      await atender(comPacote, p1.id).expect(201);
      await atender(comPacote).expect(409);
      await atender(comPacote, null).expect(409);
      await atender(comPacote, p2.id).expect(409);
      expect((await pacote(p1.id))?.consumedSessions).toBe(1);
      expect((await pacote(p2.id))?.consumedSessions).toBe(0);
      const registros = await prisma.raw.clinicsAttendance.findMany({
        orderBy: { createdAt: 'asc' },
      });
      expect(registros.map((r) => r.packageId)).toEqual([null, p1.id]);
      expect(await igualdadeVale()).toBe(true);
    });

    it('registros SIMULTÂNEOS do mesmo pedido: um registro e UM consumo', async () => {
      const p = await criarPacote();
      const ag = await agendar();
      const respostas = await Promise.all([1, 2, 3].map(() => atender(ag, p.id)));
      expect(respostas.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(new Set(respostas.map((r) => r.body.id)).size).toBe(1);
      expect((await pacote(p.id))?.consumedSessions).toBe(1);
      expect(await igualdadeVale()).toBe(true);
    });
  });

  // ── As corridas ───────────────────────────────────────────────────────────

  describe('as corridas, com a ordem forçada', () => {
    it('o ÚLTIMO saldo disputado por dois agendamentos: um consome, o outro espera a trava e responde 409 sem registrar', async () => {
      const p = await criarPacote({ totalSessions: 1 });
      const a1 = await agendar();
      const a2 = await agendar();
      const pausa = pausarNaAuditoria('clinics.attendance.recorded');
      // `.then`: o supertest só dispara a requisição quando ela é aguardada
      const primeiro = atender(a1, p.id).then((r) => r);
      const segundoPedido = (async () => {
        await pausa.chegou.aberto; // o primeiro já consumiu e segura a linha
        return atender(a2, p.id).then((r) => r);
      })();
      try {
        await pausa.chegou.aberto;
        await alguemEsperaOPacote();
      } finally {
        pausa.segue.abrir();
      }
      expect((await primeiro).status).toBe(201);
      expect((await segundoPedido).status).toBe(409);
      expect((await pacote(p.id))?.status).toBe('completed');
      expect(await estadoDo(a2)).toBe('scheduled');
      expect(await prisma.raw.clinicsAttendance.count()).toBe(1);
      expect(await igualdadeVale()).toBe(true);
    });

    it('CONSUMO primeiro, na última sessão: o cancelamento espera e responde 409 — o pacote fica `completed`, nunca `canceled`', async () => {
      const p = await criarPacote({ totalSessions: 1 });
      const ag = await agendar();
      const pausa = pausarNaAuditoria('clinics.attendance.recorded');
      const consumo = atender(ag, p.id).then((r) => r);
      await pausa.chegou.aberto;
      const cancelou = post(`/api/clinics/packages/${p.id}/cancel`, owner).then((r) => r);
      try {
        await alguemEsperaOPacote();
      } finally {
        pausa.segue.abrir();
      }
      expect((await consumo).status).toBe(201);
      expect((await cancelou).status).toBe(409);
      expect((await pacote(p.id))?.status).toBe('completed');
      expect(await igualdadeVale()).toBe(true);
    });

    it('CONSUMO primeiro, com saldo sobrando: o cancelamento espera e comita depois, com as consumidas mantidas', async () => {
      const p = await criarPacote({ totalSessions: 3 });
      const ag = await agendar();
      const pausa = pausarNaAuditoria('clinics.attendance.recorded');
      const consumo = atender(ag, p.id).then((r) => r);
      await pausa.chegou.aberto;
      const cancelou = post(`/api/clinics/packages/${p.id}/cancel`, owner).then((r) => r);
      try {
        await alguemEsperaOPacote();
      } finally {
        pausa.segue.abrir();
      }
      expect((await consumo).status).toBe(201);
      expect((await cancelou).status).toBe(201);
      const depois = await pacote(p.id);
      expect([depois?.status, depois?.consumedSessions]).toEqual(['canceled', 1]);
      expect(await igualdadeVale()).toBe(true);
    });

    it('CANCELAMENTO primeiro: o consumo espera a trava e, depois do commit, falha (409) SEM registrar atendimento — o agendamento volta ao que era', async () => {
      const p = await criarPacote({ totalSessions: 3 });
      const ag = await agendar();
      const pausa = pausarNaAuditoria('clinics.package.canceled');
      const cancelamento = post(`/api/clinics/packages/${p.id}/cancel`, owner).then((r) => r);
      await pausa.chegou.aberto;
      const consumiu = atender(ag, p.id).then((r) => r);
      try {
        await alguemEsperaOPacote();
      } finally {
        pausa.segue.abrir();
      }
      expect((await cancelamento).status).toBe(201);
      expect((await consumiu).status).toBe(409);
      expect(await estadoDo(ag)).toBe('scheduled');
      expect(await prisma.raw.clinicsAttendance.count()).toBe(0);
      expect((await pacote(p.id))?.consumedSessions).toBe(0);
      expect(await igualdadeVale()).toBe(true);
    });

    it('cancelar de novo um pacote cancelado devolve o estado; cancelar um concluído é 409', async () => {
      const p = await criarPacote();
      await post(`/api/clinics/packages/${p.id}/cancel`, owner).expect(201);
      expect(
        (await post(`/api/clinics/packages/${p.id}/cancel`, owner).expect(201)).body.status,
      ).toBe('canceled');
      const unico = await criarPacote({ totalSessions: 1 });
      await atender(await agendar(), unico.id).expect(201);
      await post(`/api/clinics/packages/${unico.id}/cancel`, owner).expect(409);
      expect(
        await prisma.raw.auditLog.count({ where: { action: 'clinics.package.canceled' } }),
      ).toBe(1);
    });
  });

  // ── As regras do banco ────────────────────────────────────────────────────

  describe('as regras do banco (triggers e CHECKs)', () => {
    const recusa = (sql: string, params: unknown[] = []) =>
      expect(observador.query(sql, params)).rejects.toThrow();

    it('recusa: nascer com consumo, mudar paciente, serviço, total, preço ou moeda, consumir de dois em dois, voltar o contador, concluir sem consumo e mudar o pacote encerrado', async () => {
      const p = await criarPacote({ totalPriceCents: 10000 });
      const dono = await prisma.raw.clinicsPackage.findFirst({ where: { id: p.id } });
      await recusa(
        `INSERT INTO "ClinicsPackage" ("id","workspaceId","patientId","serviceId","totalSessions",
           "consumedSessions","currency","createdByMembershipId")
         VALUES (gen_random_uuid(), $1, $2, $3, 3, 1, 'BRL', $4)`,
        [wsA.workspaceId, paciente, servico, dono?.createdByMembershipId],
      );
      // cada mudança proibida vai JUNTO de um caminho legítimo (o consumo `+1` ou o
      // cancelamento): só a regra de imutabilidade a recusa, não a do caminho
      const comConsumo = (campo: string) =>
        `UPDATE "ClinicsPackage" SET ${campo}, "consumedSessions" = "consumedSessions" + 1 WHERE "id" = $1`;
      const comCancelamento = (campo: string) =>
        `UPDATE "ClinicsPackage" SET ${campo}, "status" = 'canceled' WHERE "id" = $1`;
      for (const campo of [
        `"totalSessions" = 5`,
        `"totalPriceCents" = 1`,
        `"totalPriceCents" = NULL`,
        `"currency" = 'USD'`,
      ]) {
        await recusa(comConsumo(campo), [p.id]);
        await recusa(comCancelamento(campo), [p.id]);
      }
      await recusa(comConsumo(`"patientId" = '${outroPaciente}'`), [p.id]);
      await recusa(comConsumo(`"serviceId" = '${outroServico}'`), [p.id]);
      await recusa(`UPDATE "ClinicsPackage" SET "patientId" = $2 WHERE "id" = $1`, [
        p.id,
        outroPaciente,
      ]);
      await recusa(`UPDATE "ClinicsPackage" SET "serviceId" = $2 WHERE "id" = $1`, [
        p.id,
        outroServico,
      ]);
      await recusa(`UPDATE "ClinicsPackage" SET "totalSessions" = 5 WHERE "id" = $1`, [p.id]);
      await recusa(`UPDATE "ClinicsPackage" SET "totalPriceCents" = 1 WHERE "id" = $1`, [p.id]);
      await recusa(`UPDATE "ClinicsPackage" SET "totalPriceCents" = NULL WHERE "id" = $1`, [p.id]);
      await recusa(`UPDATE "ClinicsPackage" SET "currency" = 'USD' WHERE "id" = $1`, [p.id]);
      await recusa(
        `UPDATE "ClinicsPackage" SET "consumedSessions" = "consumedSessions" + 2 WHERE "id" = $1`,
        [p.id],
      );
      await recusa(`UPDATE "ClinicsPackage" SET "status" = 'completed' WHERE "id" = $1`, [p.id]);
      await observador.query(
        `UPDATE "ClinicsPackage" SET "consumedSessions" = "consumedSessions" + 1 WHERE "id" = $1`,
        [p.id],
      );
      await recusa(
        `UPDATE "ClinicsPackage" SET "consumedSessions" = "consumedSessions" - 1 WHERE "id" = $1`,
        [p.id],
      );
      await observador.query(`UPDATE "ClinicsPackage" SET "status" = 'canceled' WHERE "id" = $1`, [
        p.id,
      ]);
      await recusa(
        `UPDATE "ClinicsPackage" SET "consumedSessions" = "consumedSessions" + 1 WHERE "id" = $1`,
        [p.id],
      );
      await recusa(`UPDATE "ClinicsPackage" SET "status" = 'active' WHERE "id" = $1`, [p.id]);
      const fim = await pacote(p.id);
      expect([
        fim?.status,
        fim?.consumedSessions,
        fim?.totalSessions,
        fim?.totalPriceCents,
      ]).toEqual(['canceled', 1, 3, 10000]);
    });

    it('permite os dois caminhos legítimos: a última sessão passa a `completed` NA MESMA instrução, e o cancelamento sem incremento', async () => {
      const ultima = await criarPacote({ totalSessions: 1 });
      const { rowCount } = await observador.query(
        `UPDATE "ClinicsPackage" SET "consumedSessions" = "consumedSessions" + 1 WHERE "id" = $1`,
        [ultima.id],
      );
      expect(rowCount).toBe(1);
      const concluido = await pacote(ultima.id);
      expect([concluido?.status, concluido?.consumedSessions, concluido?.closedAt]).toEqual([
        'completed',
        1,
        expect.any(Date),
      ]);
      const cancelado = await criarPacote();
      await observador.query(`UPDATE "ClinicsPackage" SET "status" = 'canceled' WHERE "id" = $1`, [
        cancelado.id,
      ]);
      const c = await pacote(cancelado.id);
      expect([c?.status, c?.consumedSessions, c?.closedAt]).toEqual([
        'canceled',
        0,
        expect.any(Date),
      ]);
    });

    it('o pacote de um atendimento não muda depois do registro: nem trocar, nem tirar, nem pôr', async () => {
      const p1 = await criarPacote();
      const p2 = await criarPacote();
      const comPacote = (await atender(await agendar(), p1.id).expect(201)).body.id;
      const avulso = (await atender(await agendar()).expect(201)).body.id;
      await recusa(`UPDATE "ClinicsAttendance" SET "packageId" = $2 WHERE "id" = $1`, [
        comPacote,
        p2.id,
      ]);
      await recusa(`UPDATE "ClinicsAttendance" SET "packageId" = NULL WHERE "id" = $1`, [
        comPacote,
      ]);
      await recusa(`UPDATE "ClinicsAttendance" SET "packageId" = $2 WHERE "id" = $1`, [
        avulso,
        p1.id,
      ]);
      expect(await igualdadeVale()).toBe(true);
    });

    it('excluir o WORKSPACE leva pacotes e atendimentos vinculados em cascata, como o resto do vertical', async () => {
      const p = await criarPacote();
      await atender(await agendar(), p.id).expect(201);
      await prisma.raw.workspace.deleteMany({ where: { id: wsA.workspaceId } });
      expect(
        await prisma.raw.clinicsPackage.count({ where: { workspaceId: wsA.workspaceId } }),
      ).toBe(0);
      expect(
        await prisma.raw.clinicsAttendance.count({ where: { workspaceId: wsA.workspaceId } }),
      ).toBe(0);
    });
  });

  // ── Permissões e isolamento ───────────────────────────────────────────────

  describe('permissões e isolamento', () => {
    it('quem tem só a AGENDA (recepção) não vê nem cria pacote, nem saldo — e a agenda não traz vínculo nenhum', async () => {
      const p = await criarPacote();
      const ag = await agendar();
      await atender(ag, p.id).expect(201);
      await get(`/api/clinics/packages?patientId=${paciente}`, recepcao).expect(403);
      await get(`/api/clinics/packages/${p.id}`, recepcao).expect(403);
      await post('/api/clinics/packages', recepcao, {
        patientId: paciente,
        serviceId: servico,
        totalSessions: 2,
      }).expect(403);
      await post(`/api/clinics/packages/${p.id}/cancel`, recepcao).expect(403);
      const dia = (await get(`/api/clinics/appointments?date=${SEGUNDA}`, recepcao).expect(200))
        .body as Record<string, unknown>[];
      expect(JSON.stringify(dia)).not.toContain(p.id);
      expect(dia.every((linha) => !('attendanceId' in linha) && !('packageId' in linha))).toBe(
        true,
      );
    });

    it('um papel que ESCREVE atendimento sem LER (customizado, fora da matriz) não consome, não cria nem cancela pacote — registra só o avulso', async () => {
      const papel = await prisma.raw.role.create({
        data: { workspaceId: wsA.workspaceId, name: 'Escreve sem ler (fictício)' },
      });
      await prisma.raw.rolePermission.createMany({
        data: ['clinics:care:write', 'clinics:schedule:read', 'clinics:catalog:read'].map(
          (permissionKey) => ({ workspaceId: wsA.workspaceId, roleId: papel.id, permissionKey }),
        ),
      });
      const user = await createUserFixture(prisma, 'sem-leitura-a@veyra.test');
      await createMembershipFixture(prisma, wsA.workspaceId, user, papel.id);
      const semLeitura = await loginAs('sem-leitura-a@veyra.test');
      const p = await criarPacote();
      const ag = await agendar();
      await atender(ag, p.id, semLeitura).expect(403);
      expect(await estadoDo(ag)).toBe('scheduled');
      await post('/api/clinics/packages', semLeitura, {
        patientId: paciente,
        serviceId: servico,
        totalSessions: 2,
      }).expect(403);
      await post(`/api/clinics/packages/${p.id}/cancel`, semLeitura).expect(403);
      expect((await atender(ag, undefined, semLeitura).expect(201)).body.packageId).toBeNull();
      expect((await pacote(p.id))?.consumedSessions).toBe(0);
    });

    it('o `Profissional` cria, lê e cancela pacote, e consome no registro de atendimento', async () => {
      const p = await criarPacote({}, profissional);
      const ag = await agendar();
      expect((await atender(ag, p.id, profissional).expect(201)).body.packageId).toBe(p.id);
      const lista = (
        await get(`/api/clinics/packages?patientId=${paciente}`, profissional).expect(200)
      ).body as { id: string; remainingSessions: number }[];
      expect(lista.map((x) => [x.id, x.remainingSessions])).toEqual([[p.id, 2]]);
      await post(`/api/clinics/packages/${p.id}/cancel`, profissional).expect(201);
    });

    it('P0: o workspace B não vê, não cancela nem consome o pacote de A, nem cria pacote para paciente de A', async () => {
      const p = await criarPacote();
      await get(`/api/clinics/packages/${p.id}`, ownerB).expect(404);
      expect(
        (await get(`/api/clinics/packages?patientId=${paciente}`, ownerB).expect(200)).body,
      ).toEqual([]);
      await post(`/api/clinics/packages/${p.id}/cancel`, ownerB).expect(404);
      await post('/api/clinics/packages', ownerB, {
        patientId: paciente,
        serviceId: servico,
        totalSessions: 2,
      }).expect(404);
      // e não CONSOME: um agendamento real de B, com o pacote de A
      const unitB = (await prisma.raw.clinicsUnit.findFirst({
        where: { workspaceId: wsB.workspaceId },
      }))!.id;
      const servicoB = (
        await post('/api/clinics/services', ownerB, { name: 'Serviço B', durationMin: 60 }).expect(
          201,
        )
      ).body.id as string;
      const profB = (
        await post('/api/clinics/professionals', ownerB, { name: 'Profissional B' }).expect(201)
      ).body.id as string;
      await put(`/api/clinics/professionals/${profB}/profile`, ownerB, {
        name: 'Profissional B',
        serviceIds: [servicoB],
        intervals: [{ unitId: unitB, weekday: 1, startMinute: 480, endMinute: 1320 }],
      }).expect(200);
      const agB = (
        await post('/api/clinics/appointments', ownerB, {
          patientId: await novoPaciente('Paciente B', ownerB),
          professionalId: profB,
          serviceId: servicoB,
          date: SEGUNDA,
          time: '08:00',
        }).expect(201)
      ).body.id as string;
      const antes = await estadoDo(agB);
      await atender(agB, p.id, ownerB).expect(404);
      expect(await estadoDo(agB)).toBe(antes);
      expect(await prisma.raw.clinicsAttendance.count()).toBe(0);
      expect((await pacote(p.id))?.consumedSessions).toBe(0);
      expect((await pacote(p.id))?.status).toBe('active');
    });

    it('a FK composta recusa, no banco, o vínculo de um atendimento com pacote de OUTRO workspace', async () => {
      const pacienteB = await novoPaciente('Paciente B', ownerB);
      const servicoB = (
        await post('/api/clinics/services', ownerB, { name: 'Serviço B', durationMin: 60 }).expect(
          201,
        )
      ).body.id;
      const pB = (
        await post('/api/clinics/packages', ownerB, {
          patientId: pacienteB,
          serviceId: servicoB,
          totalSessions: 2,
        }).expect(201)
      ).body.id as string;
      // um agendamento REAL de A, ainda sem atendimento: só a FK do pacote pode
      // recusar a linha (a do agendamento e a do profissional valem)
      const agA = await agendar();
      const dono = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsA.workspaceId, role: { systemKey: 'owner' } },
      });
      const linha = [wsA.workspaceId, agA, ana, dono?.id];
      await expect(
        observador.query(
          `INSERT INTO "ClinicsAttendance" ("id","workspaceId","appointmentId","professionalId",
             "completedAt","recordedByMembershipId","packageId")
           VALUES (gen_random_uuid(), $1, $2, $3, now(), $4, $5)`,
          [...linha, pB],
        ),
      ).rejects.toThrow(/ClinicsAttendance_workspaceId_packageId_fkey/);
      // a mesma linha, sem o pacote cruzado, entra: o que recusou foi a FK do pacote
      await observador.query(
        `INSERT INTO "ClinicsAttendance" ("id","workspaceId","appointmentId","professionalId",
           "completedAt","recordedByMembershipId","packageId")
         VALUES (gen_random_uuid(), $1, $2, $3, now(), $4, NULL)`,
        linha,
      );
      expect((await pacote(pB))?.consumedSessions).toBe(0);
    });
  });
});
