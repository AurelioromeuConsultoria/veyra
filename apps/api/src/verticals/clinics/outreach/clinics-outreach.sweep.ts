import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EnvioDoNegocioService } from '../../../business-outbound/business-outbound.service';
import { JobsService } from '../../../jobs/jobs.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { origemDoPedido } from './clinics-outreach.precondition';
import {
  CAMPOS_DO_ESTADO,
  estadoDoPedido,
  type PedidoParaEstado,
} from './clinics-outreach.validity';

const FILA = 'clinics-outreach-sweep';
/** Lotes da leitura: de workspaces e, dentro de cada um, de pedidos com texto. */
const WORKSPACES_POR_LOTE = 100;
const PEDIDOS_POR_LOTE = 500;
/**
 * O orçamento de uma passada. Estourado, a passada para e a seguinte, cinco
 * minutos depois, RETOMA do workspace em que esta parou: nenhum fica de fora
 * para sempre por estar sempre depois dos mesmos.
 */
const ORCAMENTO_DA_PASSADA_MS = 60_000;

/**
 * A VARREDURA do texto dos pedidos (ADR-048 adendo 9, decisão 5): apaga o
 * texto renderizado — o único lugar com os valores — quando o desfecho é
 * terminal: enviado, incerto ou comprovadamente não enviado (o despacho
 * cancelado ou recusado; a aprovação vencida fora de `sending`; o rascunho
 * cujo alvo deixou de valer ou cujo limite passou). O pendente fica, inclusive
 * a falha transitória ainda elegível.
 *
 * É um escritor PRÓPRIO do vertical, e não a porta do E7, que continua só de
 * leitura. Decide só pelo banco, pelo relógio dele, e roda pelo agendador de
 * jobs do Core: funciona depois de reinício e não depende de alguém abrir a
 * tela. Idempotente: o apagado não volta (gatilho), e repetir não muda nada.
 *
 * Percorre TODOS os workspaces com texto, por cursor ordenado, e todos os
 * pedidos de cada um, por página ordenada (criação, id): um rascunho ainda
 * válido não esconde os terminais que vêm depois dele (revisão de segurança
 * da F4.2).
 */
@Injectable()
export class VarreduraDosPedidos implements OnApplicationBootstrap {
  private readonly logger = new Logger(VarreduraDosPedidos.name);
  /** onde a passada anterior parou, se estourou o orçamento */
  private retomarDepoisDe: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly envio: EnvioDoNegocioService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.jobs.agendarPeriodico(FILA, '*/5 * * * *', () => this.varrer());
  }

  /**
   * Uma passada: devolve quantos textos apagou. O orçamento e os lotes são
   * parâmetros para o teste; o agendador usa os padrões.
   */
  async varrer({
    orcamentoMs = ORCAMENTO_DA_PASSADA_MS,
    workspacesPorLote = WORKSPACES_POR_LOTE,
    pedidosPorLote = PEDIDOS_POR_LOTE,
  }: {
    orcamentoMs?: number;
    workspacesPorLote?: number;
    pedidosPorLote?: number;
  } = {}): Promise<number> {
    const inicio = Date.now();
    const agora = await this.envio.agora();
    let apagados = 0;
    let cursor = this.retomarDepoisDe;
    this.retomarDepoisDe = null;
    for (;;) {
      // raw: job cross-workspace (CLAUDE.md §3.3) — só os ids dos workspaces com
      // texto a conferir, agrupados no banco; o resto roda no contexto de cada
      // um, pelo client protegido
      const lote = (await this.prisma.raw.clinicsOutreachRequest.groupBy({
        by: ['workspaceId'],
        where: {
          renderedText: { not: null },
          ...(cursor ? { workspaceId: { gt: cursor } } : {}),
        },
        orderBy: { workspaceId: 'asc' },
        take: workspacesPorLote,
      } as never)) as unknown as { workspaceId: string }[];
      for (const { workspaceId } of lote) {
        try {
          apagados += await this.cls.run(async () => {
            this.cls.set('workspaceId', workspaceId);
            return await this.varrerWorkspace(agora, pedidosPorLote);
          });
        } catch (erro) {
          // o erro de um workspace não para a passada: os seguintes são varridos,
          // e ele, de novo na próxima. Só o tipo do erro: a mensagem traria ids
          this.logger.error(
            `Varredura dos pedidos falhou num workspace (${(erro as Error)?.name ?? 'Error'})`,
          );
        }
        cursor = workspaceId;
        if (Date.now() - inicio > orcamentoMs) {
          this.retomarDepoisDe = cursor;
          break;
        }
      }
      if (this.retomarDepoisDe || lote.length < workspacesPorLote) break;
    }
    if (apagados > 0) this.logger.log(`Varredura dos pedidos: ${apagados} texto(s) apagado(s)`);
    return apagados;
  }

  private async varrerWorkspace(agora: Date, pedidosPorLote: number): Promise<number> {
    let apagados = 0;
    let depoisDe: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const pedidos = (await this.prisma.db.clinicsOutreachRequest.findMany({
        where: {
          renderedText: { not: null },
          ...(depoisDe
            ? {
                OR: [
                  { createdAt: { gt: depoisDe.createdAt } },
                  { createdAt: depoisDe.createdAt, id: { gt: depoisDe.id } },
                ],
              }
            : {}),
        },
        select: CAMPOS_DO_ESTADO,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: pedidosPorLote,
      } as never)) as unknown as PedidoParaEstado[];
      if (pedidos.length === 0) break;
      const situacoes = await this.envio.situacoesPorOrigem(
        pedidos.map((p) => origemDoPedido(p.id)),
      );
      const terminais = pedidos
        .filter((p) => {
          const estado = estadoDoPedido(p, situacoes.get(origemDoPedido(p.id)), agora);
          return estado === 'sent' || estado === 'uncertain' || estado === 'not_sent';
        })
        .map((p) => p.id);
      if (terminais.length > 0) {
        const { count } = await this.prisma.db.clinicsOutreachRequest.updateMany({
          where: { id: { in: terminais }, renderedText: { not: null } },
          // o instante é do banco: o gatilho o reescreve com `now()`
          data: { renderedText: null, textClearedAt: agora },
        });
        apagados += count;
      }
      if (pedidos.length < pedidosPorLote) break;
      const ultimo = pedidos[pedidos.length - 1];
      depoisDe = { createdAt: ultimo.createdAt, id: ultimo.id };
    }
    return apagados;
  }
}
