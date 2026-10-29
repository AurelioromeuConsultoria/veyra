import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FakeMetaTransport } from '../channels/fake.transport';
import { FakeTemplateCatalog, META_TEMPLATE_CATALOG } from '../channels/meta-templates.catalog';
import { META_TRANSPORT } from '../channels/meta.transport';
import { CryptoService } from '../common/crypto.service';
import { ConsentPurposesService } from '../consents/consent-purposes.service';
import { WABA_DA_DEMONSTRACAO } from '../demo/catalogo-da-demonstracao';
import { TEMPLATES_DA_DEMONSTRACAO } from '../demo/templates-da-demonstracao';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import {
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { cadastrarTemplatesDaDemonstracao, RecusaDoProcedimento } from './templates-demo.core';

/**
 * O procedimento `templates:demo` (ADR-048 adendo 12, item 2): os templates
 * FICTÍCIOS da demonstração cadastrados e revisados pelos serviços de sempre,
 * só com o transporte simulado, só num canal da WABA fictícia e só por um
 * revisor com `templates:review`. O catálogo é o do staging
 * (`daDemonstracao`). Nomes e números FICTÍCIOS.
 */

const NOMES = TEMPLATES_DA_DEMONSTRACAO.map((t) => t.nome);

describe('F4.4b — o procedimento dos templates da demonstração (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: META_TEMPLATE_CATALOG, useValue: FakeTemplateCatalog.daDemonstracao() },
        { provide: META_TRANSPORT, useValue: new FakeMetaTransport() },
      ],
    );
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let canalDemo: string;
  let canalReal: string;
  let canalB: string;
  let donoA: string;

  /** O transporte simulado só durante o procedimento: o resto do app segue igual. */
  const simulado = <T>(fn: () => Promise<T>): Promise<T> => {
    const config = app.get(ConfigService);
    const original = config.get.bind(config);
    const espiao = jest
      .spyOn(config, 'get')
      .mockImplementation(((chave: string) =>
        chave === 'META_TRANSPORT_MODE'
          ? 'fake'
          : chave === 'VEYRA_ENV'
            ? 'staging'
            : original(chave)) as ConfigService['get']);
    return fn().finally(() => espiao.mockRestore());
  };
  const procedimento = (revisor = 'dono@veyra.test', channelId = canalDemo, slug = 'acme') =>
    cadastrarTemplatesDaDemonstracao(app, { slug, channelId, revisor });
  const canal = async (workspaceId: string, nome: string, waba: string) => {
    const criado = await prisma.raw.channel.create({
      data: { workspaceId, type: 'whatsapp', name: nome },
    });
    await prisma.raw.channelCredential.create({
      data: {
        workspaceId,
        channelId: criado.id,
        phoneNumberId: `0${Math.floor(Math.random() * 1e9)}`,
        businessAccountId: waba,
        tokenCipher: app.get(CryptoService).encrypt('token-ficticio-da-demonstracao'),
      },
    });
    return criado.id;
  };
  const finalidade = (slug: string, key: string, fields: string[]) =>
    app.get(ConsentPurposesService).criarVersao(slug, {
      key,
      description: `Finalidade fictícia ${key}`,
      category: 'utility',
      fields,
    });
  const contagem = async () => ({
    versoes: await prisma.raw.messageTemplateVersion.count(),
    revisoes: await prisma.raw.templateReview.count(),
    consentimentos: await prisma.raw.consent.count(),
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const dono = await createUserFixture(prisma, 'dono@veyra.test');
    donoA = await createMembershipFixture(prisma, wsA.workspaceId, dono, wsA.roles.owner);
    const membro = await createUserFixture(prisma, 'membro@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, membro, wsA.roles.member);
    const donoB = await createUserFixture(prisma, 'dono-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, donoB, wsB.roles.owner);
    canalDemo = await canal(wsA.workspaceId, 'WhatsApp da demonstração', WABA_DA_DEMONSTRACAO);
    canalReal = await canal(wsA.workspaceId, 'WhatsApp de outra conta', '1001');
    canalB = await canal(wsB.workspaceId, 'WhatsApp do beta', WABA_DA_DEMONSTRACAO);
    await finalidade('acme', 'clinics_confirmacao', [
      'contato.primeiro_nome',
      'clinics.data',
      'clinics.hora',
    ]);
    await finalidade('acme', 'clinics_reativacao', ['contato.primeiro_nome']);
  });

  it('o catálogo do staging só responde à WABA fictícia', async () => {
    const catalogo = FakeTemplateCatalog.daDemonstracao();
    const ler = (waba: string) =>
      catalogo.buscarPorNome({ businessAccountId: waba, token: 'x' }, NOMES[0], 'pt_BR');
    expect((await ler(WABA_DA_DEMONSTRACAO)).tipo).toBe('achado');
    expect((await ler('1001')).tipo).toBe('ausente');
    expect(
      await new FakeTemplateCatalog().buscarPorNome(
        { businessAccountId: WABA_DA_DEMONSTRACAO, token: 'x' },
        NOMES[0],
        'pt_BR',
      ),
    ).toEqual({ tipo: 'ausente' });
  });

  it('sem o transporte simulado, recusa antes de qualquer gravação', async () => {
    await expect(procedimento()).rejects.toThrow(
      new RecusaDoProcedimento(
        'O procedimento só roda com o transporte e o catálogo falsos (META_TRANSPORT_MODE=fake e VEYRA_ENV=staging).',
      ),
    );
    expect(await contagem()).toEqual({ versoes: 0, revisoes: 0, consentimentos: 0 });
  });

  it('recusa o canal de outra WABA e o canal de outro workspace (P0)', async () => {
    await expect(simulado(() => procedimento(undefined, canalReal))).rejects.toThrow(
      /não está na WABA fictícia da demonstração/,
    );
    await expect(simulado(() => procedimento(undefined, canalB))).rejects.toThrow(
      /O canal não existe neste workspace/,
    );
    expect(await contagem()).toEqual({ versoes: 0, revisoes: 0, consentimentos: 0 });
  });

  it('recusa o revisor sem templates:review, de outro workspace, desconhecido, suspenso ou de workspace suspenso', async () => {
    const recusa = /O revisor precisa ser usuário ativo e membro ativo deste workspace ativo/;
    for (const revisor of ['membro@veyra.test', 'dono-b@veyra.test', 'ninguem@veyra.test']) {
      await expect(simulado(() => procedimento(revisor))).rejects.toThrow(recusa);
    }
    // as checagens do guard, uma de cada vez, e desfeitas: a membership, o
    // usuário e o workspace suspensos
    const suspender = async (
      alvo: 'membership' | 'user' | 'workspace',
      status: 'suspended' | 'active',
    ) => {
      if (alvo === 'membership') {
        await prisma.raw.membership.updateMany({ where: { id: donoA }, data: { status } });
      } else if (alvo === 'user') {
        await prisma.raw.user.updateMany({ where: { email: 'dono@veyra.test' }, data: { status } });
      } else {
        await prisma.raw.workspace.updateMany({ where: { id: wsA.workspaceId }, data: { status } });
      }
    };
    for (const alvo of ['membership', 'user', 'workspace'] as const) {
      await suspender(alvo, 'suspended');
      await expect(simulado(() => procedimento())).rejects.toThrow(recusa);
      await suspender(alvo, 'active');
    }
    expect(await contagem()).toEqual({ versoes: 0, revisoes: 0, consentimentos: 0 });
  });

  it('cadastra e revisa pelos serviços, em nome do revisor; rodar de novo não muda nada', async () => {
    await finalidade('acme', 'atendimento_retomada', ['contato.nome']);
    const linhas = await simulado(() => procedimento());
    expect(linhas).toEqual(
      NOMES.map((template) =>
        expect.objectContaining({
          template,
          ok: true,
          cadastro: 'registrada',
          revisao: 'revisada',
        }),
      ),
    );
    const versoes = await prisma.raw.messageTemplateVersion.findMany({
      where: { workspaceId: wsA.workspaceId },
    });
    expect(versoes.map((v) => v.name).sort()).toEqual([...NOMES].sort());
    for (const v of versoes) {
      expect(v).toMatchObject({
        channelId: canalDemo,
        businessAccountId: WABA_DA_DEMONSTRACAO,
        status: 'active',
        category: 'utility',
      });
    }
    const revisoes = await prisma.raw.templateReview.findMany({
      where: { workspaceId: wsA.workspaceId },
    });
    expect(revisoes).toHaveLength(3);
    expect(new Set(revisoes.map((r) => r.reviewedByMembershipId))).toEqual(new Set([donoA]));
    // a trilha da revisão, a mesma da rota, em nome do revisor
    const trilha = await prisma.raw.auditLog.findMany({
      where: { workspaceId: wsA.workspaceId, action: 'template_review.created' },
    });
    expect(trilha).toHaveLength(3);
    expect(new Set(trilha.map((t) => t.actorMembershipId))).toEqual(new Set([donoA]));
    // a trilha diz que a revisão veio do procedimento, não da rota
    for (const t of trilha) expect(t.after).toMatchObject({ via: 'cli:templates-demo' });
    const cadastros = await prisma.raw.auditLog.findMany({
      where: { workspaceId: wsA.workspaceId, action: 'template_version.registered' },
    });
    expect(cadastros).toHaveLength(3);
    expect(new Set(cadastros.map((t) => `${t.actorType}:${t.actorId}`))).toEqual(
      new Set(['system:cli:templates-demo']),
    );

    const antes = await contagem();
    const deNovo = await simulado(() => procedimento());
    expect(deNovo).toEqual(
      NOMES.map((template) =>
        expect.objectContaining({
          template,
          ok: true,
          cadastro: 'sem_mudanca',
          revisao: 'ja_revisada',
        }),
      ),
    );
    expect(await contagem()).toEqual(antes);
    // nada criou consentimento, e o outro workspace segue sem nada (P0)
    expect(antes.consentimentos).toBe(0);
    expect(
      await prisma.raw.messageTemplateVersion.count({ where: { workspaceId: wsB.workspaceId } }),
    ).toBe(0);
  });

  it('sem alguma finalidade, recusa antes de qualquer cadastro, e diz quais faltam', async () => {
    await expect(simulado(() => procedimento())).rejects.toThrow(
      new RecusaDoProcedimento(
        'Sem as finalidades atendimento_retomada: crie-as antes pela CLI consents:purpose. Nada foi cadastrado.',
      ),
    );
    expect(await contagem()).toEqual({ versoes: 0, revisoes: 0, consentimentos: 0 });
    expect(
      await prisma.raw.auditLog.count({ where: { action: 'template_version.registered' } }),
    ).toBe(0);
    expect(await prisma.raw.consentPurpose.count({ where: { key: 'atendimento_retomada' } })).toBe(
      0,
    );
  });
});
