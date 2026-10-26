import { createHmac } from 'node:crypto';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chaveDeCoincidencia } from '../contacts/phone-identity';
import type { Db } from '../prisma/prisma.service';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from './content-use.pools';
import { MudancasDeRestricao } from './restriction-changes';
import { prazoDeTrava, travarIngestao, travarParaUso } from './restriction-locks';

type Coordenavel = Pick<Db, '$executeRaw' | '$queryRaw'>;

/** O lote da ingestão passou do teto: nada mais começa, e a Meta reentrega. */
export const MENSAGEM_LOTE_SEM_PRAZO =
  'Ingestão sem prazo para o restante do lote; a reentrega é deduplicada.';

/**
 * As travas da identidade de quem escreve (ADR-052 item 3, F4.1a): a ingestão
 * do WhatsApp, os três atos de identificação e quem escreve telefone. Todos
 * passam pela primitiva única, na ordem global:
 *
 * | Operação                         | Travas                                          |
 * | -------------------------------- | ----------------------------------------------- |
 * | ingestão                         | nível 0; workspace e `address:` compartilhadas  |
 * | identificar, desfazer e rejeitar | nível 0; a mudança por contato (os contatos,    |
 * |                                  | `conversation:` e `address:` exclusivos)        |
 * | escritor de telefone de contato  | a mudança por contato: o contato e o `address:` |
 * | (criar na tela, editar, excluir) | de cada NÚMERO acrescentado ou removido         |
 * | consentimento e pedido de parar  | a mudança por contato: os contatos do número e  |
 * | (F4.1b)                          | o `address:` dele                               |
 *
 * O contato criado na própria transação (o lead da ingestão, o novo da
 * identificação) tem id fresco, que ninguém mais conhece: ele não pega o nível
 * 2 depois do 3. Isso NÃO vale para contato existente — editar sempre passa por
 * `paraTelefones`. A importação não trava endereço (ADR-052, resultados da
 * F4.1a): só cria contatos, e um lote de até mil números ocuparia a tabela de
 * travas compartilhada do Postgres.
 *
 * Nenhuma chave leva o telefone em claro: o nível 0 e o `address:` passam pelo
 * HMAC da `ADDRESS_LOCK_KEY` — o texto da chave vai como parâmetro ao SQL, e
 * apareceria num log de instruções.
 */
@Injectable()
export class TravasDeIdentidade {
  private readonly chave: Buffer;

  constructor(
    config: ConfigService,
    private readonly mudancas: MudancasDeRestricao,
    @Inject(CONFIG_DA_GUARDA) private readonly guarda: ConfigDaGuarda,
  ) {
    // obrigatória no boot (env.ts); a checagem aqui é a segunda camada, e não
    // existe valor gerado na inicialização: a chave precisa ser ESTÁVEL, porque
    // as chaves `address:` ficam gravadas no registro dos usos (ADR-052, C10)
    const valor = config.get<string>('ADDRESS_LOCK_KEY');
    if (!valor || valor.length < 32) throw new Error('ADDRESS_LOCK_KEY ausente ou curta');
    this.chave = Buffer.from(valor, 'utf8');
  }

  private hmac(texto: string): string {
    return createHmac('sha256', this.chave).update(texto).digest('hex');
  }

  /** O endereço como chave de entidade: HMAC de (workspace, chave de coincidência). */
  endereco(workspaceId: string, chaveDeCoincidencia: string): string {
    return `address:${this.hmac(`${workspaceId}:${chaveDeCoincidencia}`)}`;
  }

  /**
   * O nível 0 de (workspace, chave de coincidência), pelo HMAC — com outro
   * prefixo, para não coincidir com o do endereço.
   */
  nivelZero(workspaceId: string, chaveDeCoincidencia: string): string {
    return this.hmac(`ingest:${workspaceId}:${chaveDeCoincidencia}`);
  }

  conversa(conversationId: string): string {
    return `conversation:${conversationId}`;
  }

  /** O fim do lote da ingestão que começa agora (o relógio é só do Node, que compara). */
  fimDoLote(): number {
    return Date.now() + this.guarda.ingestaoLoteMs;
  }

  /**
   * A ingestão de UMA mensagem. O prazo é da mensagem, não de cada trava: o que
   * sobra é reposto antes de cada passo, dividido entre as travas do passo, e
   * nunca passa do fim do lote. Depois das travas, o resto fica para as esperas
   * por linha da transação. Sem a trava nesse prazo, o 55P03 propaga (409); sem
   * prazo nenhum, o 503. Os dois não são 2xx: a Meta reentrega, e o
   * `externalId` deduplica.
   */
  async paraIngestao(
    tx: Coordenavel,
    workspaceId: string,
    chaveDeCoincidencia: string | null,
    fimDoLote: number,
  ): Promise<void> {
    const fim = Math.min(Date.now() + this.guarda.ingestaoTravaMs, fimDoLote);
    const repor = async (travas: number) => {
      const resta = fim - Date.now();
      if (resta <= 0) throw new ServiceUnavailableException(MENSAGEM_LOTE_SEM_PRAZO);
      await prazoDeTrava(tx, Math.floor(resta / travas));
    };
    await repor(1);
    if (!chaveDeCoincidencia) return;
    await travarIngestao(tx, workspaceId, [this.nivelZero(workspaceId, chaveDeCoincidencia)]);
    // o workspace e o endereço: duas esperas, que somadas não passam do resto
    await repor(2);
    await travarParaUso(tx, {
      workspaceId,
      entityKeys: [this.endereco(workspaceId, chaveDeCoincidencia)],
    });
    await repor(1);
  }

  /**
   * Identificar, desfazer e rejeitar: o nível 0 do número da conversa, depois a
   * mudança por contato — os contatos envolvidos, a conversa e o endereço
   * exclusivos, com a marcação de órfãos e o 409 quando a espera estoura.
   * `outrasChaves`: as dos telefones que o rejeitar tira do contato, quando
   * diferem da do número (o ramal), na MESMA passada.
   */
  async paraIdentificacao(
    tx: Db,
    escopo: {
      workspaceId: string;
      chaveDeCoincidencia: string | null;
      contactIds: readonly (string | null | undefined)[];
      conversationId: string;
      outrasChaves?: readonly string[];
    },
  ): Promise<void> {
    await prazoDeTrava(tx, this.guarda.mudancaTravaMs);
    if (escopo.chaveDeCoincidencia) {
      await travarIngestao(tx, escopo.workspaceId, [
        this.nivelZero(escopo.workspaceId, escopo.chaveDeCoincidencia),
      ]);
    }
    await this.mudancas.porContato(tx, {
      workspaceId: escopo.workspaceId,
      contactIds: escopo.contactIds,
      entityKeys: [
        this.conversa(escopo.conversationId),
        ...[
          ...new Set([
            ...(escopo.chaveDeCoincidencia ? [escopo.chaveDeCoincidencia] : []),
            ...(escopo.outrasChaves ?? []),
          ]),
        ].map((c) => this.endereco(escopo.workspaceId, c)),
      ],
    });
  }

  /**
   * O marcador do envio de PESSOA (F4.1b): o `address:` do número,
   * COMPARTILHADO — o pedido de parar o pega exclusivo. Ou o marcador comita
   * antes do pedido, que o conta como em voo, ou o pedido comita antes, e a
   * releitura de quem envia o vê. Sem trava, um despacho gravado entre o
   * cancelamento do pedido e o commit dele sairia depois, fora da trilha.
   */
  async paraMarcarEnvio(tx: Db, workspaceId: string, numero: string): Promise<void> {
    const chave = chaveDeCoincidencia(numero);
    await prazoDeTrava(tx, this.guarda.mudancaTravaMs);
    await travarParaUso(tx, {
      workspaceId,
      entityKeys: chave ? [this.endereco(workspaceId, chave)] : [],
    });
  }

  /**
   * Conceder, revogar, registrar o pedido de parar e desbloquear (ADR-052 item
   * 5, F4.1b): os contatos envolvidos e o `address:` do número, exclusivos,
   * numa passada — o mesmo `address:` que quem tira o número pega. É o que
   * impede um consentimento de ficar utilizável sob bloqueio, ou para um
   * número que saiu do contato, pela ordem das operações.
   */
  async paraNumero(
    tx: Db,
    escopo: { workspaceId: string; contactIds: readonly string[]; numero: string },
  ): Promise<void> {
    const chave = chaveDeCoincidencia(escopo.numero);
    await this.mudancas.porContato(tx, {
      workspaceId: escopo.workspaceId,
      contactIds: escopo.contactIds,
      entityKeys: chave ? [this.endereco(escopo.workspaceId, chave)] : [],
    });
  }

  /**
   * Quem escreve telefone de contato fora da ingestão, numa passada só: o
   * contato (quando já existe) e o `address:` das chaves dos NÚMEROS que entram
   * ou saem, exclusivos — inclusive quando a chave do número que muda é a mesma
   * de outro que fica (o 9º dígito, o DDI, a formatação). As chaves vêm de
   * `chavesQueMudam`; criar e editar só chamam quando algum telefone muda, e a
   * exclusão sempre chama, porque é também a mudança de restrição do contato.
   */
  async paraTelefones(
    tx: Db,
    escopo: { workspaceId: string; contactId: string | null; chaves: readonly string[] },
  ): Promise<void> {
    await this.mudancas.porContato(tx, {
      workspaceId: escopo.workspaceId,
      contactIds: escopo.contactId ? [escopo.contactId] : [],
      entityKeys: [...new Set(escopo.chaves)].map((c) => this.endereco(escopo.workspaceId, c)),
    });
  }
}
