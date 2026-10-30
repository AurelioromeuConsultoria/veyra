import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  aplicarTravaDeManutencao,
  CONSULTA_DA_TRAVA,
  interpretarTrava,
  travaDe,
  type Trava,
} from './trava-de-manutencao';

const SRC = join(__dirname, '..');

function arquivosDeProducao(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory())
      return nome === 'generated' ? [] : arquivosDeProducao(caminho);
    return nome.endsWith('.ts') && !/\.(integration-)?spec\.ts$/.test(nome) ? [caminho] : [];
  });
}

/**
 * A trava de manutenção no banco (ADR-053, adendo 1): ligada, ela vence o
 * `MAINTENANCE_MODE` do ambiente; a leitura que falha impede a subida.
 */
describe('a trava de manutenção: o valor', () => {
  it.each([null, undefined, '', 'desligada'])('%p desliga', (valor) => {
    expect(interpretarTrava(valor)).toBe('desligada');
  });

  it.each(['ligada', 'ligado', 'sim', 'true', 'Desligada', ' desligada', 'desligado'])(
    '%p conta como ligada (fail-closed)',
    (valor) => {
      expect(interpretarTrava(valor)).toBe('ligada');
    },
  );

  it.each([
    [{ sessao: 'desligada', banco: 'ligada' }, 'ligada', 'a sessão não desliga o banco'],
    [{ sessao: 'ligada', banco: null }, 'ligada', 'a sessão sozinha liga'],
    [{ sessao: null, banco: 'ligado' }, 'ligada', 'o banco com valor desconhecido liga'],
    [{ sessao: 'desligada', banco: 'desligada' }, 'desligada', 'as duas desligadas'],
    [{ sessao: null, banco: null }, 'desligada', 'nenhuma das duas'],
    [{}, 'desligada', 'sem linha'],
  ] as const)('sessão e banco %j: %s (%s)', (leitura, esperado, _motivo) => {
    expect(travaDe(leitura)).toBe(esperado);
  });
});

describe('a trava de manutenção: o efeito no ambiente, antes do AppModule', () => {
  const URL_COM_SENHA = 'postgresql://veyra:senha-que-nao-vaza@db:5432/veyra';
  const lendo = (trava: Trava) => () => Promise.resolve(trava);

  it('ligada, força MAINTENANCE_MODE=true mesmo com o ambiente em false (o valor antigo do painel)', async () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: URL_COM_SENHA, MAINTENANCE_MODE: 'false' };
    await expect(aplicarTravaDeManutencao(env, lendo('ligada'))).resolves.toBe('ligada');
    expect(env.MAINTENANCE_MODE).toBe('true');
  });

  it('desligada, o ambiente decide: false continua false, e a ausência continua ausente', async () => {
    const comFalse: NodeJS.ProcessEnv = { DATABASE_URL: URL_COM_SENHA, MAINTENANCE_MODE: 'false' };
    await expect(aplicarTravaDeManutencao(comFalse, lendo('desligada'))).resolves.toBe('desligada');
    expect(comFalse.MAINTENANCE_MODE).toBe('false');

    const semVariavel: NodeJS.ProcessEnv = { DATABASE_URL: URL_COM_SENHA };
    await aplicarTravaDeManutencao(semVariavel, lendo('desligada'));
    // a validação do ambiente recusa depois, como sempre (ADR-053, item 1)
    expect(semVariavel).not.toHaveProperty('MAINTENANCE_MODE');
  });

  it('a leitura que falha IMPEDE a subida, sem a URL nem a senha na mensagem', async () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: URL_COM_SENHA, MAINTENANCE_MODE: 'false' };
    const falha = () =>
      Promise.reject(new Error(`connect ECONNREFUSED em ${URL_COM_SENHA} (senha-que-nao-vaza)`));
    const erro = await aplicarTravaDeManutencao(env, falha).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(Error);
    const mensagem = (erro as Error).message;
    expect(mensagem).toMatch(/^A trava de manutenção não pôde ser lida .*A API não sobe/);
    expect(mensagem).toContain('ECONNREFUSED');
    expect(mensagem).not.toContain('senha-que-nao-vaza');
    expect(mensagem).not.toContain(URL_COM_SENHA);
    // e o ambiente não muda: quem decide é a saída do processo
    expect(env.MAINTENANCE_MODE).toBe('false');
  });

  it('sem DATABASE_URL, também não sobe (nada é lido)', async () => {
    const ler = jest.fn(lendo('desligada'));
    await expect(aplicarTravaDeManutencao({ MAINTENANCE_MODE: 'false' }, ler)).rejects.toThrow(
      'A trava de manutenção não pôde ser lida: sem DATABASE_URL. A API não sobe.',
    );
    expect(ler).not.toHaveBeenCalled();
  });
});

describe('a trava de manutenção: a ordem no main.ts e o texto fixo', () => {
  it('o main.ts lê a trava ANTES de importar o AppModule, e o AppModule não é importado no topo', () => {
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
    // nenhuma importação estática do AppModule (a configuração é validada na importação dele)
    expect(main).not.toMatch(/^\s*import\b[^;]*['"]\.\/app\.module['"]/m);
    const trava = main.indexOf('await aplicarTravaDeManutencao(process.env)');
    // o `.env` (o `pnpm dev`) é carregado ANTES da trava, que precisa do DATABASE_URL
    const dotenv = main.indexOf("import 'dotenv/config';");
    expect(dotenv).toBeGreaterThan(-1);
    expect(trava).toBeGreaterThan(dotenv);
    const modulo = main.indexOf("await import('./app.module')");
    const nest = main.indexOf('NestFactory.create(');
    expect(trava).toBeGreaterThan(-1);
    expect(modulo).toBeGreaterThan(trava);
    expect(nest).toBeGreaterThan(modulo);
    // e a falha da leitura encerra o processo, sem `void` engolindo a rejeição
    expect(main).toMatch(/bootstrap\(\)\.catch\([\s\S]*process\.exit\(1\)/);
  });

  it('a leitura é uma consulta de texto fixo, sem tabela nem parâmetro, num arquivo só', () => {
    // a sessão E o valor gravado pelo ALTER DATABASE (o catálogo, sem papel)
    expect(CONSULTA_DA_TRAVA).toMatch(
      /^SELECT current_setting\('veyra\.manutencao', true\) AS sessao, /,
    );
    expect(CONSULTA_DA_TRAVA).toContain('FROM pg_db_role_setting d');
    expect(CONSULTA_DA_TRAVA).toContain('d.setrole = 0');
    expect(CONSULTA_DA_TRAVA).toMatch(/ AS banco$/);
    // sem parâmetro e sem tabela de domínio (nenhum identificador entre aspas)
    expect(CONSULTA_DA_TRAVA).not.toMatch(/\$\d|"/);
    const UNICO = join(SRC, 'common/trava-de-manutencao.ts');
    const outros = arquivosDeProducao(SRC)
      .filter((f) => f !== UNICO && readFileSync(f, 'utf8').includes('veyra.manutencao'))
      .map((f) => relative(SRC, f));
    expect(outros).toEqual([]);
  });
});
