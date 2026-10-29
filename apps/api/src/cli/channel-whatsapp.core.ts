import type { INestApplicationContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto.service';
import { PrismaService, type Db } from '../prisma/prisma.service';

/**
 * O cadastro do canal WhatsApp (ADR-037; compilado na F4.4c, ADR-048 adendo
 * 13): o corpo testável da CLI `channel:whatsapp`. As regras são as do script
 * que ele substitui:
 *
 * - o `phoneNumberId` ROTEIA o webhook para o tenant e é único global: se já
 *   pertence a outro workspace, para — reatribuir entregaria as mensagens
 *   daquele número ao workspace errado;
 * - o mesmo `phoneNumberId` no mesmo workspace é ROTAÇÃO do token;
 * - a WABA não muda na rotação sem `trocarWaba`: as versões de template do
 *   canal ficam presas à WABA de onde saíram, e a releitura diverge todas;
 * - o token é cifrado pelo `CryptoService` (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`)
 *   e nunca é impresso, nem no erro, nem na trilha.
 *
 * As escritas vão pelo client protegido, no contexto do workspace; o `raw` só
 * onde é preciso ver além dele (comentado em cada uso).
 */

export class RecusaDoCanal extends Error {}

export interface EntradaDoCanal {
  slug: string;
  phoneNumberId: string;
  businessAccountId: string;
  nome: string;
  token: string;
  trocarWaba: boolean;
}

export type ResultadoDoCanal =
  | { tipo: 'criado'; channelId: string }
  | { tipo: 'rotacionado'; channelId: string; trocouWaba: boolean };

const ATOR = { type: 'system', id: 'cli:channel-whatsapp' } as const;

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

export async function cadastrarCanalWhatsapp(
  app: INestApplicationContext,
  entrada: EntradaDoCanal,
): Promise<ResultadoDoCanal> {
  if (!entrada.token) throw new RecusaDoCanal('token vazio.');
  const prisma = app.get(PrismaService);
  // `raw` justificado (CLAUDE.md §3.3): rotina administrativa que resolve o
  // workspace pelo slug, antes de existir contexto
  const workspace = await prisma.raw.workspace.findFirst({
    where: { slug: entrada.slug },
    select: { id: true },
  });
  if (!workspace) throw new RecusaDoCanal(`Workspace não encontrado: ${entrada.slug}`);

  // `raw` justificado: o `phoneNumberId` é único GLOBAL, e a recusa precisa ver
  // a credencial de OUTRO workspace — o client protegido a esconderia
  const existente = await prisma.raw.channelCredential.findFirst({
    where: { phoneNumberId: entrada.phoneNumberId },
    select: { workspaceId: true, channelId: true, businessAccountId: true },
  });
  if (existente && existente.workspaceId !== workspace.id) {
    throw new RecusaDoCanal(
      `phone-number-id ${entrada.phoneNumberId} já está registrado em OUTRO workspace. ` +
        'Remova lá antes, ou o webhook entregaria as mensagens ao tenant errado.',
    );
  }
  const trocaDeWaba =
    existente !== null && existente.businessAccountId !== entrada.businessAccountId;
  if (trocaDeWaba && !entrada.trocarWaba) {
    throw new RecusaDoCanal(
      `a WABA informada (${entrada.businessAccountId}) não é a registrada (${existente.businessAccountId}). ` +
        'Trocar a WABA diverge todas as versões de template do canal; confirme com --trocar-waba.',
    );
  }

  const tokenCipher = app.get(CryptoService).encrypt(entrada.token);
  const audit = app.get(AuditService);
  const cls = app.get(ClsService);
  return cls.run(async () => {
    cls.set('workspaceId', workspace.id);
    // a marca da CLI na trilha: o `:` fica fora do formato do cabeçalho HTTP
    cls.set('requestId', `cli:channel-whatsapp:${randomUUID()}`);
    const db = prisma.db as unknown as TxRunner;
    return db.$transaction(async (tx) => {
      if (existente) {
        const { count } = await tx.channelCredential.updateMany({
          where: { channelId: existente.channelId },
          data: { businessAccountId: entrada.businessAccountId, tokenCipher },
        });
        // a credencial sumiu entre a leitura e a transação: nada a rotacionar
        if (count !== 1) {
          throw new RecusaDoCanal(
            'a credencial deste número mudou durante o cadastro; rode de novo.',
          );
        }
        await audit.record(tx, workspace.id, 'channel.credential_rotated', {
          entityType: 'channelCredential',
          entityId: existente.channelId,
          actor: ATOR,
          after: {
            channelId: existente.channelId,
            phoneNumberId: entrada.phoneNumberId,
            businessAccountId: entrada.businessAccountId,
            trocouWaba: trocaDeWaba,
          },
        });
        return {
          tipo: 'rotacionado' as const,
          channelId: existente.channelId,
          trocouWaba: trocaDeWaba,
        };
      }
      const canal = (await tx.channel.create({
        data: { type: 'whatsapp', name: entrada.nome },
        select: { id: true },
      } as never)) as unknown as { id: string };
      await tx.channelCredential.create({
        data: {
          channelId: canal.id,
          phoneNumberId: entrada.phoneNumberId,
          businessAccountId: entrada.businessAccountId,
          tokenCipher,
        },
      } as never);
      await audit.record(tx, workspace.id, 'channel.credential_registered', {
        entityType: 'channelCredential',
        entityId: canal.id,
        actor: ATOR,
        after: {
          channelId: canal.id,
          phoneNumberId: entrada.phoneNumberId,
          businessAccountId: entrada.businessAccountId,
          trocouWaba: false,
        },
      });
      return { tipo: 'criado' as const, channelId: canal.id };
    });
  });
}

// ── a linha de comando, testável ───────────────────────────────────────────

export const USO_DO_CANAL =
  'uso: channel:whatsapp --slug <workspace> --phone-number-id <id> ' +
  '--waba <id> [--name "WhatsApp"] [--token-stdin] [--trocar-waba]\n' +
  'o token é perguntado sem eco; com --token-stdin, vem da entrada padrão (um pipe, nunca o terminal).\n' +
  'na rotação, trocar a WABA exige --trocar-waba: diverge as versões de template do canal.\n' +
  'se algum argumento recusado era o token, considere-o COMPROMETIDO e rotacione-o no app da Meta.';

export const AVISO_DE_TOKEN_EXPOSTO =
  'RECUSADO: o token na linha de comando fica exposto em `ps` e no histórico do ' +
  'shell. Use --token-stdin com um pipe, ou deixe a CLI perguntar.\n' +
  'O token que você acabou de digitar deve ser considerado COMPROMETIDO: ' +
  'rotacione-o no app da Meta antes de seguir.';

const COM_VALOR = new Set(['--slug', '--phone-number-id', '--waba', '--name']);
const SEM_VALOR = new Set(['--token-stdin', '--trocar-waba']);

export interface LinhaDeComando {
  /** os argumentos, sem `node` e o arquivo */
  argv: string[];
  /** a entrada padrão é um terminal: `--token-stdin` ecoaria o token */
  entradaEhTerminal: boolean;
  lerEntrada: () => Promise<string>;
  perguntarSemEco: (rotulo: string) => Promise<string>;
  /** sobe o contexto do Nest só depois das recusas (a configuração é validada nele) */
  criarApp: () => Promise<INestApplicationContext>;
  saida: (linha: string) => void;
  erro: (linha: string) => void;
}

/** O código de saída: 0 deu certo; 1 recusa ou falha. Nunca imprime o token. */
export async function executarCadastroDoCanal(cmd: LinhaDeComando): Promise<number> {
  // qualquer forma de passar o token por argumento é recusada ANTES de tudo:
  // `--token X`, `--token=X`, `--tokenX`
  if (cmd.argv.some((a) => a.startsWith('--token') && a !== '--token-stdin')) {
    cmd.erro(AVISO_DE_TOKEN_EXPOSTO);
    return 1;
  }
  const valores = new Map<string, string>();
  const marcas = new Set<string>();
  for (let i = 0; i < cmd.argv.length; i += 1) {
    const a = cmd.argv[i];
    if (SEM_VALOR.has(a)) {
      marcas.add(a);
    } else if (COM_VALOR.has(a) && cmd.argv[i + 1] && !cmd.argv[i + 1].startsWith('--')) {
      valores.set(a, cmd.argv[i + 1]);
      i += 1;
    } else {
      // argumento desconhecido ou posicional: nada adivinhado
      cmd.erro(USO_DO_CANAL);
      return 1;
    }
  }
  const slug = valores.get('--slug');
  const phoneNumberId = valores.get('--phone-number-id');
  const businessAccountId = valores.get('--waba');
  if (!slug || !phoneNumberId || !businessAccountId) {
    cmd.erro(USO_DO_CANAL);
    return 1;
  }
  if (marcas.has('--token-stdin') && cmd.entradaEhTerminal) {
    cmd.erro(
      'RECUSADO: --token-stdin com a entrada padrão no terminal mostraria o token na tela. ' +
        'Use um pipe, ou rode sem --token-stdin para a pergunta sem eco.',
    );
    return 1;
  }
  const token = marcas.has('--token-stdin')
    ? await cmd.lerEntrada()
    : await cmd.perguntarSemEco('token permanente da Meta (não aparece na tela): ');

  let app: INestApplicationContext | null = null;
  try {
    app = await cmd.criarApp();
    const r = await cadastrarCanalWhatsapp(app, {
      slug,
      phoneNumberId,
      businessAccountId,
      nome: valores.get('--name') ?? 'WhatsApp',
      token,
      trocarWaba: marcas.has('--trocar-waba'),
    });
    cmd.saida(
      r.tipo === 'criado'
        ? `canal WhatsApp criado para ${slug}: channelId=${r.channelId}`
        : `credencial ATUALIZADA (rotação de token${r.trocouWaba ? ' e troca de WABA' : ''}) para ${slug} / ${phoneNumberId}`,
    );
    cmd.saida('token cifrado com TOKEN_ENCRYPTION_KEY — nunca é impresso nem logado.');
    return 0;
  } catch (erro) {
    // a recusa é a mensagem da regra; de qualquer outro erro só o tipo e o
    // código — a mensagem de um erro do Prisma carrega o payload da operação
    if (erro instanceof RecusaDoCanal) {
      cmd.erro(`falhou: ${erro.message}`);
    } else {
      const { name, code } = (erro ?? {}) as { name?: string; code?: string };
      cmd.erro(`falhou: ${name ?? 'Error'} ${code ?? 'sem código'}`);
    }
    return 1;
  } finally {
    await app?.close();
  }
}
