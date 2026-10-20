import { ConflictException, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { updateConversationSchema } from '@veyra/contracts';
import { PrismaExceptionFilter } from '../common/prisma-exception.filter';
import { Prisma } from '../generated/prisma/client';
import {
  COORDENACAO,
  ehSqlDeCoordenacao,
  modelosLiberados,
  sqlDeCoordenacao,
} from './coordination-sql';
import {
  FOLGA_DE_DESISTENCIA_MS,
  orcamentoDaGuarda,
  prazosDaRecuperacao,
} from './content-use.guard';
import { CONFIG_PADRAO_DA_GUARDA, type ConfigDaGuarda } from './content-use.pools';
import { prazosDaReconciliacao, varrerNaSubida } from './content-use.reconciler';
import { MudancasDeRestricao } from './restriction-changes';

/**
 * Regras estáticas e de unidade da guarda de uso externo (ADR-047 adendos 6 e 7).
 */
describe('modelos de SQL de coordenação (a única exceção ao bloqueio de SQL cru do client protegido)', () => {
  it('a lista é FIXA: mexer nela é decisão de segurança, revista junto com o adendo 7 §3.8', () => {
    expect(modelosLiberados()).toHaveLength(10);
    for (const modelo of modelosLiberados()) {
      // a chave é o JSON das partes de texto; '$' marca cada parâmetro
      const texto = (JSON.parse(modelo) as string[]).join('$');
      const permitido =
        /^SELECT pg_advisory_xact_lock(_shared)?\(hashtextextended\(\$, 0\)\)$/.test(texto) ||
        /^SELECT pg_try_advisory_xact_lock\(hashtextextended\(\$, 0\)\) AS obtida$/.test(texto) ||
        /^SELECT set_config\('(lock_timeout|idle_in_transaction_session_timeout|statement_timeout)', \$, true\)$/.test(
          texto,
        ) ||
        texto === 'SELECT pg_backend_pid() AS pid' ||
        texto === 'SELECT 1 AS vivo' ||
        texto === 'SAVEPOINT veyra_persistencia' ||
        texto === 'ROLLBACK TO SAVEPOINT veyra_persistencia';
      expect({ modelo: texto, permitido }).toEqual({ modelo: texto, permitido: true });
    }
  });

  it('libera só pelo TEXTO do modelo — valores são parâmetros, qualquer outro SQL é recusado', () => {
    const comoOHookRecebe = (sql: Prisma.Sql) => ({ strings: sql.strings, values: sql.values });
    expect(ehSqlDeCoordenacao(comoOHookRecebe(COORDENACAO.travaExclusiva('qualquer:chave')))).toBe(
      true,
    );
    expect(ehSqlDeCoordenacao(comoOHookRecebe(Prisma.sql`SELECT 1`))).toBe(false);
    expect(
      ehSqlDeCoordenacao(comoOHookRecebe(Prisma.sql`SELECT * FROM "Contact" WHERE id = ${'x'}`)),
    ).toBe(false);
    // o texto de um modelo com um pedaço a mais não passa
    expect(
      ehSqlDeCoordenacao({ strings: ['SELECT 1 AS vivo; DROP TABLE "Contact"'], values: [] }),
    ).toBe(false);
    expect(ehSqlDeCoordenacao(null)).toBe(false);
    expect(ehSqlDeCoordenacao({ strings: 'SELECT 1 AS vivo' })).toBe(false);
  });
});

describe('o SQL que vai ao banco é RECONSTRUÍDO do modelo', () => {
  it('descarta o `text` forjado e recusa valor que seria emendado no texto', () => {
    const forjado = {
      strings: ['SELECT 1 AS vivo'],
      values: [],
      text: 'SELECT * FROM "Contact"',
      sql: 'SELECT * FROM "Contact"',
    };
    expect(sqlDeCoordenacao(forjado)?.text).toBe('SELECT 1 AS vivo');
    const modelo = COORDENACAO.prazoDeTrava('5000ms');
    const comoOHookRecebe = { strings: modelo.strings, values: modelo.values };
    expect(sqlDeCoordenacao(comoOHookRecebe)?.text).toBe(modelo.text);
    // um `Prisma.Sql` como valor seria emendado nas partes de texto
    expect(
      sqlDeCoordenacao({ strings: modelo.strings, values: [Prisma.raw("'0'); DROP TABLE x; --")] }),
    ).toBeNull();
    // um valor a mais ou a menos que as lacunas
    expect(sqlDeCoordenacao({ strings: modelo.strings, values: [] })).toBeNull();
    expect(sqlDeCoordenacao({ strings: modelo.strings, values: ['1', '2'] })).toBeNull();
  });
});

/**
 * O pior caso de cada fase, escrito AQUI à parte da implementação: o
 * orçamento da guarda precisa cobrir a soma dos limites do caminho que de fato
 * acontece (adendo 7 §3.1). Tirar um termo do orçamento derruba este teste.
 */
function piorCaso(cfg: ConfigDaGuarda, prazoMs: number, travas: number) {
  const ateORegistro =
    travas * cfg.travaMs + // cada trava espera o seu lock_timeout
    cfg.reconferenciaMs +
    cfg.registroConexaoMs +
    cfg.registroInstrucaoMs;
  const lapide = 2 * cfg.registroInstrucaoMs + cfg.travaMs + cfg.travaMs; // espera + margem
  const prova = 2 * cfg.travaMs; // o statement_timeout da prova de vida
  const chamada = prazoMs + FOLGA_DE_DESISTENCIA_MS;
  const persistencia = cfg.persistenciaMs;
  return { ateORegistro, lapide, prova, chamada, persistencia };
}

describe('o orçamento do prazo da transação da guarda', () => {
  const casos: [string, ConfigDaGuarda, number, number][] = [
    ['IA, padrão, 3 contatos', CONFIG_PADRAO_DA_GUARDA, 60_000, 4],
    ['Meta, padrão, 1 contato', CONFIG_PADRAO_DA_GUARDA, 20_000, 2],
    ['webhook sem contato', CONFIG_PADRAO_DA_GUARDA, 10_000, 1],
    // a lápide domina quando o registro é lento e a chamada é curta
    ['registro lento', { ...CONFIG_PADRAO_DA_GUARDA, registroInstrucaoMs: 30_000 }, 1_000, 2],
  ];
  it.each(casos)('%s: cobre o caminho da chamada e o da lápide', (_nome, cfg, prazoMs, travas) => {
    const o = orcamentoDaGuarda(cfg, prazoMs, travas);
    const p = piorCaso(cfg, prazoMs, travas);
    expect(o.transacao).toBeGreaterThanOrEqual(
      p.ateORegistro + p.prova + p.chamada + p.persistencia + cfg.folgaDaTransacaoMs,
    );
    expect(o.transacao).toBeGreaterThanOrEqual(p.ateORegistro + p.lapide + cfg.folgaDaTransacaoMs);
    // o que precisa sobrar em cada conferência
    expect(o.antesDaProva).toBeGreaterThanOrEqual(
      p.prova + p.chamada + p.persistencia + cfg.folgaDaTransacaoMs,
    );
    expect(o.depoisDaProva).toBeGreaterThanOrEqual(
      p.chamada + p.persistencia + cfg.folgaDaTransacaoMs,
    );
  });
});

describe('a ORDEM dos prazos das transações fora da guarda (com os padrões da produção)', () => {
  const cfg = CONFIG_PADRAO_DA_GUARDA;
  it('recuperação (passos 6 e 12): instrução acima da trava, transação acima da instrução e das seguintes', () => {
    const p = prazosDaRecuperacao(cfg);
    expect(p.travaMs).toBe(cfg.travaMs);
    expect(p.instrucaoMs).toBeGreaterThan(p.travaMs); // 55P03 antes do 57014
    expect(p.timeoutMs).toBeGreaterThanOrEqual(p.instrucaoMs + cfg.persistenciaMs);
    expect(p.maxWaitMs).toBe(cfg.esperaPorSessaoMs);
    // acima do padrão do Prisma (5 s), que era o que valia sem opções
    expect(p.timeoutMs).toBeGreaterThan(5_000);
  });

  it('reconciliação: instrução acima da trava, transação acima da instrução e das seguintes', () => {
    const p = prazosDaReconciliacao(cfg);
    expect(p.instrucaoMs).toBeGreaterThan(p.travaMs);
    expect(p.timeoutMs).toBeGreaterThanOrEqual(p.instrucaoMs + cfg.persistenciaMs);
  });
});

describe('a transação interativa das mudanças e aprovações', () => {
  const restricao = new MudancasDeRestricao({} as never, CONFIG_PADRAO_DA_GUARDA);
  const falhaCom = (code: string) => ({
    $transaction: async () => {
      throw Object.assign(new Error('falha'), { code });
    },
  });

  it('usa o prazo da transação interativa (30 s)', async () => {
    let opcoes: unknown;
    await restricao.naTransacaoInterativa(
      {
        $transaction: async (fn: (tx: never) => Promise<unknown>, o?: unknown) => {
          opcoes = o;
          return fn({} as never);
        },
      } as never,
      async () => 1,
    );
    expect(opcoes).toEqual({ timeout: CONFIG_PADRAO_DA_GUARDA.mudancaTransacaoMs });
  });

  it('o prazo da transação vencido (P2028) vira 409, como a espera de trava; outro erro passa como veio', async () => {
    await expect(
      restricao.naTransacaoInterativa(falhaCom('P2028') as never, async () => 1),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      restricao.naTransacaoInterativa(falhaCom('P2002') as never, async () => 1),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('55P03 (lock_not_available) vira 409, sem efeito', () => {
  it('a mudança que esperou o `lock_timeout` por um uso em andamento responde 409', () => {
    const capturado: unknown[] = [];
    const espiao = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation((excecao: unknown) => {
        capturado.push(excecao);
      });
    try {
      new PrismaExceptionFilter().catch(
        { code: 'P2039', meta: { driverAdapterError: { cause: { originalCode: '55P03' } } } },
        {} as ArgumentsHost,
      );
    } finally {
      espiao.mockRestore();
    }
    expect(capturado[0]).toBeInstanceOf(ConflictException);
    expect((capturado[0] as ConflictException).message).toBe(
      'Uso em andamento para este contato; tente de novo em instantes.',
    );
  });
});

describe('varredura na subida', () => {
  it('não espera a varredura (o boot não depende do banco) e não derruba nada se ela falhar', async () => {
    const avisos: string[] = [];
    let terminou = false;
    varrerNaSubida(
      () =>
        new Promise((_, rejeitar) =>
          setTimeout(() => {
            terminou = true;
            rejeitar(new Error('banco fora'));
          }, 20),
        ),
      (mensagem) => avisos.push(mensagem),
    );
    expect(terminou).toBe(false); // voltou sem esperar
    await new Promise((r) => setTimeout(r, 50));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/varredura periódica tenta de novo/);
  });
});

describe('regras estáticas', () => {
  const pasta = __dirname;
  const fontes = readdirSync(pasta)
    .filter((f) => f.endsWith('.ts') && !f.includes('spec'))
    .map((f) => ({ nome: f, texto: readFileSync(join(pasta, f), 'utf8') }));

  it('toda ESCRITA em `ContentUse` leva o `workspaceId` explícito (adendo 7 §3.8), salvo as exceções nomeadas', () => {
    const violacoes: string[] = [];
    for (const { nome, texto } of fontes) {
      const escritas = [
        ...texto.matchAll(/\.contentUse\.(updateMany|create|createMany|deleteMany)\(/g),
      ];
      for (const escrita of escritas) {
        const trecho = texto.slice(escrita.index, (escrita.index ?? 0) + 400);
        if (!trecho.includes('workspaceId')) violacoes.push(`${nome}: ${escrita[0]}`);
      }
      for (const sql of texto.matchAll(/(UPDATE|DELETE FROM) "ContentUse"/g)) {
        const antes = texto.slice(Math.max(0, (sql.index ?? 0) - 600), sql.index);
        const depois = texto.slice(sql.index, (sql.index ?? 0) + 300);
        if (!depois.includes('workspaceId') && !antes.includes('Exceção nomeada')) {
          violacoes.push(`${nome}: ${sql[0]}`);
        }
      }
    }
    expect(violacoes).toEqual([]);
  });

  it('SQL próprio e `raw` sobre `ContentUse` só nas funções das exceções nomeadas (adendo 7 §3.8)', () => {
    // o método que contém cada ocorrência: a última declaração de método antes dela
    const metodoDe = (texto: string, posicao: number): string => {
      const declaracoes = [
        ...texto
          .slice(0, posicao)
          .matchAll(/^ {2}(?:private |public )?(?:async )?([a-zA-Z]\w*)(?:<[^>]*>)?\(/gm),
      ];
      return declaracoes.at(-1)?.[1] ?? '(topo)';
    };
    const achados: string[] = [];
    for (const { nome, texto } of fontes) {
      for (const uso of texto.matchAll(
        /prisma\.raw\b|cliente\.query\(|(?<!const )REGISTRO_SQL\b/g,
      )) {
        achados.push(`${nome}:${metodoDe(texto, uso.index ?? 0)}`);
      }
    }
    expect([...new Set(achados)].sort()).toEqual([
      // o registro, na conexão curta do pool de registro (passo 5)
      'content-use.guard.ts:registrar',
      // a busca de candidatos e o expurgo de retenção: cross-workspace por definição
      'content-use.reconciler.ts:candidatos',
      'content-use.reconciler.ts:expurgar',
    ]);
  });

  it('os pools da guarda (e a conexão `pg` do registro) não saem de `content-use/`', () => {
    const raiz = join(__dirname, '..');
    const achados: string[] = [];
    const varrer = (dir: string) => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const caminho = join(dir, entrada.name);
        if (entrada.isDirectory()) {
          if (!['generated', 'content-use'].includes(entrada.name)) varrer(caminho);
        } else if (entrada.name.endsWith('.ts') && !entrada.name.includes('spec')) {
          if (/PoolsDaGuarda|conectarRegistro/.test(readFileSync(caminho, 'utf8'))) {
            achados.push(caminho.slice(raiz.length));
          }
        }
      }
    };
    varrer(raiz);
    expect(achados).toEqual([]);
  });

  it('fora de `content-use/`, o único acesso a `ContentUse` é a leitura da varredura de reservas', () => {
    const raiz = join(__dirname, '..');
    const metodoDe = (texto: string, posicao: number): string =>
      [
        ...texto
          .slice(0, posicao)
          .matchAll(/^ {2}(?:private |public )?(?:async )?([a-zA-Z]\w*)(?:<[^>]*>)?\(/gm),
      ].at(-1)?.[1] ?? '(topo)';
    const achados: string[] = [];
    const varrer = (dir: string) => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const caminho = join(dir, entrada.name);
        if (entrada.isDirectory()) {
          if (!['generated', 'content-use'].includes(entrada.name)) varrer(caminho);
        } else if (entrada.name.endsWith('.ts') && !entrada.name.includes('spec')) {
          const texto = readFileSync(caminho, 'utf8');
          for (const uso of texto.matchAll(/\.contentUse\.|"ContentUse"/g)) {
            achados.push(`${caminho.slice(raiz.length)}:${metodoDe(texto, uso.index ?? 0)}`);
          }
        }
      }
    };
    varrer(raiz);
    expect([...new Set(achados)]).toEqual(['/usage/usage.service.ts:purgeExpiredReservations']);
  });

  it('fora de `content-use/`, as travas de restrição só se pegam pela primitiva das mudanças (adendo 6 §10.9)', () => {
    const raiz = join(__dirname, '..');
    const achados: string[] = [];
    const varrer = (dir: string) => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const caminho = join(dir, entrada.name);
        if (entrada.isDirectory()) {
          if (!['generated', 'content-use'].includes(entrada.name)) varrer(caminho);
        } else if (entrada.name.endsWith('.ts') && !entrada.name.includes('spec')) {
          const texto = readFileSync(caminho, 'utf8');
          // a primitiva baixa (sem marcação de órfãos) e a trava de linha antiga
          if (/restriction-locks|lockContactsForRestriction|contact-restriction-lock/.test(texto)) {
            achados.push(caminho.slice(raiz.length));
          }
        }
      }
    };
    varrer(raiz);
    expect(achados).toEqual([]);
  });

  it('o contato da CONVERSA é imutável: o contrato não o atualiza e nenhuma escrita o muda (adendo 6 §9)', () => {
    expect(Object.keys(updateConversationSchema.shape)).not.toContain('contactId');
    const raiz = join(__dirname, '..');
    const achados: string[] = [];
    const varrer = (dir: string) => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const caminho = join(dir, entrada.name);
        if (entrada.isDirectory()) {
          if (entrada.name !== 'generated') varrer(caminho);
        } else if (entrada.name.endsWith('.ts') && !entrada.name.includes('spec')) {
          const texto = readFileSync(caminho, 'utf8');
          for (const escrita of texto.matchAll(/\.conversation\.(updateMany|update|upsert)\(/g)) {
            // o objeto da escrita inteiro: até o fechamento da chamada
            const trecho = texto.slice(escrita.index, (escrita.index ?? 0) + 600);
            const fim = trecho.indexOf('});');
            if ((fim === -1 ? trecho : trecho.slice(0, fim)).includes('contactId')) {
              achados.push(caminho.slice(raiz.length));
            }
          }
        }
      }
    };
    varrer(raiz);
    expect(achados).toEqual([]);
  });

  it('as chaves das travas de restrição só existem na primitiva', () => {
    const raiz = join(__dirname, '..');
    const achados: string[] = [];
    const varrer = (dir: string) => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const caminho = join(dir, entrada.name);
        if (entrada.isDirectory()) {
          if (entrada.name !== 'generated') varrer(caminho);
        } else if (entrada.name.endsWith('.ts') && !entrada.name.includes('spec')) {
          const texto = readFileSync(caminho, 'utf8');
          if (/veyra\.(restriction|content_use)/.test(texto))
            achados.push(caminho.slice(raiz.length));
        }
      }
    };
    varrer(raiz);
    expect(achados).toEqual(['/content-use/restriction-locks.ts']);
  });
});
