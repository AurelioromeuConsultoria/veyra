import { PrismaPg } from '@prisma/adapter-pg';

const SESSAO_EM_UTC = '-c TimeZone=UTC';

/**
 * Adapter de TODO `PrismaClient` do projeto: a aplicação, os CLIs e os scripts.
 * A sessão fica em UTC (ADR-049). As colunas são `TIMESTAMP` sem fuso; com a
 * sessão em outro fuso, `now()` e o DEFAULT do banco seriam convertidos por
 * ele, enquanto o adapter lê tudo como UTC, e o agendamento erraria pelo
 * deslocamento do fuso. Fixar aqui não depende do padrão do servidor.
 *
 * Módulo sem dependência do Nest, para os scripts o usarem sem subir a app.
 */
export function prismaAdapter(connectionString: string | undefined): PrismaPg {
  if (!connectionString) throw new Error('DATABASE_URL ausente');
  return new PrismaPg({ connectionString: comSessaoEmUtc(connectionString) });
}

/**
 * Põe a fixação NA PRÓPRIA URL, somada a um `options` que ela já traga. No
 * `pg`, parâmetro da URL tem precedência sobre o config: passar `options` só
 * no config seria descartado em silêncio por uma URL com `?options=` (ex.:
 * Neon). O último `-c` vence, então um `TimeZone` vindo da URL não prevalece.
 *
 * Sem `new URL()`, de propósito: o erro dele carrega a URL inteira (senha
 * incluída) e iria para o log; ele também recusa formatos que o `pg` aceita,
 * como o de socket (`postgresql://u:s@/db?host=/var/run/postgresql`). Só o
 * parâmetro `options` é tocado; os demais seguem byte a byte.
 */
export function comSessaoEmUtc(connectionString: string): string {
  return comOpcoesDeSessao(connectionString, []);
}

/**
 * Como `comSessaoEmUtc`, com parâmetros de sessão a mais (`-c nome=valor`), na
 * mesma regra: na URL, somados ao `options` existente, e o UTC sempre por
 * último. Os pools da guarda de uso externo (ADR-047 adendo 7) a usam para o
 * keepalive e os prazos de sessão.
 */
export function comOpcoesDeSessao(connectionString: string, extras: readonly string[]): string {
  const cerca = connectionString.indexOf('#');
  const semFragmento = cerca === -1 ? connectionString : connectionString.slice(0, cerca);
  const fragmento = cerca === -1 ? '' : connectionString.slice(cerca);
  const interrogacao = semFragmento.indexOf('?');
  const base = interrogacao === -1 ? semFragmento : semFragmento.slice(0, interrogacao);
  const parametros =
    interrogacao === -1
      ? []
      : semFragmento
          .slice(interrogacao + 1)
          .split('&')
          .filter(Boolean);

  const atuais: string[] = [];
  const outros = parametros.filter((parametro) => {
    if (!parametro.startsWith('options=')) return true;
    try {
      // a query do `pg` é lida como URLSearchParams: `+` é espaço
      atuais.push(decodeURIComponent(parametro.slice('options='.length).replace(/\+/g, ' ')));
    } catch {
      // sem a entrada e sem `cause`: a URL tem a senha
      throw new Error('DATABASE_URL inválida: o parâmetro `options` não está bem codificado');
    }
    return false;
  });
  const opcoes = [...atuais.filter(Boolean), ...extras, SESSAO_EM_UTC].join(' ');
  return `${base}?${[...outros, `options=${encodeURIComponent(opcoes)}`].join('&')}${fragmento}`;
}
