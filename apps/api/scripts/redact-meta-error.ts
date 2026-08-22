/**
 * Redige um erro da Meta para poder circular. A lógica vive em
 * `src/channels/meta-redact.ts`, com teste; aqui é só entrada e saída.
 *
 *   pbpaste | pnpm --filter @veyra/api redact:meta
 *   cat erro.json | pnpm --filter @veyra/api redact:meta
 */
import { redigir, redigirTexto } from '../src/channels/meta-redact';

async function main(): Promise<void> {
  const partes: Buffer[] = [];
  for await (const chunk of process.stdin) partes.push(Buffer.from(chunk));
  const bruto = Buffer.concat(partes).toString('utf8').trim();
  if (!bruto) {
    console.error('uso: pbpaste | pnpm --filter @veyra/api redact:meta');
    process.exitCode = 1;
    return;
  }
  try {
    console.log(JSON.stringify(redigir(JSON.parse(bruto)), null, 2));
  } catch {
    // não era JSON: redige como texto, que ainda pega Bearer, token e número
    console.log(redigirTexto(bruto));
  }
}

main().catch((error) => {
  console.error('falhou:', error instanceof Error ? error.message : 'erro desconhecido');
  process.exit(1);
});
