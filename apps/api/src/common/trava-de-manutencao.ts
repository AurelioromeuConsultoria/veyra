import { Client } from 'pg';

/**
 * A TRAVA DE MANUTENÇÃO NO BANCO (ADR-053, adendo 1).
 *
 * O `MAINTENANCE_MODE` vem do ambiente do container, que o painel monta a cada
 * deploy, e um valor antigo do painel já chegou ao container (DEPLOY_STAGING
 * §14, a janela de 2026-10-29). A trava é uma configuração do PRÓPRIO banco
 * (`ALTER DATABASE … SET veyra.manutencao = 'ligada'`): vale para toda API que
 * subir depois de ligada, qualquer que seja o ambiente, sem terminal nem vigia.
 *
 * O `main.ts` a lê ANTES de importar o `AppModule` (a configuração validada é
 * lida na importação dele, como em `cli/sem-jobs.ts`): nenhum módulo, rota ou
 * job existe ainda. Ligada, ela força `MAINTENANCE_MODE=true`, e a barreira e
 * os jobs, que já leem a variável, fazem o resto.
 *
 * DUAS leituras, e basta UMA dizer ligada (revisão de security):
 * - `sessao`: o valor efetivo da sessão. Uma opção da conexão (`PGOPTIONS`,
 *   `?options=-c …` na URL) ou um `ALTER ROLE … SET` VENCERIA o do banco nele;
 * - `banco`: o valor gravado pelo próprio `ALTER DATABASE`, lido no catálogo
 *   (`pg_db_role_setting`, sem papel, do banco atual), que nenhuma opção de
 *   sessão ou de papel muda.
 *
 * Fora do client protegido (SECURITY.md §2 e §7-H): uma conexão `pg` própria,
 * de vida curta, com texto FIXO, só do catálogo do sistema (nenhuma tabela de
 * domínio), sem parâmetro e sem dado de tenant — o mesmo critério do relógio do
 * banco. Um teste estático fixa este arquivo como o único com esse texto.
 */
export const CONSULTA_DA_TRAVA =
  "SELECT current_setting('veyra.manutencao', true) AS sessao, " +
  "(SELECT substr(s, length('veyra.manutencao=') + 1) FROM pg_db_role_setting d, unnest(d.setconfig) s " +
  'WHERE d.setrole = 0 AND d.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) ' +
  "AND s LIKE 'veyra.manutencao=%' LIMIT 1) AS banco";

/** o prazo da conexão e da consulta: sem resposta nele, a API não sobe */
const PRAZO_MS = 10_000;

export type Trava = 'ligada' | 'desligada';

/**
 * Fail-closed: só a ausência, o vazio e `desligada` desligam. Qualquer outro
 * valor (`ligado`, `sim`, um erro de digitação) conta como ligada.
 */
export function interpretarTrava(valor: string | null | undefined): Trava {
  if (valor === null || valor === undefined || valor === '' || valor === 'desligada') {
    return 'desligada';
  }
  return 'ligada';
}

/** Ligada se a sessão OU o banco disserem ligada: nenhuma das duas desliga a outra. */
export function travaDe(leitura: { sessao?: string | null; banco?: string | null }): Trava {
  return interpretarTrava(leitura.sessao) === 'ligada' ||
    interpretarTrava(leitura.banco) === 'ligada'
    ? 'ligada'
    : 'desligada';
}

export async function lerTrava(databaseUrl: string, prazoMs = PRAZO_MS): Promise<Trava> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: prazoMs,
    query_timeout: prazoMs,
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ sessao: string | null; banco: string | null }>(
      CONSULTA_DA_TRAVA,
    );
    return travaDe(rows[0] ?? {});
  } finally {
    await client.end().catch(() => undefined);
  }
}

function senhaDa(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return '';
  }
}

/**
 * Antes do `AppModule`: com a trava ligada, `MAINTENANCE_MODE=true`, qualquer
 * que seja o ambiente; desligada, o ambiente decide, como antes. Sem
 * `DATABASE_URL` ou com a leitura falhando, LANÇA: o processo não sobe.
 */
export async function aplicarTravaDeManutencao(
  env: NodeJS.ProcessEnv,
  ler: (databaseUrl: string) => Promise<Trava> = lerTrava,
): Promise<Trava> {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error('A trava de manutenção não pôde ser lida: sem DATABASE_URL. A API não sobe.');
  }
  let trava: Trava;
  try {
    trava = await ler(url);
  } catch (erro) {
    // só o nome e a mensagem do driver, sem a URL nem a senha, se aparecerem
    let motivo = erro instanceof Error ? `${erro.name}: ${erro.message}` : 'erro desconhecido';
    const senha = senhaDa(url);
    for (const segredo of [url, senha]) if (segredo) motivo = motivo.split(segredo).join('***');
    // eslint-disable-next-line preserve-caught-error -- a causa levaria a mensagem crua do driver ao log da subida; só sai o motivo saneado
    throw new Error(
      `A trava de manutenção não pôde ser lida (${motivo}). A API não sobe (fail-closed).`,
    );
  }
  if (trava === 'ligada') env.MAINTENANCE_MODE = 'true';
  return trava;
}
