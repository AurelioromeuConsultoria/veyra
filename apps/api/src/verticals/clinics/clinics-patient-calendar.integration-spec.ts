import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CLINICS_RECEPTION_CARE_SYSTEM_KEY } from '@veyra/contracts/verticals/clinics';
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
import { resetDb } from '../../../test/integration/harness';
import { ClinicsActivationService } from './clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const RESTRITO = 'Conteúdo restrito';

const HOJE = new Date('2026-09-01T13:00:00.000Z');
const iso = (offsetMinutes: number) =>
  new Date(HOJE.getTime() + offsetMinutes * 60_000).toISOString();
const JANELA = `from=${encodeURIComponent(iso(-24 * 60))}&to=${encodeURIComponent(iso(24 * 60))}`;

/** o texto clínico de um paciente e o comercial de um interessado (FICTÍCIOS) */
const TEXTO_DO_PACIENTE = {
  title: 'Retorno da aplicação de toxina',
  description: 'Conferir reação no local da aplicação',
  location: 'Sala de procedimentos',
};
const TEXTO_DO_INTERESSADO = {
  title: 'Apresentar orçamento',
  description: 'Levar a tabela de pacotes',
  location: 'Recepção',
};
const CLINICO = /toxina|aplicação|procedimentos/i;

interface Session {
  cookieHeader: string;
  csrf: string;
}

/**
 * B1, a agenda do Core sob o E8 (ADR-061, adendo 8, item 1): o texto de um
 * `CalendarEvent` (título, descrição, local) ligado a uma pessoa é conteúdo
 * escrito sobre ela, da classe das notas e tarefas. Antes, quem tem
 * `calendar:read` e NÃO tem `clinics:schedule:read` (o Guest padrão, um papel
 * personalizado) distinguia o paciente do interessado pelo texto — na lista,
 * no evento, na atividade `event_scheduled` da timeline e na notificação
 * `calendar_event_scheduled`. Agora:
 * - `uniforme` (sem a agenda clínica): o texto de TODA pessoa sai como
 *   "Conteúdo restrito", e as escritas que tocam uma pessoa são recusadas;
 * - `restrito` (a recepção): só o do paciente sai mascarado; nada que ela
 *   escrevia é recusado;
 * - `livre` ("Recepção e atendimento", o workspace sem o Clinics): como antes.
 * Dados FICTÍCIOS.
 */
describe('Clinics — a agenda do Core sob o E8 (integração, ADR-061 adendo 8)', () => {
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

  let ws: WorkspaceFixture;
  let owner: Session;
  let recepcao: Session;
  let combinado: Session;
  let membershipRecepcao: string;
  let membershipCombinado: string;
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
    headers: Record<string, string> = {},
  ) => {
    const r = request(http)
      [metodo](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return body === undefined ? r : r.send(body as object);
  };
  const post = (path: string, s: Session, body?: unknown, headers?: Record<string, string>) =>
    enviar('post', path, s, body, headers);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);
  const contato = async (name: string) =>
    (await post('/api/contacts', owner, { name }).expect(201)).body.id as string;

  /** um membro com um papel (de sistema ou personalizado) e a sessão dele */
  const membro = async (workspaceId: string, email: string, roleId: string) => {
    const membership = await createMembershipFixture(
      prisma,
      workspaceId,
      await createUserFixture(prisma, email),
      roleId,
    );
    return { membership, sessao: await loginAs(email) };
  };
  /** um papel PERSONALIZADO só com chaves do Core, sem a agenda clínica */
  const papelSemAgenda = async (workspaceId: string) => {
    const role = await prisma.raw.role.create({
      data: { workspaceId, name: 'Agenda do CRM', isSystem: false },
    });
    await prisma.raw.rolePermission.createMany({
      data: [
        'workspace:read',
        'contacts:read',
        'contacts:write',
        'pipelines:read',
        'deals:write',
        'calendar:read',
        'calendar:write',
      ].map((permissionKey) => ({ workspaceId, roleId: role.id, permissionKey })),
    });
    return role.id;
  };

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    ws = await createWorkspaceFixture(prisma, 'acme');
    await createMembershipFixture(
      prisma,
      ws.workspaceId,
      await createUserFixture(prisma, 'owner@veyra.test'),
      ws.roles.owner,
    );
    membershipRecepcao = await createMembershipFixture(
      prisma,
      ws.workspaceId,
      await createUserFixture(prisma, 'member@veyra.test'),
      ws.roles.member,
    );
    await app.get(ClinicsActivationService).enable('acme');
    const papelCombinado = (await prisma.raw.role.findFirst({
      where: { workspaceId: ws.workspaceId, systemKey: CLINICS_RECEPTION_CARE_SYSTEM_KEY },
    }))!.id;
    membershipCombinado = await createMembershipFixture(
      prisma,
      ws.workspaceId,
      await createUserFixture(prisma, 'combinado@veyra.test'),
      papelCombinado,
    );
    owner = await loginAs('owner@veyra.test');
    recepcao = await loginAs('member@veyra.test');
    combinado = await loginAs('combinado@veyra.test');
    paciente = await contato('Paciente Fictícia');
    await post('/api/clinics/patients', owner, { contactId: paciente }).expect(201);
    interessado = await contato('Interessado Fictício');
  });

  /**
   * Para a pessoa: uma oportunidade e dois eventos com o texto dado, criados
   * pelo Owner — um pelo contato (organizado por `orgContato`) e um só pela
   * oportunidade (organizado por `orgOportunidade`). Organizar um evento de
   * outra pessoa gera a notificação para o organizador.
   */
  const agendaDa = async (
    contactId: string,
    texto: typeof TEXTO_DO_PACIENTE,
    offset: number,
    orgContato: string,
    orgOportunidade: string,
  ) => {
    const dealId = (await post('/api/deals', owner, { title: 'Pacote', contactId }).expect(201))
      .body.id as string;
    const janela = (min: number) => ({ startAt: iso(min), endAt: iso(min + 30) });
    const doContato = (
      await post('/api/calendar/events', owner, {
        ...texto,
        ...janela(offset),
        contactId,
        organizerMembershipId: orgContato,
      }).expect(201)
    ).body.id as string;
    const daOportunidade = (
      await post('/api/calendar/events', owner, {
        ...texto,
        ...janela(offset + 60),
        dealId,
        organizerMembershipId: orgOportunidade,
      }).expect(201)
    ).body.id as string;
    return {
      contactId,
      dealId,
      doContato,
      daOportunidade,
      inicios: [iso(offset), iso(offset + 60)],
    };
  };
  type Agenda = Awaited<ReturnType<typeof agendaDa>>;

  /**
   * O que a sessão LÊ da agenda da pessoa, por todos os caminhos: sem ids,
   * nomes nem horários (que diferem por construção e não são o sinal).
   */
  const leitura = async (s: Session, a: Agenda) => {
    const projetar = (e: Record<string, unknown>) => ({
      title: e.title,
      description: e.description,
      location: e.location,
      status: e.status,
      textRestricted: e.textRestricted,
      contato: e.contactId === a.contactId ? 'a pessoa' : e.contactId,
      oportunidade: e.dealId === a.dealId ? 'a oportunidade' : e.dealId,
    });
    const lista = async (filtro: string) => {
      const r = await get(`/api/calendar/events?${JANELA}&status=all&${filtro}`, s);
      return r.status === 200 ? (r.body as Record<string, unknown>[]).map(projetar) : r.status;
    };
    const porId = async (id: string) => {
      const r = await get(`/api/calendar/events/${id}`, s);
      return r.status === 200 ? projetar(r.body) : r.status;
    };
    const timeline = async (filtro: string) => {
      const r = await get(`/api/activities?${filtro}`, s);
      if (r.status !== 200) return r.status;
      return {
        restrictedContent: r.body.restrictedContent,
        eventos: (r.body.items as { type: string; payload: Record<string, unknown> }[])
          .filter((i) => i.type === 'event_scheduled')
          .map((i) => i.payload.title),
      };
    };
    const caixa = (await get('/api/notifications', s).expect(200)).body.items as {
      type: string;
      payload: Record<string, string>;
    }[];
    return {
      doContato: await lista(`contactId=${a.contactId}`),
      daOportunidade: await lista(`dealId=${a.dealId}`),
      porId: [await porId(a.doContato), await porId(a.daOportunidade)],
      timeline: await timeline(`contactId=${a.contactId}`),
      timelineDaOportunidade: await timeline(`dealId=${a.dealId}`),
      notificacoes: caixa
        .filter(
          (n) => n.type === 'calendar_event_scheduled' && a.inicios.includes(n.payload.startAt),
        )
        .map((n) => n.payload.title),
    };
  };

  it('uniforme: o Guest e o papel sem a agenda clínica não distinguem o paciente pelo texto da agenda do Core', async () => {
    const guest = await membro(ws.workspaceId, 'guest@veyra.test', ws.roles.guest);
    const personalizado = await membro(
      ws.workspaceId,
      'agenda-crm@veyra.test',
      await papelSemAgenda(ws.workspaceId),
    );
    const p = await agendaDa(
      paciente,
      TEXTO_DO_PACIENTE,
      60,
      guest.membership,
      personalizado.membership,
    );
    const i = await agendaDa(
      interessado,
      TEXTO_DO_INTERESSADO,
      300,
      guest.membership,
      personalizado.membership,
    );

    for (const s of [guest.sessao, personalizado.sessao]) {
      const lidoP = await leitura(s, p);
      // o sinal: o texto clínico não sai por nenhum caminho
      expect(JSON.stringify(lidoP)).not.toMatch(CLINICO);
      // a mesma resposta para o paciente e para o interessado
      expect(lidoP).toEqual(await leitura(s, i));
      // e o que é igual é o texto mascarado, com os vínculos e o estado
      const mascarado = {
        title: RESTRITO,
        description: RESTRITO,
        location: RESTRITO,
        status: 'scheduled',
        textRestricted: true,
      };
      expect(lidoP.doContato).toEqual([{ ...mascarado, contato: 'a pessoa', oportunidade: null }]);
      expect(lidoP.daOportunidade).toEqual([
        { ...mascarado, contato: null, oportunidade: 'a oportunidade' },
      ]);
      expect(lidoP.timeline).toEqual({ restrictedContent: true, eventos: [RESTRITO] });
      expect(lidoP.timelineDaOportunidade).toEqual({
        restrictedContent: true,
        eventos: [RESTRITO],
      });
    }
    // a notificação de quem organiza: uma por pessoa, mascarada
    expect((await leitura(guest.sessao, p)).notificacoes).toEqual([RESTRITO]);
    expect((await leitura(personalizado.sessao, p)).notificacoes).toEqual([RESTRITO]);
    // as datas e os ids continuam: o evento é o mesmo
    const doGuest = (await get(`/api/calendar/events/${p.doContato}`, guest.sessao).expect(200))
      .body;
    expect(doGuest).toMatchObject({ id: p.doContato, startAt: iso(60), contactId: paciente });
  });

  it('uniforme: as escritas que tocam uma pessoa são recusadas iguais; sem pessoa, como sempre', async () => {
    const operador = (
      await membro(ws.workspaceId, 'agenda-crm@veyra.test', await papelSemAgenda(ws.workspaceId))
    ).sessao;
    const escritas = async (a: Agenda) => {
      const semPessoa = (
        await post('/api/calendar/events', owner, {
          title: 'Sem pessoa',
          startAt: iso(900),
          endAt: iso(930),
        }).expect(201)
      ).body.id as string;
      const janela = { startAt: iso(1000), endAt: iso(1030) };
      const r = [
        await post('/api/calendar/events', operador, {
          title: 'x',
          ...janela,
          contactId: a.contactId,
        }),
        await post('/api/calendar/events', operador, { title: 'x', ...janela, dealId: a.dealId }),
        await enviar('patch', `/api/calendar/events/${a.doContato}`, operador, { status: 'done' }),
        await enviar('patch', `/api/calendar/events/${a.doContato}`, operador, { contactId: null }),
        await enviar('patch', `/api/calendar/events/${a.daOportunidade}`, operador, {
          title: 'outro',
        }),
        await enviar('patch', `/api/calendar/events/${semPessoa}`, operador, {
          contactId: a.contactId,
        }),
        await enviar('patch', `/api/calendar/events/${semPessoa}`, operador, { dealId: a.dealId }),
        await enviar('delete', `/api/calendar/events/${a.doContato}`, operador),
        await enviar('delete', `/api/calendar/events/${a.daOportunidade}`, operador),
      ];
      return r.map((x) => [x.status, x.body.message]);
    };
    const p = await agendaDa(
      paciente,
      TEXTO_DO_PACIENTE,
      60,
      membershipRecepcao,
      membershipRecepcao,
    );
    const i = await agendaDa(
      interessado,
      TEXTO_DO_INTERESSADO,
      300,
      membershipRecepcao,
      membershipRecepcao,
    );
    const escritoP = await escritas(p);
    expect(escritoP).toEqual(await escritas(i));
    expect(escritoP).toEqual(Array.from({ length: 9 }, () => [403, RESTRITO]));
    // nada mudou
    for (const a of [p, i]) {
      const eventos = await prisma.raw.calendarEvent.findMany({
        where: { id: { in: [a.doContato, a.daOportunidade] } },
        orderBy: { startAt: 'asc' },
      });
      expect(eventos.map((e) => [e.status, e.contactId, e.dealId])).toEqual([
        ['scheduled', a.contactId, null],
        ['scheduled', null, a.dealId],
      ]);
    }
    expect(
      await prisma.raw.calendarEvent.count({
        where: {
          workspaceId: ws.workspaceId,
          OR: [{ contactId: { not: null } }, { dealId: { not: null } }],
          title: { in: ['x', 'outro'] },
        },
      }),
    ).toBe(0);
    // o que não tem pessoa: criar, editar, ligar a uma oportunidade sem contato e apagar
    const semContato = (await post('/api/deals', operador, { title: 'Sem contato' }).expect(201))
      .body.id as string;
    const meu = (
      await post('/api/calendar/events', operador, {
        title: 'Inventário',
        location: 'Estoque',
        startAt: iso(1200),
        endAt: iso(1260),
      }).expect(201)
    ).body;
    expect(meu).toMatchObject({ title: 'Inventário', location: 'Estoque' });
    expect(meu.textRestricted).toBeUndefined();
    await enviar('patch', `/api/calendar/events/${meu.id}`, operador, {
      title: 'Inventário geral',
      dealId: semContato,
    }).expect(200);
    expect((await get(`/api/calendar/events/${meu.id}`, operador).expect(200)).body.title).toBe(
      'Inventário geral',
    );
    await enviar('delete', `/api/calendar/events/${meu.id}`, operador).expect(200);
  });

  it('restrito, a recepção: só o texto do paciente sai mascarado, e nada do que ela escrevia é recusado', async () => {
    const p = await agendaDa(
      paciente,
      TEXTO_DO_PACIENTE,
      60,
      membershipRecepcao,
      membershipRecepcao,
    );
    const i = await agendaDa(
      interessado,
      TEXTO_DO_INTERESSADO,
      300,
      membershipRecepcao,
      membershipRecepcao,
    );
    const lidoP = await leitura(recepcao, p);
    expect(JSON.stringify(lidoP)).not.toMatch(CLINICO);
    expect(lidoP.doContato).toEqual([
      {
        title: RESTRITO,
        description: RESTRITO,
        location: RESTRITO,
        status: 'scheduled',
        textRestricted: true,
        contato: 'a pessoa',
        oportunidade: null,
      },
    ]);
    expect(lidoP.timeline).toEqual({ restrictedContent: true, eventos: [RESTRITO] });
    expect(lidoP.notificacoes).toEqual([RESTRITO, RESTRITO]);
    // o interessado: o texto de sempre, sem marca
    const lidoI = await leitura(recepcao, i);
    expect(lidoI.doContato).toEqual([
      {
        ...TEXTO_DO_INTERESSADO,
        status: 'scheduled',
        textRestricted: undefined,
        contato: 'a pessoa',
        oportunidade: null,
      },
    ]);
    expect(lidoI.timeline).toEqual({
      restrictedContent: undefined,
      eventos: [TEXTO_DO_INTERESSADO.title],
    });
    expect(lidoI.notificacoes.sort()).toEqual(
      [TEXTO_DO_INTERESSADO.title, TEXTO_DO_INTERESSADO.title].sort(),
    );

    // as escritas que ela já fazia continuam: criar para o paciente (a
    // resposta segue a regra de leitura), remarcar, concluir e apagar
    const criado = (
      await post('/api/calendar/events', recepcao, {
        title: 'Confirmar horário',
        startAt: iso(600),
        endAt: iso(630),
        contactId: paciente,
      }).expect(201)
    ).body;
    expect(criado).toMatchObject({ title: RESTRITO, contactId: paciente, textRestricted: true });
    expect((await prisma.raw.calendarEvent.findFirst({ where: { id: criado.id } }))?.title).toBe(
      'Confirmar horário',
    );
    await post('/api/calendar/events', recepcao, {
      title: 'Ligar sobre o pacote',
      startAt: iso(640),
      endAt: iso(650),
      dealId: p.dealId,
    }).expect(201);
    await enviar('patch', `/api/calendar/events/${p.doContato}`, recepcao, {
      startAt: iso(90),
      endAt: iso(120),
    }).expect(200);
    await enviar('patch', `/api/calendar/events/${p.daOportunidade}`, recepcao, {
      status: 'done',
    }).expect(200);
    await enviar('delete', `/api/calendar/events/${criado.id}`, recepcao).expect(200);
    await enviar('patch', `/api/calendar/events/${i.doContato}`, recepcao, {
      title: 'Apresentar orçamento revisado',
    }).expect(200);

    // desligar o evento do paciente continua possível, mas não devolve o
    // texto: o vínculo da criação (gravado na atividade) segue valendo
    for (const [id, desligar] of [
      [p.doContato, { contactId: null }],
      [p.daOportunidade, { dealId: null, contactId: interessado }],
    ] as const) {
      const r = await enviar('patch', `/api/calendar/events/${id}`, recepcao, desligar).expect(200);
      expect(r.body).toMatchObject({ title: RESTRITO, textRestricted: true });
      expect(JSON.stringify(r.body)).not.toMatch(CLINICO);
    }
    const depois = await leitura(recepcao, p);
    expect(JSON.stringify(depois)).not.toMatch(CLINICO);
    expect(depois.notificacoes).toEqual([RESTRITO, RESTRITO]);
    // a lista do interessado, para onde um dos eventos foi levado, também não
    const doInteressado = (
      await get(`/api/calendar/events?${JANELA}&status=all&contactId=${interessado}`, recepcao)
    ).body as { title: string }[];
    expect(doInteressado.map((e) => e.title).sort()).toEqual(
      ['Apresentar orçamento revisado', RESTRITO].sort(),
    );
  });

  it('livre, "Recepção e atendimento" e o Owner: o texto de sempre, sem marca', async () => {
    const p = await agendaDa(
      paciente,
      TEXTO_DO_PACIENTE,
      60,
      membershipCombinado,
      membershipCombinado,
    );
    for (const s of [combinado, owner]) {
      const lido = await leitura(s, p);
      expect(lido.doContato).toEqual([
        {
          ...TEXTO_DO_PACIENTE,
          status: 'scheduled',
          textRestricted: undefined,
          contato: 'a pessoa',
          oportunidade: null,
        },
      ]);
      expect(lido.timeline).toEqual({
        restrictedContent: undefined,
        eventos: [TEXTO_DO_PACIENTE.title],
      });
    }
    expect((await leitura(combinado, p)).notificacoes).toEqual([
      TEXTO_DO_PACIENTE.title,
      TEXTO_DO_PACIENTE.title,
    ]);
    await enviar('patch', `/api/calendar/events/${p.doContato}`, combinado, {
      title: 'Retorno remarcado',
    }).expect(200);
  });

  it('a repetição com a mesma chave segue a regra de AGORA: o interessado que vira paciente sai mascarado', async () => {
    const chave = { 'Idempotency-Key': 'evento-do-interessado-1' };
    const corpo = {
      ...TEXTO_DO_INTERESSADO,
      startAt: iso(60),
      endAt: iso(90),
      contactId: interessado,
    };
    const primeiro = (await post('/api/calendar/events', recepcao, corpo, chave).expect(201)).body;
    expect(primeiro.title).toBe(TEXTO_DO_INTERESSADO.title);
    await post('/api/clinics/patients', owner, { contactId: interessado }).expect(201);
    const repetido = (await post('/api/calendar/events', recepcao, corpo, chave).expect(201)).body;
    expect(repetido).toMatchObject({ id: primeiro.id, title: RESTRITO, textRestricted: true });
    expect(await prisma.raw.calendarEvent.count({ where: { workspaceId: ws.workspaceId } })).toBe(
      1,
    );
  });

  it('a desativação mantém a proteção: o Owner também fica no uniforme', async () => {
    const p = await agendaDa(
      paciente,
      TEXTO_DO_PACIENTE,
      60,
      membershipRecepcao,
      membershipRecepcao,
    );
    const i = await agendaDa(
      interessado,
      TEXTO_DO_INTERESSADO,
      300,
      membershipRecepcao,
      membershipRecepcao,
    );
    await app.get(ClinicsActivationService).disable('acme');
    owner = await loginAs('owner@veyra.test');
    const lidoP = await leitura(owner, p);
    expect(JSON.stringify(lidoP)).not.toMatch(CLINICO);
    expect(lidoP).toEqual(await leitura(owner, i));
    await post('/api/calendar/events', owner, {
      title: 'x',
      startAt: iso(700),
      endAt: iso(730),
      contactId: interessado,
    }).expect(403);
  });

  it('num workspace que nunca ativou o Clinics, o mesmo papel tem a agenda de sempre', async () => {
    const beta = await createWorkspaceFixture(prisma, 'beta');
    const { sessao: operador } = await membro(
      beta.workspaceId,
      'agenda-beta@veyra.test',
      await papelSemAgenda(beta.workspaceId),
    );
    const { sessao: guest, membership: guestBeta } = await membro(
      beta.workspaceId,
      'guest-beta@veyra.test',
      beta.roles.guest,
    );
    const c = (await post('/api/contacts', operador, { name: 'Contato do Core' }).expect(201)).body
      .id as string;
    const criado = (
      await post('/api/calendar/events', operador, {
        ...TEXTO_DO_INTERESSADO,
        startAt: iso(60),
        endAt: iso(90),
        contactId: c,
        organizerMembershipId: guestBeta,
      }).expect(201)
    ).body;
    expect(criado).toMatchObject(TEXTO_DO_INTERESSADO);
    expect(criado.textRestricted).toBeUndefined();
    for (const s of [operador, guest]) {
      expect((await get(`/api/calendar/events/${criado.id}`, s).expect(200)).body).toMatchObject(
        TEXTO_DO_INTERESSADO,
      );
      const timeline = (await get(`/api/activities?contactId=${c}`, s).expect(200)).body;
      expect(timeline.restrictedContent).toBeUndefined();
      expect(
        timeline.items.find((a: { type: string }) => a.type === 'event_scheduled').payload.title,
      ).toBe(TEXTO_DO_INTERESSADO.title);
    }
    const caixa = (await get('/api/notifications', guest).expect(200)).body.items;
    expect(caixa.map((n: { payload: { title: string } }) => n.payload.title)).toEqual([
      TEXTO_DO_INTERESSADO.title,
    ]);
    await enviar('patch', `/api/calendar/events/${criado.id}`, operador, { status: 'done' }).expect(
      200,
    );
    await enviar('delete', `/api/calendar/events/${criado.id}`, operador).expect(200);
  });
});
