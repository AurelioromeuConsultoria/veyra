import { Client } from 'pg';

/**
 * Sessões bloqueadas, direta ou indiretamente, pela transação desta conexão —
 * só com informação VIVA do gerenciador de locks (`pg_locks` e
 * `pg_blocking_pids`). A cadeia a partir do pid da trava exclui qualquer outra
 * sessão do banco: nenhuma delas espera por esta linha.
 */
const CADEIA_SQL = `
  WITH RECURSIVE esperando AS (
    SELECT DISTINCT pid FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()
  ), cadeia AS (
    SELECT e.pid FROM esperando e WHERE pg_backend_pid() = ANY (pg_blocking_pids(e.pid))
    UNION
    SELECT e.pid FROM esperando e JOIN cadeia c ON c.pid = ANY (pg_blocking_pids(e.pid))
  )
  SELECT count(*)::text AS n FROM cadeia`;

/** Para o diagnóstico: quem espera o quê, por quem, e com qual consulta. */
const SESSOES_SQL = `
  SELECT a.pid, a.state, a.wait_event_type, a.wait_event,
         pg_blocking_pids(a.pid) AS bloqueado_por,
         (SELECT json_agg(json_build_object('tipo', l.locktype, 'modo', l.mode))
            FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted) AS esperas,
         left(a.query, 160) AS query
    FROM pg_stat_activity a
   WHERE a.datname = current_database() AND a.pid <> pg_backend_pid() AND a.state <> 'idle'`;

/**
 * Espera `quantos` requisições ficarem BLOQUEADAS pela trava que `trava` segura
 * numa transação aberta. É o que torna as corridas determinísticas.
 *
 * NUNCA filtrar por `pg_stat_activity` aqui: dentro de uma transação, essa visão
 * é CONGELADA no primeiro acesso (estado, texto da consulta e até a lista de
 * sessões). Se as requisições ainda estavam nos guards quando o laço começou,
 * ela nunca as mostrava esperando — e o teste estourava o prazo com as duas
 * bloqueadas. Foi a falha do CI no d742e7a, reproduzida localmente congelando a
 * visão antes do laço. `pg_locks` e `pg_blocking_pids` são lidos ao vivo.
 *
 * `aCadaTentativa` pode lançar para abortar cedo (ex.: uma requisição que já
 * respondeu sem chegar à trava). O estouro do prazo lança com o estado de cada
 * sessão, lido DEPOIS de `pg_stat_clear_snapshot()`.
 */
export async function esperarBloqueadosPor(
  trava: Client,
  quantos: number,
  { descricao, aCadaTentativa }: { descricao: string; aCadaTentativa?: () => void },
): Promise<void> {
  for (let tentativa = 0; tentativa <= 400; tentativa += 1) {
    aCadaTentativa?.();
    const { rows } = await trava.query<{ n: string }>(CADEIA_SQL);
    if (Number(rows[0].n) >= quantos) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await trava.query('SELECT pg_stat_clear_snapshot()');
  const { rows: sessoes } = await trava.query(SESSOES_SQL);
  throw new Error(
    `esperava ${quantos} ${descricao} bloqueada(s) pela trava e não houve; sessões: ${JSON.stringify(sessoes)}`,
  );
}

/**
 * Espera haver `quantas` travas CONSULTIVAS pendentes (pedidas e não obtidas)
 * no banco de teste, lidas ao vivo em `pg_locks`. Serve às corridas em que quem
 * segura a trava é a própria aplicação, e não um travador do teste — por
 * exemplo, a importação esperando a ingestão pausada por um portão (F4.1c-1).
 * Abre e fecha a própria conexão; nunca dentro de transação.
 */
export async function esperarTravasPendentes(
  connectionString: string,
  quantas: number,
  descricao: string,
): Promise<void> {
  const c = new Client({ connectionString });
  await c.connect();
  try {
    for (let tentativa = 0; tentativa <= 400; tentativa += 1) {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND database = (
            SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      if (Number(rows[0].n) >= quantas) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`esperava ${quantas} trava(s) consultiva(s) pendente(s): ${descricao}`);
  } finally {
    await c.end();
  }
}
