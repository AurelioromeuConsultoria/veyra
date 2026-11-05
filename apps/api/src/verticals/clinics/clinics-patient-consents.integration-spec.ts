import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ConsentPurposesService } from '../../consents/consent-purposes.service';
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
const NUM_P = '+5511987650001';
const NUM_I = '+5511987650002';

interface Session {
  cookieHeader: string;
  csrf: string;
}

type Consentimento = {
  id: string;
  purposeKey: string;
  origin: string;
  revokedAt: string | null;
  revocationReason: string | null;
};

/**
 * B1, item 7 (ADR-061, adendo 8): a lista de consentimentos por contato sob o
 * E8. Quem tem `consents:read` e NÃO tem a agenda (o `uniforme`) não distingue
 * paciente de interessado pelas finalidades da extensão: elas saem da lista de
 * TODO contato, pelo contato e pela conversa, e também da concessão, da
 * revogação por id, das finalidades oferecidas e da trilha (`consent.revoked`).
 * A recepção (com a agenda) e o workspace sem o Clinics ficam como estão.
 * Dados FICTÍCIOS.
 */
describe('Clinics — a lista de consentimentos sob o E8 (integração, B1 item 7)', () => {
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
  let canal: string;
  let lembrete: string;
  let confirmacao: string;
  let paciente: string;
  let interessado: string;
  let conversaP: string;
  let conversaI: string;
  /** o consentimento da confirmação do paciente, dado pela recepção */
  let daConfirmacao: string;

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
  const post = (path: string, s: Session, body: unknown, chave?: string) => {
    const r = request(http)
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    return (chave ? r.set('idempotency-key', chave) : r).send(body as object);
  };
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);
  const papel = async (workspaceId: string, email: string, chaves: string[]) => {
    const role = await prisma.raw.role.create({
      data: { workspaceId, name: `Papel ${email}`, isSystem: false },
    });
    await prisma.raw.rolePermission.createMany({
      data: chaves.map((permissionKey) => ({ workspaceId, roleId: role.id, permissionKey })),
    });
    await createMembershipFixture(
      prisma,
      workspaceId,
      await createUserFixture(prisma, email),
      role.id,
    );
    return loginAs(email);
  };
  const canalDeWhatsapp = async (workspaceId: string, numero: string) => {
    const c = await prisma.raw.channel.create({
      data: { workspaceId, type: 'whatsapp', name: `WhatsApp ${numero}` },
    });
    await prisma.raw.channelCredential.create({
      data: {
        workspaceId,
        channelId: c.id,
        phoneNumberId: numero,
        businessAccountId: `waba-${numero}`,
        tokenCipher: 'cifrado',
      },
    });
    return c.id;
  };
  const conceder = (
    contactId: string,
    number: string,
    purposeId: string,
    s = owner,
    chave: string = randomUUID(),
  ) =>
    post(
      `/api/contacts/${contactId}/consents`,
      s,
      { channelId: canal, number, purposeId, origin: 'in_person' },
      chave,
    );
  const revogar = (contactId: string, consentId: string, s = owner, chave: string = randomUUID()) =>
    post(`/api/contacts/${contactId}/consents/${consentId}/revoke`, s, { origin: 'phone' }, chave);
  const doContato = async (s: Session, contactId: string) =>
    (await get(`/api/contacts/${contactId}/consents`, s).expect(200)).body
      .consents as Consentimento[];
  const daConversa = async (s: Session, conversationId: string) =>
    (await get(`/api/conversations/${conversationId}/consents`, s).expect(200)).body
      .consents as Consentimento[];
  /** a lista sem o que é de cada pessoa (ids, datas, recibos): o que sobra não pode diferir */
  const forma = (lista: Consentimento[]) =>
    lista.map((c) => ({
      purposeKey: c.purposeKey,
      origin: c.origin,
      ativo: c.revokedAt === null,
      revocationReason: c.revocationReason,
    }));
  const chaves = (lista: Consentimento[]) => lista.map((c) => c.purposeKey).sort();

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    ws = await createWorkspaceFixture(prisma, 'acme');
    for (const systemKey of ['owner', 'member']) {
      const user = await createUserFixture(prisma, `${systemKey}@veyra.test`);
      await createMembershipFixture(prisma, ws.workspaceId, user, ws.roles[systemKey]);
    }
    await app.get(ClinicsActivationService).enable('acme');
    owner = await loginAs('owner@veyra.test');
    // a recepção do Clinics: o Member com a agenda (e sem a chave do conteúdo)
    recepcao = await loginAs('member@veyra.test');
    canal = await canalDeWhatsapp(ws.workspaceId, '109876540001');
    const finalidades = app.get(ConsentPurposesService);
    lembrete = (
      await finalidades.criarVersao('acme', {
        key: 'lembrete',
        description: 'Lembretes (fictícia)',
        category: 'utility',
        fields: [],
      })
    ).purposeId;
    confirmacao = (
      await finalidades.criarVersao('acme', {
        key: 'clinics_confirmacao',
        description: 'Confirmação de horário (fictícia)',
        category: 'utility',
        fields: [],
      })
    ).purposeId;

    paciente = (
      await post('/api/contacts', owner, { name: 'Paciente Fictícia', phones: [NUM_P] }).expect(201)
    ).body.id;
    await post('/api/clinics/patients', owner, { contactId: paciente }).expect(201);
    interessado = (
      await post('/api/contacts', owner, { name: 'Interessado Fictício', phones: [NUM_I] }).expect(
        201,
      )
    ).body.id;
    // os dois com a finalidade do Core; só o paciente com a da confirmação,
    // registrada pela recepção como no fluxo da clínica
    await conceder(paciente, NUM_P, lembrete).expect(201);
    await conceder(interessado, NUM_I, lembrete).expect(201);
    daConfirmacao = (await conceder(paciente, NUM_P, confirmacao, recepcao).expect(201)).body.id;
    for (const [contactId, numero, guardar] of [
      [paciente, NUM_P, (id: string) => (conversaP = id)],
      [interessado, NUM_I, (id: string) => (conversaI = id)],
    ] as const) {
      const c = await prisma.raw.conversation.create({
        data: {
          workspaceId: ws.workspaceId,
          channelId: canal,
          contactId,
          externalAddress: numero,
          senderStatus: 'identified',
        },
      });
      guardar(c.id);
    }
  });

  it('sem a agenda, a lista do paciente e a do interessado são iguais, pelo contato e pela conversa', async () => {
    const leitor = await papel(ws.workspaceId, 'leitor@veyra.test', [
      'workspace:read',
      'contacts:read',
      'conversations:read',
      'consents:read',
    ]);
    const [cP, cI, vP, vI] = await Promise.all([
      doContato(leitor, paciente),
      doContato(leitor, interessado),
      daConversa(leitor, conversaP),
      daConversa(leitor, conversaI),
    ]);
    expect(forma(cP)).toEqual(forma(cI));
    expect(forma(vP)).toEqual(forma(vI));
    expect(chaves(cP)).toEqual(['lembrete']);
    expect(chaves(vP)).toEqual(['lembrete']);
    expect(JSON.stringify([cP, vP])).not.toMatch(/clinics_|Confirmação/);
    // o revogado da extensão também não sai (a revogação pela recepção)
    await revogar(paciente, daConfirmacao, recepcao).expect(201);
    expect(forma(await doContato(leitor, paciente))).toEqual(
      forma(await doContato(leitor, interessado)),
    );
  });

  it('sem a agenda, concessão, revogação por id e finalidades oferecidas não distinguem ninguém', async () => {
    const gestor = await papel(ws.workspaceId, 'gestor@veyra.test', [
      'workspace:read',
      'contacts:read',
      'conversations:read',
      'consents:read',
      'consents:manage',
    ]);
    const oferecidas = (await get('/api/consent-purposes', gestor).expect(200)).body as {
      key: string;
    }[];
    expect(oferecidas.map((f) => f.key)).toEqual(['lembrete']);
    // conceder a finalidade da extensão: a mesma recusa para os dois — o
    // paciente já a tem ativa, o que antes devolvia o registro existente
    const gP = await conceder(paciente, NUM_P, confirmacao, gestor);
    const gI = await conceder(interessado, NUM_I, confirmacao, gestor);
    expect(gP.status).toBe(404);
    expect([gI.status, gI.body.message]).toEqual([gP.status, gP.body.message]);
    // revogar pelo id do consentimento da extensão: como um id que não existe
    const rP = await revogar(paciente, daConfirmacao, gestor);
    const rNada = await revogar(paciente, randomUUID(), gestor);
    expect(rP.status).toBe(404);
    expect([rP.status, rP.body.message]).toEqual([rNada.status, rNada.body.message]);
    expect(
      (await prisma.raw.consent.findFirstOrThrow({ where: { id: daConfirmacao } })).revokedAt,
    ).toBeNull();
    // a finalidade do Core segue como sempre
    const lembreteP = (await doContato(gestor, paciente))[0];
    await revogar(paciente, lembreteP.id, gestor).expect(201);
    await conceder(paciente, NUM_P, lembrete, gestor).expect(201);
  });

  it('trilha: sem a agenda, a revogação da finalidade da extensão não sai; com a agenda, sai', async () => {
    const lembreteP = (await doContato(owner, paciente)).find((c) => c.purposeKey === 'lembrete')!;
    await revogar(paciente, daConfirmacao, recepcao).expect(201);
    await revogar(paciente, lembreteP.id, recepcao).expect(201);
    const revogacoes = async (s: Session) =>
      (
        (await get('/api/audit?limit=100&action=consent.revoked', s).expect(200)).body.items as {
          entityId: string;
        }[]
      )
        .map((i) => i.entityId)
        .sort();
    const auditor = await papel(ws.workspaceId, 'auditor@veyra.test', [
      'audit:read',
      'contacts:read',
      'consents:read',
    ]);
    expect(await revogacoes(auditor)).toEqual([lembreteP.id]);
    expect(
      (await get(`/api/audit?limit=100&entityId=${daConfirmacao}`, auditor).expect(200)).body.items,
    ).toEqual([]);
    const comAgenda = await papel(ws.workspaceId, 'auditor-agenda@veyra.test', [
      'audit:read',
      'clinics:schedule:read',
    ]);
    expect(await revogacoes(comAgenda)).toEqual([daConfirmacao, lembreteP.id].sort());
  });

  it('trilha: sem a agenda, o pedido de parar do paciente e o do interessado saem iguais, sem as contagens', async () => {
    // o paciente tem um consentimento a mais (o da extensão); o interessado, não
    const pararP = (
      await post(
        `/api/contacts/${paciente}/stop`,
        owner,
        { number: NUM_P, origin: 'phone' },
        randomUUID(),
      ).expect(201)
    ).body.id as string;
    const pararI = (
      await post(
        `/api/contacts/${interessado}/stop`,
        owner,
        { number: NUM_I, origin: 'phone' },
        randomUUID(),
      ).expect(201)
    ).body.id as string;
    const pedidos = async (s: Session) => {
      const itens = (await get('/api/audit?limit=100&action=stop.registered', s).expect(200)).body
        .items as { entityId: string; after: Record<string, unknown> }[];
      // sem o que é de cada pedido (o recibo)
      const de = (id: string) => {
        const resto = { ...itens.find((i) => i.entityId === id)!.after };
        delete resto.receipt;
        return resto;
      };
      return { p: de(pararP), i: de(pararI) };
    };
    const auditor = await papel(ws.workspaceId, 'auditor@veyra.test', [
      'audit:read',
      'contacts:read',
      'consents:read',
    ]);
    const uniforme = await pedidos(auditor);
    expect(uniforme.p).toEqual(uniforme.i);
    expect(uniforme.p.consentsRevoked).toBe('Conteúdo restrito');
    expect(uniforme.p.dispatchesCanceled).toBe('Conteúdo restrito');
    // quem tem a agenda vê as contagens como sempre (o paciente, duas revogações)
    const comAgenda = await pedidos(
      await papel(ws.workspaceId, 'auditor-agenda@veyra.test', [
        'audit:read',
        'clinics:schedule:read',
      ]),
    );
    expect([comAgenda.p.consentsRevoked, comAgenda.i.consentsRevoked]).toEqual([2, 1]);
  });

  it('a repetição da concessão e da revogação confere o acesso de agora: sem a agenda, o mesmo 404 de um pedido novo', async () => {
    const gestor = await papel(ws.workspaceId, 'gestor@veyra.test', [
      'workspace:read',
      'contacts:read',
      'consents:read',
      'consents:manage',
      'clinics:schedule:read',
    ]);
    const lembreteP = (await doContato(owner, paciente)).find((c) => c.purposeKey === 'lembrete')!;
    const [kRevogar, kConceder, kCore] = [randomUUID(), randomUUID(), randomUUID()];
    await revogar(paciente, daConfirmacao, gestor, kRevogar).expect(201);
    const nova = (await conceder(paciente, NUM_P, confirmacao, gestor, kConceder).expect(201)).body
      .id as string;
    await revogar(paciente, lembreteP.id, gestor, kCore).expect(201);
    // com a agenda, a repetição devolve o corpo guardado
    const comAgenda = await conceder(paciente, NUM_P, confirmacao, gestor, kConceder).expect(201);
    expect([comAgenda.headers['idempotent-replay'], comAgenda.body.id]).toEqual(['true', nova]);

    // o papel perde a chave da agenda
    const membership = await prisma.raw.membership.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId, user: { email: 'gestor@veyra.test' } },
      select: { roleId: true },
    });
    await prisma.raw.rolePermission.deleteMany({
      where: { roleId: membership.roleId, permissionKey: 'clinics:schedule:read' },
    });
    const semAgenda = await loginAs('gestor@veyra.test');
    const antes = await prisma.raw.consent.count({ where: { workspaceId: ws.workspaceId } });

    const repetirConceder = await conceder(paciente, NUM_P, confirmacao, semAgenda, kConceder);
    const novoNoInteressado = await conceder(interessado, NUM_I, confirmacao, semAgenda);
    expect(repetirConceder.status).toBe(404);
    expect([repetirConceder.status, repetirConceder.body.message]).toEqual([
      novoNoInteressado.status,
      novoNoInteressado.body.message,
    ]);
    const repetirRevogar = await revogar(paciente, daConfirmacao, semAgenda, kRevogar);
    const revogarNada = await revogar(interessado, randomUUID(), semAgenda);
    expect(repetirRevogar.status).toBe(404);
    expect([repetirRevogar.status, repetirRevogar.body.message]).toEqual([
      revogarNada.status,
      revogarNada.body.message,
    ]);
    expect(JSON.stringify([repetirConceder.body, repetirRevogar.body])).not.toMatch(/clinics_/);
    // a finalidade do Core segue repetindo o corpo guardado
    const repetirCore = await revogar(paciente, lembreteP.id, semAgenda, kCore).expect(201);
    expect(repetirCore.headers['idempotent-replay']).toBe('true');
    // nada executou de novo
    expect(await prisma.raw.consent.count({ where: { workspaceId: ws.workspaceId } })).toBe(antes);
  });

  it('a recepção vê e registra o consentimento da confirmação como antes, pela ficha e pelo Inbox', async () => {
    expect(chaves(await doContato(recepcao, paciente))).toEqual([
      'clinics_confirmacao',
      'lembrete',
    ]);
    expect(chaves(await daConversa(recepcao, conversaP))).toEqual([
      'clinics_confirmacao',
      'lembrete',
    ]);
    const oferecidas = (await get('/api/consent-purposes', recepcao).expect(200)).body as {
      key: string;
    }[];
    expect(oferecidas.map((f) => f.key).sort()).toEqual(['clinics_confirmacao', 'lembrete']);
    // revoga e concede de novo a confirmação
    await revogar(paciente, daConfirmacao, recepcao).expect(201);
    const nova = (await conceder(paciente, NUM_P, confirmacao, recepcao).expect(201)).body.id;
    const lista = await daConversa(recepcao, conversaP);
    expect(lista.find((c) => c.id === nova)?.revokedAt).toBeNull();
    expect(lista.find((c) => c.id === daConfirmacao)?.revocationReason).toBe('manual');
    // e no interessado também, se a recepção quiser
    await conceder(interessado, NUM_I, confirmacao, recepcao).expect(201);
    // o Owner (as duas chaves), como sempre
    expect(chaves(await doContato(owner, paciente))).toEqual([
      'clinics_confirmacao',
      'clinics_confirmacao',
      'lembrete',
    ]);
  });

  it('depois da desativação, o Owner também cai na regra uniforme: as listas ficam iguais', async () => {
    await app.get(ClinicsActivationService).disable('acme');
    // a desativação muda as permissões e invalida as sessões: entra de novo
    owner = await loginAs('owner@veyra.test');
    const [cP, cI] = await Promise.all([doContato(owner, paciente), doContato(owner, interessado)]);
    expect(forma(cP)).toEqual(forma(cI));
    expect(chaves(cP)).toEqual(['lembrete']);
  });

  it('no workspace sem o Clinics, nada muda: o papel sem a agenda vê toda finalidade', async () => {
    const beta = await createWorkspaceFixture(prisma, 'beta');
    const dono = await createUserFixture(prisma, 'dono-b@veyra.test');
    await createMembershipFixture(prisma, beta.workspaceId, dono, beta.roles.owner);
    const ownerB = await loginAs('dono-b@veyra.test');
    const canalB = await canalDeWhatsapp(beta.workspaceId, '109876540002');
    // uma finalidade de nome igual ao da extensão, sem o vertical no workspace
    const purposeId = (
      await app.get(ConsentPurposesService).criarVersao('beta', {
        key: 'clinics_confirmacao',
        description: 'Uma finalidade qualquer (fictícia)',
        category: 'utility',
        fields: [],
      })
    ).purposeId;
    const contato = (
      await post('/api/contacts', ownerB, { name: 'Contato Fictício', phones: [NUM_P] }).expect(201)
    ).body.id as string;
    const consentId = (
      await post(
        `/api/contacts/${contato}/consents`,
        ownerB,
        { channelId: canalB, number: NUM_P, purposeId, origin: 'in_person' },
        randomUUID(),
      ).expect(201)
    ).body.id as string;
    await post(
      `/api/contacts/${contato}/consents/${consentId}/revoke`,
      ownerB,
      { origin: 'phone' },
      randomUUID(),
    ).expect(201);
    const leitor = await papel(beta.workspaceId, 'leitor-b@veyra.test', [
      'workspace:read',
      'contacts:read',
      'consents:read',
      'audit:read',
    ]);
    expect(chaves(await doContato(leitor, contato))).toEqual(['clinics_confirmacao']);
    expect(
      ((await get('/api/consent-purposes', leitor).expect(200)).body as { key: string }[]).map(
        (f) => f.key,
      ),
    ).toEqual(['clinics_confirmacao']);
    const revogacoes = (
      await get('/api/audit?limit=100&action=consent.revoked', leitor).expect(200)
    ).body.items as { entityId: string }[];
    expect(revogacoes.map((i) => i.entityId)).toEqual([consentId]);
  });
});
