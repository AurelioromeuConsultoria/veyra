/**
 * Stub de pg-boss para o Jest (CJS) — o pacote é ESM puro e o runner não o
 * importa. Seguro porque em NODE_ENV=test o JobsService NÃO inicia o worker:
 * as suítes chamam `dispatchPending()` diretamente, sem depender de cron.
 * Se alguém tentar usar o boss em teste, os métodos falham alto.
 */
export class PgBoss {
  constructor(_options?: unknown) {
    throw new Error('pg-boss não deve ser instanciado em testes (worker desabilitado)');
  }
}
