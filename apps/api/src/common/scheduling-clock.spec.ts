import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Relógio de agendamento (ADR-049): instantes que o BANCO compara com `now()`
 * são escritos pelo banco. O Prisma preenche `@default(now())`/`@updatedAt` e
 * qualquer `new Date()` com o relógio do NODE — escrever um deles pelo Prisma
 * traria de volta o par misto (a falha intermitente da integração).
 */
const SRC = join(__dirname, '..');
const SCHEMA = join(__dirname, '../../prisma/schema/schema.prisma');

/** Instantes agendados pelo banco: modelo (delegate do Prisma) → campo. */
const DO_BANCO: Record<string, string> = {
  outboxEvent: 'nextRetryAt',
  messageDispatch: 'updatedAt',
};

function arquivosDeProducao(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory())
      return nome === 'generated' ? [] : arquivosDeProducao(caminho);
    return nome.endsWith('.ts') && !/\.(integration-)?spec\.ts$/.test(nome) ? [caminho] : [];
  });
}

/** O texto da chamada, do `(` até o `)` que o fecha. */
function chamada(texto: string, abre: number): string {
  let profundidade = 0;
  for (let i = abre; i < texto.length; i++) {
    if (texto[i] === '(') profundidade += 1;
    if (texto[i] === ')' && --profundidade === 0) return texto.slice(abre, i + 1);
  }
  return texto.slice(abre);
}

describe('relógio de agendamento (ADR-049)', () => {
  it('nenhum código de produção escreve pelo Prisma um instante que o banco agenda', () => {
    const ofensas: string[] = [];
    for (const arquivo of arquivosDeProducao(SRC)) {
      const texto = readFileSync(arquivo, 'utf8');
      const escrita =
        /\.(\w+)\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)\(/g;
      for (const m of texto.matchAll(escrita)) {
        const campo = DO_BANCO[m[1]];
        if (!campo) continue;
        const corpo = chamada(texto, m.index! + m[0].length - 1);
        if (new RegExp(`\\b${campo}\\s*:`).test(corpo)) {
          ofensas.push(`${relative(SRC, arquivo)}: ${m[1]}.${m[2]} escreve ${campo}`);
        }
      }
    }
    expect(ofensas).toEqual([]);
  });

  it('nenhum SQL cru grava esses instantes com valor de fora do banco', () => {
    // o trigger do despacho RESPEITA valor explícito: um `"updatedAt" = $n` com
    // um Date do Node traria o par misto de volta pela porta do SQL
    const permitido = /^(now\(\)|transaction_timestamp\(\)|CASE\b)/;
    const ofensas: string[] = [];
    for (const arquivo of arquivosDeProducao(SRC)) {
      for (const [, sql] of readFileSync(arquivo, 'utf8').matchAll(/`([^`]*)`/g)) {
        const alvos: [RegExp, string][] = [
          [/"MessageDispatch"/, 'updatedAt'],
          [/"OutboxEvent"/, 'nextRetryAt'],
        ];
        for (const [tabela, campo] of alvos) {
          if (!tabela.test(sql)) continue;
          for (const m of sql.matchAll(new RegExp(`"${campo}"\\s*=\\s*([^,\\n]+)`, 'g'))) {
            if (!permitido.test(m[1].trim())) {
              ofensas.push(`${relative(SRC, arquivo)}: "${campo}" = ${m[1].trim()}`);
            }
          }
          if (/INSERT\s+INTO/i.test(sql) && new RegExp(`"${campo}"`).test(sql)) {
            ofensas.push(`${relative(SRC, arquivo)}: INSERT com "${campo}" explícito`);
          }
        }
      }
    }
    expect(ofensas).toEqual([]);
  });

  it('o schema deixa esses instantes para o DEFAULT do banco, nunca para o Prisma', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    const modelo = (nome: string) =>
      schema.match(new RegExp(`model ${nome} \\{[\\s\\S]*?\\n\\}`))![0];
    expect(modelo('OutboxEvent')).toMatch(
      /\n\s*nextRetryAt\s+DateTime\s+@default\(dbgenerated\("transaction_timestamp\(\)"\)\)/,
    );
    expect(modelo('MessageDispatch')).toMatch(
      /\n\s*updatedAt\s+DateTime\s+@default\(dbgenerated\("transaction_timestamp\(\)"\)\)/,
    );
    // atributo de campo, não a palavra no comentário
    expect(modelo('MessageDispatch')).not.toMatch(/^\s*\w+\s+DateTime\b[^\n]*@updatedAt/m);
  });
});
