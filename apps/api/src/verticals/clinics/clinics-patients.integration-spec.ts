import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { CryptoService } from '../../common/crypto.service';
import { CHAVE } from '../../content-use/restriction-locks';
import { MudancasDeRestricao } from '../../content-use/restriction-changes';
import {
  META_TRANSPORT,
  type FetchOutcome,
  type MetaTransport,
  type SendOutcome,
} from '../../channels/meta.transport';
import {
  LLM_CLIENT,
  type LlmClient,
  type LlmOutcome,
  type LlmRequest,
} from '../../intelligence/llm/llm.client';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
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
import { ClinicsContentRestriction } from './clinics-content-restriction';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const APP_SECRET = process.env.META_APP_SECRET as string;
const PHONE_NUMBER_ID = '109876543277';

class FakeLlm implements LlmClient {
  readonly model = 'claude-sonnet-5';
  calls: LlmRequest[] = [];
  nextText = '{}';
  async complete(request: LlmRequest): Promise<LlmOutcome> {
    this.calls.push(request);
    return { kind: 'ok', text: this.nextText, inputTokens: 500, outputTokens: 100 };
  }
}

class FakeMetaTransport implements MetaTransport {
  sends: { to: string; body?: string }[] = [];
  async sendText(_c: unknown, to: string, body: string): Promise<SendOutcome> {
    this.sends.push({ to, body });
    return { ok: true, externalId: `wamid.ENVIADA.${this.sends.length}` };
  }
  async sendTemplate(_c: unknown, to: string): Promise<SendOutcome> {
    this.sends.push({ to });
    return { ok: true, externalId: `wamid.T.${this.sends.length}` };
  }
  async fetchMedia(): Promise<FetchOutcome> {
    return { ok: false, failure: { status: 400 } };
  }
}

const RESUMO = JSON.stringify({
  subject: 'Agendamento',
  summary: 'O contato pediu horário.',
  pendencies: [],
  sentiment: 'neutro',
  injectionAttempt: false,
});
const RASCUNHO = JSON.stringify({
  body: 'Temos horário amanhã às 10h.',
  rationale: 'Pedido de horário dentro da janela.',
  injectionAttempt: false,
});
const ACAO = JSON.stringify({ title: 'Retornar contato', rationale: 'Sinais.', dueInDays: 1 });

interface Session {
  cookieHeader: string;
  csrf: string;
}

/**
 * Perfil de paciente e a regra da liberação (F2.1, ADR-048 adendo 2, itens 1
 * a 3; ADR-047 adendo 5). Dados FICTÍCIOS. A prova central: se a associação
 * a paciente comitar, nenhuma aprovação concorrente converte uma proposta em
 * mensagem ou tarefa — por trava na linha do contato, não por limpeza.
 */
describe('Clinics — paciente e a regra da liberação de IA (integração, F2.1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const llm = new FakeLlm();
  const meta = new FakeMetaTransport();

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: LLM_CLIENT, useValue: llm },
        { provide: META_TRANSPORT, useValue: meta },
      ],
    );
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let owner: Session;
  let conversationId: string;
  /** contato vindo pelo WhatsApp, com conversa: alvo das propostas da IA */
  let contactId: string;

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
  const send = (method: 'post' | 'put' | 'delete', path: string, s: Session, body?: unknown) =>
    request(http)
      [method](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send((body ?? {}) as object);
  const post = (path: string, s: Session, body?: unknown) => send('post', path, s, body);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);
  const tornarPaciente = (id: string, s: Session = owner) =>
    post('/api/clinics/patients', s, { contactId: id });
  const liberar = (id: string, s: Session = owner) =>
    post(`/api/clinics/contacts/${id}/ai-release`, s, { reason: 'supplier' });
  const drain = async () => {
    await prisma.raw.outboxEvent.updateMany({
      where: { status: 'pending' },
      data: { nextRetryAt: new Date(0) },
    });
    return app.get(JobsService).dispatchPending(50);
  };

  const ingest = (texto = 'Tem horário amanhã?') => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                contacts: [{ wa_id: '5511966665555', profile: { name: 'Fornecedora Teste' } }],
                messages: [
                  {
                    id: `wamid.IN${timestamp}${Math.random()}`,
                    from: '5511966665555',
                    timestamp,
                    type: 'text',
                    text: { body: texto },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    return request(http)
      .post('/api/channels/whatsapp/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'x-hub-signature-256',
        `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(raw)).digest('hex')}`,
      )
      .send(raw);
  };

  /** Propostas pendentes geradas com o contato LIBERADO (a IA podia gerar). */
  const gerarPropostas = async () => {
    llm.nextText = RASCUNHO;
    const rascunho = await post(
      `/api/intelligence/conversations/${conversationId}/reply-suggestion`,
      owner,
    ).expect(201);
    expect(rascunho.body.status).toBe('proposed');
    llm.nextText = ACAO;
    const acao = await post(`/api/intelligence/contacts/${contactId}/next-action`, owner).expect(
      201,
    );
    expect(acao.body.status).toBe('proposed');
    return {
      rascunho: rascunho.body.proposalId as string,
      tarefa: acao.body.proposalId as string,
    };
  };

  beforeEach(async () => {
    llm.calls = [];
    llm.nextText = RESUMO;
    meta.sends = [];
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
    owner = await loginAs('owner-a@veyra.test');
    await send('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
      200,
    );
    const channel = await prisma.raw.channel.create({
      data: { workspaceId: wsA.workspaceId, type: 'whatsapp', name: 'WhatsApp' },
    });
    await prisma.raw.channelCredential.create({
      data: {
        workspaceId: wsA.workspaceId,
        channelId: channel.id,
        phoneNumberId: PHONE_NUMBER_ID,
        businessAccountId: 'waba-pacientes',
        tokenCipher: app.get(CryptoService).encrypt('token-de-envio'),
      },
    });
    await ingest().expect(200);
    const conversa = await prisma.raw.conversation.findFirst({
      where: { workspaceId: wsA.workspaceId, channelId: channel.id },
    });
    conversationId = conversa!.id;
    contactId = conversa!.contactId!;
  });

  // ── Perfil de paciente ────────────────────────────────────────────────────

  describe('perfil de paciente', () => {
    it('criar é idempotente, audita só o id do contato e aparece na lista com o nome', async () => {
      const primeira = await tornarPaciente(contactId).expect(201);
      expect(primeira.body).toMatchObject({ contactId, name: 'Fornecedora Teste' });
      const segunda = await tornarPaciente(contactId).expect(201);
      expect(segunda.body.id).toBe(primeira.body.id);
      const trilhas = await prisma.raw.auditLog.findMany({
        where: { action: 'clinics.patient.created' },
      });
      expect(trilhas).toHaveLength(1);
      expect(trilhas[0].after).toEqual({ contactId });
      const lista = (await get('/api/clinics/patients', owner).expect(200)).body;
      expect(lista).toEqual([primeira.body]);
      await tornarPaciente(randomUUID()).expect(404);
      await post('/api/clinics/patients', owner, { contactId, extra: 1 }).expect(400);
    });

    it('permissões: recepção cria; Profissional lê mas não cria; Guest e workspace sem Clinics: 403', async () => {
      const recepcao = await loginAs('member-a@veyra.test');
      await tornarPaciente(contactId, recepcao).expect(201);
      const profissional = await prisma.raw.role.findFirst({
        where: { workspaceId: wsA.workspaceId, systemKey: 'clinics:professional' },
      });
      const userProf = await createUserFixture(prisma, 'prof-a@veyra.test');
      await createMembershipFixture(prisma, wsA.workspaceId, userProf, profissional!.id);
      const prof = await loginAs('prof-a@veyra.test');
      expect((await get('/api/clinics/patients', prof).expect(200)).body).toHaveLength(1);
      await tornarPaciente(contactId, prof).expect(403);
      const guest = await loginAs('guest-a@veyra.test');
      await get('/api/clinics/patients', guest).expect(403);
      const donoB = await loginAs('owner-b@veyra.test');
      await get('/api/clinics/patients', donoB).expect(403);
    });

    it('`contacts:read` é exigido onde a rota traz ou escolhe contato; sem ele, a lista de pacientes sai SEM o id do contato', async () => {
      // papel customizado só com as chaves do Clinics: prova que as rotas
      // exigem TAMBÉM `contacts:read`, e não só a chave do vertical
      const papel = await prisma.raw.role.create({
        data: { workspaceId: wsA.workspaceId, name: 'Só Clínica' },
      });
      await prisma.raw.rolePermission.createMany({
        data: ['clinics:restriction:manage', 'clinics:schedule:read', 'clinics:schedule:write'].map(
          (permissionKey) => ({ workspaceId: wsA.workspaceId, roleId: papel.id, permissionKey }),
        ),
      });
      const usuario = await createUserFixture(prisma, 'so-clinica-a@veyra.test');
      await createMembershipFixture(prisma, wsA.workspaceId, usuario, papel.id);
      const soClinica = await loginAs('so-clinica-a@veyra.test');

      await get('/api/clinics/ai-releases', soClinica).expect(403);
      await liberar(contactId, soClinica).expect(403);
      await tornarPaciente(contactId, soClinica).expect(403);

      await tornarPaciente(contactId).expect(201);
      const semId = (await get('/api/clinics/patients', soClinica).expect(200)).body;
      expect(semId).toEqual([
        { id: expect.any(String), name: 'Fornecedora Teste', createdAt: expect.any(String) },
      ]);
      // nem por filtro: sondar ids de contato refaria o vínculo escondido
      await get(`/api/clinics/patients?contactIds=${contactId}`, soClinica).expect(403);
      const comId = (await get('/api/clinics/patients', owner).expect(200)).body;
      expect(comId).toEqual([expect.objectContaining({ contactId })]);
    });

    it('o paciente por id (F3.3a): a MESMA autorização e projeção da lista, inclusive sem `contactId` para quem não lê contatos; outro workspace e o guest não', async () => {
      const papel = await prisma.raw.role.create({
        data: { workspaceId: wsA.workspaceId, name: 'Só a agenda (fictício)' },
      });
      await prisma.raw.rolePermission.create({
        data: {
          workspaceId: wsA.workspaceId,
          roleId: papel.id,
          permissionKey: 'clinics:schedule:read',
        },
      });
      await createMembershipFixture(
        prisma,
        wsA.workspaceId,
        await createUserFixture(prisma, 'so-agenda-a@veyra.test'),
        papel.id,
      );
      const soAgenda = await loginAs('so-agenda-a@veyra.test');
      const id = (await tornarPaciente(contactId).expect(201)).body.id as string;
      const daLista = (await get('/api/clinics/patients', soAgenda).expect(200)).body[0];
      const direto = (await get(`/api/clinics/patients/${id}`, soAgenda).expect(200)).body;
      expect(direto).toEqual(daLista);
      expect(direto).not.toHaveProperty('contactId');
      expect((await get(`/api/clinics/patients/${id}`, owner).expect(200)).body).toEqual(
        expect.objectContaining({ id, contactId }),
      );
      await get(`/api/clinics/patients/${id}`, await loginAs('guest-a@veyra.test')).expect(403);
      // P0: o workspace B (com o Clinics ativo) não lê o paciente de A pela URL
      await app.get(ClinicsActivationService).enable('beta');
      await get(`/api/clinics/patients/${id}`, await loginAs('owner-b@veyra.test')).expect(404);
      await get('/api/clinics/patients/nao-e-uuid', owner).expect(400);
    });

    it('busca pelo nome (a partir de 2 letras, sem diferenciar maiúsculas) e teto com os mais recentes primeiro', async () => {
      for (const name of ['Ana Fictícia', 'Bruno Fictício', 'Carla Outra']) {
        const id = (await post('/api/contacts', owner, { name }).expect(201)).body.id as string;
        await tornarPaciente(id).expect(201);
      }
      const nomes = async (q: string) =>
        (await get(`/api/clinics/patients${q}`, owner).expect(200)).body.map(
          (p: { name: string }) => p.name,
        );
      // contato com nome que casa, mas que NÃO é paciente, nunca volta
      await post('/api/contacts', owner, { name: 'Diana Fictícia' }).expect(201);
      expect((await nomes('?search=FICT')).sort()).toEqual(['Ana Fictícia', 'Bruno Fictício']);
      expect(await nomes('?search=xyz')).toEqual([]);
      // os mais recentes primeiro: Carla foi a última
      expect(await nomes('?limit=2')).toEqual(['Carla Outra', 'Bruno Fictício']);
      await get('/api/clinics/patients?search=a', owner).expect(400);
      await get('/api/clinics/patients?limit=101', owner).expect(400);
    });

    it('filtro por contatos: só os pedidos, no máximo 50, e só ids válidos', async () => {
      const outro = (await post('/api/contacts', owner, { name: 'Outra Fictícia' }).expect(201))
        .body.id as string;
      await tornarPaciente(contactId).expect(201);
      await tornarPaciente(outro).expect(201);
      const filtrada = await get(`/api/clinics/patients?contactIds=${contactId}`, owner).expect(
        200,
      );
      expect(filtrada.body.map((p: { contactId: string }) => p.contactId)).toEqual([contactId]);
      const nenhum = await get(`/api/clinics/patients?contactIds=${randomUUID()}`, owner).expect(
        200,
      );
      expect(nenhum.body).toEqual([]);
      // com a busca, os dois filtros valem juntos (E)
      const ambos = async (nome: string) =>
        (
          await get(
            `/api/clinics/patients?contactIds=${contactId},${outro}&search=${encodeURIComponent(nome)}`,
            owner,
          ).expect(200)
        ).body.map((p: { contactId: string }) => p.contactId);
      expect(await ambos('Outra')).toEqual([outro]);
      expect(await ambos('xyz')).toEqual([]);
      await get('/api/clinics/patients?contactIds=nao-e-uuid', owner).expect(400);
      const muitos = Array.from({ length: 51 }, () => randomUUID()).join(',');
      await get(`/api/clinics/patients?contactIds=${muitos}`, owner).expect(400);
    });

    it('P0: B não vê nem cria paciente com contato de A; FK composta recusa contato e membership de outro workspace', async () => {
      await tornarPaciente(contactId).expect(201);
      await app.get(ClinicsActivationService).enable('beta');
      const donoB = await loginAs('owner-b@veyra.test');
      expect((await get('/api/clinics/patients', donoB).expect(200)).body).toEqual([]);
      // nem pela busca: com um paciente de B que casa o mesmo termo, só ele volta para B
      const deB = (await post('/api/contacts', donoB, { name: 'Fornecedora de B' }).expect(201))
        .body.id as string;
      await tornarPaciente(deB, donoB).expect(201);
      expect(
        (await get('/api/clinics/patients?search=Fornecedora', donoB).expect(200)).body.map(
          (p: { name: string }) => p.name,
        ),
      ).toEqual(['Fornecedora de B']);
      expect(
        (await get('/api/clinics/patients?search=Fornecedora', owner).expect(200)).body.map(
          (p: { name: string }) => p.name,
        ),
      ).toEqual(['Fornecedora Teste']);
      await tornarPaciente(contactId, donoB).expect(404);

      const contatoB = await prisma.raw.contact.create({
        data: { workspaceId: wsB.workspaceId, name: 'Contato B' },
      });
      const donoA = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsA.workspaceId, role: { systemKey: 'owner' } },
      });
      const membroB = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsB.workspaceId },
      });
      const outro = await prisma.raw.contact.create({
        data: { workspaceId: wsA.workspaceId, name: 'Outro' },
      });
      await expect(
        prisma.raw.clinicsPatient.create({
          data: {
            workspaceId: wsA.workspaceId,
            contactId: contatoB.id,
            createdByMembershipId: donoA!.id,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      await expect(
        prisma.raw.clinicsPatient.create({
          data: {
            workspaceId: wsA.workspaceId,
            contactId: outro.id,
            createdByMembershipId: membroB!.id,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('excluir contato que é paciente: 409, e NADA da exclusão fica (§9.1)', async () => {
      await tornarPaciente(contactId).expect(201);
      await post('/api/notes', owner, { body: 'Nota fictícia', contactId }).expect(201);
      const antes = {
        notas: await prisma.raw.note.count({ where: { contactId } }),
        trilhas: await prisma.raw.auditLog.count({ where: { action: 'contact.deleted' } }),
        eventos: await prisma.raw.outboxEvent.count({ where: { eventType: 'contact.deleted' } }),
        cota: (
          await prisma.raw.usageCounter.findFirst({
            where: { workspaceId: wsA.workspaceId, metric: 'contacts' },
          })
        )?.value,
      };
      await send('delete', `/api/contacts/${contactId}`, owner).expect(409);
      expect(await prisma.raw.contact.count({ where: { id: contactId } })).toBe(1);
      expect({
        notas: await prisma.raw.note.count({ where: { contactId } }),
        trilhas: await prisma.raw.auditLog.count({ where: { action: 'contact.deleted' } }),
        eventos: await prisma.raw.outboxEvent.count({ where: { eventType: 'contact.deleted' } }),
        cota: (
          await prisma.raw.usageCounter.findFirst({
            where: { workspaceId: wsA.workspaceId, metric: 'contacts' },
          })
        )?.value,
      }).toEqual(antes);
    });

    it('excluir o WORKSPACE leva o paciente em cascata, passando pela FK NO ACTION', async () => {
      await tornarPaciente(contactId).expect(201);
      await prisma.raw.workspace.deleteMany({ where: { id: wsA.workspaceId } });
      expect(await prisma.raw.clinicsPatient.count()).toBe(0);
      expect(await prisma.raw.workspace.count({ where: { id: wsB.workspaceId } })).toBe(1);
    });
  });

  // ── A liberação perde efeito ──────────────────────────────────────────────

  describe('a liberação de IA perde efeito quando o contato vira paciente', () => {
    it('no commit: a porta restringe, a liberação some com trilha, a IA recusa, e liberar de novo é 409', async () => {
      await liberar(contactId).expect(201);
      const port = app.get(ClinicsContentRestriction);
      expect(await port.restricted(wsA.workspaceId, 'ai', [contactId])).toEqual([false]);

      await tornarPaciente(contactId).expect(201);
      expect(await port.restricted(wsA.workspaceId, 'ai', [contactId])).toEqual([true]);
      expect(await prisma.raw.clinicsContactRelease.count()).toBe(0);
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.ai_release.revoked_by_patient' },
      });
      expect(trilha!.before).toEqual({ contactId, consumer: 'ai', reason: 'supplier' });

      llm.calls = [];
      const resumo = await post(
        `/api/intelligence/conversations/${conversationId}/summary`,
        owner,
      ).expect(201);
      expect(resumo.body.status).toBe('content_restricted');
      expect(llm.calls).toEqual([]);
      const conflito = await liberar(contactId).expect(409);
      expect(conflito.body.message).toMatch(/paciente/);
    });

    it('a regra é DERIVADA: mesmo com uma liberação que sobrou, paciente é restrito', async () => {
      await tornarPaciente(contactId).expect(201);
      // liberação inserida por fora do produto, depois do paciente
      const dono = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsA.workspaceId, role: { systemKey: 'owner' } },
      });
      await prisma.raw.clinicsContactRelease.create({
        data: {
          workspaceId: wsA.workspaceId,
          contactId,
          consumer: 'ai',
          reason: 'staff',
          releasedByMembershipId: dono!.id,
        },
      });
      expect(
        await app.get(ClinicsContentRestriction).restricted(wsA.workspaceId, 'ai', [contactId]),
      ).toEqual([true]);
    });

    it('propostas geradas quando liberado: somem da fila no commit, expiram depois, e aprovar é recusado', async () => {
      await liberar(contactId).expect(201);
      const { rascunho, tarefa } = await gerarPropostas();
      await tornarPaciente(contactId).expect(201);
      const fila = await get('/api/intelligence/proposals?status=pending', owner).expect(200);
      expect(fila.body).toEqual([]);
      const estados = await prisma.raw.aiProposal.findMany({
        where: { id: { in: [rascunho, tarefa] } },
        select: { status: true },
      });
      expect(estados.map((p) => p.status)).toEqual(['expired', 'expired']);
      await post(`/api/intelligence/proposals/${rascunho}/approve-reply`, owner, {}).expect(400);
      await post(`/api/intelligence/proposals/${tarefa}/approve`, owner).expect(400);
      expect(await prisma.raw.task.count()).toBe(0);
      expect(await prisma.raw.messageDispatch.count()).toBe(0);
    });
  });

  // ── PROVA DE CONCORRÊNCIA (ADR-047 adendo 5) ──────────────────────────────

  describe('associação a paciente × aprovação concorrente', () => {
    /**
     * Uma conexão externa faz o que a criação do paciente faz — pega as travas
     * de restrição do contato, a do workspace compartilhada e a do contato
     * EXCLUSIVA (ADR-047 adendo 6 §6), e insere o paciente — e segura a
     * transação aberta. A
     * aprovação, disparada nesse meio, passa pela checagem rápida (o paciente
     * ainda não comitou) e precisa ficar BLOQUEADA na trava do contato; depois
     * do commit, reconfere e recusa. Sem a trava na aprovação, ela terminaria
     * antes do commit e converteria a proposta — a mutação derruba o teste.
     */
    const corridaComPaciente = async (aprovar: () => request.Test) => {
      const dono = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsA.workspaceId, role: { systemKey: 'owner' } },
      });
      const trava = new Client({ connectionString: TEST_DATABASE_URL });
      await trava.connect();
      try {
        await trava.query('BEGIN');
        await trava.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
          CHAVE.workspace(wsA.workspaceId),
        ]);
        await trava.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          CHAVE.contato(wsA.workspaceId, contactId),
        ]);
        await trava.query(
          `INSERT INTO "ClinicsPatient" ("id", "workspaceId", "contactId", "createdByMembershipId")
           VALUES ($1, $2, $3, $4)`,
          [randomUUID(), wsA.workspaceId, contactId, dono!.id],
        );
        let respondeu: number | null = null;
        const pedido = aprovar().then((res) => {
          respondeu = res.status;
          return res;
        });
        await esperarBloqueadosPor(trava, 1, {
          descricao: 'aprovação esperando a trava do contato',
          aCadaTentativa: () => {
            if (respondeu !== null) {
              throw new Error(`a aprovação respondeu ${respondeu} SEM esperar a trava do contato`);
            }
          },
        });
        await trava.query('COMMIT');
        return await pedido;
      } finally {
        await trava.end();
      }
    };

    it('aprovação de MENSAGEM esperando a trava: a associação comita, e a aprovação recusa sem criar mensagem nem despacho', async () => {
      await liberar(contactId).expect(201);
      const { rascunho } = await gerarPropostas();
      const mensagensAntes = await prisma.raw.message.count({ where: { direction: 'outbound' } });

      const res = await corridaComPaciente(() =>
        post(`/api/intelligence/proposals/${rascunho}/approve-reply`, owner, {}),
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/restrito/);
      expect(await prisma.raw.message.count({ where: { direction: 'outbound' } })).toBe(
        mensagensAntes,
      );
      expect(await prisma.raw.messageDispatch.count()).toBe(0);
      expect((await prisma.raw.aiProposal.findFirst({ where: { id: rascunho } }))!.status).toBe(
        'expired',
      );
      expect(await prisma.raw.usageReservation.count()).toBe(0); // a reserva foi devolvida
    });

    it('aprovação de TAREFA esperando a trava: a associação comita, e a aprovação recusa sem criar tarefa', async () => {
      await liberar(contactId).expect(201);
      const { tarefa } = await gerarPropostas();

      const res = await corridaComPaciente(() =>
        post(`/api/intelligence/proposals/${tarefa}/approve`, owner),
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/restrito/);
      expect(await prisma.raw.task.count()).toBe(0);
      expect((await prisma.raw.aiProposal.findFirst({ where: { id: tarefa } }))!.status).toBe(
        'expired',
      );
    });

    it('aprovação que travou PRIMEIRO termina antes da associação; a mensagem da IA não sai, porque o despacho reconfere', async () => {
      await liberar(contactId).expect(201);
      const { rascunho } = await gerarPropostas();
      await post(`/api/intelligence/proposals/${rascunho}/approve-reply`, owner, {}).expect(201);
      await tornarPaciente(contactId).expect(201);
      await drain();
      expect(meta.sends).toEqual([]);
      expect(await prisma.raw.messageDispatch.findFirst()).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'content_restricted',
      });
    });

    it('porta INDISPONÍVEL só na reconferência SOB a trava: 503, a proposta segue pendente, nada é criado e a reserva volta', async () => {
      await liberar(contactId).expect(201);
      const { rascunho, tarefa } = await gerarPropostas();
      const mensagensAntes = await prisma.raw.message.count({ where: { direction: 'outbound' } });

      // a porta falha só DEPOIS de a aprovação tomar as travas do contato: a
      // checagem rápida passa, e quem responde é a reconferência sob as travas
      const restricao = app.get(MudancasDeRestricao);
      const travaReal = restricao.paraAprovacao.bind(restricao);
      let travou = false;
      const espiaTrava = jest
        .spyOn(restricao, 'paraAprovacao')
        .mockImplementation(async (...args) => {
          await travaReal(...args);
          travou = true;
        });
      const port = app.get(ClinicsContentRestriction);
      const portaReal = port.restricted.bind(port);
      const espiaPorta = jest.spyOn(port, 'restricted').mockImplementation(async (...args) => {
        if (travou) throw new Error('porta indisponível (teste)');
        return portaReal(...args);
      });
      try {
        for (const [id, rota] of [
          [rascunho, 'approve-reply'],
          [tarefa, 'approve'],
        ] as const) {
          travou = false;
          await post(`/api/intelligence/proposals/${id}/${rota}`, owner, {}).expect(503);
          expect(travou).toBe(true);
          expect((await prisma.raw.aiProposal.findFirst({ where: { id } }))!.status).toBe(
            'pending',
          );
        }
      } finally {
        espiaTrava.mockRestore();
        espiaPorta.mockRestore();
      }
      expect(await prisma.raw.message.count({ where: { direction: 'outbound' } })).toBe(
        mensagensAntes,
      );
      expect(await prisma.raw.messageDispatch.count()).toBe(0);
      expect(await prisma.raw.task.count()).toBe(0);
      expect(await prisma.raw.usageReservation.count()).toBe(0); // a reserva foi devolvida

      // a porta voltou: as mesmas propostas são aprovadas normalmente
      await post(`/api/intelligence/proposals/${tarefa}/approve`, owner).expect(201);
      expect(await prisma.raw.task.count()).toBe(1);
    });

    it('o outro lado do contrato: criar paciente, conceder e revogar liberação ESPERAM as travas que um uso ou uma aprovação seguram', async () => {
      const sobTrava = async (mudar: () => request.Test, esperado: number) => {
        const trava = new Client({ connectionString: TEST_DATABASE_URL });
        await trava.connect();
        try {
          // o que um uso ou uma aprovação seguram: tudo COMPARTILHADO
          await trava.query('BEGIN');
          await trava.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
            CHAVE.workspace(wsA.workspaceId),
          ]);
          await trava.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
            CHAVE.contato(wsA.workspaceId, contactId),
          ]);
          let respondeu: number | null = null;
          const pedido = mudar().then((res) => {
            respondeu = res.status;
            return res;
          });
          await esperarBloqueadosPor(trava, 1, {
            descricao: 'mudança de restrição esperando a trava do contato',
            aCadaTentativa: () => {
              if (respondeu !== null) {
                throw new Error(`a mudança respondeu ${respondeu} SEM esperar a trava do contato`);
              }
            },
          });
          await trava.query('ROLLBACK');
          expect((await pedido).status).toBe(esperado);
        } finally {
          await trava.end();
        }
      };
      await sobTrava(() => liberar(contactId), 201);
      await sobTrava(
        () => send('delete', `/api/clinics/contacts/${contactId}/ai-release`, owner),
        200,
      );
      await sobTrava(() => tornarPaciente(contactId), 201);
    });
  });
});
