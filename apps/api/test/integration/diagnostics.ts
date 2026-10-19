import { appendFileSync } from 'node:fs';
import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Diagnóstico do OUTBOX para falhas intermitentes (pedido da revisão da F1.c,
 * entrega 2): grava, num arquivo JSONL, o estado do evento e do despacho e a
 * comparação de `nextRetryAt` com `now()` LIDA NO POSTGRES, mais as sessões
 * conectadas ao banco naquele instante. Só escreve com `INTEGRATION_DIAG_FILE`
 * definido; sem ele, não faz nada.
 */
export interface OutboxSnapshot {
  node_menos_db_ms: number;
  eventos: Record<string, unknown>[];
  despachos: Record<string, unknown>[];
  sessoes: { application_name: string; state: string }[];
}

/**
 * Lê o snapshot no Postgres. Grava no arquivo JSONL quando `INTEGRATION_DIAG_FILE`
 * está definido, e sempre o DEVOLVE — para entrar na mensagem de uma falha e
 * aparecer também no log do CI.
 */
export async function outboxSnapshot(
  prisma: PrismaService,
  rotulo: string,
  workspaceId?: string,
): Promise<OutboxSnapshot> {
  const destino = process.env.INTEGRATION_DIAG_FILE;
  const nodeAntes = Date.now();
  const [relogio] = await prisma.raw.$queryRawUnsafe<{ db_ms: number }[]>(
    `SELECT (extract(epoch from clock_timestamp()) * 1000)::float8 AS db_ms`,
  );
  const nodeDepois = Date.now();
  const filtro = workspaceId
    ? `WHERE "workspaceId" = '${workspaceId.replace(/'/g, '')}'::uuid`
    : '';
  const eventos = await prisma.raw.$queryRawUnsafe<unknown[]>(
    `SELECT "id", "eventType", "status", "attempts", "claimToken" IS NOT NULL AS "temClaim",
            "leaseExpiresAt", "nextRetryAt",
            round((extract(epoch from ("nextRetryAt" - now())) * 1000)::numeric)::float8 AS "nextRetryAt_menos_now_ms",
            ("status" = 'pending' AND "nextRetryAt" <= now()) AS "elegivel",
            left("lastError", 160) AS "lastError"
       FROM "OutboxEvent" ${filtro} ORDER BY "createdAt"`,
  );
  const despachos = await prisma.raw.$queryRawUnsafe<unknown[]>(
    `SELECT "messageId", "state", "attempts", "errorCode", "leaseExpiresAt",
            "claimToken" IS NOT NULL AS "temClaim", "dispatchedAt"
       FROM "MessageDispatch" ${filtro} ORDER BY "messageId"`,
  );
  // `execute`: a função devolve `void`, que o Prisma não desserializa
  await prisma.raw.$executeRawUnsafe('SELECT pg_stat_clear_snapshot()');
  const sessoes = await prisma.raw.$queryRawUnsafe<unknown[]>(
    `SELECT pid, application_name, state, backend_start, xact_start, wait_event_type, wait_event,
            left(query, 100) AS query
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  const snapshot: OutboxSnapshot = {
    node_menos_db_ms: Math.round((nodeAntes + nodeDepois) / 2 - relogio.db_ms),
    eventos: eventos as Record<string, unknown>[],
    despachos: despachos as Record<string, unknown>[],
    sessoes: sessoes as OutboxSnapshot['sessoes'],
  };
  if (destino) {
    appendFileSync(
      destino,
      `${JSON.stringify({
        rotulo,
        teste: expect.getState().currentTestName,
        arquivo: expect.getState().testPath?.split('/').pop(),
        processo: process.pid,
        ...snapshot,
      })}\n`,
    );
  }
  return snapshot;
}

/**
 * Resumo de uma linha para a mensagem de falha: cada evento com status,
 * tentativas, posse e `nextRetryAt − now()` do BANCO; o desvio Node×banco; e
 * as sessões de OUTRO processo (indício de execução paralela no mesmo banco).
 */
export function resumoDoOutbox(snapshot: OutboxSnapshot): string {
  const meu = `veyra-int-${process.pid}-`;
  const eventos = snapshot.eventos
    .map(
      (e) =>
        `${e.eventType}:${e.status}/t${e.attempts}${e.temClaim ? '/posse' : ''}` +
        `/nextRetryAt−now=${e.nextRetryAt_menos_now_ms}ms${e.elegivel ? '/elegível' : ''}`,
    )
    .join(', ');
  const despachos = snapshot.despachos
    .map((d) => `${d.state}/t${d.attempts}${d.temClaim ? '/posse' : ''}`)
    .join(', ');
  const alheias = snapshot.sessoes
    .map((s) => s.application_name)
    .filter((nome) => !nome.startsWith(meu));
  return (
    `node−db=${snapshot.node_menos_db_ms}ms; eventos=[${eventos}]; despachos=[${despachos}]; ` +
    `sessões de outro processo=[${alheias.join(', ') || 'nenhuma'}]`
  );
}
