import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { postgresErrorCode } from '../common/prisma-exception.filter';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { MudancasDeRestricao, type OpcoesDaTransacao } from '../content-use/restriction-changes';
import { WhatsappSendService } from '../channels/whatsapp-send.service';
import type {
  AiConsentRepository,
  AiProposalType,
  AiConsentState,
  AiProposalInput,
  AiProposalRecord,
  AiProposalRepository,
  AiProposalStatus,
  AiRunRecord,
  AiRunRepository,
  AiRunSummary,
  ApprovalContext,
  ConsentActor,
  ContentTarget,
  CreateTaskExecution,
  ExecutionGuard,
  GuardRefusal,
  PromptVersionRepository,
  SendMessageExecution,
} from '../intelligence/ports/repositories';
import { PromptHashMismatchError } from '../intelligence/ports/repositories';
import type { AiTx } from '../intelligence/ports/ai-use-guard';

/**
 * ADAPTADORES Prisma das portas do módulo `intelligence` (ADR-027). Ficam AQUI,
 * fora de `src/intelligence/**`, para que o banimento de import de Prisma lá
 * dentro seja absoluto e verificável — sem pasta de exceção.
 */

type TxRunner = {
  $transaction: <T>(fn: (tx: Db) => Promise<T>, options?: OpcoesDaTransacao) => Promise<T>;
};

/**
 * Reconhece a violação do unique do RASCUNHO PENDENTE — e só ela: engolir
 * qualquer P2002 faria um unique futuro em `AiProposal` virar "outra geração
 * venceu" em silêncio.
 *
 * A busca é no `meta` INTEIRO serializado, não em `meta.target`: com o driver
 * adapter do Prisma 7 o alvo não vem em `target`, e sim em
 * `meta.driverAdapterError.cause.constraint.fields`. Restringir a `target`
 * fazia a condição nunca casar — o caminho de corrida vazava como 409
 * "Registro duplicado" para quem só pediu uma sugestão, e só aparecia quando a
 * corrida acontecia de verdade. É o motivo de esta função existir separada:
 * a forma do erro é do provedor, e merece teste próprio.
 */
export function isPendingReplyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  return JSON.stringify(error.meta ?? '').includes('pendingReplyMark');
}

/**
 * Reconhece a violação do unique `(capability, version)` de `PromptVersion` —
 * a corrida do PRIMEIRO uso de uma versão de prompt. Mesmo critério de
 * `isPendingReplyConflict`: o `meta` inteiro, porque no driver adapter do
 * Prisma 7 o alvo vem aninhado, não em `target`.
 */
export function isPromptVersionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const meta = JSON.stringify(error.meta ?? '');
  return meta.includes('capability') && meta.includes('version');
}

@Injectable()
export class PrismaAiRunRepository implements AiRunRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
  ) {}

  async create(workspaceId: string, run: AiRunRecord): Promise<string> {
    const id = randomUUID();
    try {
      await this.gravar(this.prisma.db, workspaceId, { ...run, id });
    } catch (erro) {
      /**
       * A recusa e o erro podem chegar DEPOIS de o alvo sumir (ADR-047 adendo 7
       * §10, achado da G4): o contato excluído enquanto o uso esperava as
       * travas, e a conversa dele, em cascata. A FK recusava a linha, a pessoa
       * recebia 409 e a recusa ficava sem registro (CLAUDE.md §3.10). O run
       * fica, sem a referência que não existe mais — como o run incerto
       * (`criarRunIncerto`). Só recusa e erro: o run `ok` persiste na transação
       * da guarda, sob as travas, e o alvo não some no meio.
       */
      const fkRecusada =
        (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2003') ||
        postgresErrorCode(erro) === '23503';
      if (!fkRecusada || (run.status !== 'refused' && run.status !== 'error')) throw erro;
      const existe = async (modelo: 'contact' | 'conversation', alvo?: string | null) =>
        typeof alvo === 'string' &&
        (await (
          this.prisma.db[modelo] as unknown as { count: (a: object) => Promise<number> }
        ).count({ where: { workspaceId, id: alvo } })) > 0;
      await this.gravar(this.prisma.db, workspaceId, {
        ...run,
        id,
        contactId: (await existe('contact', run.contactId)) ? run.contactId : null,
        conversationId: (await existe('conversation', run.conversationId))
          ? run.conversationId
          : null,
      });
    }
    return id;
  }

  /** NA transação da guarda (ADR-047 adendo 7 §9): o id veio de antes da chamada. */
  async createWithin(
    tx: AiTx,
    workspaceId: string,
    run: AiRunRecord & { id: string },
  ): Promise<void> {
    await this.gravar(tx as unknown as Db, workspaceId, run);
  }

  private async gravar(
    db: Db,
    workspaceId: string,
    run: AiRunRecord & { id: string },
  ): Promise<void> {
    await db.aiRun.create({
      data: {
        id: run.id,
        workspaceId,
        capability: run.capability,
        promptVersionId: run.promptVersionId,
        model: run.model,
        contextSummary: run.contextSummary,
        status: run.status,
        reasonCode: run.reasonCode ?? null,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costCents: run.costCents,
        latencyMs: run.latencyMs,
        action: run.action,
        result: (run.result ?? undefined) as object | undefined,
        conversationId: run.conversationId ?? null,
        contactId: run.contactId ?? null,
        triggeredByMembershipId: run.triggeredByMembershipId,
      },
    } as never);
  }

  async latestResult(
    capability: string,
    target: { conversationId?: string; contactId?: string },
  ): Promise<{ id: string; result: Record<string, unknown>; createdAt: Date } | null> {
    // filtrar JSON não-nulo no Prisma exige DbNull e vira ruído aqui; pegar as
    // últimas e escolher a primeira COM resultado é simples e suficiente
    const rows = (await this.prisma.db.aiRun.findMany({
      where: {
        capability,
        status: 'ok',
        ...(target.conversationId ? { conversationId: target.conversationId } : {}),
        ...(target.contactId ? { contactId: target.contactId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    } as never)) as unknown as { id: string; result: unknown; createdAt: Date }[];
    const row = rows.find((candidate) => candidate.result !== null);
    if (!row) return null;
    return { id: row.id, result: row.result as Record<string, unknown>, createdAt: row.createdAt };
  }

  /** Sem `result`: visão de custo não carrega conteúdo derivado de conversa. */
  async list(limit: number): Promise<AiRunSummary[]> {
    const rows = (await this.prisma.db.aiRun.findMany({
      select: {
        id: true,
        capability: true,
        promptVersionId: true,
        model: true,
        contextSummary: true,
        status: true,
        reasonCode: true,
        inputTokens: true,
        outputTokens: true,
        costCents: true,
        latencyMs: true,
        action: true,
        triggeredByMembershipId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    } as never)) as unknown as AiRunSummary[];
    return rows;
  }

  async totalCostCents(): Promise<number> {
    const rows = (await this.prisma.db.aiRun.findMany({
      select: { costCents: true },
    } as never)) as unknown as { costCents: number }[];
    return rows.reduce((total, row) => total + row.costCents, 0);
  }
  /**
   * `raw` justificado: expurgo CROSS-WORKSPACE (SECURITY.md §2), rotina de
   * retenção como a de auditoria. Só toca runs que ainda têm conteúdo, para não
   * reescrever linha já limpa a cada madrugada.
   */
  async purgeResultsOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.raw.aiRun.updateMany({
      where: { createdAt: { lt: cutoff }, result: { not: Prisma.DbNull } },
      data: { result: Prisma.DbNull },
    });
    return count;
  }

  /**
   * Client protegido: só o workspace do contexto é alcançado. A limpeza deixa
   * TRILHA com a contagem (nunca o conteúdo), como toda mutação relevante.
   */
  async expireResultsFor(target: ContentTarget): Promise<number> {
    const workspaceId = this.cls.get<string>('workspaceId');
    if (typeof workspaceId !== 'string') {
      throw new Error('expireResultsFor sem workspace no contexto');
    }
    const db = this.prisma.db as unknown as TxRunner;
    return db.$transaction(async (tx) => {
      const { count } = await tx.aiRun.updateMany({
        where: { ...contentWhere(target), result: { not: Prisma.DbNull } },
        data: { result: Prisma.DbNull },
      } as never);
      if (count > 0) {
        await this.audit.record(tx, workspaceId, 'ai_run.results_expired', {
          entityType: 'aiContent',
          entityId: workspaceId,
          actor: { type: 'system', id: 'content-restriction' },
          after: { results: count, scope: target === 'workspace' ? 'workspace' : 'contacts' },
        });
      }
      return count;
    });
  }
}

/**
 * Conteúdo "sobre" um contato: ligado a ele diretamente ou pela conversa. A
 * conversa entra porque o resumo grava só o `conversationId` — filtrar só por
 * `contactId` deixaria o resumo de fora.
 */
function contentWhere(target: ContentTarget): Record<string, unknown> {
  if (target === 'workspace') return {};
  const ids = [...target.contactIds];
  return {
    OR: [{ contactId: { in: ids } }, { conversation: { contactId: { in: ids } } }],
  };
}

/** rotas de CAPACIDADE de IA cujo corpo de resposta é conteúdo derivado */
const CAPABILITY_ROUTES = ['/summary', '/next-action', '/reply-suggestion'];

@Injectable()
export class PrismaAiProposalRepository implements AiProposalRepository {
  private readonly logger = new Logger(PrismaAiProposalRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
    /**
     * Serviço de DOMÍNIO do envio. Este adaptador não escreve `Message` nem
     * fala com a Meta: ele COMPÕE as duas fases do envio (ADR-044.4). Toda a
     * política — janela, opt-in, quota, append-only, dispatch, outbox —
     * continua morando num lugar só.
     */
    private readonly send: WhatsappSendService,
    private readonly cls: ClsService,
    private readonly restricao: MudancasDeRestricao,
  ) {}

  async create(workspaceId: string, proposal: AiProposalInput): Promise<string> {
    return this.criar(this.prisma.db, workspaceId, proposal);
  }

  /** NA transação da guarda (ADR-047 adendo 7 §9). */
  async createWithin(tx: AiTx, workspaceId: string, proposal: AiProposalInput): Promise<string> {
    return this.criar(tx as unknown as Db, workspaceId, proposal);
  }

  private async criar(db: Db, workspaceId: string, proposal: AiProposalInput): Promise<string> {
    const created = await db.aiProposal.create({
      data: {
        workspaceId,
        runId: proposal.runId,
        type: proposal.type,
        payload: proposal.payload as object,
        rationale: proposal.rationale,
        contactId: proposal.contactId ?? null,
        dealId: proposal.dealId ?? null,
        conversationId: proposal.conversationId ?? null,
        expiresAt: proposal.expiresAt,
      },
    } as never);
    return (created as unknown as { id: string }).id;
  }

  async expirePendingFor(target: ContentTarget): Promise<number> {
    // o workspace da trilha é o MESMO do client filtrado: lido do contexto, nunca
    // de parâmetro que pudesse divergir dele
    const workspaceId = this.cls.get<string>('workspaceId');
    if (typeof workspaceId !== 'string') {
      throw new Error('expirePendingFor sem workspace no contexto');
    }
    const db = this.prisma.db as unknown as TxRunner;
    return db.$transaction(async (tx) => {
      const alvos = (await tx.aiProposal.findMany({
        where: { ...contentWhere(target), status: 'pending' },
        select: { id: true, type: true },
      } as never)) as unknown as { id: string; type: string }[];
      let expiradas = 0;
      for (const alvo of alvos) {
        const { count } = await tx.aiProposal.updateMany({
          where: { id: alvo.id, status: 'pending' },
          data: { status: 'expired', reviewedAt: new Date(), pendingReplyMark: null },
        });
        if (count === 0) continue;
        expiradas += count;
        // ninguém decidiu: o conteúdo deixou de poder ir à IA. Ator `system`,
        // e o payload (texto de terceiro) fica fora da trilha, como sempre
        await this.audit.record(tx, workspaceId, 'ai_proposal.expired', {
          entityType: 'aiProposal',
          entityId: alvo.id,
          actor: { type: 'system', id: 'content-restriction' },
          before: { type: alvo.type, status: 'pending' },
          after: { type: alvo.type, status: 'expired' },
        });
      }
      return expiradas;
    });
  }

  async purgeCapabilityReplays(): Promise<number> {
    // só respostas JÁ gravadas (`completed`): apagar uma reserva em curso
    // liberaria execução concorrente duplicada com a mesma chave. O alcance é o
    // workspace inteiro mesmo quando o alvo são contatos — a chave não guarda o
    // contato, e apagar a mais aqui só custa um replay, nunca expõe nada
    const { count } = await this.prisma.db.idempotencyKey.deleteMany({
      where: {
        state: 'completed',
        OR: CAPABILITY_ROUTES.map((suffix) => ({
          endpoint: { startsWith: 'POST ', contains: '/intelligence/', endsWith: suffix },
        })),
      },
    } as never);
    return count;
  }

  async findById(id: string): Promise<AiProposalRecord | null> {
    const row = (await this.prisma.db.aiProposal.findFirst({
      where: { id },
    })) as unknown as AiProposalRecord | null;
    return row;
  }

  async list(
    status: AiProposalStatus | 'all',
    limit: number,
    excludeTypes?: AiProposalType[],
  ): Promise<AiProposalRecord[]> {
    const rows = (await this.prisma.db.aiProposal.findMany({
      where: {
        ...(status === 'all' ? {} : { status }),
        ...(excludeTypes && excludeTypes.length > 0 ? { type: { notIn: excludeTypes } } : {}),
      },
      // contato ATUAL da conversa: a restrição de conteúdo vale por ele também
      include: { conversation: { select: { contactId: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    } as never)) as unknown as (AiProposalRecord & {
      conversation: { contactId: string | null } | null;
    })[];
    return rows.map(({ conversation, ...row }) => ({
      ...row,
      conversationContactId: conversation?.contactId ?? null,
    }));
  }

  /**
   * Transições que não executam nada (rejeitar, expirar) — mas que são
   * AUDITADAS na mesma transação: desde o adendo 2 do ADR-044, descartar um
   * rascunho é ação sobre a conversa, e as colunas de revisão sozinhas não são
   * trilha (CLAUDE.md §3.13). O ator é a PESSOA quando houve decisão — a IA
   * propôs, o humano recusou —, e `system` quando quem expirou foi o relógio.
   */
  async transition(
    id: string,
    to: 'rejected' | 'expired',
    reviewer: ApprovalContext,
    actorType: 'user' | 'system' = 'user',
  ): Promise<boolean> {
    const db = this.prisma.db as unknown as TxRunner;
    return db.$transaction(async (tx) => {
      const alvo = (await tx.aiProposal.findFirst({
        where: { id, status: 'pending' },
        select: { id: true, type: true },
      } as never)) as unknown as { id: string; type: string } | null;
      if (!alvo) return false;

      const { count } = await tx.aiProposal.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: to,
          reviewedByMembershipId: reviewer.membershipId,
          reviewedAt: new Date(),
          // deixou de ser rascunho pendente: libera o unique da conversa
          pendingReplyMark: null,
        },
      });
      if (count === 0) return false;

      await this.audit.record(tx, reviewer.workspaceId, `ai_proposal.${to}`, {
        entityType: 'aiProposal',
        entityId: id,
        actor: { type: actorType, membershipId: reviewer.membershipId },
        // allowlist de `aiProposal`: tipo e estado. O payload NUNCA — é texto
        // de terceiro, e o motivo de a fila existir não é guardá-lo duas vezes
        before: { type: alvo.type, status: 'pending' },
        after: { type: alvo.type, status: to },
      });
      return count > 0;
    });
  }

  /**
   * Reivindicar → criar → registrar → concluir, TUDO numa transação (ADR-030).
   *
   * O `status: 'pending'` no WHERE do claim é o que serializa duas aprovações
   * simultâneas. E como a criação da tarefa acontece DENTRO da mesma transação,
   * uma falha ali desfaz o claim junto: a proposta volta a `pending` por
   * rollback, em vez de ficar `approved` sem tarefa nenhuma.
   */
  async executeCreateTask(
    id: string,
    runId: string,
    input: CreateTaskExecution,
    approver: ApprovalContext,
    guard: ExecutionGuard,
  ): Promise<{ taskId: string } | 'not_pending' | GuardRefusal> {
    const db = this.prisma.db as unknown as TxRunner;
    return this.restricao.naTransacaoInterativa(db, async (tx) => {
      // trava os contatos e reconfere ANTES do claim (ADR-047 adendo 6 §6)
      const veredito = await this.underGuard(tx, guard);
      if (veredito !== 'allowed') return veredito;
      const claimed = await tx.aiProposal.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: 'executing',
          reviewedByMembershipId: approver.membershipId,
          reviewedAt: new Date(),
          pendingReplyMark: null,
        },
      });
      if (claimed.count === 0) return 'not_pending';

      // a mutação é da IA; o aprovador fica como contexto de aprovação
      const taskId = await this.tasks.createWithin(
        tx,
        approver.workspaceId,
        {
          title: input.title,
          dueAt: input.dueAt,
          contactId: input.contactId,
          priority: 'normal',
        },
        { type: 'ai', membershipId: approver.membershipId },
      );

      await this.audit.record(tx, approver.workspaceId, 'task.created_by_ai', {
        entityType: 'task',
        entityId: taskId,
        // actorId = AiRun: a trilha liga a mutação ao run que a propôs
        actor: { type: 'ai', id: runId, membershipId: approver.membershipId },
        after: { title: input.title, status: 'open' },
      });

      const concluida = await tx.aiProposal.updateMany({
        where: { id, status: 'executing' },
        data: { status: 'approved' },
      });
      // impossível dentro da transação que fez o claim — e é por isso que vale
      // gritar: `executing` órfão é o único estado que ninguém varre
      if (concluida.count === 0) throw new Error('proposta perdeu o claim durante a execução');
      return { taskId };
    });
  }

  /**
   * Aprovação de rascunho de resposta (ADR-044).
   *
   * A ordem é a mesma do caminho humano, e não por acaso: é literalmente o
   * mesmo código. `prepareOutbound` avalia política e reserva quota FORA da
   * transação — se a janela fechou, o opt-in caiu ou a quota estourou entre
   * gerar e aprovar, ele LANÇA aqui, antes do claim, e a proposta permanece
   * `pending`.
   *
   * Dentro da transação, o claim `pending → executing` e a escrita da mensagem
   * são inseparáveis: duas aprovações simultâneas produzem uma mensagem e um
   * dispatch, no máximo. Falha em qualquer ponto desfaz as duas coisas.
   */
  async executeSendMessage(
    id: string,
    runId: string,
    input: SendMessageExecution,
    approver: ApprovalContext,
    guard: ExecutionGuard,
  ): Promise<{ messageId: string } | 'not_pending' | GuardRefusal> {
    const prepared = await this.send.prepareOutbound(approver.workspaceId, {
      conversationId: input.conversationId,
    });

    // a mensagem é da IA quando o texto aprovado é o que ela escreveu; se o
    // aprovador reescreveu, a autoria é dele (ADR-044.8)
    const authorType = input.edited ? 'user' : 'ai';
    try {
      const db = this.prisma.db as unknown as TxRunner;
      const outcome = await this.restricao.naTransacaoInterativa(db, async (tx) => {
        // trava os contatos e reconfere ANTES do claim (ADR-047 adendo 6 §6)
        const veredito = await this.underGuard(tx, guard);
        if (veredito !== 'allowed') return veredito;
        const claimed = await tx.aiProposal.updateMany({
          where: { id, status: 'pending' },
          data: {
            status: 'executing',
            reviewedByMembershipId: approver.membershipId,
            reviewedAt: new Date(),
            // sai da exclusividade de "pendente"; se a transação abortar, o
            // rollback devolve a marca junto com o estado
            pendingReplyMark: null,
          },
        });
        if (claimed.count === 0) return 'not_pending' as const;

        const { messageId } = await this.send.writeOutboundWithin(
          tx,
          approver.workspaceId,
          prepared,
          {
            body: input.body,
            authorType,
            authorMembershipId: approver.membershipId,
          },
          // os contatos que ESTA aprovação conferiu sob as travas: o envio
          // reconfere todos eles, não só o contato atual da conversa
          {
            contactIds: guard.contactIds.filter((id): id is string => typeof id === 'string'),
          },
        );

        await this.audit.record(tx, approver.workspaceId, 'message.created_from_ai_proposal', {
          entityType: 'message',
          entityId: messageId,
          // actorId = AiRun; o aprovador vai no `actorMembershipId` (ADR-044.7)
          actor: { type: 'ai', id: runId, membershipId: approver.membershipId },
          // corpo JAMAIS: `authorType` já diz se o texto é do modelo ou da pessoa
          after: { direction: 'outbound', authorType },
        });

        const concluida = await tx.aiProposal.updateMany({
          where: { id, status: 'executing' },
          data: { status: 'approved' },
        });
        if (concluida.count === 0) throw new Error('proposta perdeu o claim durante a execução');
        return { messageId };
      });
      if (outcome === 'not_pending' || outcome === 'restricted' || outcome === 'unavailable') {
        /**
         * Reserva sem mensagem: outra aprovação venceu o claim. A falha em
         * liberar NÃO pode derrubar a resposta — o perdedor da corrida precisa
         * receber "já revisada", não 500. Reserva não liberada cai no TTL, que
         * é o comportamento já assumido em todo o caminho de envio.
         */
        await this.send.releaseReservation(prepared).catch((erro: unknown) => {
          // só o NOME do erro: a mensagem do Prisma traz a invocação, com ids
          this.logger.warn(
            `Reserva ${prepared.reservationId} não liberada: ${
              erro instanceof Error ? erro.name : 'erro desconhecido'
            }`,
          );
        });
      }
      return outcome;
    } catch (error) {
      await this.send.releaseReservation(prepared);
      throw error;
    }
  }

  /**
   * Pega as travas de restrição da proposta — compartilhadas, como um uso
   * (ADR-047 adendo 6 §6) — e reconfere a restrição SOB elas. Uma mudança que
   * comitou enquanto esta transação esperava é vista aqui: a reconferência é
   * uma consulta NOVA, feita depois de as travas serem concedidas — e elas só
   * são concedidas depois do commit de quem segurava a exclusiva. Duas
   * aprovações do mesmo contato não se esperam; o claim impede a dupla
   * execução.
   *
   * Custo conhecido (ADR-047 adendo 5, item 5): a reconferência usa OUTRA
   * conexão do pool enquanto esta transação segura a sua. Rajada que esgote o
   * pool termina pelo timeout da porta (503) — falha fechada; dívida registrada.
   */
  private async underGuard(tx: Db, guard: ExecutionGuard): Promise<'allowed' | GuardRefusal> {
    await this.restricao.paraAprovacao(tx, {
      workspaceId: guard.workspaceId,
      contactIds: guard.contactIds,
    });
    return guard.recheck();
  }

  async findPendingReply(conversationId: string): Promise<AiProposalRecord | null> {
    return (await this.prisma.db.aiProposal.findFirst({
      where: { conversationId, type: 'send_message', status: 'pending' },
      orderBy: { createdAt: 'desc' },
    } as never)) as unknown as AiProposalRecord | null;
  }

  /**
   * Supersede o anterior e cria o novo na MESMA transação (ADR-044, adendo 1).
   * Fora de transação, duas gerações simultâneas superseiam uma à outra e podem
   * deixar zero pendentes — ou duas, se a supersessão falhar. O unique parcial
   * (`pendingReplyMark`) é a garantia final: o banco recusa o segundo pendente.
   */
  async createReplySuperseding(
    author: ApprovalContext,
    proposal: Omit<AiProposalInput, 'type' | 'dealId' | 'conversationId'> & {
      conversationId: string;
    },
  ): Promise<{ id: string } | 'concurrent'> {
    const db = this.prisma.db as unknown as TxRunner;
    try {
      return await db.$transaction((tx) => this.substituirECriar(tx, author, proposal, 'falha'));
    } catch (error) {
      if (isPendingReplyConflict(error)) return 'concurrent';
      throw error;
    }
  }

  /**
   * NA transação da guarda de uso externo (ADR-047 adendo 7 §9). Uma violação
   * de unicidade abortaria a transação inteira da guarda — e a corrida com
   * outra geração da mesma conversa é benigna. A inserção é `ON CONFLICT DO
   * NOTHING`, e o perdedor responde `'concurrent'`.
   */
  async createReplySupersedingWithin(
    tx: AiTx,
    author: ApprovalContext,
    proposal: Omit<AiProposalInput, 'type' | 'dealId' | 'conversationId'> & {
      conversationId: string;
    },
  ): Promise<{ id: string } | 'concurrent'> {
    return this.substituirECriar(tx as unknown as Db, author, proposal, 'pula');
  }

  /**
   * Supersede o anterior e cria o novo na MESMA transação (ADR-044, adendo 1).
   * `conflito`: `'falha'` deixa a violação de unicidade abortar a transação
   * (quem chama a reconhece); `'pula'` não aborta e devolve `'concurrent'`.
   */
  private async substituirECriar(
    tx: Db,
    author: ApprovalContext,
    proposal: Omit<AiProposalInput, 'type' | 'dealId' | 'conversationId'> & {
      conversationId: string;
    },
    conflito: 'falha' | 'pula',
  ): Promise<{ id: string } | 'concurrent'> {
    /**
     * Os substituídos são lidos ANTES de expirar: a trilha precisa dizer
     * QUAIS rascunhos morreram, e depois do `updateMany` não há como
     * distingui-los de outros já expirados.
     */
    const substituidos = (await tx.aiProposal.findMany({
      where: {
        conversationId: proposal.conversationId,
        type: 'send_message',
        status: 'pending',
      },
      select: { id: true },
    } as never)) as unknown as { id: string }[];

    /**
     * Expira id A ID, e SEMPRE com o predicado repetido na escrita
     * (`status: 'pending'`, `type: 'send_message'`). Duas razões, ambas
     * aprendidas caro neste projeto:
     *
     * 1. Sem o predicado no WHERE da escrita, uma aprovação que commite
     *    entre a leitura e a atualização é SOBRESCRITA: em READ COMMITTED
     *    o update destrava, reavalia a linha nova e — se o predicado não
     *    estiver ali — grava `expired` por cima de `approved`. A mensagem
     *    foi enviada e a proposta diria que foi supersedida.
     * 2. Sem o id, o predicado sozinho pegaria também um rascunho nascido
     *    entre as duas sentenças, que a trilha não registrou.
     *
     * Por linha, e não em lote, porque a auditoria precisa saber QUAIS
     * foram de fato expirados: `updateMany` devolve contagem, não ids.
     */
    const expirados: string[] = [];
    for (const anterior of substituidos) {
      const { count } = await tx.aiProposal.updateMany({
        where: { id: anterior.id, status: 'pending', type: 'send_message' },
        // `expired`, não `rejected`: ninguém recusou — ficou obsoleto. Sem
        // revisor, porque não houve revisão humana. A marca sai com o estado.
        data: { status: 'expired', pendingReplyMark: null },
      });
      if (count === 1) expirados.push(anterior.id);
    }

    const dados = {
      workspaceId: author.workspaceId,
      runId: proposal.runId,
      type: 'send_message',
      payload: proposal.payload as object,
      rationale: proposal.rationale,
      contactId: proposal.contactId ?? null,
      conversationId: proposal.conversationId,
      expiresAt: proposal.expiresAt,
      pendingReplyMark: true,
    };
    let id: string;
    let substituto: string;
    if (conflito === 'falha') {
      const created = await tx.aiProposal.create({ data: dados } as never);
      id = (created as unknown as { id: string }).id;
      substituto = id;
    } else {
      id = randomUUID();
      const { count } = await tx.aiProposal.createMany({
        data: [{ id, ...dados }],
        skipDuplicates: true,
      } as never);
      if (count === 0) {
        // outra geração venceu: os que ESTA expirou foram substituídos pelo
        // rascunho dela, e a trilha diz isso
        const vencedor = (await tx.aiProposal.findFirst({
          where: {
            conversationId: proposal.conversationId,
            type: 'send_message',
            status: 'pending',
          },
          select: { id: true },
        } as never)) as unknown as { id: string } | null;
        await this.auditarSubstituidos(tx, author, expirados, vencedor?.id ?? null);
        return 'concurrent';
      }
      substituto = id;
    }
    await this.auditarSubstituidos(tx, author, expirados, substituto);
    return { id };
  }

  /**
   * Supersessão é AUDITADA (ADR-044, adendo 3): ela invalida trabalho que
   * outra pessoa poderia aprovar, então precisa dizer quem gerou o
   * substituto e qual rascunho morreu. Ids e estados apenas — o corpo do
   * rascunho jamais entra na trilha.
   *
   * Só entra quem foi REALMENTE expirado: um rascunho aprovado no meio da
   * corrida não é supersedido, e a trilha não pode dizer que foi.
   */
  private async auditarSubstituidos(
    tx: Db,
    author: ApprovalContext,
    expirados: readonly string[],
    substituto: string | null,
  ): Promise<void> {
    for (const expirado of expirados) {
      await this.audit.record(tx, author.workspaceId, 'ai_proposal.superseded', {
        entityType: 'aiProposal',
        entityId: expirado,
        actor: { type: 'user', membershipId: author.membershipId },
        before: { type: 'send_message', status: 'pending' },
        after: { type: 'send_message', status: 'expired', supersededByProposalId: substituto },
      });
    }
  }
}

@Injectable()
export class PrismaAiConsentRepository implements AiConsentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<AiConsentState> {
    const row = (await this.prisma.db.aiConsent.findFirst({})) as unknown as {
      conversationContent: boolean;
    } | null;
    // ausência = NÃO consentido (ADR-028): default-deny também na falta da linha
    return { conversationContent: row?.conversationContent ?? false };
  }

  async set(state: AiConsentState, actor: ConsentActor): Promise<void> {
    const before = await this.get();
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      const existing = await tx.aiConsent.findFirst({});
      if (existing) {
        await tx.aiConsent.updateMany({
          where: {},
          data: {
            conversationContent: state.conversationContent,
            updatedByMembershipId: actor.membershipId,
          },
        });
      } else {
        await tx.aiConsent.create({
          data: {
            conversationContent: state.conversationContent,
            updatedByMembershipId: actor.membershipId,
          },
        } as never);
      }
      // consentimento é decisão sensível: quem mudou e para o quê fica na trilha
      await this.audit.record(tx, actor.workspaceId, 'ai.consent_changed', {
        entityType: 'aiConsent',
        entityId: actor.workspaceId,
        actor: { type: 'user', membershipId: actor.membershipId },
        before: { conversationContent: before.conversationContent },
        after: { conversationContent: state.conversationContent },
      });
    });
  }
}

@Injectable()
export class PrismaPromptVersionRepository implements PromptVersionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * raw justificado: PromptVersion é catálogo GLOBAL do sistema (como
   * Permission), não dado de tenant — SECURITY.md §2.
   */
  async ensure(
    capability: string,
    version: number,
    hash: string,
    changelog: string,
  ): Promise<string> {
    const existing = await this.find(capability, version);
    if (existing) return conferido(existing, capability, version, hash);
    try {
      const created = await this.prisma.raw.promptVersion.create({
        data: { capability, version, hash, changelog },
      });
      return created.id;
    } catch (error) {
      // corrida do PRIMEIRO uso: outra geração criou esta versão entre a
      // leitura e a criação. Vale a vencedora — relida e com o hash conferido,
      // como no caminho normal —, nunca um 409 para quem só pediu uma geração.
      // Sem transação em volta, a releitura depois do erro é segura.
      if (!isPromptVersionConflict(error)) throw error;
      const vencedora = await this.find(capability, version);
      if (!vencedora) throw error;
      return conferido(vencedora, capability, version, hash);
    }
  }

  private find(capability: string, version: number) {
    return this.prisma.raw.promptVersion.findFirst({ where: { capability, version } });
  }
}

/**
 * Editar o texto sem subir a versão faria runs antigos e novos apontarem para
 * a MESMA versão com conteúdos diferentes: o hash precisa bater.
 */
function conferido(
  row: { id: string; hash: string },
  capability: string,
  version: number,
  hash: string,
): string {
  if (row.hash !== hash) {
    throw new PromptHashMismatchError(
      `Prompt ${capability}@${version} foi alterado sem subir a versão — crie a versão ${version + 1}`,
    );
  }
  return row.id;
}
