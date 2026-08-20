import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Quota estourada é 402 (ADR-033): não 403, que confunde com permissão, nem
 * 429, que sugere "tente em instantes" quando o certo é "mude de plano ou
 * espere a virada". O corpo carrega o suficiente para a interface explicar.
 */
export class QuotaExceededException extends HttpException {
  constructor(
    readonly metric: string,
    readonly limit: number,
    readonly current: number,
    readonly resetsAt: Date | null,
  ) {
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
