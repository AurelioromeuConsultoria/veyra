import type { INestApplication } from '@nestjs/common';
import {
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
  CLINICS_RECEPTION_CARE_SYSTEM_KEY,
} from '@veyra/contracts/verticals/clinics';
import { Client } from 'pg';
import request from 'supertest';
import { generateOpaqueToken, sha256 } from '../../auth/tokens';
import { PrismaService } from '../../prisma/prisma.service';
import { PAPEL_INDISPONIVEL } from '../../workspaces/members.service';
import { createTestApp } from '../../../test/integration/app';
import { TEST_DATABASE_URL } from '../../../test/integration/db-url';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../test/integration/fixtures';
import { resetDb } from '../../../test/integration/harness';
import { esperarBloqueadosPor } from '../../../test/integration/locks';
import { ClinicsActivationService } from './clinics-activation.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const INVALIDO = 'Convite inválido ou expirado';

interface Session {
  cookieHeader: string;
  csrf: string;
}

/**
 * ADR-056 adendo 1: com o Clinics desativado, nenhum papel dele é atribuído — o
 * convite, o aceite e a troca recusam no servidor —, e a reativação não
 * transforma a tentativa numa concessão. Os vínculos atuais ficam, e sair do
 * papel continua livre. Dados fictícios.
 */
describe('ADR-056 adendo 1 — papel do vertical desativado não é atribuído (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let activation: ClinicsActivationService;
  let ws: WorkspaceFixture;
  let recepcao: string;
  let profissional: string;
  let memberId: string;
  /** o alvo do operador: o Guest cabe nas chaves dele, com o Clinics ativo ou não */
  let guestId: string;
  /** o que uma corrida deixa em aberto: soltos no afterEach, ou o jest não sai */
  let trava: Client | null = null;
  let pendentes: Promise<unknown>[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
    activation = app.get(ClinicsActivationService);
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    ws = await createWorkspaceFixture(prisma, 'acme');
    for (const systemKey of ['owner', 'admin', 'member', 'guest']) {
      const user = await createUserFixture(prisma, `${systemKey}-a@veyra.test`);
      const id = await createMembershipFixture(prisma, ws.workspaceId, user, ws.roles[systemKey]);
      if (systemKey === 'member') memberId = id;
      if (systemKey === 'guest') guestId = id;
    }
    await activation.enable('acme');
    recepcao = (
      await prisma.raw.role.findFirstOrThrow({
        where: { workspaceId: ws.workspaceId, systemKey: CLINICS_RECEPTION_CARE_SYSTEM_KEY },
      })
    ).id;
    profissional = (
      await prisma.raw.role.findFirstOrThrow({
        where: { workspaceId: ws.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
      })
    ).id;
  });

  afterEach(async () => {
    if (trava) {
      await trava.query('ROLLBACK').catch(() => undefined);
      await trava.end().catch(() => undefined);
      trava = null;
    }
    await Promise.allSettled(pendentes);
    pendentes = [];
    respondidas.length = 0;
  });

  const loginAs = async (email: string, password = TEST_PASSWORD): Promise<Session> => {
    const res = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password })
      .expect(201);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
    return { cookieHeader, csrf: /veyra_csrf=([^;]+)/.exec(cookieHeader)?.[1] ?? '' };
  };
  const send = (
    method: 'post' | 'patch' | 'delete',
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
  const convidar = (s: Session, email: string, roleId: string) =>
    send('post', '/api/invites', s, { email, roleId });
  const trocar = (s: Session, membershipId: string, roleId: string) =>
    send('patch', `/api/members/${membershipId}/role`, s, { roleId });
  const aceitar = (token: string, email: string) =>
    request(http)
      .post('/api/invites/accept')
      .set('Origin', ORIGIN)
      .send({ token, name: email.split('@')[0], password: 'senha-forte-123' });
  const papelDe = async (membershipId: string) =>
    (await prisma.raw.membership.findFirstOrThrow({ where: { id: membershipId } })).roleId;
  const trilha = (action: string) =>
    prisma.raw.auditLog.findMany({ where: { workspaceId: ws.workspaceId, action } });

  /**
   * O operador do ADR: gere a equipe e tem as chaves do Member, mas não o
   * atendimento. Um papel personalizado, criado com o Clinics ativo. Devolve o
   * id do papel.
   */
  const operadorSemAtendimento = async (): Promise<string> => {
    const gestor = await prisma.raw.role.create({
      data: { workspaceId: ws.workspaceId, name: 'Gestor da recepção', isSystem: false },
    });
    const chavesDoMember = (
      await prisma.raw.rolePermission.findMany({ where: { roleId: ws.roles.member } })
    ).map((rp) => rp.permissionKey);
    expect(chavesDoMember).not.toContain('clinics:care:write');
    await prisma.raw.rolePermission.createMany({
      data: [...chavesDoMember, 'members:manage'].map((permissionKey) => ({
        workspaceId: ws.workspaceId,
        roleId: gestor.id,
        permissionKey,
      })),
    });
    const user = await createUserFixture(prisma, 'gestor-a@veyra.test');
    await createMembershipFixture(prisma, ws.workspaceId, user, gestor.id);
    return gestor.id;
  };

  /** Segura uma linha numa transação aberta: quem a gravar para nela. */
  const segurarLinha = async (sql: string, params: unknown[]): Promise<Client> => {
    const c = new Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    trava = c;
    await c.query('BEGIN');
    await c.query(sql, params);
    return c;
  };
  /** A linha da ativação: a mudança para nela, já com a trava dos membros. */
  const pararNaLinhaDaAtivacao = () =>
    segurarLinha('SELECT id FROM "ClinicsSettings" WHERE "workspaceId" = $1 FOR UPDATE', [
      ws.workspaceId,
    ]);

  /** Dispara sem esperar, guardando para o afterEach; `respondidas` aborta a espera cedo. */
  const respondidas: string[] = [];
  const disparar = <T>(nome: string, p: PromiseLike<T>): Promise<T> => {
    const promessa = Promise.resolve(p).then((r) => {
      respondidas.push(nome);
      return r;
    });
    pendentes.push(promessa);
    return promessa;
  };
  /** todas estão paradas atrás da trava: nenhuma pode ter respondido */
  const nenhumaRespondeu = () => {
    if (respondidas.length > 0) {
      throw new Error(`responderam sem esperar a trava: ${respondidas.join(', ')}`);
    }
  };

  it('o caso do ADR: com o Clinics desativado, o convite e a troca recusam (409); reativado, nada foi concedido e a mesma tentativa dá 403', async () => {
    const papelDoGestor = await operadorSemAtendimento();
    await activation.disable('acme');
    const gestor = await loginAs('gestor-a@veyra.test');

    for (const roleId of [recepcao, profissional]) {
      const convite = await convidar(gestor, 'x@veyra.test', roleId).expect(409);
      expect(convite.body.message).toBe(PAPEL_INDISPONIVEL);
      const troca = await trocar(gestor, guestId, roleId).expect(409);
      expect(troca.body.message).toBe(PAPEL_INDISPONIVEL);
    }
    // a recusa é do estado, não de quem pede: nem o Owner atribui agora
    const owner = await loginAs('owner-a@veyra.test');
    await convidar(owner, 'y@veyra.test', recepcao).expect(409);
    await trocar(owner, guestId, recepcao).expect(409);
    expect(await prisma.raw.invite.count({ where: { workspaceId: ws.workspaceId } })).toBe(0);
    expect(await papelDe(guestId)).toBe(ws.roles.guest);
    expect(await trilha('member.role_changed')).toHaveLength(0);

    // a reativação devolve as chaves ao papel; a tentativa não virou concessão
    await activation.enable('acme');
    expect(await papelDe(guestId)).toBe(ws.roles.guest);
    const alvo = await loginAs('guest-a@veyra.test');
    const me = await request(http).get('/api/auth/me').set('Cookie', alvo.cookieHeader);
    expect(me.body.permissions.filter((k: string) => k.startsWith('clinics:'))).toEqual([]);
    // e o operador, que nunca teve o atendimento, continua sem poder concedê-lo.
    // Com as chaves da recepção de volta (a reativação não as devolve ao papel
    // personalizado), ele atribui o Member; o que falta para o papel combinado
    // é SÓ o atendimento
    await prisma.raw.rolePermission.createMany({
      data: (await prisma.raw.rolePermission.findMany({ where: { roleId: ws.roles.member } }))
        .filter((rp) => rp.permissionKey.startsWith('clinics:'))
        .map((rp) => ({
          workspaceId: ws.workspaceId,
          roleId: papelDoGestor,
          permissionKey: rp.permissionKey,
        })),
    });
    const deNovo = await loginAs('gestor-a@veyra.test');
    await convidar(deNovo, 'recepcao@veyra.test', ws.roles.member).expect(201);
    await convidar(deNovo, 'x@veyra.test', recepcao).expect(403);
    await trocar(deNovo, guestId, recepcao).expect(403);
    expect(await papelDe(guestId)).toBe(ws.roles.guest);
  });

  it('convite emitido antes da desativação e aceito durante ela: invalidado de vez, com trilha; a reativação não o ressuscita', async () => {
    const admin = await loginAs('admin-a@veyra.test');
    const doMembro = (await convidar(admin, 'nova@veyra.test', recepcao).expect(201)).body as {
      id: string;
      token: string;
    };
    // o da operação também: a disponibilidade vale para qualquer convite
    const tokenDaOperacao = generateOpaqueToken();
    const daOperacao = await prisma.raw.invite.create({
      data: {
        workspaceId: ws.workspaceId,
        email: 'operacao@veyra.test',
        roleId: profissional,
        tokenHash: sha256(tokenDaOperacao),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        issuedByProvisioning: true,
      },
    });
    await activation.disable('acme');

    for (const [token, email] of [
      [doMembro.token, 'nova@veyra.test'],
      [tokenDaOperacao, 'operacao@veyra.test'],
    ]) {
      const res = await aceitar(token, email).expect(400);
      expect(res.body.message).toBe(INVALIDO);
    }
    expect(await prisma.raw.invite.count({ where: { workspaceId: ws.workspaceId } })).toBe(0);
    const invalidados = await trilha('invite.invalidated');
    expect(invalidados).toHaveLength(2);
    expect(invalidados).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityId: doMembro.id, before: { roleId: recepcao } }),
        expect.objectContaining({ entityId: daOperacao.id, before: { roleId: profissional } }),
      ]),
    );
    expect(
      await prisma.raw.user.count({
        where: { email: { in: ['nova@veyra.test', 'operacao@veyra.test'] } },
      }),
    ).toBe(0);

    await activation.enable('acme');
    await aceitar(doMembro.token, 'nova@veyra.test').expect(400);
    await aceitar(tokenDaOperacao, 'operacao@veyra.test').expect(400);
    expect(await prisma.raw.membership.count({ where: { workspaceId: ws.workspaceId } })).toBe(4);
  });

  it('com o Clinics desativado, os vínculos ficam e sair continua livre: trocar para o Member, remover, revogar; os papéis do Core seguem atribuíveis', async () => {
    const fica = await createMembershipFixture(
      prisma,
      ws.workspaceId,
      await createUserFixture(prisma, 'rc-fica@veyra.test'),
      recepcao,
    );
    const sai = await createMembershipFixture(
      prisma,
      ws.workspaceId,
      await createUserFixture(prisma, 'rc-sai@veyra.test'),
      recepcao,
    );
    const removido = await createMembershipFixture(
      prisma,
      ws.workspaceId,
      await createUserFixture(prisma, 'prof-sai@veyra.test'),
      profissional,
    );
    const pendente = (
      await convidar(
        await loginAs('admin-a@veyra.test'),
        'pendente@veyra.test',
        profissional,
      ).expect(201)
    ).body as { id: string };
    await activation.disable('acme');
    const admin = await loginAs('admin-a@veyra.test');

    expect(await papelDe(fica)).toBe(recepcao);
    await trocar(admin, sai, ws.roles.member).expect(200);
    expect(await papelDe(sai)).toBe(ws.roles.member);
    await send('delete', `/api/members/${removido}`, admin).expect(200);
    await send('delete', `/api/invites/${pendente.id}`, admin).expect(200);
    expect(await prisma.raw.invite.count({ where: { id: pendente.id } })).toBe(0);
    // os papéis do Core: o workspace segue como CRM
    await trocar(admin, memberId, ws.roles.guest).expect(200);
    await trocar(admin, guestId, ws.roles.member).expect(200);
    await convidar(admin, 'crm@veyra.test', ws.roles.member).expect(201);
    expect(await papelDe(fica)).toBe(recepcao);
  });

  it('papel de extensão que a composição não conhece nunca é atribuível, mesmo com chave dela', async () => {
    await prisma.raw.permission.create({
      data: { key: 'semproduto:ler', description: 'chave de uma extensão não composta' },
    });
    const papel = await prisma.raw.role.create({
      data: {
        workspaceId: ws.workspaceId,
        name: 'Papel sem produto',
        isSystem: true,
        systemKey: 'semproduto:papel',
      },
    });
    // o Owner também tem a chave: o subconjunto passa, e a recusa é da disponibilidade
    await prisma.raw.rolePermission.createMany({
      data: [papel.id, ws.roles.owner].map((roleId) => ({
        workspaceId: ws.workspaceId,
        roleId,
        permissionKey: 'semproduto:ler',
      })),
    });
    const owner = await loginAs('owner-a@veyra.test');
    const convite = await convidar(owner, 'x@veyra.test', papel.id).expect(409);
    expect(convite.body.message).toBe(PAPEL_INDISPONIVEL);
    const troca = await trocar(owner, memberId, papel.id).expect(409);
    expect(troca.body.message).toBe(PAPEL_INDISPONIVEL);
    expect(await papelDe(memberId)).toBe(ws.roles.member);
  });

  it('corrida com a desativação: parada depois da trava dos membros, a troca, o convite e o aceite esperam, e recusam', async () => {
    const admin = await loginAs('admin-a@veyra.test');
    const convite = (await convidar(admin, 'nova@veyra.test', recepcao).expect(201)).body as {
      id: string;
      token: string;
    };
    const c = await pararNaLinhaDaAtivacao();
    const desativacao = disparar('desativação', activation.disable('acme'));
    await esperarBloqueadosPor(c, 1, {
      descricao: 'a desativação',
      aCadaTentativa: nenhumaRespondeu,
    });

    const troca = disparar('troca', trocar(admin, memberId, recepcao));
    const novo = disparar('convite', convidar(admin, 'outra@veyra.test', recepcao));
    const aceite = disparar('aceite', aceitar(convite.token, 'nova@veyra.test'));
    // a desativação (direto) e as três atrás dela, na trava dos membros
    await esperarBloqueadosPor(c, 4, {
      descricao: 'a desativação e as três atribuições',
      aCadaTentativa: nenhumaRespondeu,
    });
    await c.query('COMMIT');
    await c.end();
    trava = null;

    expect((await desativacao).outcome).toBe('disabled');
    const [t, n, a] = await Promise.all([troca, novo, aceite]);
    expect({ troca: t.status, convite: n.status, aceite: a.status }).toEqual({
      troca: 409,
      convite: 409,
      aceite: 400,
    });
    expect(t.body.message).toBe(PAPEL_INDISPONIVEL);
    expect(n.body.message).toBe(PAPEL_INDISPONIVEL);
    expect(a.body.message).toBe(INVALIDO);
    expect(await papelDe(memberId)).toBe(ws.roles.member);
    expect(await prisma.raw.invite.count({ where: { workspaceId: ws.workspaceId } })).toBe(0);
    expect((await trilha('invite.invalidated')).map((r) => r.entityId)).toEqual([convite.id]);
  });

  it('corrida com a desativação, no outro sentido: a troca em andamento termina antes, e a desativação a vê (o tokenVersion cai)', async () => {
    const admin = await loginAs('admin-a@veyra.test');
    const antes = await prisma.raw.membership.findFirstOrThrow({ where: { id: guestId } });
    // a troca para na linha da membership, já com a trava dos membros e as leituras feitas
    const c = await segurarLinha('SELECT id FROM "Membership" WHERE id = $1 FOR UPDATE', [guestId]);
    const troca = disparar('troca', trocar(admin, guestId, recepcao));
    await esperarBloqueadosPor(c, 1, { descricao: 'a troca', aCadaTentativa: nenhumaRespondeu });
    const desativacao = disparar('desativação', activation.disable('acme'));
    // a desativação espera a troca, na trava dos membros
    await esperarBloqueadosPor(c, 2, {
      descricao: 'a troca e a desativação atrás dela',
      aCadaTentativa: nenhumaRespondeu,
    });
    await c.query('COMMIT');
    await c.end();
    trava = null;

    expect((await troca).status).toBe(200);
    expect((await desativacao).outcome).toBe('disabled');
    // o vínculo atribuído com o Clinics ativo fica, e a desativação derrubou o
    // acesso dele junto com os demais: a troca e a desativação, uma vez cada
    expect(await prisma.raw.membership.findFirstOrThrow({ where: { id: guestId } })).toMatchObject({
      roleId: recepcao,
      tokenVersion: antes.tokenVersion + 2,
    });
    expect(
      await prisma.raw.rolePermission.count({
        where: { roleId: recepcao, permissionKey: { startsWith: 'clinics:' } },
      }),
    ).toBe(0);
  });

  it('corrida com a reativação: parada depois da trava dos membros, a troca espera e lê o papel já com o atendimento (403, não 409)', async () => {
    await operadorSemAtendimento();
    await activation.disable('acme');
    const gestor = await loginAs('gestor-a@veyra.test');
    const c = await pararNaLinhaDaAtivacao();
    const reativacao = disparar('reativação', activation.enable('acme'));
    await esperarBloqueadosPor(c, 1, {
      descricao: 'a reativação',
      aCadaTentativa: nenhumaRespondeu,
    });

    const troca = disparar('troca', trocar(gestor, guestId, recepcao));
    await esperarBloqueadosPor(c, 2, {
      descricao: 'a reativação e a troca',
      aCadaTentativa: nenhumaRespondeu,
    });
    await c.query('COMMIT');
    await c.end();
    trava = null;

    expect((await reativacao).outcome).toBe('reenabled');
    // sem a trava na reativação, a troca leria o papel ainda sem as chaves: 409
    const t = await troca;
    expect(t.status).toBe(403);
    expect(await papelDe(guestId)).toBe(ws.roles.guest);
  });
});
