import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { PermissionsService } from '../auth/permissions.service';
import { transporteSimulado } from '../channels/fake.transport';
import type { AuthContext } from '../common/decorators';
import { WABA_DA_DEMONSTRACAO } from '../demo/catalogo-da-demonstracao';
import { TEMPLATES_DA_DEMONSTRACAO } from '../demo/templates-da-demonstracao';
import { PrismaService } from '../prisma/prisma.service';
import { TemplateReviewsService } from '../templates/template-reviews.service';
import { TemplateVersionsService } from '../templates/template-versions.service';

/**
 * O procedimento `templates:demo` (ADR-048 adendo 12, item 2): cadastra e
 * revisa os templates FICTÍCIOS da demonstração num workspace e num canal
 * explícitos, pelos serviços de sempre — o cadastro da CLI `templates:register`
 * e a revisão da rota `POST /templates/versions/:id/reviews`. Nada é gravado
 * por fora deles: a forma canônica, o hash, as versões, a checagem da WABA, da
 * categoria e dos campos da finalidade, e a trilha são os mesmos.
 *
 * - Só com o transporte e o catálogo falsos, e só num canal da WABA fictícia.
 * - A revisão fica em nome do revisor indicado, que precisa estar ativo, ser
 *   membro ativo do workspace ativo e ter `templates:review` (as checagens do
 *   guard). Quem roda o procedimento é quem opera o servidor, com a
 *   autorização do revisor obtida fora do sistema; a trilha registra o nome
 *   dele e a origem (`via: cli:templates-demo`).
 * - Não cria finalidade nem consentimento: sem alguma das finalidades, recusa
 *   antes de qualquer cadastro.
 * - Rodar de novo não muda nada.
 */

export class RecusaDoProcedimento extends Error {}

/** o cadastro na trilha: o procedimento, não a CLI `templates:register` */
const ATOR_DO_PROCEDIMENTO = { type: 'system', id: 'cli:templates-demo' } as const;

export interface EntradaDoProcedimento {
  slug: string;
  channelId: string;
  /** o e-mail do revisor, membro ativo do workspace com `templates:review` */
  revisor: string;
}

export type LinhaDoProcedimento =
  | {
      template: string;
      ok: true;
      cadastro: 'registrada' | 'sem_mudanca';
      version: number;
      finalidade: string;
      finalidadeVersao: number;
      revisao: 'revisada' | 'ja_revisada';
    }
  | { template: string; ok: false; motivo: string };

export async function cadastrarTemplatesDaDemonstracao(
  app: INestApplicationContext,
  entrada: EntradaDoProcedimento,
): Promise<LinhaDoProcedimento[]> {
  if (!transporteSimulado(app.get(ConfigService))) {
    throw new RecusaDoProcedimento(
      'O procedimento só roda com o transporte e o catálogo falsos (META_TRANSPORT_MODE=fake e VEYRA_ENV=staging).',
    );
  }
  const prisma = app.get(PrismaService);
  const cls = app.get(ClsService);
  // `raw` justificado: rotina administrativa (CLAUDE.md §3.3) que resolve o
  // workspace pelo slug e o usuário global pelo e-mail, antes de existir
  // contexto; o resto vai pelo client protegido, no contexto do workspace
  const workspace = await prisma.raw.workspace.findFirst({
    where: { slug: entrada.slug },
    select: { id: true, status: true },
  });
  if (!workspace) throw new RecusaDoProcedimento(`Workspace ${entrada.slug} não encontrado.`);
  // o revisor como o guard o aceitaria numa requisição: o usuário ativo, a
  // membership ativa num workspace ativo, e a permissão do papel (revisão de
  // segurança da F4.4b)
  const usuario = await prisma.raw.user.findFirst({
    where: { email: entrada.revisor.trim().toLowerCase(), status: 'active' },
    select: { id: true, email: true },
  });

  return cls.run(async () => {
    cls.set('workspaceId', workspace.id);
    const credencial = await prisma.db.channelCredential.findFirst({
      where: { channelId: entrada.channelId },
      select: { businessAccountId: true },
    });
    if (!credencial) {
      throw new RecusaDoProcedimento('O canal não existe neste workspace ou está sem credencial.');
    }
    if (credencial.businessAccountId !== WABA_DA_DEMONSTRACAO) {
      throw new RecusaDoProcedimento(
        'O canal não está na WABA fictícia da demonstração: o procedimento não cadastra template numa conta real.',
      );
    }
    const membership = usuario
      ? await prisma.db.membership.findFirst({
          where: { userId: usuario.id, status: 'active' },
          select: { id: true },
        })
      : null;
    if (
      workspace.status !== 'active' ||
      !usuario ||
      !membership ||
      !(await app.get(PermissionsService).membershipHas(membership.id, 'templates:review'))
    ) {
      throw new RecusaDoProcedimento(
        'O revisor precisa ser usuário ativo e membro ativo deste workspace ativo, com templates:review.',
      );
    }
    const revisor: AuthContext = {
      userId: usuario.id,
      email: usuario.email,
      membershipId: membership.id,
      workspaceId: workspace.id,
      sessionId: 'cli:templates-demo',
    };

    // as finalidades ANTES de qualquer cadastro: sem uma delas, nada é gravado
    // (revisão da F4.4b — antes, a versão nascia e ficava sem revisão)
    const finalidades = new Map<string, { id: string; version: number }>();
    for (const { finalidade } of TEMPLATES_DA_DEMONSTRACAO) {
      const purpose = await prisma.db.consentPurpose.findFirst({
        where: { key: finalidade },
        orderBy: { version: 'desc' },
        select: { id: true, version: true },
      });
      if (purpose) finalidades.set(finalidade, purpose);
    }
    const faltam = [...new Set(TEMPLATES_DA_DEMONSTRACAO.map((t) => t.finalidade))].filter(
      (f) => !finalidades.has(f),
    );
    if (faltam.length > 0) {
      throw new RecusaDoProcedimento(
        `Sem as finalidades ${faltam.join(', ')}: crie-as antes pela CLI consents:purpose. Nada foi cadastrado.`,
      );
    }

    const versoes = app.get(TemplateVersionsService);
    const revisoes = app.get(TemplateReviewsService);
    const linhas: LinhaDoProcedimento[] = [];
    for (const { nome, vinculos, finalidade } of TEMPLATES_DA_DEMONSTRACAO) {
      const cadastro = await versoes.registrar(
        entrada.slug,
        { channelId: entrada.channelId, name: nome, language: 'pt_BR', vinculos },
        ATOR_DO_PROCEDIMENTO,
      );
      if (cadastro.resultado === 'recusada' || cadastro.resultado === 'falha') {
        // nada foi gravado para este template: o cadastro recusou antes da transação
        linhas.push({
          template: nome,
          ok: false,
          motivo:
            cadastro.resultado === 'recusada'
              ? `cadastro recusado (${cadastro.motivo})`
              : 'o catálogo não respondeu',
        });
        continue;
      }
      const purpose = finalidades.get(finalidade) as { id: string; version: number };
      const existente = await prisma.db.templateReview.findFirst({
        where: { templateVersionId: cadastro.versionId, purposeId: purpose.id },
        select: { id: true },
      });
      // o ator é o revisor; a trilha diz que veio do procedimento, não da rota
      await revisoes.revisar(
        revisor,
        cadastro.versionId,
        { purposeId: purpose.id, contentHash: cadastro.contentHash },
        'cli:templates-demo',
      );
      linhas.push({
        template: nome,
        ok: true,
        cadastro: cadastro.resultado,
        version: cadastro.version,
        finalidade,
        finalidadeVersao: purpose.version,
        revisao: existente ? 'ja_revisada' : 'revisada',
      });
    }
    return linhas;
  });
}
