import { Injectable } from '@nestjs/common';
import type { ClinicsOutreachState } from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../../audit/audit.service';
import {
  EnvioDoNegocioService,
  type SituacaoDaOrigem,
} from '../../../business-outbound/business-outbound.service';
import type { AuthContext } from '../../../common/decorators';
import { MudancasDeRestricao } from '../../../content-use/restriction-changes';
import type { Db } from '../../../prisma/prisma.service';
import {
  ANTECEDENCIA_DA_CONFIRMACAO_MS,
  PRAZO_DA_REATIVACAO_MS,
  origemDoPedido,
} from './clinics-outreach.precondition';

/** O que o estado e a validade precisam do pedido. */
export interface PedidoParaEstado {
  id: string;
  kind: 'confirmation' | 'reactivation';
  appointmentId: string | null;
  startsAt: Date | null;
  returnId: string | null;
  activeMark: boolean | null;
  createdAt: Date;
}

export const CAMPOS_DO_ESTADO = {
  id: true,
  kind: true,
  appointmentId: true,
  startsAt: true,
  returnId: true,
  activeMark: true,
  createdAt: true,
} as const;

/** O limite da origem: o início menos duas horas, ou a criação mais 24 horas. */
export function limiteDoPedido(pedido: PedidoParaEstado): Date {
  return pedido.kind === 'confirmation' && pedido.startsAt
    ? new Date(pedido.startsAt.getTime() - ANTECEDENCIA_DA_CONFIRMACAO_MS)
    : new Date(pedido.createdAt.getTime() + PRAZO_DA_REATIVACAO_MS);
}

/**
 * O estado do pedido, DERIVADO da aprovação e do despacho do Core, pelo
 * relógio do banco (`agora`). Sem aprovação, o pedido é rascunho enquanto
 * conta e o limite não passou. Com ela:
 * - `sent`, `uncertain` (o incerto nunca é reenviado) e `not_sent`
 *   (cancelado ou recusado antes de sair) vêm do despacho;
 * - reservado ou com falha transitória é `pending` até o prazo da aprovação;
 *   vencido, o verificador recusa antes da chamada, e é `not_sent`;
 * - `sending` é `pending`: a chamada pode estar em curso.
 */
export function estadoDoPedido(
  pedido: PedidoParaEstado,
  situacao: SituacaoDaOrigem | undefined,
  agora: Date,
): ClinicsOutreachState {
  if (!situacao) {
    if (pedido.activeMark !== true) return 'not_sent';
    return limiteDoPedido(pedido).getTime() > agora.getTime() ? 'draft' : 'not_sent';
  }
  switch (situacao.estado) {
    case 'sent':
      return 'sent';
    case 'unknown_after_dispatch':
      return 'uncertain';
    case 'canceled':
    case 'failed_permanent':
      return 'not_sent';
    case 'sending':
      return 'pending';
    default:
      return situacao.expiresAt.getTime() > agora.getTime() ? 'pending' : 'not_sent';
  }
}

/**
 * Comprovadamente não enviado, para TIRAR A MARCA sob a `validity:` exclusiva:
 * sem aprovação, ou com o despacho cancelado ou recusado antes de sair. A
 * marca tirada faz a porta dizer "não vale" para sempre, então nem um despacho
 * atrasado sai depois. Enviado, incerto ou em curso mantêm a marca (C5).
 */
export function comprovadamenteNaoEnviado(situacao: SituacaoDaOrigem | undefined): boolean {
  return !situacao || situacao.estado === 'canceled' || situacao.estado === 'failed_permanent';
}

/** O alvo de uma mudança: o agendamento (todos os inícios, ou os diferentes do novo) ou o retorno. */
export type AlvoDaMudanca =
  { appointmentId: string; exceto?: Date } | { returnId: string; exceto?: never };

/**
 * A VALIDADE dos pedidos (ADR-048 adendos 8 e 9, F4.2). Toda mudança que
 * invalida um pedido — o estado do agendamento, a remarcação, o atendimento,
 * o vínculo e o cancelamento do retorno — abre a transação com `travar`, a
 * `validity:` EXCLUSIVA do alvo, ANTES de qualquer linha própria: é a chave que
 * o despacho do negócio pega compartilhada. Depois da mudança, `invalidar`
 * cancela os despachos dos pedidos que contavam, pelo cancelamento neutro do
 * Core, e tira a marca dos comprovadamente não enviados.
 */
@Injectable()
export class ValidadeDosPedidos {
  constructor(
    private readonly restricao: MudancasDeRestricao,
    private readonly envio: EnvioDoNegocioService,
    private readonly audit: AuditService,
  ) {}

  /** A `validity:` exclusiva das chaves, no começo da transação de quem muda. */
  async travar(tx: Db, workspaceId: string, chaves: readonly string[]): Promise<void> {
    await this.restricao.porContato(tx, {
      workspaceId,
      entityKeys: chaves.map((chave) => `validity:${chave}`),
    });
  }

  /**
   * O alvo deixou de valer para os pedidos que contavam: os despachos não
   * iniciados vão a `canceled` (`origin_invalidated`), e a marca sai dos
   * comprovadamente não enviados. Pré-condição: `travar` na mesma transação.
   */
  async invalidar(tx: Db, auth: AuthContext, alvo: AlvoDaMudanca): Promise<void> {
    const workspaceId = auth.workspaceId as string;
    const where =
      'returnId' in alvo && alvo.returnId
        ? { returnId: alvo.returnId, activeMark: true }
        : {
            appointmentId: (alvo as { appointmentId: string }).appointmentId,
            activeMark: true,
            ...(alvo.exceto ? { NOT: { startsAt: alvo.exceto } } : {}),
          };
    const pedidos = (await tx.clinicsOutreachRequest.findMany({
      where,
      select: CAMPOS_DO_ESTADO,
    } as never)) as unknown as PedidoParaEstado[];
    if (pedidos.length === 0) return;
    const { situacoes } = await this.envio.invalidarOrigensNaTransacao(
      tx,
      workspaceId,
      pedidos.map((p) => origemDoPedido(p.id)),
    );
    for (const pedido of pedidos) {
      const situacao = situacoes.get(origemDoPedido(pedido.id));
      const sai = comprovadamenteNaoEnviado(situacao);
      if (sai) {
        await tx.clinicsOutreachRequest.updateMany({
          where: { id: pedido.id, activeMark: true },
          data: { activeMark: null },
        });
      }
      // o enviado e o incerto já estavam encerrados: nada mudou para eles, e a
      // trilha não os repete a cada mudança do alvo
      if (!sai && (situacao?.estado === 'sent' || situacao?.estado === 'unknown_after_dispatch')) {
        continue;
      }
      // o estado logo depois do cancelamento: o que fica com a marca saiu ou
      // está em curso
      const estado: ClinicsOutreachState = sai
        ? 'not_sent'
        : situacao?.estado === 'sent'
          ? 'sent'
          : situacao?.estado === 'unknown_after_dispatch'
            ? 'uncertain'
            : 'pending';
      await this.audit.record(tx, workspaceId, 'clinics.outreach.invalidated', {
        entityType: 'clinicsOutreachRequest',
        entityId: pedido.id,
        actor: this.audit.actorFrom(auth),
        after: {
          kind: pedido.kind,
          appointmentId: pedido.appointmentId,
          startsAt: pedido.startsAt?.toISOString() ?? null,
          returnId: pedido.returnId,
          state: estado,
          activeMark: sai ? null : true,
        },
      });
    }
  }
}
