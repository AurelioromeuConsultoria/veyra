/**
 * CLI administrativa do canal WhatsApp (ADR-037), COMPILADA desde a F4.4c
 * (ADR-048 adendo 13): roda na imagem, como as outras CLIs. Não existe
 * endpoint para isto — cadastrar credencial de provedor é ato administrativo,
 * com segredo que nunca deve transitar por API de produto nem aparecer em log.
 *
 *   pnpm --filter @veyra/api channel:whatsapp \
 *     --slug acme --phone-number-id 123456789 --waba 987654321
 *   (na imagem: node dist/cli/channel-whatsapp.js …)
 *
 * O TOKEN NUNCA VAI NA LINHA DE COMANDO: qualquer `--token…` (menos
 * `--token-stdin`) é recusado com o aviso de rotação. Por padrão a CLI PERGUNTA
 * sem eco; para automação, `--token-stdin` lê de um pipe — nunca do terminal,
 * que ecoaria o token. As regras estão em `channel-whatsapp.core.ts`.
 */
import 'dotenv/config';
// antes do AppModule: a CLI não abre workers nem reconciliação
import './sem-jobs';
import { NestFactory } from '@nestjs/core';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { executarCadastroDoCanal } from './channel-whatsapp.core';

/** Lê a entrada padrão inteira (uso com `printf '%s' "$T" | ... --token-stdin`). */
async function lerEntrada(): Promise<string> {
  const partes: Buffer[] = [];
  for await (const pedaco of process.stdin) partes.push(Buffer.from(pedaco));
  return Buffer.concat(partes).toString('utf8').trim();
}

/**
 * Pergunta sem ECO. O terminal não deve mostrar o token nem deixá-lo rolar na
 * tela — e, com `terminal: true` e uma saída que descarta, o readline não imprime
 * o que é digitado.
 */
async function perguntarSemEco(rotulo: string): Promise<string> {
  process.stderr.write(rotulo);
  const mudo = new Writable({
    write(_pedaco, _codificacao, cb) {
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: mudo, terminal: true });
  try {
    // a entrada fechada (sem `-i`) ou o Ctrl+C: token vazio, que é recusa — e
    // não um processo que sai com sucesso sem ter cadastrado nada
    const linha = await new Promise<string>((resolve) => {
      rl.on('close', () => resolve(''));
      rl.question('', resolve);
    });
    return linha.trim();
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}

executarCadastroDoCanal({
  argv: process.argv.slice(2),
  entradaEhTerminal: process.stdin.isTTY === true,
  lerEntrada,
  perguntarSemEco,
  // o AppModule (e a validação do ambiente) só depois das recusas
  criarApp: async () => {
    const { AppModule } = await import('../app.module');
    return NestFactory.createApplicationContext(AppModule, { logger: false });
  },
  saida: (linha) => console.log(linha),
  erro: (linha) => console.error(linha),
})
  .then((codigo) => process.exit(codigo))
  .catch((erro: unknown) => {
    // só o tipo: nada do que chegou aqui pode carregar o token para a saída
    console.error('falhou:', (erro as Error)?.name ?? 'erro desconhecido');
    process.exit(1);
  });
