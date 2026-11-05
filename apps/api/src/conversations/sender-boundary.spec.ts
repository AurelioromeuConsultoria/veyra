import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  automationTriggerSchema,
  notificationTypeSchema,
  webhookEventSchema,
} from '@veyra/contracts';
import { OUTBOX_EVENTS } from '../outbox/outbox.service';
import { PREENCHIMENTO_UNICO_DO_RECEBIMENTO } from '../prisma/workspace-models';

/**
 * A fronteira do "remetente a identificar" (ADR-052 item 2). Hoje nenhum evento,
 * gatilho ou notificação carrega mensagem; a regra é PREVENTIVA: tudo o que
 * vier a falar de mensagem ou de conversa precisa dizer aqui como trata a
 * conversa RAI — senão este teste falha e a pergunta volta para quem o criou.
 */
const SRC = join(__dirname, '..');

function arquivosDeProducao(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory())
      return nome === 'generated' ? [] : arquivosDeProducao(caminho);
    return nome.endsWith('.ts') && !/\.(integration-)?spec\.ts$/.test(nome) ? [caminho] : [];
  });
}

const TRATAMENTO_RAI: Record<string, string> = {
  conversation_assigned:
    'a conversa RAI só é atribuída a quem tem contacts:write (ConversationsService.update): a notificação não revela a conversa a quem não pode vê-la',
};

/**
 * A varredura das escritas em `Message` (ADR-061, adendo 9), aplicada à fonte
 * NORMALIZADA: todo espaço (inclusive a quebra de linha) vira um só, e sai ao
 * lado de pontuação — fica só entre duas palavras (`await message`). Assim
 * `tx.message\n.updateMany(` e `tx . message . updateMany (` caem na mesma
 * forma, `tx.message.updateMany(`. O acesso ao modelo, em
 * qualquer variável: `tx.message`, `tx.message?.`, `tx['message']`,
 * `tx["message"]`, e a variável desestruturada (`const { message } = tx;
 * message.updateMany(`). Um falso positivo (`erro.message.update(`, que não
 * existe) falha alto, nunca cala.
 */
const semEspacos = (texto: string) => texto.replace(/\s+/g, ' ').replace(/ (?=\W)|(?<=\W) /g, '');
const ACESSO_A_MESSAGE = String.raw`(?:\bmessage|\[['"\x60]message['"\x60]\])\??\.`;
const ESCRITA_EM_MESSAGE = new RegExp(
  `${ACESSO_A_MESSAGE}(update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\\(`,
  'g',
);
const CRIACAO_EM_MESSAGE = new RegExp(
  `${ACESSO_A_MESSAGE}(create|createMany|createManyAndReturn)\\(`,
  'g',
);
/**
 * O delegate do modelo guardado numa variável, a partir de um client (`const m
 * = tx.message;`, `const { message: m } = tx`): a escrita por ele escaparia
 * das formas acima, então a própria referência é recusada.
 */
const APELIDO_DE_MESSAGE =
  /(?:\btx|\bdb|\.raw|\.db)\??\.message(?![\w?.])|\{(?:[^{}]*,)?message:\w+[^{}]*\}=(?:tx|db|this\.prisma)/;
/** E por SQL cru, em qualquer forma de citar a tabela (na fonte original). */
const SQL_CRU_EM_MESSAGE =
  /(UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE)(\s+ONLY)?\s+(public\.)?"?Message"?(?![\w"])/i;

describe('a fronteira do remetente a identificar (ADR-052 item 2)', () => {
  it('todo evento, gatilho ou notificação de mensagem ou de conversa declara o tratamento RAI', () => {
    const catalogo = [
      ...webhookEventSchema.options,
      ...automationTriggerSchema.options,
      ...notificationTypeSchema.options,
      ...Object.keys(OUTBOX_EVENTS),
    ];
    const deConversa = [...new Set(catalogo.filter((nome) => /message|conversation/i.test(nome)))];
    expect(deConversa.filter((nome) => !(nome in TRATAMENTO_RAI))).toEqual([]);
  });

  it('as exceções das travas só são chamadas por quem segura as travas (critério 5)', () => {
    // o contato de id FRESCO e a retirada do número rodam sem pegar trava: quem
    // chama já segura o nível 0 e o endereço — a ingestão e a identificação
    const permitidos: Record<string, string[]> = {
      createFromExternalChannel: ['channels/whatsapp.service.ts'],
      criarPelaIdentificacao: ['conversations/conversation-sender.service.ts'],
      tirarNumeroNaTransacao: ['conversations/conversation-sender.service.ts'],
      saidaDoNumero: ['conversations/conversation-sender.service.ts'],
    };
    const chamadas: Record<string, string[]> = {};
    for (const arquivo of arquivosDeProducao(SRC)) {
      const texto = readFileSync(arquivo, 'utf8');
      for (const metodo of Object.keys(permitidos)) {
        if (new RegExp(`\\.${metodo}\\(`).test(texto)) {
          (chamadas[metodo] ??= []).push(relative(SRC, arquivo));
        }
      }
    }
    expect(chamadas).toEqual(permitidos);
  });

  it('o `raw` do serviço de contatos: a região do workspace e o nome do User global (SECURITY.md §2)', () => {
    const texto = readFileSync(join(SRC, 'contacts', 'contacts.service.ts'), 'utf8');
    const usos = [...texto.matchAll(/prisma\.raw\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
    // o `user.findMany` é anterior: o nome do responsável vem da identidade global
    expect(usos.sort()).toEqual(['user.findMany', 'workspace.findUnique']);
    expect(texto).toMatch(
      /raw\.workspace\.findUnique\(\{\s*where: \{ id: workspaceId \},\s*select: \{ phoneRegion: true \},/,
    );
  });

  it('a única escrita em `Message` é o preenchimento único do contato do recebimento, na identificação (ADR-061, adendo 9)', () => {
    // a exceção do client protegido: o modelo, a coluna e o escopo, e nada mais
    expect(PREENCHIMENTO_UNICO_DO_RECEBIMENTO).toEqual({
      model: 'Message',
      coluna: 'receivedContactId',
      escopo: 'conversationId',
    });
    const escritas: string[] = [];
    const criacoes: Record<string, number> = {};
    const apelidos: string[] = [];
    const sqlCru: string[] = [];
    for (const arquivo of arquivosDeProducao(SRC)) {
      const texto = readFileSync(arquivo, 'utf8');
      const nome = relative(SRC, arquivo);
      const fonte = semEspacos(texto);
      // pelo client (protegido ou cru), em qualquer variável: update*, delete*, upsert
      for (const m of fonte.matchAll(ESCRITA_EM_MESSAGE)) {
        escritas.push(`${nome}:${m[1]}:${m.index}`);
      }
      // as criações também, por arquivo: todo escritor novo grava o contato do
      // recebimento, e precisa entrar na lista abaixo
      const criadas = [...fonte.matchAll(CRIACAO_EM_MESSAGE)].length;
      if (criadas > 0) criacoes[nome] = criadas;
      if (APELIDO_DE_MESSAGE.test(fonte)) apelidos.push(nome);
      if (SQL_CRU_EM_MESSAGE.test(texto)) sqlCru.push(nome);
    }
    expect(sqlCru).toEqual([]);
    expect(apelidos).toEqual([]);
    // os quatro escritores (a ingestão, o registro manual, o envio de pessoa e
    // da IA, e o envio do negócio), todos com o contato do recebimento
    expect(criacoes).toEqual({
      'channels/whatsapp.service.ts': 1,
      'channels/whatsapp-send.service.ts': 2,
      'conversations/conversations.service.ts': 1,
    });
    expect(escritas).toHaveLength(1);
    const [arquivo, operacao, posicao] = escritas[0].split(':');
    expect([arquivo, operacao]).toEqual([
      'conversations/conversation-sender.service.ts',
      'updateMany',
    ]);

    // dentro de `identify`, e na forma exata que o client aceita
    const fonte = semEspacos(readFileSync(join(SRC, arquivo), 'utf8'));
    const inicio = fonte.indexOf('async identify(');
    const fim = fonte.indexOf('async unidentify(');
    expect(inicio).toBeGreaterThan(-1);
    expect(Number(posicao)).toBeGreaterThan(inicio);
    expect(Number(posicao)).toBeLessThan(fim);
    expect(fonte.slice(Number(posicao), Number(posicao) + 200)).toMatch(
      /^message\.updateMany\(\{where:\{conversationId:conversa\.id,receivedContactId:null\},data:\{receivedContactId:contactId\},?\}\)/,
    );
  });

  it('a varredura da escrita em `Message` pega as formas que escapavam da regex anterior (revisão do adendo 9)', () => {
    // as MESMAS expressões do teste acima, sobre fontes de exemplo
    const pega = (codigo: string) => {
      const fonte = semEspacos(codigo);
      return (
        [...fonte.matchAll(ESCRITA_EM_MESSAGE)].length > 0 ||
        APELIDO_DE_MESSAGE.test(fonte) ||
        SQL_CRU_EM_MESSAGE.test(codigo)
      );
    };
    for (const codigo of [
      `await tx.message.updateMany({ where: {}, data: {} })`,
      `await tx['message'].updateMany({})`,
      `await tx["message"].deleteMany({})`,
      'await tx[`message`].upsert({})',
      `const { message } = tx; await message.updateMany({})`,
      `await tx.message?.updateMany({})`,
      `await tx['message']?.update({})`,
      `await tx\n  .message\n  .updateMany({})`,
      `await tx.message\n  ?.updateManyAndReturn({})`,
      `await this.prisma.raw.message . delete ({})`,
      `const m = tx.message; await m.updateMany({})`,
      `const m = this.prisma.raw.message;`,
      `const { message: m } = tx; await m.updateMany({})`,
      `await tx.$executeRawUnsafe('UPDATE "Message" SET "body" = $1')`,
      `await tx.$executeRawUnsafe('DELETE FROM public."Message"')`,
      'await tx.$executeRaw`UPDATE\n  Message SET body = 1`',
    ]) {
      expect([codigo, pega(codigo)]).toEqual([codigo, true]);
    }
    // e não confunde leitura, criação, o despacho ou a mensagem de um erro
    for (const codigo of [
      `await tx.message.findFirst({})`,
      `await tx.message.count({})`,
      `await tx.message.create({ data: {} })`,
      `await tx.messageDispatch.updateMany({})`,
      `await tx.$executeRawUnsafe('UPDATE "MessageDispatch" SET "state" = $1')`,
      `throw new Error(erro.message)`,
      `const { message } = erro;`,
    ]) {
      expect([codigo, pega(codigo)]).toEqual([codigo, false]);
    }
  });

  it('a ingestão RAI não enfileira nada: o serviço de ingestão não fala com o outbox', () => {
    // o único evento que a ingestão pode gerar é o `contact.created` do lead,
    // pelo serviço de contatos — e a conversa RAI não cria contato
    const ingestao = readFileSync(join(__dirname, '..', 'channels', 'whatsapp.service.ts'), 'utf8');
    expect(ingestao).not.toMatch(/OutboxService|this\.outbox|\.enqueue\(/);
  });
});
