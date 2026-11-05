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
    const sqlCru: string[] = [];
    for (const arquivo of arquivosDeProducao(SRC)) {
      const texto = readFileSync(arquivo, 'utf8');
      // pelo client (protegido ou cru), em qualquer variável: update*, delete*, upsert
      for (const m of texto.matchAll(
        /\.message\.(update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\(/g,
      )) {
        escritas.push(`${relative(SRC, arquivo)}:${m[1]}:${m.index}`);
      }
      // e por SQL cru, em qualquer forma de citar a tabela
      if (/(UPDATE|DELETE\s+FROM)\s+"?Message"?\b/i.test(texto))
        sqlCru.push(relative(SRC, arquivo));
    }
    expect(sqlCru).toEqual([]);
    expect(escritas).toHaveLength(1);
    const [arquivo, operacao, posicao] = escritas[0].split(':');
    expect([arquivo, operacao]).toEqual([
      'conversations/conversation-sender.service.ts',
      'updateMany',
    ]);

    // dentro de `identify`, e na forma exata que o client aceita
    const texto = readFileSync(join(SRC, arquivo), 'utf8');
    const inicio = texto.indexOf('  async identify(');
    const fim = texto.indexOf('  async unidentify(');
    expect(inicio).toBeGreaterThan(-1);
    expect(Number(posicao)).toBeGreaterThan(inicio);
    expect(Number(posicao)).toBeLessThan(fim);
    expect(texto.slice(Number(posicao), Number(posicao) + 200)).toMatch(
      /^\.message\.updateMany\(\{\s*where: \{ conversationId: conversa\.id, receivedContactId: null \},\s*data: \{ receivedContactId: contactId \},\s*\}\)/,
    );
  });

  it('a ingestão RAI não enfileira nada: o serviço de ingestão não fala com o outbox', () => {
    // o único evento que a ingestão pode gerar é o `contact.created` do lead,
    // pelo serviço de contatos — e a conversa RAI não cria contato
    const ingestao = readFileSync(join(__dirname, '..', 'channels', 'whatsapp.service.ts'), 'utf8');
    expect(ingestao).not.toMatch(/OutboxService|this\.outbox|\.enqueue\(/);
  });
});
