import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import request from 'supertest';
import {
  FakeTemplateCatalog,
  META_TEMPLATE_CATALOG,
  type TemplateDaMeta,
} from '../channels/meta-templates.catalog';
import { CryptoService } from '../common/crypto.service';
import { ConsentPurposesService } from '../consents/consent-purposes.service';
import { CONFIG_DA_GUARDA, CONFIG_PADRAO_DA_GUARDA } from '../content-use/content-use.pools';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import { TEST_DATABASE_URL } from '../../test/integration/db-url';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { esperarBloqueadosPor } from '../../test/integration/locks';
import { TemplateVersionsService } from './template-versions.service';

/**
 * F4.1c-2 (ADR-052 item 4): as versões de template lidas da Meta (o catálogo
 * FALSO faz o papel dela), a revisão por versão e finalidade e a releitura.
 * Nada aqui envia. Conteúdo e nomes FICTÍCIOS; os ids da Meta são números
 * inventados.
 */

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const WABA_A = '1001';
const WABA_B = '1002';
const ID_DO_TEMPLATE = '5001';

/** Prazo curto: a espera pela linha da versão aparece em segundos. */
const CONFIG = { ...CONFIG_PADRAO_DA_GUARDA, mudancaTravaMs: 2_000, mudancaTransacaoMs: 10_000 };

interface Session {
  cookieHeader: string;
  csrf: string;
}

const lembrete = (mudanca: Partial<TemplateDaMeta> = {}): TemplateDaMeta => ({
  id: ID_DO_TEMPLATE,
  name: 'lembrete_horario',
  language: 'pt_BR',
  status: 'APPROVED',
  category: 'UTILITY',
  parameterFormat: 'POSITIONAL',
  components: [
    {
      type: 'BODY',
      text: 'Ola {{1}}, seu horario esta confirmado.',
      example: { body_text: [['Ana']] },
    },
    { type: 'FOOTER', text: 'Clinica Ficticia' },
  ],
  ...mudanca,
});
const NOME = { 'body.1': 'contato.nome' };

describe('F4.1c-2 — templates versionados, revisados e relidos (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const catalogo = new FakeTemplateCatalog();

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: META_TEMPLATE_CATALOG, useValue: catalogo },
        { provide: CONFIG_DA_GUARDA, useValue: CONFIG },
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
  let canalA: string;
  let canalB: string;
  let owner: Session;
  let ownerB: Session;
  let membro: Session;
  let finalidade: string;

  const login = async (email: string): Promise<Session> => {
    const res = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: TEST_PASSWORD })
      .expect(201);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
    return { cookieHeader, csrf: /veyra_csrf=([^;]+)/.exec(cookieHeader)?.[1] ?? '' };
  };
  const get = (path: string, s: Session) =>
    request(http).get(path).set('Origin', ORIGIN).set('Cookie', s.cookieHeader);
  const revisar = (versionId: string, s: Session, body: unknown) =>
    request(http)
      .post(`/api/templates/versions/${versionId}/reviews`)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send(body as object);
  const servico = () => app.get(TemplateVersionsService);
  const registrar = (
    mudanca: Partial<{ channelId: string; vinculos: Record<string, string>; slug: string }> = {},
  ) =>
    servico().registrar(mudanca.slug ?? 'acme', {
      channelId: mudanca.channelId ?? canalA,
      name: 'lembrete_horario',
      language: 'pt_BR',
      vinculos: mudanca.vinculos ?? NOME,
    });
  /** No contexto do workspace, como a F4.1c-3 chamará a releitura. */
  const reler = (versionId: string, workspaceId = wsA.workspaceId) => {
    const cls = app.get(ClsService);
    return cls.run(async () => {
      cls.set('workspaceId', workspaceId);
      return servico().reler(versionId);
    });
  };
  const versao = (id: string) =>
    prisma.raw.messageTemplateVersion.findUniqueOrThrow({ where: { id } });
  const trilha = (action: string) => prisma.raw.auditLog.findMany({ where: { action } });
  const registrada = async () => {
    const r = await registrar();
    if (r.resultado !== 'registrada') throw new Error(`esperava registrada: ${JSON.stringify(r)}`);
    return r;
  };
  const membershipDoDono = () =>
    prisma.raw.membership.findFirstOrThrow({
      where: { workspaceId: wsA.workspaceId, roleId: wsA.roles.owner },
    });
  /**
   * Os clientes que seguram a linha da versão e as chamadas que esperam por ela.
   * O teste que estoura o prazo não chega ao `finally`: sem o afterEach, a trava
   * ficaria presa, o próximo `resetDb` esperaria por ela e o jest não sairia.
   */
  const travas: Client[] = [];
  const emCurso: Promise<unknown>[] = [];
  const segurar = async () => {
    const c = new Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    travas.push(c);
    return c;
  };
  const soltar = async (c: Client) => {
    const i = travas.indexOf(c);
    if (i < 0) return;
    travas.splice(i, 1);
    await c.query('ROLLBACK').catch(() => undefined);
    // um `end` que falha não pode deixar os outros clientes segurando a linha
    await c.end().catch(() => undefined);
  };
  const disparar = <T>(p: Promise<T>): Promise<T> => {
    emCurso.push(p);
    return p;
  };
  afterEach(async () => {
    for (const c of [...travas]) await soltar(c);
    // o que o teste abandonado dispara logo depois que a trava solta também
    // espera — desde que não haja outro acesso ao banco antes do `disparar`
    while (emCurso.length) {
      await Promise.allSettled(emCurso.splice(0));
      await new Promise((r) => setImmediate(r));
    }
  });

  beforeEach(async () => {
    catalogo.limpar();
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const dono = await createUserFixture(prisma, 'dono@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, dono, wsA.roles.owner);
    const donoB = await createUserFixture(prisma, 'dono-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, donoB, wsB.roles.owner);
    const comum = await createUserFixture(prisma, 'membro@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, comum, wsA.roles.member);
    const crypto = app.get(CryptoService);
    for (const [ws, waba, guardar] of [
      [wsA.workspaceId, WABA_A, (id: string) => (canalA = id)],
      [wsB.workspaceId, WABA_B, (id: string) => (canalB = id)],
    ] as const) {
      const canal = await prisma.raw.channel.create({
        data: { workspaceId: ws, type: 'whatsapp', name: `WhatsApp ${waba}` },
      });
      guardar(canal.id);
      await prisma.raw.channelCredential.create({
        data: {
          workspaceId: ws,
          channelId: canal.id,
          phoneNumberId: `9${waba}`,
          businessAccountId: waba,
          tokenCipher: crypto.encrypt('token-ficticio'),
        },
      });
    }
    finalidade = (
      await app.get(ConsentPurposesService).criarVersao('acme', {
        key: 'lembrete',
        description: 'Lembretes de horário marcado',
        category: 'utility',
        fields: ['contato.nome'],
      })
    ).purposeId;
    catalogo.publicar(WABA_A, lembrete());
    owner = await login('dono@veyra.test');
    ownerB = await login('dono-b@veyra.test');
    membro = await login('membro@veyra.test');
  });

  // ── O cadastro ──────────────────────────────────────────────────────────

  describe('o cadastro (CLI templates:register)', () => {
    it('lê da Meta, guarda a forma canônica com o hash, a WABA e a trilha; o mesmo template não muda nada', async () => {
      const r = await registrada();
      expect(r.version).toBe(1);
      const v = await versao(r.versionId);
      expect(v).toMatchObject({
        workspaceId: wsA.workspaceId,
        channelId: canalA,
        businessAccountId: WABA_A,
        metaTemplateId: ID_DO_TEMPLATE,
        category: 'utility',
        parameterFormat: 'positional',
        status: 'active',
        contentHash: r.contentHash,
        bindings: NOME,
      });
      // sem `example`: só o que sai para a pessoa
      expect(JSON.stringify(v.components)).not.toContain('example');
      const [registro] = await trilha('template_version.registered');
      expect(registro).toMatchObject({ actorType: 'system', actorId: 'cli:templates-register' });
      expect(registro.after).toMatchObject({
        businessAccountId: WABA_A,
        metaTemplateId: ID_DO_TEMPLATE,
        contentHash: r.contentHash,
      });
      expect(JSON.stringify(registro)).not.toContain('Ola');
      expect(await registrar()).toEqual({
        resultado: 'sem_mudanca',
        versionId: r.versionId,
        version: 1,
        contentHash: r.contentHash,
      });
    });

    it('mudou o conteúdo ou a categoria: versão nova, e a anterior diverge com trilha', async () => {
      const v1 = await registrada();
      catalogo.publicar(
        WABA_A,
        lembrete({ components: [{ type: 'BODY', text: 'Ola {{1}}, ate amanha.' }] }),
      );
      const v2 = await registrada();
      expect(v2.version).toBe(2);
      expect((await versao(v1.versionId)).status).toBe('divergent');
      expect(await trilha('template_version.diverged')).toHaveLength(1);
      catalogo.publicar(
        WABA_A,
        lembrete({
          category: 'MARKETING',
          components: [{ type: 'BODY', text: 'Ola {{1}}, ate amanha.' }],
        }),
      );
      const v3 = await registrada();
      expect((await versao(v3.versionId)).category).toBe('marketing');
      // conteúdo sem parâmetro, e por isso sem vínculo: outra versão (que o
      // vínculo entra no hash, prova o vetor da unidade)
      catalogo.publicar(
        WABA_A,
        lembrete({
          category: 'MARKETING',
          components: [{ type: 'BODY', text: 'Ola, ate amanha.' }],
        }),
      );
      const v4 = await registrar({ vinculos: {} });
      expect(v4).toMatchObject({ resultado: 'registrada', version: 4 });
      const versoes = await prisma.raw.messageTemplateVersion.findMany({
        where: { workspaceId: wsA.workspaceId },
        orderBy: { version: 'asc' },
      });
      expect(versoes.map((v) => v.status)).toEqual([
        'divergent',
        'divergent',
        'divergent',
        'active',
      ]);
    });

    it('o template recriado na Meta com o mesmo conteúdo e outro id é versão nova, não "sem mudança"', async () => {
      const v1 = await registrada();
      catalogo.remover(ID_DO_TEMPLATE);
      catalogo.publicar(WABA_A, lembrete({ id: '5009' }));
      const v2 = await registrada();
      expect(v2).toMatchObject({ version: 2, contentHash: v1.contentHash });
      expect(await versao(v2.versionId)).toMatchObject({ metaTemplateId: '5009' });
      expect((await versao(v1.versionId)).status).toBe('divergent');
    });

    it('a credencial noutra WABA: o mesmo template de lá é versão nova, não "sem mudança"', async () => {
      const v1 = await registrada();
      await prisma.raw.channelCredential.updateMany({
        where: { channelId: canalA },
        data: { businessAccountId: '1003' },
      });
      // o catálogo falso guarda pelo id: o mesmo id, agora na outra WABA
      catalogo.publicar('1003', lembrete());
      const v2 = await registrada();
      expect(v2).toMatchObject({ version: 2, contentHash: v1.contentHash });
      expect(await versao(v2.versionId)).toMatchObject({ businessAccountId: '1003' });
      expect((await versao(v1.versionId)).status).toBe('divergent');
    });

    it('a versão divergente com o mesmo conteúdo não volta: nasce outra', async () => {
      const v1 = await registrada();
      catalogo.remover(ID_DO_TEMPLATE);
      expect(await reler(v1.versionId)).toBe('divergente');
      catalogo.publicar(WABA_A, lembrete());
      const v2 = await registrada();
      expect(v2).toMatchObject({ version: 2, contentHash: v1.contentHash });
      expect((await versao(v1.versionId)).status).toBe('divergent');
    });

    it('dois cadastros ao mesmo tempo nunca deixam duas versões ativas', async () => {
      const resultados = await Promise.allSettled([registrar(), registrar()]);
      const ativas = await prisma.raw.messageTemplateVersion.count({
        where: { workspaceId: wsA.workspaceId, status: 'active' },
      });
      expect(ativas).toBe(1);
      // um registrou; o outro viu "sem mudança" ou caiu no único da versão
      // a rejeição, se houver, é a do único da versão — nunca outra falha
      const feitos = resultados.map((r) => {
        if (r.status === 'fulfilled') return r.value.resultado;
        expect((r.reason as { code?: string }).code).toBe('P2002');
        return 'recusado_pelo_unico';
      });
      expect(feitos.filter((f) => f === 'registrada')).toHaveLength(1);
    });

    it.each([
      ['o template que não existe na WABA', () => catalogo.limpar(), NOME, 'nao_encontrado'],
      [
        'o status que não é APPROVED',
        () => catalogo.publicar(WABA_A, lembrete({ status: 'PAUSED' })),
        NOME,
        'status_nao_aprovado',
      ],
      [
        'a categoria authentication',
        () => catalogo.publicar(WABA_A, lembrete({ category: 'AUTHENTICATION' })),
        NOME,
        'categoria_recusada',
      ],
      [
        'o cabeçalho de mídia',
        () =>
          catalogo.publicar(
            WABA_A,
            lembrete({
              components: [{ type: 'HEADER', format: 'IMAGE' }, ...lembrete().components],
            }),
          ),
        NOME,
        'componente_recusado',
      ],
      ['o parâmetro sem vínculo', () => undefined, {}, 'vinculo_incompleto'],
      [
        'o campo fora do catálogo do Core',
        () => undefined,
        { 'body.1': 'contato.cpf' },
        'campo_fora_do_catalogo',
      ],
    ])('recusa %s, sem criar versão', async (_nome, preparar, vinculos, motivo) => {
      preparar();
      expect(await registrar({ vinculos })).toEqual({ resultado: 'recusada', motivo });
      expect(await prisma.raw.messageTemplateVersion.count()).toBe(0);
    });

    it('a Meta que não responde: falha, só com o status e o código, e nada muda', async () => {
      catalogo.falha = { status: 500, metaCode: 2 };
      expect(await registrar()).toEqual({ resultado: 'falha', status: 500, metaCode: 2 });
      expect(await prisma.raw.messageTemplateVersion.count()).toBe(0);
    });

    it('o canal de outro workspace não existe para o cadastro (P0)', async () => {
      catalogo.publicar(WABA_B, lembrete({ id: '5002' }));
      await expect(registrar({ channelId: canalB })).rejects.toThrow(/sem credencial/);
      expect(await prisma.raw.messageTemplateVersion.count()).toBe(0);
    });
  });

  // ── A revisão ───────────────────────────────────────────────────────────

  describe('a revisão (templates:review)', () => {
    it('registra QUEM (a membership autenticada), quando e o hash visto, com trilha; repetir devolve a mesma, sem trilha nova', async () => {
      const v = await registrada();
      const quem = await membershipDoDono();
      const r1 = await revisar(v.versionId, owner, {
        purposeId: finalidade,
        contentHash: v.contentHash,
      }).expect(201);
      expect(r1.body).toMatchObject({
        templateVersionId: v.versionId,
        purposeId: finalidade,
        contentHash: v.contentHash,
        reviewedByMembershipId: quem.id,
      });
      const [registro] = await trilha('template_review.created');
      expect(registro).toMatchObject({ actorType: 'user', actorMembershipId: quem.id });
      const r2 = await revisar(v.versionId, owner, {
        purposeId: finalidade,
        contentHash: v.contentHash,
      }).expect(201);
      expect(r2.body.id).toBe(r1.body.id);
      expect(await trilha('template_review.created')).toHaveLength(1);
      const lida = await get(`/api/templates/versions/${v.versionId}`, owner).expect(200);
      expect(lida.body).toMatchObject({ businessAccountId: WABA_A });
      expect(lida.body.reviews).toHaveLength(1);
    });

    it('a credencial do canal noutra WABA recusa a revisão (409): o envio acharia outro template', async () => {
      const v = await registrada();
      await prisma.raw.channelCredential.updateMany({
        where: { channelId: canalA },
        data: { businessAccountId: '1003' },
      });
      const recusada = await revisar(v.versionId, owner, {
        purposeId: finalidade,
        contentHash: v.contentHash,
      }).expect(409);
      expect(recusada.body.message).toMatch(/noutra conta/);
      expect(await prisma.raw.templateReview.count()).toBe(0);
    });

    it('o canal sem credencial recusa a revisão (409), com a mensagem própria', async () => {
      const v = await registrada();
      await prisma.raw.channelCredential.deleteMany({ where: { channelId: canalA } });
      const recusada = await revisar(v.versionId, owner, {
        purposeId: finalidade,
        contentHash: v.contentHash,
      }).expect(409);
      expect(recusada.body.message).toMatch(/sem a credencial/);
      expect(await prisma.raw.templateReview.count()).toBe(0);
    });

    it('o corpo com um campo a mais é recusado (400), e quem revisou nunca vem do cliente', async () => {
      const v = await registrada();
      await revisar(v.versionId, owner, {
        purposeId: finalidade,
        contentHash: v.contentHash,
        reviewedByMembershipId: '00000000-0000-4000-8000-000000000000',
      }).expect(400);
      expect(await prisma.raw.templateReview.count()).toBe(0);
    });

    it('sem templates:review, 403 na revisão e nas duas leituras, sem efeito', async () => {
      const v = await registrada();
      await revisar(v.versionId, membro, {
        purposeId: finalidade,
        contentHash: v.contentHash,
      }).expect(403);
      await get('/api/templates/versions', membro).expect(403);
      await get(`/api/templates/versions/${v.versionId}`, membro).expect(403);
      expect(await prisma.raw.templateReview.count()).toBe(0);
    });

    it('recusa o hash velho e a versão divergente (409), com a mensagem de cada um, sem efeito', async () => {
      const v1 = await registrada();
      const velho = await revisar(v1.versionId, owner, {
        purposeId: finalidade,
        contentHash: '0'.repeat(64),
      }).expect(409);
      expect(velho.body.message).toMatch(/mudou desde que você o viu/);
      catalogo.publicar(WABA_A, lembrete({ components: [{ type: 'BODY', text: 'Ola {{1}}.' }] }));
      await registrada();
      const divergente = await revisar(v1.versionId, owner, {
        purposeId: finalidade,
        contentHash: v1.contentHash,
      }).expect(409);
      expect(divergente.body.message).toMatch(/revise a versão nova/);
      expect(await prisma.raw.templateReview.count()).toBe(0);
    });

    it('recusa a finalidade de outra categoria, a que não tem o campo, a inexistente e a de outro workspace (400)', async () => {
      const v = await registrada();
      const purposes = app.get(ConsentPurposesService);
      const marketing = (
        await purposes.criarVersao('acme', {
          key: 'ofertas',
          description: 'Ofertas',
          category: 'marketing',
          fields: ['contato.nome'],
        })
      ).purposeId;
      const semCampo = (
        await purposes.criarVersao('acme', {
          key: 'aviso',
          description: 'Avisos',
          category: 'utility',
          fields: ['nome'],
        })
      ).purposeId;
      // a mesma finalidade, idêntica, no outro workspace (P0)
      const deB = (
        await purposes.criarVersao('beta', {
          key: 'lembrete',
          description: 'Lembretes de horário marcado',
          category: 'utility',
          fields: ['contato.nome'],
        })
      ).purposeId;
      for (const purposeId of [marketing, semCampo, '00000000-0000-4000-8000-000000000000', deB]) {
        await revisar(v.versionId, owner, { purposeId, contentHash: v.contentHash }).expect(400);
      }
      expect(await prisma.raw.templateReview.count()).toBe(0);
    });

    it('a versão e o canal de outro workspace não existem para quem revisa nem para quem lê (P0)', async () => {
      const v = await registrada();
      await revisar(v.versionId, ownerB, {
        purposeId: finalidade,
        contentHash: v.contentHash,
      }).expect(404);
      await get(`/api/templates/versions/${v.versionId}`, ownerB).expect(404);
      expect((await get('/api/templates/versions', ownerB).expect(200)).body).toEqual([]);
      // o dono de A, filtrando pelo canal de B, não acha nada
      expect(
        (await get(`/api/templates/versions?channelId=${canalB}`, owner).expect(200)).body,
      ).toEqual([]);
      expect(await prisma.raw.templateReview.count()).toBe(0);
    });

    it('a revisão que chega durante a divergência espera a linha da versão e é recusada (409)', async () => {
      const v = await registrada();
      const divergencia = await segurar();
      try {
        await divergencia.query('BEGIN');
        await divergencia.query(
          `UPDATE "MessageTemplateVersion" SET "status" = 'divergent' WHERE "id" = $1::uuid`,
          [v.versionId],
        );
        const revisao = disparar(
          revisar(v.versionId, owner, {
            purposeId: finalidade,
            contentHash: v.contentHash,
          }).then((r) => r),
        );
        await esperarBloqueadosPor(divergencia, 1, { descricao: 'a revisão, na linha da versão' });
        await divergencia.query('COMMIT');
        const recusada = await revisao;
        expect(recusada.status).toBe(409);
        expect(recusada.body.message).toMatch(/mudou enquanto a revisão era registrada/);
      } finally {
        await soltar(divergencia);
      }
      expect(await prisma.raw.templateReview.count()).toBe(0);
    });

    it('a divergência que chega durante a revisão espera o commit dela; a revisão fica, como histórico', async () => {
      const v = await registrada();
      const quem = await membershipDoDono();
      const revisao = await segurar();
      try {
        await revisao.query('BEGIN');
        await revisao.query(
          `INSERT INTO "TemplateReview"
             ("id", "workspaceId", "templateVersionId", "purposeId", "contentHash", "reviewedByMembershipId")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)`,
          [wsA.workspaceId, v.versionId, finalidade, v.contentHash, quem.id],
        );
        catalogo.publicar(
          WABA_A,
          lembrete({ components: [{ type: 'BODY', text: 'Outro {{1}}.' }] }),
        );
        const releitura = disparar(reler(v.versionId));
        await esperarBloqueadosPor(revisao, 1, { descricao: 'a divergência, na linha da versão' });
        await revisao.query('COMMIT');
        expect(await releitura).toBe('divergente');
      } finally {
        await soltar(revisao);
      }
      expect((await versao(v.versionId)).status).toBe('divergent');
      expect(await prisma.raw.templateReview.count()).toBe(1);
    });

    it('a espera pela linha da versão tem prazo: 409, sem efeito', async () => {
      const v = await registrada();
      const trava = await segurar();
      try {
        await trava.query('BEGIN');
        await trava.query(
          'SELECT 1 FROM "MessageTemplateVersion" WHERE "id" = $1::uuid FOR UPDATE',
          [v.versionId],
        );
        const inicio = Date.now();
        const esperou = await disparar(
          revisar(v.versionId, owner, {
            purposeId: finalidade,
            contentHash: v.contentHash,
          }).then((r) => r),
        );
        expect(esperou.status).toBe(409);
        expect(esperou.body.message).toMatch(/sendo atualizada/);
        // o prazo de trava das mudanças (2 s aqui), não o da transação (10 s)
        expect(Date.now() - inicio).toBeLessThan(4_500);
      } finally {
        await soltar(trava);
      }
      expect(await prisma.raw.templateReview.count()).toBe(0);
    });
  });

  // ── A releitura ─────────────────────────────────────────────────────────

  describe('a releitura', () => {
    it('confere; indisponível com o status pausado, sem mudar a versão; falha sem mudar nada', async () => {
      const v = await registrada();
      expect(await reler(v.versionId)).toBe('confere');
      catalogo.publicar(WABA_A, lembrete({ status: 'PAUSED' }));
      expect(await reler(v.versionId)).toBe('indisponivel');
      catalogo.falha = { networkFailure: true };
      expect(await reler(v.versionId)).toBe('falha');
      expect((await versao(v.versionId)).status).toBe('active');
      expect(await trilha('template_version.diverged')).toEqual([]);
    });

    it('o canal sem credencial é falha, não exceção, e a versão não muda', async () => {
      const v = await registrada();
      await prisma.raw.channelCredential.deleteMany({ where: { channelId: canalA } });
      expect(await reler(v.versionId)).toBe('falha');
      expect((await versao(v.versionId)).status).toBe('active');
    });

    it.each([
      [
        'o conteúdo mudou',
        () =>
          catalogo.publicar(
            WABA_A,
            lembrete({ components: [{ type: 'BODY', text: 'Outro {{1}}.' }] }),
          ),
      ],
      ['a categoria mudou', () => catalogo.publicar(WABA_A, lembrete({ category: 'MARKETING' }))],
      ['o template sumiu da WABA', () => catalogo.remover(ID_DO_TEMPLATE)],
      [
        'o template de mesmo nome tem outro id',
        () => {
          catalogo.remover(ID_DO_TEMPLATE);
          catalogo.publicar(WABA_A, lembrete({ id: '5009' }));
        },
      ],
      [
        'o conteúdo virou recusado',
        () =>
          catalogo.publicar(
            WABA_A,
            lembrete({
              components: [{ type: 'HEADER', format: 'VIDEO' }, ...lembrete().components],
            }),
          ),
      ],
    ])(
      'divergente quando %s: a versão diverge, com trilha, e nunca mais é lida',
      async (_nome, mudar) => {
        const v = await registrada();
        mudar();
        expect(await reler(v.versionId)).toBe('divergente');
        expect((await versao(v.versionId)).status).toBe('divergent');
        const [registro] = await trilha('template_version.diverged');
        expect(registro).toMatchObject({ actorType: 'system', actorId: 'template-reread' });
        expect(registro.after).toMatchObject({ motivo: 'releitura' });
        // a divergente não chega à Meta
        const leituras = catalogo.leituras;
        expect(await reler(v.versionId)).toBe('divergente');
        expect(catalogo.leituras).toBe(leituras);
      },
    );

    it('a divergência que não se grava no prazo ainda é divergente, sem lançar; a próxima releitura grava', async () => {
      const v = await registrada();
      const quem = await membershipDoDono();
      const revisao = await segurar();
      try {
        // uma revisão em curso segura a linha da versão (o FOR SHARE do gatilho)
        await revisao.query('BEGIN');
        await revisao.query(
          `INSERT INTO "TemplateReview"
             ("id", "workspaceId", "templateVersionId", "purposeId", "contentHash", "reviewedByMembershipId")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)`,
          [wsA.workspaceId, v.versionId, finalidade, v.contentHash, quem.id],
        );
        catalogo.publicar(
          WABA_A,
          lembrete({ components: [{ type: 'BODY', text: 'Outro {{1}}.' }] }),
        );
        const inicio = Date.now();
        expect(await disparar(reler(v.versionId))).toBe('divergente');
        // o prazo de trava das mudanças (2 s aqui), não o da transação do Prisma
        expect(Date.now() - inicio).toBeLessThan(4_500);
        expect((await versao(v.versionId)).status).toBe('active');
      } finally {
        await soltar(revisao);
      }
      expect(await disparar(reler(v.versionId))).toBe('divergente');
      expect((await versao(v.versionId)).status).toBe('divergent');
    });

    it('a credencial do canal noutra WABA diverge a versão sem ler a Meta: o envio acharia o template de lá', async () => {
      const v = await registrada();
      // o mesmo template também existe na outra WABA
      catalogo.publicar('1003', lembrete({ id: '5003' }));
      await prisma.raw.channelCredential.updateMany({
        where: { channelId: canalA },
        data: { businessAccountId: '1003' },
      });
      const leituras = catalogo.leituras;
      expect(await reler(v.versionId)).toBe('divergente');
      expect(catalogo.leituras).toBe(leituras);
      const [registro] = await trilha('template_version.diverged');
      expect(registro.after).toMatchObject({ motivo: 'waba_trocada' });
    });

    it('a versão de outro workspace não existe para a releitura (P0)', async () => {
      const v = await registrada();
      await expect(reler(v.versionId, wsB.workspaceId)).rejects.toThrow(/não encontrada/);
    });
  });

  // ── A imutabilidade ─────────────────────────────────────────────────────

  describe('o client e o banco garantem a imutabilidade', () => {
    it('pelo client protegido: só o status da versão se escreve, e a revisão não muda', async () => {
      const v = await registrada();
      const cls = app.get(ClsService);
      await cls.run(async () => {
        cls.set('workspaceId', wsA.workspaceId);
        await expect(
          prisma.db.messageTemplateVersion.updateMany({
            where: { id: v.versionId },
            data: { contentHash: 'e'.repeat(64) },
          }),
        ).rejects.toThrow(/só aceita o preenchimento do desfecho/);
        await expect(
          prisma.db.templateReview.updateMany({ where: {}, data: { contentHash: 'e'.repeat(64) } }),
        ).rejects.toThrow(/append-only/);
      });
    });

    it('pelo banco: o conteúdo e a WABA da versão não mudam, e o status só vai de ativa a divergente, uma vez', async () => {
      const v = await registrada();
      for (const data of [{ bindings: {} }, { businessAccountId: '1003' }]) {
        await expect(
          prisma.raw.messageTemplateVersion.updateMany({ where: { id: v.versionId }, data }),
        ).rejects.toThrow(/imutável|só vai de ativa/);
      }
      await prisma.raw.messageTemplateVersion.updateMany({
        where: { id: v.versionId },
        data: { status: 'divergent' },
      });
      await expect(
        prisma.raw.messageTemplateVersion.updateMany({
          where: { id: v.versionId },
          data: { status: 'active' },
        }),
      ).rejects.toThrow(/só vai de ativa/);
    });

    it('pelo banco: os ids da Meta são só dígitos', async () => {
      const v = await versao((await registrada()).versionId);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, status, createdAt, components, bindings, ...resto } = v;
      for (const ids of [{ businessAccountId: '../1001' }, { metaTemplateId: 'abc' }]) {
        await expect(
          prisma.raw.messageTemplateVersion.create({
            data: {
              ...resto,
              components: components as object,
              bindings: bindings as object,
              version: 99,
              ...ids,
            },
          }),
        ).rejects.toThrow(/metaIds_check/);
      }
    });

    it('pelo banco: a revisão só nasce para a versão ativa com o mesmo hash, e não muda depois', async () => {
      const v = await registrada();
      const quem = await membershipDoDono();
      const nova = (contentHash: string) =>
        prisma.raw.templateReview.create({
          data: {
            workspaceId: wsA.workspaceId,
            templateVersionId: v.versionId,
            purposeId: finalidade,
            contentHash,
            reviewedByMembershipId: quem.id,
          },
        });
      await expect(nova('f'.repeat(64))).rejects.toThrow(/mesmo conteúdo/);
      const criada = await nova(v.contentHash);
      await expect(
        prisma.raw.templateReview.updateMany({
          where: { id: criada.id },
          data: { contentHash: 'e'.repeat(64) },
        }),
      ).rejects.toThrow(/imutável/);
    });
  });
});
