import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  FetchOutcome,
  MetaTransport,
  ParametrosDoTemplate,
  SendCredential,
  SendOutcome,
} from './meta.transport';

/**
 * Transporte FALSO do WhatsApp — existe para que STAGING exercite o caminho de
 * envio inteiro (rascunho, aprovação, `Message`, `MessageDispatch`, outbox,
 * estados de entrega) sem que uma única mensagem chegue a uma pessoa real
 * (ADR-046).
 *
 * Este é o tipo de código que precisa gritar. Um ambiente que finge envio em
 * SILÊNCIO é pior que um que falha: quem opera acredita ter falado com o
 * paciente. Por isso cada envio registra `warn` com destinatário e motivo, e a
 * seleção deste transporte é recusada fora de staging pela validação de
 * ambiente (`env.ts`) — o modo `graph` é o padrão, e a ausência da variável
 * NUNCA produz este comportamento.
 *
 * O `externalId` é sintético e marcado: `wamid.FAKE-…` é impossível de
 * confundir com um wamid da Meta em log, banco ou tela.
 */
/**
 * Telefone é dado pessoal, e o log deste container vai para `json-file` numa
 * VPS compartilhada com outros projetos. Nenhum outro logger do módulo imprime
 * endereço — os quatro últimos dígitos bastam para o operador cruzar com a
 * conversa (SECURITY.md §9, minimização por padrão).
 */
function mascarar(endereco: string): string {
  return endereco.length <= 4 ? '****' : `****${endereco.slice(-4)}`;
}

@Injectable()
export class FakeMetaTransport implements MetaTransport {
  private readonly logger = new Logger(FakeMetaTransport.name);

  constructor() {
    this.logger.warn(
      'TRANSPORTE FALSO ATIVO: nenhuma mensagem sai para a Meta. ' +
        'Correto apenas em staging — em produção isto seria perda silenciosa.',
    );
  }

  async sendText(_credential: SendCredential, to: string, body: string): Promise<SendOutcome> {
    // o CORPO não vai para o log: é conteúdo de conversa (SECURITY.md §5).
    // Tamanho basta para depurar truncamento.
    this.logger.warn(
      `envio FALSO de texto para ${mascarar(to)} (${body.length} caracteres) — nada saiu`,
    );
    return { ok: true, externalId: this.id() };
  }

  async sendTemplate(
    _credential: SendCredential,
    to: string,
    template: { name: string; language: string },
    params: ParametrosDoTemplate,
  ): Promise<SendOutcome> {
    // os VALORES não vão para o log (o nome do contato): só a contagem
    this.logger.warn(
      `envio FALSO de template "${template.name}" (${template.language}, ` +
        `${params.header.length + params.body.length} parâmetro(s)) para ${mascarar(to)} — nada saiu`,
    );
    return { ok: true, externalId: this.id() };
  }

  async fetchMedia(_credential: SendCredential, mediaId: string): Promise<FetchOutcome> {
    /**
     * Coleta de mídia FALHA em vez de devolver bytes inventados. Devolver um
     * arquivo sintético faria o scanner aprová-lo e ele viraria anexo de
     * verdade no banco — um dado que ninguém enviou. Falhar deixa a
     * `InboundMedia` em erro, que é um estado honesto e visível.
     */
    this.logger.warn(`coleta FALSA de mídia ${mediaId} — recusada de propósito`);
    return { ok: false, failure: { status: 501 } };
  }

  private id(): string {
    return `wamid.FAKE-${randomUUID()}`;
  }
}
