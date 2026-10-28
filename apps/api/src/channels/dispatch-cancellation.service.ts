import { Injectable } from '@nestjs/common';
import type { Db } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';

/** O alvo do cancelamento: os despachos para um número, ou mensagens nomeadas. */
export type AlvoDoCancelamento =
  { numero: string; messageIds?: never } | { messageIds: readonly string[]; numero?: never };

/**
 * Os motivos que um cancelamento grava no `errorCode` — que o Inbox mostra a
 * quem lê a conversa. Lista fechada: um motivo novo entra aqui, no rótulo do
 * web e na restrição `MessageDispatch_cancel_check` (por migration), nunca como
 * texto livre do chamador.
 */
const MOTIVOS = [
  'stop_requested',
  // a origem do pedido deixou de valer: o vertical cancelou o agendamento ou
  // o retorno, sob a `validity:` exclusiva (F4.2)
  'origin_invalidated',
] as const;
export type MotivoDoCancelamento = (typeof MOTIVOS)[number];

/** O motivo lido do banco é da lista (a restrição garante; o tipo confere). */
export function ehMotivoDoCancelamento(valor: unknown): valor is MotivoDoCancelamento {
  return MOTIVOS.includes(valor as MotivoDoCancelamento);
}

export interface ResultadoDoCancelamento {
  /** os não iniciados que foram a `canceled`, com a reserva devolvida */
  cancelados: number;
  /** os em voo que receberam o pedido de cancelamento agora */
  pedidos: number;
  /** os em voo, com o marcador: não voltam, e a trilha diz "pode ter saído" */
  emVoo: number;
}

/**
 * O CANCELAMENTO NEUTRO de despachos do Core (ADR-052 item 7, F4.1c-1), na
 * transação de quem chama. Pré-condição: quem chama segura, EXCLUSIVAS, as
 * travas que o envio pega compartilhadas antes de começar — o `address:` do
 * número (o marcador da mensagem de pessoa) e os contatos do número (a guarda
 * do envio da IA), com os escritores em massa. O pedido de parar é o primeiro
 * a usá-lo, e pega todas.
 *
 * Dois comandos, e a ordem é a garantia:
 *
 * 1. **Prende TODAS as candidatas num comando só** — `reserved`,
 *    `failed_before_send` e `sending`, com ou sem o marcador, ainda sem pedido
 *    — e grava nelas o pedido e o motivo. Daqui ao commit, nenhuma muda de
 *    estado por fora: o marcador que chegasse entre um comando e outro (o da IA
 *    não pega trava) espera a linha e perde a posse; a falha transitória que
 *    devolvia o em voo à fila espera a linha e vê o pedido.
 * 2. **Cancela os não iniciados** do alvo (`reserved`, `failed_before_send`,
 *    ou `sending` SEM o marcador): vão a `canceled`, com o motivo, e o worker
 *    que já tinha reivindicado perde a posse — o marcador exige o
 *    `claimToken` — e não chama o transporte. `sending` não é tratado como
 *    chamada iniciada: o que decide é o marcador. Um despacho que entrou entre
 *    os dois comandos também é cancelado, sem pedido gravado.
 *
 * - **Em voo** (`sending` COM o marcador): não volta. Fica com o pedido, que
 *   vale enquanto a chamada não começou: na reconferência sob a guarda da IA, e
 *   na falha que prova o não envio (o `finish` leva a `canceled` em vez de
 *   `failed_before_send`). Começada a chamada, o desfecho é o dela, e a trilha
 *   diz "pode ter saído". O motivo gravado é o que o despacho grava ao terminar
 *   `canceled`, por qualquer caminho.
 * - **A reserva volta uma vez só:** é lida pelo RETURNING e zerada depois, com
 *   as linhas presas por esta transação; só a lida é devolvida, e a devolução
 *   desconta pelo que de fato apagou.
 * - **Enviado, incerto, recusado ou já cancelado:** nada muda — nunca volta a
 *   ser elegível.
 * - **Repetir** não cancela nada de novo, não devolve reserva de novo e não pede
 *   de novo: as contagens voltam zeradas, e quem chama não audita o que não
 *   mudou.
 *
 * O `workspaceId` vai explícito em cada comando, além do filtro do client: uma
 * transação `raw` de um chamador futuro não cancela o mesmo número noutro
 * workspace.
 *
 * A pré-condição também evita o impasse de linhas: o primeiro comando prende
 * as candidatas na ordem do plano, e dois cancelamentos de conjuntos que se
 * cruzam, sem as travas exclusivas, podem se travar (40P01, um é desfeito,
 * nada sai a mais). O chamador por `messageIds` precisa serializar antes:
 * o vertical (F4.2) chama sob a `validity:` EXCLUSIVA do alvo, a mesma chave
 * que o despacho do negócio pega compartilhada, com o motivo
 * `origin_invalidated`. Esse chamador e o pedido de parar (`address:`) não se
 * serializam entre si: o que os dois prendem em comum é no máximo o despacho
 * de UMA origem para UM número, e uma linha só não forma impasse (ADR-048
 * adendo 9, residuais).
 */
@Injectable()
export class CancelamentoDeDespachos {
  constructor(private readonly usage: UsageService) {}

  async cancelarNaTransacao(
    tx: Db,
    workspaceId: string,
    alvo: AlvoDoCancelamento,
    motivo: MotivoDoCancelamento,
  ): Promise<ResultadoDoCancelamento> {
    const doAlvo = {
      workspaceId,
      ...(alvo.numero
        ? { message: { conversation: { externalAddress: alvo.numero } } }
        : { messageId: { in: [...(alvo.messageIds ?? [])] } }),
    };
    const presas = await tx.messageDispatch.updateManyAndReturn({
      where: {
        ...doAlvo,
        state: { in: ['reserved', 'failed_before_send', 'sending'] },
        cancelRequestedAt: null,
      },
      data: { cancelRequestedAt: new Date(), cancelReason: motivo },
      select: { dispatchedAt: true, state: true },
    });
    const pedidos = presas.filter((d) => d.state === 'sending' && d.dispatchedAt !== null).length;
    const cancelados = await tx.messageDispatch.updateManyAndReturn({
      where: {
        ...doAlvo,
        OR: [
          { state: { in: ['reserved', 'failed_before_send'] } },
          { state: 'sending', dispatchedAt: null },
        ],
      },
      data: { state: 'canceled', errorCode: motivo, claimToken: null, leaseExpiresAt: null },
      select: { messageId: true, reservationId: true },
    });
    if (cancelados.length > 0) {
      // a reserva sai do despacho DEPOIS de lida: o RETURNING entrega o valor
      // pós-escrita, e zerá-la no mesmo comando a perderia. As linhas já estão
      // presas por esta transação, e `canceled` não é reivindicável
      await tx.messageDispatch.updateMany({
        where: { workspaceId, messageId: { in: cancelados.map((c) => c.messageId) } },
        data: { reservationId: null },
      });
      for (const { reservationId } of cancelados) {
        if (reservationId) await this.usage.releaseWithin(tx, workspaceId, reservationId);
      }
    }
    const emVoo = await tx.messageDispatch.count({
      where: { ...doAlvo, state: 'sending', dispatchedAt: { not: null } },
    });
    return { cancelados: cancelados.length, pedidos, emVoo };
  }
}
