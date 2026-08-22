/**
 * CLI administrativa de canal WhatsApp (ADR-037): não existe endpoint para isto,
 * pelo mesmo motivo do plano e do provisionamento — cadastrar credencial de
 * provedor é ato administrativo, com segredo que nunca deve transitar por API de
 * produto nem aparecer em log.
 *
 *   pnpm --filter @veyra/api channel:whatsapp \
 *     --slug acme --phone-number-id 123456789 --waba 987654321
 *
 * O TOKEN NUNCA VAI NA LINHA DE COMANDO. `argv` é legível por outros usuários da
 * máquina em `ps` e fica no histórico do shell — não imprimir depois não desfaz
 * isso. Por padrão o script PERGUNTA sem eco; para automação, `--token-stdin` lê
 * da entrada padrão.
 *
 * O token é CIFRADO antes de ir ao banco (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`) e
 * nunca é impresso — nem em erro. Reexecutar com o mesmo `phone-number-id`
 * rotaciona o token, que é o caminho normal de rotação.
 */
import 'dotenv/config';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Lê a entrada padrão inteira (uso com `printf '%s' "$T" | ... --token-stdin`). */
async function readStdin(): Promise<string> {
  const partes: Buffer[] = [];
  for await (const chunk of process.stdin) partes.push(Buffer.from(chunk));
  return Buffer.concat(partes).toString('utf8').trim();
}

/**
 * Pergunta sem ECO. O terminal não deve mostrar o token nem deixá-lo rolar na
 * tela — e, com `terminal: true` e uma saída que descarta, o readline não imprime
 * o que é digitado.
 */
async function promptSecret(rotulo: string): Promise<string> {
  process.stderr.write(rotulo);
  const mudo = new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: mudo, terminal: true });
  try {
    const linha = await new Promise<string>((resolve) => rl.question('', resolve));
    return linha.trim();
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}

/** Mesmo formato do CryptoService: base64(iv[12] | authTag[16] | ciphertext). */
function encrypt(plaintext: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

async function main(): Promise<void> {
  const slug = arg('slug');
  const phoneNumberId = arg('phone-number-id');
  const businessAccountId = arg('waba');
  const nome = arg('name') ?? 'WhatsApp';
  if (!slug || !phoneNumberId || !businessAccountId) {
    console.error(
      'uso: channel:whatsapp --slug <workspace> --phone-number-id <id> ' +
        '--waba <id> [--name "WhatsApp"] [--token-stdin]\n' +
        'o token é perguntado sem eco; com --token-stdin, vem da entrada padrão.',
    );
    process.exitCode = 1;
    return;
  }
  /**
   * `--token` na linha de comando é RECUSADO em vez de aceito com aviso: quem
   * digitou já expôs o segredo em `ps` e no histórico, e continuar daria a
   * impressão de que estava tudo bem.
   */
  if (process.argv.includes('--token')) {
    console.error(
      'RECUSADO: --token na linha de comando expõe a credencial em `ps` e no ' +
        'histórico do shell. Use --token-stdin ou deixe o script perguntar.\n' +
        'O token que você acabou de digitar deve ser considerado COMPROMETIDO: ' +
        'rotacione-o no app da Meta antes de seguir.',
    );
    process.exitCode = 1;
    return;
  }

  const token = process.argv.includes('--token-stdin')
    ? await readStdin()
    : await promptSecret('token permanente da Meta (não aparece na tela): ');
  if (!token) {
    console.error('token vazio.');
    process.exitCode = 1;
    return;
  }
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    console.error('TOKEN_ENCRYPTION_KEY ausente: sem ela o token iria em claro para o banco.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL) });
  try {
    const workspace = await prisma.workspace.findUnique({ where: { slug } });
    if (!workspace) throw new Error(`Workspace não encontrado: ${slug}`);

    /**
     * O `phoneNumberId` é o que ROTEIA o webhook para o tenant (ADR-037), e é
     * unique global: se já pertence a outro workspace, parar é obrigatório —
     * reatribuir entregaria as mensagens daquele número ao workspace errado.
     */
    const existente = await prisma.channelCredential.findFirst({
      where: { phoneNumberId },
      select: { workspaceId: true, channelId: true },
    });
    if (existente && existente.workspaceId !== workspace.id) {
      throw new Error(
        `phone-number-id ${phoneNumberId} já está registrado em OUTRO workspace. ` +
          'Remova lá antes, ou o webhook entregaria as mensagens ao tenant errado.',
      );
    }

    const tokenCipher = encrypt(token, secret);
    if (existente) {
      await prisma.channelCredential.updateMany({
        where: { workspaceId: workspace.id, channelId: existente.channelId },
        data: { businessAccountId, tokenCipher },
      });
      console.log(`credencial ATUALIZADA (rotação de token) para ${slug} / ${phoneNumberId}`);
      return;
    }

    const channel = await prisma.channel.create({
      data: { workspaceId: workspace.id, type: 'whatsapp', name: nome },
    });
    await prisma.channelCredential.create({
      data: {
        workspaceId: workspace.id,
        channelId: channel.id,
        phoneNumberId,
        businessAccountId,
        tokenCipher,
      },
    });
    console.log(`canal WhatsApp criado para ${slug}: channelId=${channel.id}`);
    console.log('token cifrado com TOKEN_ENCRYPTION_KEY — nunca é impresso nem logado.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // mensagem apenas: um erro do Prisma pode carregar o payload da operação,
  // e o payload aqui contém o token
  console.error('falhou:', error instanceof Error ? error.message : 'erro desconhecido');
  process.exit(1);
});
