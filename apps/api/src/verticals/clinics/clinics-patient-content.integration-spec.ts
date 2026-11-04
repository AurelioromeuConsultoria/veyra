import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { CLINICS_RECEPTION_CARE_SYSTEM_KEY } from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../audit/audit.service';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { createTestApp } from '../../../test/integration/app';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../test/integration/fixtures';
import { TEST_DATABASE_URL } from '../../../test/integration/db-url';
import { resetDb } from '../../../test/integration/harness';
import { ClinicsActivationService } from './clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const RESTRITO = /Conteúdo restrito/;

interface Session {
  cookieHeader: string;
  csrf: string;
}

/**
 * F5.3b (ADR-061, adendo 2): as notas e as tarefas de quem é PACIENTE só saem
 * para quem tem `clinics:patient-content:read`, somada à permissão do recurso.
 * A recepção (Member) segue trabalhando pela agenda e pelas conversas; o
 * interessado que não é paciente segue com o acesso de sempre. Dados FICTÍCIOS.
 *
 * Adendo 3: quem NÃO pode saber quem é paciente (sem `clinics:schedule:read`)
 * recebe a regra uniforme — paciente e interessado com dados equivalentes dão
 * as MESMAS respostas, leitura e escrita. A corrida entre mover a tarefa e
 * converter o contato é forçada pela pausa na auditoria da conversão e vista
 * esperando a trava (`pg_stat_activity`), nunca por sono.
 */
describe('Clinics — notas e tarefas de pacientes (integração, F5.3b)', () => {
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

  // os portões da corrida: abertos e esperados no fim de cada teste, para o
  // jest sair e nenhuma transação ficar presa
  let portoes: (() => void)[] = [];
  let pendentes: Promise<unknown>[] = [];
  afterEach(async () => {
    for (const abrir of portoes) abrir();
    portoes = [];
    await Promise.allSettled(pendentes);
    pendentes = [];
    jest.restoreAllMocks();
  });

  let ws: WorkspaceFixture;
  let owner: Session;
  let recepcao: Session;
  let combinado: Session;
  let paciente: string;
  let interessado: string;

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
  const enviar = (
    metodo: 'post' | 'patch' | 'delete',
    path: string,
    s: Session,
    body?: unknown,
  ) => {
    const r = request(http)
      [metodo](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    return body === undefined ? r : r.send(body as object);
  };
  const post = (path: string, s: Session, body?: unknown) => enviar('post', path, s, body);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);
  const contato = async (name: string) =>
    (await post('/api/contacts', owner, { name }).expect(201)).body.id as string;
  const tarefa = async (body: Record<string, unknown>) =>
    (await post('/api/tasks', owner, { title: 'Ligar sobre a alergia', ...body }).expect(201)).body
      .id as string;
  const nota = async (body: Record<string, unknown>) =>
    (await post('/api/notes', owner, { body: 'Alergia a látex (fictício)', ...body }).expect(201))
      .body.id as string;
  const titulos = async (s: Session, query = '') =>
    (
      (await get(`/api/tasks?status=all${query}`, s).expect(200)).body.items as {
        title: string;
        id: string;
      }[]
    ).map((t) => t.id);

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    ws = await createWorkspaceFixture(prisma, 'acme');
    for (const systemKey of ['owner', 'member']) {
      const user = await createUserFixture(prisma, `${systemKey}@veyra.test`);
      await createMembershipFixture(prisma, ws.workspaceId, user, ws.roles[systemKey]);
    }
    await app.get(ClinicsActivationService).enable('acme');
    const papelCombinado = (await prisma.raw.role.findFirst({
      where: { workspaceId: ws.workspaceId, systemKey: CLINICS_RECEPTION_CARE_SYSTEM_KEY },
    }))!.id;
    await createMembershipFixture(
      prisma,
      ws.workspaceId,
      await createUserFixture(prisma, 'combinado@veyra.test'),
      papelCombinado,
    );
    owner = await loginAs('owner@veyra.test');
    recepcao = await loginAs('member@veyra.test');
    combinado = await loginAs('combinado@veyra.test');
    const c = await contato('Paciente Fictícia');
    await post('/api/clinics/patients', owner, { contactId: c }).expect(201);
    paciente = c;
    interessado = await contato('Interessado Fictício');
  });

  it('a recepção: listas sem o conteúdo do paciente (nem no total); a lista PARA ele é 403; o interessado segue visível', async () => {
    const doPaciente = await tarefa({ contactId: paciente });
    const doInteressado = await tarefa({ contactId: interessado, title: 'Enviar orçamento' });
    await nota({ contactId: paciente });
    await nota({ contactId: interessado, body: 'Prefere à tarde' });
    // a recepção: a tarefa do paciente não sai, nem no total
    const lista = await get('/api/tasks?status=all', recepcao).expect(200);
    expect(lista.body.items.map((t: { id: string }) => t.id)).toEqual([doInteressado]);
    expect(lista.body.total).toBe(1);
    expect(JSON.stringify(lista.body)).not.toMatch(/alergia/i);
    // a lista pedida para o paciente: 403 "Conteúdo restrito"
    for (const r of [
      get(`/api/tasks?contactId=${paciente}`, recepcao),
      get(`/api/notes?contactId=${paciente}`, recepcao),
    ]) {
      expect((await r.expect(403)).body.message).toMatch(RESTRITO);
    }
    // o interessado (não paciente, sem liberação para IA): o acesso de sempre
    expect(await titulos(recepcao, `&contactId=${interessado}`)).toEqual([doInteressado]);
    expect(
      (await get(`/api/notes?contactId=${interessado}`, recepcao).expect(200)).body,
    ).toHaveLength(1);
    // o Owner e "Recepção e atendimento" (com a chave) leem tudo
    for (const s of [owner, combinado]) {
      expect((await titulos(s)).sort()).toEqual([doInteressado, doPaciente].sort());
      expect((await get(`/api/notes?contactId=${paciente}`, s).expect(200)).body).toHaveLength(1);
    }
  });

  it('o acesso direto e a escrita: editar, concluir e apagar o do paciente é 404; criar para o paciente é 403', async () => {
    const t = await tarefa({ contactId: paciente });
    const n = await nota({ contactId: paciente });
    await enviar('patch', `/api/tasks/${t}`, recepcao, { status: 'done' }).expect(404);
    await enviar('patch', `/api/tasks/${t}`, recepcao, { title: 'outro' }).expect(404);
    await enviar('delete', `/api/tasks/${t}`, recepcao).expect(404);
    await enviar('delete', `/api/notes/${n}`, recepcao).expect(404);
    expect(await prisma.raw.task.count({ where: { id: t, status: 'open' } })).toBe(1);
    expect(await prisma.raw.note.count({ where: { id: n } })).toBe(1);
    for (const r of [
      post('/api/tasks', recepcao, { title: 'x', contactId: paciente }),
      post('/api/notes', recepcao, { body: 'x', contactId: paciente }),
    ]) {
      expect((await r.expect(403)).body.message).toMatch(RESTRITO);
    }
    // levar uma tarefa do interessado para o paciente: 403, sem efeito
    const minha = await tarefa({ contactId: interessado });
    await enviar('patch', `/api/tasks/${minha}`, recepcao, { contactId: paciente }).expect(403);
    expect((await prisma.raw.task.findFirst({ where: { id: minha } }))?.contactId).toBe(
      interessado,
    );
  });

  it('a oportunidade de um paciente protege as notas e tarefas dela, também numa lista sem filtro', async () => {
    const deal = (
      await post('/api/deals', owner, { title: 'Pacote facial', contactId: paciente }).expect(201)
    ).body.id as string;
    const t = await tarefa({ dealId: deal });
    await nota({ dealId: deal });
    expect(await titulos(recepcao)).not.toContain(t);
    for (const r of [
      get(`/api/tasks?dealId=${deal}`, recepcao),
      get(`/api/notes?dealId=${deal}`, recepcao),
    ]) {
      expect((await r.expect(403)).body.message).toMatch(RESTRITO);
    }
    // tirar a oportunidade do paciente levaria o conteúdo junto: só com a chave
    for (const contactId of [interessado, null]) {
      const r = await enviar('patch', `/api/deals/${deal}`, recepcao, { contactId }).expect(403);
      expect(r.body.message).toMatch(RESTRITO);
    }
    expect((await prisma.raw.deal.findFirst({ where: { id: deal } }))?.contactId).toBe(paciente);
    expect(await titulos(recepcao)).not.toContain(t);
    // levar uma oportunidade PARA o paciente protege; quem tem a chave move
    await enviar('patch', `/api/deals/${deal}`, owner, { contactId: interessado }).expect(200);
    expect(await titulos(recepcao)).toContain(t);
    await enviar('patch', `/api/deals/${deal}`, recepcao, { contactId: paciente }).expect(200);
    expect(await titulos(recepcao)).not.toContain(t);
  });

  it('a automação sobre a tarefa de um paciente: a tarefa criada fica com o paciente, protegida', async () => {
    await post('/api/automations', owner, {
      name: 'Retorno da tarefa',
      trigger: 'task.created',
      action: 'create_task',
      actionConfig: { title: 'Retorno: {{title}}', dueInDays: 1 },
    }).expect(201);
    await tarefa({ contactId: paciente });
    const jobs = app.get(JobsService);
    for (let i = 0; i < 4; i += 1) {
      if ((await jobs.dispatchPending()).delivered === 0) break;
    }
    const criada = await prisma.raw.task.findFirst({
      where: { workspaceId: ws.workspaceId, title: { startsWith: 'Retorno:' } },
    });
    expect(criada?.contactId).toBe(paciente);
    const daRecepcao = (await get('/api/tasks?status=all', recepcao).expect(200)).body;
    expect(JSON.stringify(daRecepcao)).not.toMatch(/alergia/i);
    expect(await titulos(owner)).toContain(criada!.id);
  });

  it('apagar a oportunidade de um paciente (e as notas e tarefas dela) exige a chave', async () => {
    const deal = (
      await post('/api/deals', owner, { title: 'Pacote facial', contactId: paciente }).expect(201)
    ).body.id as string;
    const t = await tarefa({ dealId: deal });
    expect(
      (await enviar('delete', `/api/deals/${deal}`, recepcao).expect(403)).body.message,
    ).toMatch(RESTRITO);
    expect(await prisma.raw.task.count({ where: { id: t } })).toBe(1);
    await enviar('delete', `/api/deals/${deal}`, owner).expect(200);
    expect(await prisma.raw.task.count({ where: { id: t } })).toBe(0);
  });

  it('a timeline: as atividades de nota e tarefa do paciente não saem, e a resposta diz que há conteúdo restrito', async () => {
    await tarefa({ contactId: paciente });
    await nota({ contactId: paciente });
    const daRecepcao = (await get(`/api/activities?contactId=${paciente}`, recepcao).expect(200))
      .body;
    expect(daRecepcao.restrictedContent).toBe(true);
    expect(daRecepcao.items.map((a: { type: string }) => a.type)).not.toEqual(
      expect.arrayContaining(['task_created']),
    );
    expect(JSON.stringify(daRecepcao)).not.toMatch(/alergia/i);
    const doOwner = (await get(`/api/activities?contactId=${paciente}`, owner).expect(200)).body;
    expect(doOwner.restrictedContent).toBeUndefined();
    expect(doOwner.items.map((a: { type: string }) => a.type)).toEqual(
      expect.arrayContaining(['task_created', 'note_added']),
    );
    // o interessado: a timeline de sempre, sem a marca
    await tarefa({ contactId: interessado });
    const doInteressado = (
      await get(`/api/activities?contactId=${interessado}`, recepcao).expect(200)
    ).body;
    expect(doInteressado.restrictedContent).toBeUndefined();
    expect(doInteressado.items.map((a: { type: string }) => a.type)).toContain('task_created');
  });

  it('o interessado que VIRA paciente: o que antes era servido deixa de ser no pedido seguinte', async () => {
    const t = await tarefa({ contactId: interessado });
    await nota({ contactId: interessado });
    expect(await titulos(recepcao)).toContain(t);
    await post('/api/clinics/patients', owner, { contactId: interessado }).expect(201);
    expect(await titulos(recepcao)).not.toContain(t);
    await enviar('patch', `/api/tasks/${t}`, recepcao, { status: 'done' }).expect(404);
    expect(
      (await get(`/api/notes?contactId=${interessado}`, recepcao).expect(403)).body.message,
    ).toMatch(RESTRITO);
    const timeline = (await get(`/api/activities?contactId=${interessado}`, recepcao).expect(200))
      .body;
    expect(timeline.restrictedContent).toBe(true);
    expect(timeline.items.map((a: { type: string }) => a.type)).not.toContain('task_created');
  });

  it('a chave nos papéis que já existiam: Owner, Admin e o combinado pelo livro; nunca a recepção nem o Profissional', async () => {
    const chave = 'clinics:patient-content:read';
    await prisma.raw.rolePermission.deleteMany({
      where: { workspaceId: ws.workspaceId, permissionKey: chave },
    });
    await prisma.raw.permissionBackfill.deleteMany({
      where: { workspaceId: ws.workspaceId, permissionKey: chave },
    });
    // sem a chave, o próprio Owner deixa de ler (a chave se SOMA à do recurso)
    await tarefa({ contactId: interessado });
    expect((await get(`/api/notes?contactId=${paciente}`, owner).expect(403)).body.message).toMatch(
      RESTRITO,
    );
    await app.get(ClinicsActivationService).preencherChavesNovas();
    const comChave = await prisma.raw.role.findMany({
      where: { workspaceId: ws.workspaceId, permissions: { some: { permissionKey: chave } } },
      select: { systemKey: true },
    });
    expect(comChave.map((r) => r.systemKey).sort()).toEqual(
      ['admin', CLINICS_RECEPTION_CARE_SYSTEM_KEY, 'owner'].sort(),
    );
    await get(`/api/notes?contactId=${paciente}`, owner).expect(200);
  });

  // ── adendo 3: quem não pode identificar pacientes ─────────────────────────
  const SEM_AGENDA = [
    'contacts:read',
    'contacts:write',
    'tasks:read',
    'tasks:write',
    'pipelines:read',
    'deals:write',
  ];
  /** um papel PERSONALIZADO só com chaves do Core (como o Guest, com escrita) */
  const operadorSemAgenda = async (
    workspaceId: string,
    email: string,
    extras: readonly string[] = [],
  ) => {
    const role = await prisma.raw.role.create({
      data: { workspaceId, name: `Sem agenda ${email}`, isSystem: false },
    });
    await prisma.raw.rolePermission.createMany({
      data: [...SEM_AGENDA, ...extras].map((permissionKey) => ({
        workspaceId,
        roleId: role.id,
        permissionKey,
      })),
    });
    await createMembershipFixture(
      prisma,
      workspaceId,
      await createUserFixture(prisma, email),
      role.id,
    );
    return loginAs(email);
  };
  /** o mesmo conteúdo para a pessoa: uma tarefa, uma nota, uma oportunidade com uma tarefa */
  const conteudoEquivalente = async (contactId: string) => {
    const tarefaId = await tarefa({ contactId, title: 'Ligar amanhã' });
    await nota({ contactId, body: 'Prefere à tarde' });
    const dealId = (await post('/api/deals', owner, { title: 'Pacote', contactId }).expect(201))
      .body.id as string;
    await tarefa({ dealId, title: 'Enviar proposta' });
    return { contactId, tarefaId, dealId };
  };
  type Pessoa = Awaited<ReturnType<typeof conteudoEquivalente>>;
  /** o que o operador LÊ pelos caminhos afetados, sem ids nem nomes */
  const leituras = async (s: Session, p: Pessoa) => {
    const tasks = await get(`/api/tasks?status=all&contactId=${p.contactId}`, s);
    const notes = await get(`/api/notes?contactId=${p.contactId}`, s);
    const doDeal = await get(`/api/tasks?status=all&dealId=${p.dealId}`, s);
    const notasDoDeal = await get(`/api/notes?dealId=${p.dealId}`, s);
    const timeline = await get(`/api/activities?contactId=${p.contactId}`, s);
    const timelineDoDeal = await get(`/api/activities?dealId=${p.dealId}`, s);
    const tipos = (r: request.Response) =>
      r.status === 200
        ? {
            tipos: (r.body.items as { type: string }[]).map((a) => a.type),
            restrictedContent: r.body.restrictedContent,
          }
        : r.body;
    return {
      tasks: [tasks.status, tasks.body],
      notes: [notes.status, notes.body],
      doDeal: [doDeal.status, doDeal.body],
      notasDoDeal: [notasDoDeal.status, notasDoDeal.body],
      timeline: [timeline.status, tipos(timeline)],
      timelineDoDeal: [timelineDoDeal.status, tipos(timelineDoDeal)],
    };
  };
  /** o que o operador consegue ESCREVER: cada escrita que tocaria a pessoa */
  const escritas = async (s: Session, p: Pessoa) => {
    const semAlvo = (await post('/api/tasks', owner, { title: 'Sem alvo' }).expect(201)).body
      .id as string;
    const r = [
      await post('/api/tasks', s, { title: 'x', contactId: p.contactId }),
      await post('/api/notes', s, { body: 'x', contactId: p.contactId }),
      await post('/api/tasks', s, { title: 'x', dealId: p.dealId }),
      await enviar('patch', `/api/tasks/${semAlvo}`, s, { contactId: p.contactId }),
      await enviar('patch', `/api/tasks/${p.tarefaId}`, s, { status: 'done' }),
      await enviar('patch', `/api/deals/${p.dealId}`, s, { contactId: null }),
      await enviar('delete', `/api/deals/${p.dealId}`, s),
      await enviar('delete', `/api/contacts/${p.contactId}`, s),
    ];
    return r.map((x) => [x.status, x.body.message]);
  };

  it('adendo 3: sem leitura da agenda, paciente e interessado equivalentes dão as MESMAS respostas', async () => {
    const operador = await operadorSemAgenda(ws.workspaceId, 'sem-agenda@veyra.test');
    const p = await conteudoEquivalente(paciente);
    const i = await conteudoEquivalente(interessado);

    const lidoP = await leituras(operador, p);
    expect(lidoP).toEqual(await leituras(operador, i));
    // e o que é igual é o vazio, com o aviso uniforme
    expect(lidoP.tasks).toEqual([200, { items: [], total: 0, page: 1, pageSize: 50 }]);
    expect(lidoP.notes).toEqual([200, []]);
    expect(lidoP.timeline[1]).toMatchObject({ restrictedContent: true });
    expect((lidoP.timeline[1] as { tipos: string[] }).tipos).not.toContain('task_created');
    // nas listas gerais, nada de pessoa — nem no total
    const geral = (await get('/api/tasks?status=all', operador).expect(200)).body;
    expect(geral.total).toBe(0);

    const escritoP = await escritas(operador, p);
    expect(escritoP).toEqual(await escritas(operador, i));
    expect(escritoP).toEqual([
      [403, 'Conteúdo restrito'],
      [403, 'Conteúdo restrito'],
      [403, 'Conteúdo restrito'],
      [403, 'Conteúdo restrito'],
      [404, 'Tarefa não encontrada'],
      [403, 'Conteúdo restrito'],
      [403, 'Conteúdo restrito'],
      [403, 'Conteúdo restrito'],
    ]);
    // nada mudou
    for (const x of [p, i]) {
      expect(await prisma.raw.contact.count({ where: { id: x.contactId } })).toBe(1);
      expect((await prisma.raw.deal.findFirst({ where: { id: x.dealId } }))?.contactId).toBe(
        x.contactId,
      );
      expect((await prisma.raw.task.findFirst({ where: { id: x.tarefaId } }))?.status).toBe('open');
    }
  });

  it('adendo 3: o que não tem pessoa segue as permissões de sempre', async () => {
    const operador = await operadorSemAgenda(ws.workspaceId, 'sem-agenda@veyra.test');
    const t = (await post('/api/tasks', operador, { title: 'Repor estoque' }).expect(201)).body
      .id as string;
    await enviar('patch', `/api/tasks/${t}`, operador, { status: 'done' }).expect(200);
    const deal = (await post('/api/deals', operador, { title: 'Sem contato' }).expect(201)).body
      .id as string;
    await post('/api/tasks', operador, { title: 'Da oportunidade', dealId: deal }).expect(201);
    expect(
      (await get(`/api/tasks?status=all&dealId=${deal}`, operador).expect(200)).body.total,
    ).toBe(1);
    await enviar('delete', `/api/deals/${deal}`, operador).expect(200);
    expect((await get('/api/tasks?status=all', operador).expect(200)).body.items).toHaveLength(1);
  });

  it('adendo 3: a desativação mantém a proteção — todos na regra uniforme, inclusive o Owner', async () => {
    const p = await conteudoEquivalente(paciente);
    const i = await conteudoEquivalente(interessado);
    await app.get(ClinicsActivationService).disable('acme');
    // a desativação encerra as sessões (tokenVersion): entra de novo
    owner = await loginAs('owner@veyra.test');
    recepcao = await loginAs('member@veyra.test');
    const ownerDepois = owner;
    const lidoP = await leituras(ownerDepois, p);
    expect(lidoP).toEqual(await leituras(ownerDepois, i));
    expect(lidoP.tasks).toEqual([200, { items: [], total: 0, page: 1, pageSize: 50 }]);
    expect(await escritas(ownerDepois, p)).toEqual(await escritas(ownerDepois, i));
    // a recepção também: sem a agenda, ela não distingue mais ninguém
    expect(await leituras(recepcao, p)).toEqual(await leituras(recepcao, i));
  });

  it('adendo 3: num workspace que nunca ativou o Clinics, o mesmo papel tem o CRM de sempre', async () => {
    const beta = await createWorkspaceFixture(prisma, 'beta');
    const operador = await operadorSemAgenda(beta.workspaceId, 'sem-agenda-beta@veyra.test');
    const c = (await post('/api/contacts', operador, { name: 'Contato do Core' }).expect(201)).body
      .id as string;
    const t = (await post('/api/tasks', operador, { title: 'Ligar', contactId: c }).expect(201))
      .body.id as string;
    await post('/api/notes', operador, { body: 'Nota', contactId: c }).expect(201);
    expect(
      (await get(`/api/tasks?status=all&contactId=${c}`, operador).expect(200)).body.items,
    ).toHaveLength(1);
    expect((await get(`/api/notes?contactId=${c}`, operador).expect(200)).body).toHaveLength(1);
    const timeline = (await get(`/api/activities?contactId=${c}`, operador).expect(200)).body;
    expect(timeline.restrictedContent).toBeUndefined();
    expect(timeline.items.map((a: { type: string }) => a.type)).toContain('task_created');
    await enviar('patch', `/api/tasks/${t}`, operador, { status: 'done' }).expect(200);
    await enviar('delete', `/api/contacts/${c}`, operador).expect(200);
  });

  it('a corrida: a conversão comita enquanto a troca da tarefa espera a trava — a troca dá 404, sem efeito', async () => {
    const t = await tarefa({ contactId: interessado });
    const outro = await contato('Outro Fictício');
    const ate = async (condicao: () => Promise<boolean>) => {
      for (let n = 0; n < 400; n++) {
        if (await condicao()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('ninguém esperou a trava');
    };
    const portao = () => {
      let abrir!: () => void;
      const aberto = new Promise<void>((r) => (abrir = r));
      portoes.push(abrir);
      return { aberto, abrir };
    };
    const disparar = <T>(p: PromiseLike<T>): Promise<T> => {
      const promessa = Promise.resolve(p);
      pendentes.push(promessa);
      return promessa;
    };
    // a conversão pausa na auditoria, DEPOIS de pegar a trava do contato
    const audit = app.get(AuditService);
    const real = audit.record.bind(audit);
    const chegou = portao();
    const segue = portao();
    jest.spyOn(audit, 'record').mockImplementation(async (db, w, action, input) => {
      if (action === 'clinics.patient.created') {
        chegou.abrir();
        await segue.aberto;
      }
      return real(db, w, action, input);
    });
    const conversao = disparar(post('/api/clinics/patients', owner, { contactId: interessado }));
    await chegou.aberto;
    // a recepção ainda vê a tarefa (a conversão não comitou) e pede a troca
    const troca = disparar(enviar('patch', `/api/tasks/${t}`, recepcao, { contactId: outro }));
    await ate(async () => {
      const { rows } = await observador.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`,
      );
      return Number(rows[0].n) > 0;
    });
    segue.abrir();
    expect((await conversao).status).toBe(201);
    expect((await troca).status).toBe(404);
    expect((await prisma.raw.task.findFirst({ where: { id: t } }))?.contactId).toBe(interessado);
  });

  // ── adendo 4: os três caminhos fechados antes da publicação ───────────────
  it('adendo 4: a chave do conteúdo SEM a da agenda não libera nada — a mesma regra uniforme', async () => {
    const operador = await operadorSemAgenda(ws.workspaceId, 'so-conteudo@veyra.test', [
      'clinics:patient-content:read',
    ]);
    const p = await conteudoEquivalente(paciente);
    const i = await conteudoEquivalente(interessado);
    const lidoP = await leituras(operador, p);
    expect(lidoP).toEqual(await leituras(operador, i));
    expect(lidoP.tasks).toEqual([200, { items: [], total: 0, page: 1, pageSize: 50 }]);
    expect(lidoP.notes).toEqual([200, []]);
    const escritoP = await escritas(operador, p);
    expect(escritoP).toEqual(await escritas(operador, i));
    expect(escritoP.filter(([status]) => status === 403)).toHaveLength(7);
  });

  it('adendo 4: a automação usa o título e os vínculos da MESMA linha — renomeada e desvinculada antes do job', async () => {
    await post('/api/automations', owner, {
      name: 'Retorno da tarefa',
      trigger: 'task.created',
      action: 'create_task',
      actionConfig: { title: 'Retorno: {{title}}', dueInDays: 1 },
    }).expect(201);
    const t = await tarefa({ contactId: paciente, title: 'Ligar sobre a alergia' });
    // antes de o job rodar, quem tem a chave renomeia e desvincula
    await enviar('patch', `/api/tasks/${t}`, owner, {
      title: 'Ligar amanhã',
      contactId: null,
    }).expect(200);
    const jobs = app.get(JobsService);
    for (let n = 0; n < 4; n += 1) {
      if ((await jobs.dispatchPending()).delivered === 0) break;
    }
    const criada = await prisma.raw.task.findFirst({
      where: { workspaceId: ws.workspaceId, title: { startsWith: 'Retorno:' } },
    });
    expect(criada).toMatchObject({ title: 'Retorno: Ligar amanhã', contactId: null, dealId: null });
    // o título antigo não está em tarefa nenhuma, livre ou não
    expect(await prisma.raw.task.count({ where: { title: { contains: 'alergia' } } })).toBe(0);
    // nem no que a recepção lê: listas e timelines
    expect(
      JSON.stringify((await get('/api/tasks?status=all', recepcao).expect(200)).body),
    ).not.toMatch(/alergia/i);
    for (const alvo of [`contactId=${paciente}`, `contactId=${interessado}`]) {
      const r = await get(`/api/activities?${alvo}`, recepcao).expect(200);
      expect(JSON.stringify(r.body)).not.toMatch(/alergia/i);
    }
    // a única atividade com o título antigo é a da criação, presa ao paciente
    const comTitulo = await prisma.raw.activity.findMany({
      where: {
        workspaceId: ws.workspaceId,
        payload: { path: ['title'], string_contains: 'alergia' },
      },
      select: { contactId: true, type: true },
    });
    expect(comTitulo).toEqual([{ contactId: paciente, type: 'task_created' }]);
  });

  it('adendo 4: excluir empresa, interessado ou oportunidade que levaria em cascata uma nota oculta é recusado, sem apagar nada', async () => {
    const empresa = (await post('/api/companies', owner, { name: 'Empresa Fictícia' }).expect(201))
      .body.id as string;
    const dealDoPaciente = (
      await post('/api/deals', owner, { title: 'Pacote', contactId: paciente }).expect(201)
    ).body.id as string;
    const dealLivre = (await post('/api/deals', owner, { title: 'Sem contato' }).expect(201)).body
      .id as string;
    // notas antigas com mais de um alvo (pela API: o contrato aceita)
    const n1 = await nota({ companyId: empresa, contactId: paciente });
    const n2 = await nota({ contactId: interessado, dealId: dealDoPaciente });
    const n3 = await nota({ dealId: dealLivre, contactId: paciente });
    const t3 = await tarefa({ dealId: dealLivre, contactId: paciente });
    // a recepção não apaga nenhuma delas diretamente…
    for (const n of [n1, n2, n3]) await enviar('delete', `/api/notes/${n}`, recepcao).expect(404);
    // …nem pela cascata
    for (const caminho of [
      `/api/companies/${empresa}`,
      `/api/contacts/${interessado}`,
      `/api/deals/${dealLivre}`,
    ]) {
      const r = await enviar('delete', caminho, recepcao).expect(403);
      expect(r.body.message).toMatch(RESTRITO);
    }
    expect(await prisma.raw.note.count({ where: { id: { in: [n1, n2, n3] } } })).toBe(3);
    expect(await prisma.raw.task.count({ where: { id: t3 } })).toBe(1);
    expect(await prisma.raw.company.count({ where: { id: empresa } })).toBe(1);
    expect(await prisma.raw.contact.count({ where: { id: interessado } })).toBe(1);
    // sem nada oculto na cascata, a recepção exclui como sempre
    const outra = (await post('/api/companies', owner, { name: 'Outra' }).expect(201)).body
      .id as string;
    await nota({ companyId: outra, contactId: interessado });
    await enviar('delete', `/api/companies/${outra}`, recepcao).expect(200);
    // quem tem as duas chaves exclui, e a cascata segue
    await enviar('delete', `/api/companies/${empresa}`, owner).expect(200);
    expect(await prisma.raw.note.count({ where: { id: n1 } })).toBe(0);
  });

  it('adendo 4: sem a agenda, a recusa da cascata é igual para paciente e interessado', async () => {
    const operador = await operadorSemAgenda(ws.workspaceId, 'sem-agenda@veyra.test');
    const respostas: [number, string][] = [];
    for (const pessoa of [paciente, interessado]) {
      const empresa = (await post('/api/companies', owner, { name: 'Empresa' }).expect(201)).body
        .id as string;
      await nota({ companyId: empresa, contactId: pessoa });
      const deal = (await post('/api/deals', owner, { title: 'Sem contato' }).expect(201)).body
        .id as string;
      await nota({ dealId: deal, contactId: pessoa });
      for (const caminho of [`/api/companies/${empresa}`, `/api/deals/${deal}`]) {
        const r = await enviar('delete', caminho, operador);
        respostas.push([r.status, r.body.message]);
      }
    }
    expect(respostas).toEqual(Array(4).fill([403, 'Conteúdo restrito']));
  });

  const rodarAutomacoes = async () => {
    const jobs = app.get(JobsService);
    for (let n = 0; n < 4; n += 1) {
      if ((await jobs.dispatchPending()).delivered === 0) break;
    }
  };

  it('adendo 4: as CONDIÇÕES da automação também leem a linha atual — o título antigo não decide nada', async () => {
    await post('/api/automations', owner, {
      name: 'Alergia',
      trigger: 'task.created',
      conditions: [{ field: 'title', op: 'contains', value: 'alergia' }],
      action: 'create_task',
      actionConfig: { title: 'Retorno: {{title}}', dueInDays: 1 },
    }).expect(201);
    const t = await tarefa({ contactId: paciente, title: 'Ligar sobre a alergia' });
    await enviar('patch', `/api/tasks/${t}`, owner, {
      title: 'Ligar amanhã',
      contactId: null,
    }).expect(200);
    await rodarAutomacoes();
    // a condição não casa com o título de agora: nada é criado
    expect(await prisma.raw.task.count({ where: { title: { startsWith: 'Retorno:' } } })).toBe(0);
    expect(
      await prisma.raw.automationExecution.findFirst({ select: { status: true, reason: true } }),
    ).toEqual({ status: 'skipped', reason: 'conditions_not_met' });
  });

  it('adendo 4: num workspace que nunca teve o Clinics, a automação de tarefa é a de sempre', async () => {
    const beta = await createWorkspaceFixture(prisma, 'beta');
    await createMembershipFixture(
      prisma,
      beta.workspaceId,
      await createUserFixture(prisma, 'owner-beta@veyra.test'),
      beta.roles.owner,
    );
    const dona = await loginAs('owner-beta@veyra.test');
    await post('/api/automations', dona, {
      name: 'Retorno',
      trigger: 'task.created',
      conditions: [{ field: 'title', op: 'contains', value: 'proposta' }],
      action: 'create_task',
      actionConfig: { title: 'Retorno: {{title}}', dueInDays: 1 },
    }).expect(201);
    const c = (await post('/api/contacts', dona, { name: 'Contato do Core' }).expect(201)).body
      .id as string;
    const t = (
      await post('/api/tasks', dona, { title: 'Enviar proposta', contactId: c }).expect(201)
    ).body.id as string;
    await enviar('patch', `/api/tasks/${t}`, dona, { title: 'Ligar' }).expect(200);
    await rodarAutomacoes();
    // como antes da F5.3b: o título e a condição do EVENTO, sem vínculo herdado
    const criada = await prisma.raw.task.findFirst({
      where: { workspaceId: beta.workspaceId, title: { startsWith: 'Retorno:' } },
    });
    expect(criada).toMatchObject({
      title: 'Retorno: Enviar proposta',
      contactId: null,
      dealId: null,
    });
  });

  it('adendo 4: a oportunidade só com uma TAREFA oculta (sem nota) também não é apagada', async () => {
    const dealLivre = (await post('/api/deals', owner, { title: 'Sem contato' }).expect(201)).body
      .id as string;
    const t = await tarefa({ dealId: dealLivre, contactId: paciente });
    const r = await enviar('delete', `/api/deals/${dealLivre}`, recepcao).expect(403);
    expect(r.body.message).toMatch(RESTRITO);
    expect(await prisma.raw.task.count({ where: { id: t } })).toBe(1);
    expect(await prisma.raw.deal.count({ where: { id: dealLivre } })).toBe(1);
  });
});
