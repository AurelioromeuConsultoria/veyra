import { HttpException, HttpStatus } from '@nestjs/common';
import { MONETARY_UNITS, USAGE_METRICS } from './metrics';

/**
 * Quota estourada é 402 (ADR-033): não 403, que confunde com permissão, nem
 * 429, que sugere "tente em instantes" quando o certo é "mude de plano ou
 * espere a virada". O corpo carrega o suficiente para a interface explicar.
 */
export class QuotaExceededException extends HttpException {
  constructor(
    readonly metric: string,
    limitBruto: number | null,
    currentBruto: number | null,
    readonly resetsAt: Date | null,
  ) {
    /**
     * A REDAÇÃO acontece aqui, não em quem chama: o corpo do erro é o caminho
     * mais curto para vazar teto e gasto exatos a quem não tem `billing:manage`,
     * e havia três construtores (`consume`, `reserve`, `quotaExceeded`) — dois
     * deles genéricos sobre a métrica. Invariante no tipo, não na disciplina de
     * cada chamador (ADR-041).
     */
    /**
     * Default FAIL-CLOSED: métrica fora do catálogo é tratada como monetária.
     * `MetricKey` é `string` no fim das contas, então o tipo não impede a chave
     * errada — e invariante de privacidade que erra deve errar para o lado de
     * omitir. A redação é cega à permissão de propósito: quem tem
     * `billing:manage` também recebe `null` aqui. Hoje é inócuo (nenhuma métrica
     * em dólar chega a um 402 HTTP), e quando chegar, projetar por permissão
     * exige o contexto da request, que uma exceção não tem.
     */
    const monetaria = MONETARY_UNITS[USAGE_METRICS[metric]?.unit ?? 'usd_cents'];
    const limit = monetaria ? null : limitBruto;
    const current = monetaria ? null : currentBruto;
    super(
      {
        code: 'quota_exceeded',
        message: `Limite do plano atingido para ${metric}`,
        metric,
        limit,
        current,
        resetsAt: resetsAt?.toISOString() ?? null,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
