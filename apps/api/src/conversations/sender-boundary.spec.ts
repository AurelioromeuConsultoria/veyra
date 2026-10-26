import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  automationTriggerSchema,
  notificationTypeSchema,
  webhookEventSchema,
} from '@veyra/contracts';
import { OUTBOX_EVENTS } from '../outbox/outbox.service';

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

  it('a ingestão RAI não enfileira nada: o serviço de ingestão não fala com o outbox', () => {
    // o único evento que a ingestão pode gerar é o `contact.created` do lead,
    // pelo serviço de contatos — e a conversa RAI não cria contato
    const ingestao = readFileSync(join(__dirname, '..', 'channels', 'whatsapp.service.ts'), 'utf8');
    expect(ingestao).not.toMatch(/OutboxService|this\.outbox|\.enqueue\(/);
  });
});
