import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Quota estourada é 402 (ADR-033): não 403, que confunde com permissão, nem
 * 429, que sugere "tente em instantes" quando o certo é "mude de plano ou
 * espere a virada". O corpo carrega o suficiente para a interface explicar.
 */
export class QuotaExceededException extends HttpException {
  constructor(
    readonly metric: string,
    readonly limit: number | null,
    readonly current: number | null,
    readonly resetsAt: Date | null,
  ) {
    super(
      {
        code: 'quota_exceeded',
        message: `Limite do plano atingido para ${metric}`,
        metric,
        /**
         * `null` para métrica MONETÁRIA: o corpo do erro seria o caminho mais
         * curto para vazar teto e gasto exatos a quem não tem `billing:manage`.
         * Hoje nenhuma métrica em dólar chega a um 402 HTTP, mas os construtores
         * são genéricos — a primeira que chegar já sai protegida (ADR-041).
         */
        limit,
        current,
        resetsAt: resetsAt?.toISOString() ?? null,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
