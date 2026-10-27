import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CreateTemplateReviewInput, TemplateReviewDto } from '@veyra/contracts';
import { AuditService } from '../audit/audit.service';
import { MudancasDeRestricao } from '../content-use/restriction-changes';
import type { AuthContext } from '../common/decorators';
import { postgresErrorCode } from '../common/prisma-exception.filter';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { revisaoDto, type LinhaDaRevisao } from './template-dto';

type TxRunner = {
  $transaction: <T>(fn: (tx: Db) => Promise<T>, options?: { timeout: number }) => Promise<T>;
};

const MENSAGEM_DIVERGENTE =
  'A Meta mostrou outro conteúdo para este template: revise a versão nova.';
const MENSAGEM_HASH = 'O conteúdo mudou desde que você o viu: confira a versão de novo.';
const MENSAGEM_CONCORRENTE =
  'A versão mudou enquanto a revisão era registrada: confira a versão de novo.';
const MENSAGEM_DA_ESPERA = 'A versão está sendo atualizada; tente de novo em instantes.';
const MENSAGEM_DA_WABA =
  'O canal está agora noutra conta do WhatsApp Business: cadastre o template de novo.';
const MENSAGEM_SEM_CREDENCIAL = 'O canal está sem a credencial da Meta: cadastre o canal de novo.';

/**
 * A REVISÃO de uma versão de template para uma versão de finalidade (ADR-052
 * item 4, F4.1c-2), por quem tem `templates:review`: quem, quando e o hash que
 * viu. As recusas:
 *
 * - a versão de outro workspace não existe (404);
 * - a versão divergente, ou o hash diferente do da versão (409). O gatilho do
 *   banco garante o mesmo, com a linha da versão presa até o commit: a
 *   divergência que comitou enquanto a revisão esperava a linha também é 409,
 *   com a mensagem própria;
 * - a finalidade inexistente, a categoria diferente da finalidade, ou um
 *   parâmetro ligado a campo fora da lista fechada dela (400).
 *
 * Repetir a mesma versão e finalidade devolve a revisão existente, sem trilha
 * nova: o único (versão, finalidade) do banco recusa a segunda, e a existente
 * é a resposta — na repetição e na corrida, pelo mesmo caminho. A revisão não
 * abre envio: ligá-la ao envio é da F4.1c-3.
 */
@Injectable()
export class TemplateReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly restricao: MudancasDeRestricao,
  ) {}

  async revisar(
    auth: AuthContext,
    versionId: string,
    entrada: CreateTemplateReviewInput,
  ): Promise<TemplateReviewDto> {
    const db = this.prisma.db as unknown as TxRunner;
    try {
      // a transação interativa das mudanças: o gatilho espera a linha da versão
      // com `lock_timeout` desde o BEGIN (409 no prazo), não sem limite
      return await this.restricao.naTransacaoInterativa(db, async (tx) => {
        const versao = (await tx.messageTemplateVersion.findFirst({
          where: { id: versionId },
          select: {
            id: true,
            status: true,
            contentHash: true,
            category: true,
            bindings: true,
            channelId: true,
            businessAccountId: true,
          },
        })) as {
          id: string;
          status: string;
          contentHash: string;
          category: string;
          bindings: unknown;
          channelId: string;
          businessAccountId: string;
        } | null;
        if (!versao) throw new NotFoundException('Versão de template não encontrada');
        if (versao.status !== 'active') throw new ConflictException(MENSAGEM_DIVERGENTE);
        // a credencial do canal noutra WABA: o envio acharia outro template. É
        // a checagem RÁPIDA, sem trava: a garantia é a releitura, que diverge
        // a versão (`waba_trocada`) antes de qualquer uso
        const credencial = (await tx.channelCredential.findFirst({
          where: { channelId: versao.channelId },
          select: { businessAccountId: true },
        })) as { businessAccountId: string } | null;
        if (!credencial) throw new ConflictException(MENSAGEM_SEM_CREDENCIAL);
        if (credencial.businessAccountId !== versao.businessAccountId) {
          throw new ConflictException(MENSAGEM_DA_WABA);
        }
        if (entrada.contentHash !== versao.contentHash) {
          throw new ConflictException(MENSAGEM_HASH);
        }
        const finalidade = (await tx.consentPurpose.findFirst({
          where: { id: entrada.purposeId },
          select: { category: true, fields: true },
        })) as { category: string; fields: string[] } | null;
        if (!finalidade) throw new BadRequestException('Finalidade inválida');
        if (finalidade.category !== versao.category) {
          throw new BadRequestException('A categoria do template não é a da finalidade');
        }
        const campos = Object.values(versao.bindings as Record<string, string>);
        if (!campos.every((campo) => finalidade.fields.includes(campo))) {
          throw new BadRequestException(
            'Um parâmetro do template usa um campo fora da lista da finalidade',
          );
        }
        const criada = (await tx.templateReview.create({
          data: {
            templateVersionId: versionId,
            purposeId: entrada.purposeId,
            contentHash: entrada.contentHash,
            reviewedByMembershipId: auth.membershipId as string,
          },
        } as never)) as unknown as LinhaDaRevisao;
        await this.audit.record(tx, auth.workspaceId as string, 'template_review.created', {
          entityType: 'templateReview',
          entityId: criada.id,
          actor: this.audit.actorFrom(auth),
          after: {
            templateVersionId: versionId,
            purposeId: entrada.purposeId,
            contentHash: entrada.contentHash,
          },
        });
        return revisaoDto(criada);
      });
    } catch (erro) {
      // a mesma revisão já existe (repetida, ou criada ao mesmo tempo): é ela
      if ((erro as { code?: string } | null)?.code === 'P2002') {
        const existente = await this.existente(this.prisma.db, versionId, entrada.purposeId);
        if (existente) return revisaoDto(existente);
      }
      // o gatilho: a versão divergiu enquanto esta revisão esperava a linha
      if (postgresErrorCode(erro) === '23514') throw new ConflictException(MENSAGEM_CONCORRENTE);
      // a linha da versão presa além do prazo (uma divergência em curso)
      if (postgresErrorCode(erro) === '55P03') throw new ConflictException(MENSAGEM_DA_ESPERA);
      throw erro;
    }
  }

  private async existente(
    db: Db,
    templateVersionId: string,
    purposeId: string,
  ): Promise<LinhaDaRevisao | null> {
    return (await db.templateReview.findFirst({
      where: { templateVersionId, purposeId },
    })) as unknown as LinhaDaRevisao | null;
  }
}
