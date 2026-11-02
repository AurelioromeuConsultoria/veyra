import type { INestApplication } from '@nestjs/common';
import {
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
  CLINICS_RECEPTION_CARE_SYSTEM_KEY,
} from '@veyra/contracts/verticals/clinics';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
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
import { CLINICS_VERTICAL_ROLES, chavesPadraoDoPapel } from './clinics-permissions';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

/**
 * F5.1b, D7 (ADR-056): o papel combinado "Recepção e atendimento", pela tela de
 * equipe da F5.1a — o convite, o aceite e a troca de papel com as regras de
 * sempre — e o que ele pode e não pode na API. Dados fictícios.
 */
describe('F5.1b — "Recepção e atendimento" (ADR-056): atribuição, recusas e isolamento (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let recepcaoA: string;
  let recepcaoB: string;
  let profissionalA: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });

  const roleBySystemKey = async (workspaceId: string, systemKey: string): Promise<string> =>
    (await prisma.raw.role.findFirstOrThrow({ where: { workspaceId, systemKey } })).id;

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    for (const systemKey of ['owner', 'admin', 'member']) {
      const user = await createUserFixture(prisma, `${systemKey}-a@veyra.test`);
      await createMembershipFixture(prisma, wsA.workspaceId, user, wsA.roles[systemKey]);
    }
    const ownerB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, ownerB, wsB.roles.owner);
    const activation = app.get(ClinicsActivationService);
    await activation.enable('acme');
    await activation.enable('beta');
    recepcaoA = await roleBySystemKey(wsA.workspaceId, CLINICS_RECEPTION_CARE_SYSTEM_KEY);
    recepcaoB = await roleBySystemKey(wsB.workspaceId, CLINICS_RECEPTION_CARE_SYSTEM_KEY);
    profissionalA = await roleBySystemKey(wsA.workspaceId, CLINICS_PROFESSIONAL_SYSTEM_KEY);
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
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);
  const send = (
    method: 'post' | 'patch' | 'put' | 'delete',
    path: string,
    s: Session,
    body: Record<string, unknown> = {},
  ) =>
    request(http)
      [method](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send(body);

  /** Uma pessoa com o papel combinado no workspace A. */
  const comRecepcaoEAtendimento = async (email: string): Promise<{ membershipId: string }> => {
    const user = await createUserFixture(prisma, email);
    const membershipId = await createMembershipFixture(prisma, wsA.workspaceId, user, recepcaoA);
    return { membershipId };
  };

  it('/api/roles traz o papel com o systemKey, a matriz padrão e a descrição; o personalizado vem com systemKey null', async () => {
    await prisma.raw.role.create({
      data: { workspaceId: wsA.workspaceId, name: 'Recepção noturna', isSystem: false },
    });
    const owner = await loginAs('owner-a@veyra.test');
    const res = await get('/api/roles', owner).expect(200);
    const papeis = res.body as {
      id: string;
      name: string;
      systemKey: string | null;
      description: string | null;
      permissions: string[];
    }[];
    const combinado = papeis.find((r) => r.id === recepcaoA)!;
    const padrao = CLINICS_VERTICAL_ROLES.find(
      (p) => p.systemKey === CLINICS_RECEPTION_CARE_SYSTEM_KEY,
    )!;
    expect(combinado).toMatchObject({
      name: 'Recepção e atendimento',
      systemKey: CLINICS_RECEPTION_CARE_SYSTEM_KEY,
      description: padrao.description,
    });
    expect([...combinado.permissions].sort()).toEqual(chavesPadraoDoPapel(padrao));
    expect(papeis.find((r) => r.id === wsA.roles.member)?.systemKey).toBe('member');
    expect(papeis.find((r) => r.name === 'Recepção noturna')?.systemKey).toBeNull();
    // o papel do workspace B não aparece no A
    expect(papeis.some((r) => r.id === recepcaoB)).toBe(false);
  });

  it('o Owner e o Admin convidam com o papel; o aceite cria a membership com ele, e a sessão traz o roleSystemKey', async () => {
    const owner = await loginAs('owner-a@veyra.test');
    const admin = await loginAs('admin-a@veyra.test');
    const convite = await send('post', '/api/invites', owner, {
      email: 'nova@veyra.test',
      roleId: recepcaoA,
    }).expect(201);
    await send('post', '/api/invites', admin, {
      email: 'outra@veyra.test',
      roleId: recepcaoA,
    }).expect(201);
    // o convite e, depois do aceite, o membro trazem a chave do papel (só para a apresentação)
    const convites = (await get('/api/invites', owner).expect(200)).body as {
      email: string;
      roleSystemKey: string | null;
    }[];
    expect(convites.find((c) => c.email === 'nova@veyra.test')?.roleSystemKey).toBe(
      CLINICS_RECEPTION_CARE_SYSTEM_KEY,
    );

    await request(http)
      .post('/api/invites/accept')
      .set('Origin', ORIGIN)
      .send({ token: convite.body.token, name: 'Nova Pessoa', password: 'senha-forte-123' })
      .expect(201);
    const user = await prisma.raw.user.findFirstOrThrow({ where: { email: 'nova@veyra.test' } });
    const membership = await prisma.raw.membership.findFirstOrThrow({
      where: { workspaceId: wsA.workspaceId, userId: user.id },
    });
    expect(membership).toMatchObject({ roleId: recepcaoA, status: 'active' });
    const membros = (await get('/api/members', owner).expect(200)).body as {
      membershipId: string;
      roleSystemKey: string | null;
    }[];
    expect(membros.find((m) => m.membershipId === membership.id)?.roleSystemKey).toBe(
      CLINICS_RECEPTION_CARE_SYSTEM_KEY,
    );

    const nova = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'nova@veyra.test', password: 'senha-forte-123' })
      .expect(201);
    const cookies = ((nova.headers['set-cookie'] as unknown as string[]) ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const me = await request(http).get('/api/auth/me').set('Cookie', cookies).expect(200);
    expect(me.body.activeMembership).toMatchObject({
      roleName: 'Recepção e atendimento',
      roleSystemKey: CLINICS_RECEPTION_CARE_SYSTEM_KEY,
    });
    expect([...me.body.permissions].sort()).toEqual(
      chavesPadraoDoPapel(
        CLINICS_VERTICAL_ROLES.find((p) => p.systemKey === CLINICS_RECEPTION_CARE_SYSTEM_KEY)!,
      ),
    );
  });

  it('quem não tem TODAS as chaves do papel não o atribui (o subconjunto): o convite e a troca são recusados', async () => {
    // um gestor da recepção: gere a equipe, mas não tem o atendimento
    const gestor = await prisma.raw.role.create({
      data: { workspaceId: wsA.workspaceId, name: 'Gestor da recepção', isSystem: false },
    });
    const chavesDoMember = (
      await prisma.raw.rolePermission.findMany({ where: { roleId: wsA.roles.member } })
    ).map((rp) => rp.permissionKey);
    await prisma.raw.rolePermission.createMany({
      data: [...chavesDoMember, 'members:manage'].map((permissionKey) => ({
        workspaceId: wsA.workspaceId,
        roleId: gestor.id,
        permissionKey,
      })),
    });
    const user = await createUserFixture(prisma, 'gestor-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, user, gestor.id);
    const sessao = await loginAs('gestor-a@veyra.test');

    await send('post', '/api/invites', sessao, {
      email: 'x@veyra.test',
      roleId: recepcaoA,
    }).expect(403);
    const member = await prisma.raw.membership.findFirstOrThrow({
      where: { workspaceId: wsA.workspaceId, roleId: wsA.roles.member },
    });
    await send('patch', `/api/members/${member.id}/role`, sessao, { roleId: recepcaoA }).expect(
      403,
    );
    expect(await prisma.raw.invite.count({ where: { workspaceId: wsA.workspaceId } })).toBe(0);
    expect(
      (await prisma.raw.membership.findFirstOrThrow({ where: { id: member.id } })).roleId,
    ).toBe(wsA.roles.member);

    // o Member (sem `members:manage`) não convida ninguém
    const recepcao = await loginAs('member-a@veyra.test');
    await send('post', '/api/invites', recepcao, {
      email: 'y@veyra.test',
      roleId: recepcaoA,
    }).expect(403);
  });

  it('a troca para o papel: o Admin troca, o acesso emitido antes cai, e a trilha registra', async () => {
    const admin = await loginAs('admin-a@veyra.test');
    const alvo = await loginAs('member-a@veyra.test');
    await get('/api/auth/me', alvo).expect(200);
    const member = await prisma.raw.membership.findFirstOrThrow({
      where: { workspaceId: wsA.workspaceId, roleId: wsA.roles.member },
    });

    await send('patch', `/api/members/${member.id}/role`, admin, { roleId: recepcaoA }).expect(200);
    expect(
      (await prisma.raw.membership.findFirstOrThrow({ where: { id: member.id } })).roleId,
    ).toBe(recepcaoA);
    await get('/api/auth/me', alvo).expect(401);
    const trilha = await prisma.raw.auditLog.findFirstOrThrow({
      where: { workspaceId: wsA.workspaceId, action: 'member.role_changed', entityId: member.id },
    });
    expect(trilha.after).toMatchObject({ roleId: recepcaoA });
  });

  it('o que o papel pode e não pode na API: agenda e atendimento sim; equipe, IA, catálogo e auditoria não', async () => {
    const { membershipId } = await comRecepcaoEAtendimento('rc-a@veyra.test');
    const s = await loginAs('rc-a@veyra.test');
    const naoExiste = randomUUID();

    // leituras do Core e do Clinics
    for (const path of [
      '/api/members',
      '/api/roles',
      '/api/contacts',
      '/api/conversations',
      '/api/clinics/patients',
      '/api/clinics/services',
    ]) {
      const res = await get(path, s);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
    // a leitura do atendimento exige o paciente: passa pela autorização e para na validação
    const agenda = await get('/api/clinics/appointments', s);
    expect({
      path: 'GET /api/clinics/appointments',
      autorizado: [200, 400].includes(agenda.status),
    }).toEqual({ path: 'GET /api/clinics/appointments', autorizado: true });
    const pacotes = await get('/api/clinics/packages', s);
    expect({ path: 'GET /api/clinics/packages', status: pacotes.status }).toEqual({
      path: 'GET /api/clinics/packages',
      status: 400,
    });
    // as escritas da agenda e do atendimento passam pela autorização (a recusa,
    // se vier, é da validação ou do registro inexistente, nunca 403)
    for (const [path, body] of [
      ['/api/clinics/appointments', {}],
      [`/api/clinics/appointments/${naoExiste}/attendance`, {}],
      ['/api/clinics/packages', {}],
    ] as const) {
      const res = await send('post', path, s, body);
      expect({
        path,
        status: res.status,
        autorizado: [400, 404, 409, 422].includes(res.status),
      }).toMatchObject({
        path,
        autorizado: true,
      });
    }

    // as recusas: a gestão de equipe, a liberação para IA, o catálogo e a auditoria
    const recusas: [string, () => request.Test][] = [
      [
        'convidar',
        () => send('post', '/api/invites', s, { email: 'z@veyra.test', roleId: recepcaoA }),
      ],
      [
        'trocar papel',
        () => send('patch', `/api/members/${membershipId}/role`, s, { roleId: recepcaoA }),
      ],
      ['remover', () => send('delete', `/api/members/${membershipId}`, s)],
      ['auditoria', () => get('/api/audit', s)],
      ['liberações para IA', () => get('/api/clinics/ai-releases', s)],
      [
        'liberar contato para IA',
        () =>
          send('post', `/api/clinics/contacts/${naoExiste}/ai-release`, s, { reason: 'supplier' }),
      ],
      ['catálogo', () => send('post', '/api/clinics/services', s, { name: 'Serviço' })],
    ];
    for (const [nome, chamar] of recusas) {
      const res = await chamar();
      expect({ nome, status: res.status }).toEqual({ nome, status: 403 });
    }

    // o contraste: a recepção sozinha não registra atendimento, e o atendimento
    // sozinho não agenda — o papel combinado é a soma dos dois
    const recepcao = await loginAs('member-a@veyra.test');
    await send('post', `/api/clinics/appointments/${naoExiste}/attendance`, recepcao, {}).expect(
      403,
    );
    const userP = await createUserFixture(prisma, 'prof-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, userP, profissionalA);
    const profissional = await loginAs('prof-a@veyra.test');
    await send('post', '/api/clinics/appointments', profissional, {}).expect(403);
  });

  it('isolamento (P0): o papel de um workspace não é atribuível noutro', async () => {
    const ownerB = await loginAs('owner-b@veyra.test');
    const res = await send('post', '/api/invites', ownerB, {
      email: 'cruzado@veyra.test',
      roleId: recepcaoA,
    });
    expect([400, 403, 404]).toContain(res.status);
    expect(await prisma.raw.invite.count()).toBe(0);
    // o mesmo papel, o do próprio B, passa
    await send('post', '/api/invites', ownerB, {
      email: 'certo@veyra.test',
      roleId: recepcaoB,
    }).expect(201);

    // a troca de papel: quem gere o A não troca ninguém para o papel do B
    const owner = await loginAs('owner-a@veyra.test');
    const member = await prisma.raw.membership.findFirstOrThrow({
      where: { workspaceId: wsA.workspaceId, roleId: wsA.roles.member },
    });
    const troca = await send('patch', `/api/members/${member.id}/role`, owner, {
      roleId: recepcaoB,
    });
    expect([400, 403, 404]).toContain(troca.status);
    // e, pela outra via, quem gere o B não troca o papel de um membro do A
    const peloB = await send('patch', `/api/members/${member.id}/role`, ownerB, {
      roleId: recepcaoB,
    });
    expect([403, 404]).toContain(peloB.status);
    expect(
      await prisma.raw.membership.findFirstOrThrow({ where: { id: member.id } }),
    ).toMatchObject({ roleId: wsA.roles.member, tokenVersion: member.tokenVersion });
  });

  it('vincular a conta a um profissional não concede permissão nem muda o papel', async () => {
    const owner = await loginAs('owner-a@veyra.test');
    const prof = await send('post', '/api/clinics/professionals', owner, {
      name: 'Profissional fictícia',
    }).expect(201);
    const member = await prisma.raw.membership.findFirstOrThrow({
      where: { workspaceId: wsA.workspaceId, roleId: wsA.roles.member },
    });
    const recepcao = await loginAs('member-a@veyra.test');
    const antes = (await get('/api/auth/me', recepcao).expect(200)).body.permissions as string[];

    await send('put', `/api/clinics/professionals/${prof.body.id}/account`, owner, {
      membershipId: member.id,
    }).expect(200);

    const depois = await loginAs('member-a@veyra.test');
    const me = await get('/api/auth/me', depois).expect(200);
    expect([...me.body.permissions].sort()).toEqual([...antes].sort());
    expect(me.body.permissions).not.toContain('clinics:care:write');
    expect(
      (await prisma.raw.membership.findFirstOrThrow({ where: { id: member.id } })).roleId,
    ).toBe(wsA.roles.member);
  });
});
