import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ConversationSenderCandidateDto,
  IdentifyConversationSenderInput,
  RejectConversationSenderInput,
} from '@veyra/contracts';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../auth/permissions.service';
import { AuthContext } from '../common/decorators';
import { ContactsService } from '../contacts/contacts.service';
import { chaveDeCoincidencia, coincidencia } from '../contacts/phone-identity';
import { TravasDeIdentidade } from '../content-use/identity-locks';
import { MudancasDeRestricao, type OpcoesDaTransacao } from '../content-use/restriction-changes';
import { LimpezaDeConteudoDaConversa } from '../intelligence-persistence/conversation-cleanup';
import { CONTEUDO_RESTRITO, ProtectedContentService } from '../extensions/protected-content';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';

type TxRunner = {
  $transaction: <T>(fn: (tx: Db) => Promise<T>, options?: OpcoesDaTransacao) => Promise<T>;
};

type ConversaDoRemetente = {
  id: string;
  channelId: string;
  contactId: string | null;
  status: 'open' | 'pending' | 'closed';
  senderStatus: 'identified' | 'unidentified';
  senderIdentifiedAt: Date | null;
  externalAddress: string | null;
  assigneeMembershipId: string | null;
};

const SELECAO = {
  id: true,
  channelId: true,
  contactId: true,
  status: true,
  senderStatus: true,
  senderIdentifiedAt: true,
  externalAddress: true,
  assigneeMembershipId: true,
} as const;

/** A condição do legado (ADR-052, aprovação da F4.1a): a religação é bloqueada. */
export const MENSAGEM_DO_LEGADO =
  'Esta conversa tem mensagens anteriores à atualização, ligadas ao contato. Corrigir o remetente dela ainda não é possível.';

const MENSAGEM_MUDOU = 'A conversa acabou de mudar. Recarregue e tente de novo.';

/**
 * O remetente de uma conversa (ADR-052 item 2): identificar, desfazer e
 * rejeitar. É o ÚNICO escritor de `Conversation.contactId` (o teste estático
 * fixa isso), e os três atos são RELIGAÇÕES (ADR-047 adendo 6 §9): passam pelo
 * nível 0 do número e pela mudança por contato — os contatos envolvidos, a
 * conversa e o endereço exclusivos, com a marcação de órfãos.
 *
 * Na MESMA transação, o que a IA produziu sobre a conversa expira (resultados,
 * propostas pendentes, replays). Os despachos da IA não iniciados ficam
 * barrados pela reconferência do envio, que compara o contato da conversa com
 * o da aprovação.
 *
 * A AUTORIA não muda nunca: `authorType`, o membro e a origem de IA ficam como
 * estão, e a auditoria não é apagada. Só a ATRIBUIÇÃO ao contato, que nas
 * mensagens novas vem da conversa (C12).
 */
/** A recusa de levar à RAI a conversa protegida com mídia (ADR-061, adendo 6). */
export const MENSAGEM_MIDIA_PROTEGIDA =
  'Esta conversa tem mídia de um contato protegido e não pode voltar a remetente a identificar. A correção de uma atribuição errada ainda não está disponível.';

function mesmoConjuntoDeIds(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((id) => y.has(id));
}

@Injectable()
export class ConversationSenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly travas: TravasDeIdentidade,
    private readonly restricao: MudancasDeRestricao,
    private readonly contacts: ContactsService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
    private readonly limpeza: LimpezaDeConteudoDaConversa,
    private readonly protegido: ProtectedContentService,
  ) {}

  /** C13: ver (e operar) conversa RAI exige `contacts:write`, além da conversa. */
  podeVerRai(auth: AuthContext): Promise<boolean> {
    return this.permissions.has(auth, 'contacts:write');
  }

  /** Os candidatos a remetente de uma conversa RAI, classificados. */
  async candidates(
    auth: AuthContext,
    conversationId: string,
  ): Promise<ConversationSenderCandidateDto[]> {
    const conversa = await this.lerVisivel(auth, conversationId);
    if (conversa.senderStatus !== 'unidentified') {
      throw new BadRequestException('O remetente desta conversa já está identificado');
    }
    const classificados = await this.classificar(this.prisma.db, conversa.externalAddress);
    return classificados.map((c) => ({
      contactId: c.id,
      name: c.name,
      match: c.coincidencia === 'exata' ? 'exact' : 'possible',
    }));
  }

  async identify(
    auth: AuthContext,
    conversationId: string,
    input: IdentifyConversationSenderInput,
  ): Promise<void> {
    const workspaceId = auth.workspaceId as string;
    const antes = await this.lerVisivel(auth, conversationId);
    if (antes.senderStatus !== 'unidentified') {
      throw new BadRequestException('O remetente desta conversa já está identificado');
    }
    const escolhido = 'contactId' in input ? input.contactId : null;
    // o modo da proteção calculado FORA da transação (guardado por pedido): as
    // consultas dele não seguram uma conexão enquanto as travas estão presas
    await this.protegido.duvidaOculta(auth);
    /**
     * Em workspace sujeito ao E8, TODOS os candidatos do número entram nas
     * travas exclusivas de contato — as mesmas de quem torna o contato protegido: a
     * conversão de qualquer candidato fica em série com a identificação, e a
     * conferência do atalho (abaixo) não lê uma classificação velha (ADR-061,
     * adendo 7, item 4c). Lidos antes, relidos sob as travas: diferentes, 409.
     */
    const candidatosTravados = (await this.protegido.workspaceSujeito(workspaceId))
      ? (await this.classificar(this.prisma.db, antes.externalAddress)).map((c) => c.id)
      : null;
    const regiao = await this.contacts.regiaoDoWorkspace(workspaceId);
    const contactsLimit = escolhido
      ? null
      : await this.usage.prepareConsume(workspaceId, 'contacts');

    await this.restricao.naTransacaoInterativa(
      this.prisma.db as unknown as TxRunner,
      async (tx) => {
        const conversa = await this.travarERelear(
          tx,
          workspaceId,
          antes,
          [escolhido, ...(candidatosTravados ?? [])],
          [],
        );
        if (conversa.senderStatus !== 'unidentified' || conversa.contactId !== null) {
          throw new ConflictException(MENSAGEM_MUDOU);
        }
        const endereco = this.enderecoDe(conversa);
        // os candidatos RELIDOS sob as travas, contados na trilha em todo ato
        const classificados = await this.classificar(tx, endereco);
        if (
          candidatosTravados &&
          !mesmoConjuntoDeIds(
            candidatosTravados,
            classificados.map((c) => c.id),
          )
        ) {
          throw new ConflictException(
            'Os contatos deste número mudaram enquanto a conversa era identificada; recarregue e tente de novo.',
          );
        }
        let contactId: string;
        if (escolhido) {
          // um contato fora dos candidatos é recusado
          if (!classificados.some((c) => c.id === escolhido)) {
            throw new BadRequestException(
              'Este contato não é candidato a remetente desta conversa',
            );
          }
          contactId = escolhido;
        } else {
          const novo = (input as { newContact: { name: string } }).newContact;
          // o contato novo RECEBE o número: id fresco, sob as travas desta transação
          contactId = await this.contacts.criarPelaIdentificacao(
            tx,
            auth,
            { name: novo.name, phone: endereco, regiao },
            contactsLimit,
          );
        }
        await this.exigirIdentificacaoSemAtalho(tx, auth, conversa.id, contactId, classificados);
        /**
         * O único "uma conversa aberta por (canal, contato, número)": a anterior
         * do contato com este número é encerrada, com trilha, sem tocar
         * mensagem. Só quando ESTA fica aberta — a RAI encerrada identificada
         * continua encerrada, e o único não a alcança.
         */
        if (conversa.status !== 'closed') {
          await this.encerrarAnteriorAberta(tx, auth, conversa, contactId, endereco);
        }
        await tx.conversation.updateMany({
          where: { id: conversa.id },
          data: { contactId, senderStatus: 'identified', senderIdentifiedAt: new Date() },
        });
        await this.limpeza.expirarNaTransacao(tx, workspaceId, conversa.id);
        await this.audit.record(tx, workspaceId, 'conversation.sender_identified', {
          entityType: 'conversationSender',
          entityId: conversa.id,
          actor: this.audit.actorFrom(auth),
          before: { senderStatus: 'unidentified', contactId: null },
          after: {
            senderStatus: 'identified',
            contactId,
            candidates: classificados.length,
            newContact: escolhido === null,
          },
        });
      },
    );
  }

  /** Desfazer: a conversa que uma PESSOA identificou volta a RAI. */
  async unidentify(auth: AuthContext, conversationId: string): Promise<void> {
    const antes = await this.lerVisivel(auth, conversationId);
    if (antes.senderStatus !== 'identified' || !antes.senderIdentifiedAt || !antes.contactId) {
      throw new BadRequestException(
        'Só a identificação feita por uma pessoa pode ser desfeita; para outra conversa, use "o remetente não é este contato"',
      );
    }
    await this.levarARai(auth, antes, 'conversation.sender_unidentified', false);
  }

  /** "O remetente não é este contato": qualquer conversa identificada vai a RAI. */
  async reject(
    auth: AuthContext,
    conversationId: string,
    input: RejectConversationSenderInput,
  ): Promise<void> {
    const antes = await this.lerVisivel(auth, conversationId);
    if (antes.senderStatus !== 'identified' || !antes.contactId) {
      throw new BadRequestException('Esta conversa não tem remetente identificado');
    }
    await this.levarARai(auth, antes, 'conversation.sender_rejected', input.removeNumber);
  }

  /**
   * Identificar uma RAI como um contato que NÃO é oculto para quem pede, quando
   * algum candidato do número é oculto e a conversa tem mídia, abriria uma
   * mídia que pode ser do contato protegido (o número compartilhado; E8,
   * ADR-061, adendo 5): recusado com "Conteúdo restrito". Identificar como o
   * próprio protegido segue possível (a mídia continua protegida), e quem tem
   * as chaves identifica como sempre. No `uniforme`, a RAI com mídia não é
   * identificada (igual para todo candidato): o contato escolhido sairia da
   * dúvida para OUTRO papel, que sabe quem é protegido.
   */
  private async exigirIdentificacaoSemAtalho(
    tx: Db,
    auth: AuthContext,
    conversationId: string,
    contactId: string,
    classificados: readonly { id: string }[],
  ): Promise<void> {
    if (!(await this.protegido.duvidaOculta(auth))) return;
    // no `uniforme`, quem identifica não sabe quem é protegido: a RAI com mídia
    // não é identificada por ele, qualquer que seja o candidato (igual para
    // todos); sem isso, a identificação abriria a mídia para OUTRO papel
    const semClassificacao = await this.protegido.semClassificacao(auth);
    if (!semClassificacao) {
      const ocultos = await this.protegido.contatosOcultos(
        auth,
        [contactId, ...classificados.map((c) => c.id)],
        tx,
      );
      if (ocultos.has(contactId) || !classificados.some((c) => ocultos.has(c.id))) return;
    }
    const comMidia =
      (await tx.messageAttachment.count({
        where: { message: { conversationId } },
      } as never)) +
      (await tx.inboundMedia.count({ where: { message: { conversationId } } } as never));
    if (comMidia > 0) throw new ForbiddenException(CONTEUDO_RESTRITO);
  }

  /**
   * A MÍDIA HISTÓRICA de uma conversa protegida (ADR-061, adendo 6): a
   * proteção é derivada do contato ATUAL da conversa, e nada guarda de quem ela
   * era quando a mídia chegou. Levar à RAI a conversa de um contato protegido
   * que tem mídia — anexada ou ainda pendente de download — e depois
   * identificá-la como outro reabriria essa mídia. Por isso, em workspace
   * sujeito, desfazer e rejeitar são recusados a TODOS os papéis nessa
   * conversa, antes de qualquer mudança: o remetente, o número e o arquivo
   * ficam como estão. Quem não pode saber quem é protegido já recebeu, antes,
   * a recusa uniforme. O procedimento seguro para corrigir uma atribuição
   * errada é pendência obrigatória antes do piloto.
   */
  private async exigirSemMidiaProtegida(
    db: Db,
    conversationId: string,
    contactId: string,
  ): Promise<void> {
    if (!(await this.protegido.contatoProtegido(contactId, db))) return;
    const midia =
      (await db.messageAttachment.count({
        where: { message: { conversationId } },
      } as never)) +
      (await db.inboundMedia.count({ where: { message: { conversationId } } } as never));
    if (midia > 0) throw new ConflictException(MENSAGEM_MIDIA_PROTEGIDA);
  }

  private async levarARai(
    auth: AuthContext,
    antes: ConversaDoRemetente,
    acao: 'conversation.sender_unidentified' | 'conversation.sender_rejected',
    tirarNumero: boolean,
  ): Promise<void> {
    const workspaceId = auth.workspaceId as string;
    const regiao = await this.contacts.regiaoDoWorkspace(workspaceId);
    /**
     * Tirar o número é escritor de telefone (ADR-052 item 3): o endereço de cada
     * telefone que sai entra nas travas, ANTES de qualquer linha. Quase sempre é
     * a chave do próprio número; o telefone com ramal tem outra. Os telefones
     * lidos aqui são conferidos de novo sob as travas.
     */
    /**
     * Levar a RAI a conversa de um contato oculto para quem pede, e depois
     * identificá-la como outro, abriria a mídia dele (E8; ADR-061, adendo 5):
     * desfazer e rejeitar exigem que o contato atual não seja oculto. No
     * `uniforme`, a recusa vale para toda pessoa — igual para todos.
     */
    await this.protegido.exigirAlvoVisivel(auth, { contactId: antes.contactId });
    await this.exigirSemMidiaProtegida(this.prisma.db, antes.id, antes.contactId as string);
    const saida = tirarNumero
      ? await this.contacts.saidaDoNumero(antes.contactId as string, this.enderecoDe(antes), regiao)
      : null;
    await this.restricao.naTransacaoInterativa(
      this.prisma.db as unknown as TxRunner,
      async (tx) => {
        const conversa = await this.travarERelear(tx, workspaceId, antes, [], saida?.chaves ?? []);
        if (conversa.senderStatus !== 'identified' || conversa.contactId !== antes.contactId) {
          throw new ConflictException(MENSAGEM_MUDOU);
        }
        // de novo, sob as travas do contato: a conversão concorrente é vista
        await this.protegido.exigirAlvoVisivel(auth, { contactId: conversa.contactId }, tx);
        await this.exigirSemMidiaProtegida(tx, conversa.id, conversa.contactId as string);
        const anterior = conversa.contactId as string;
        const endereco = this.enderecoDe(conversa);
        const candidatos = (await this.classificar(tx, endereco)).length;
        const numeroTirado = saida
          ? await this.contacts.tirarNumeroNaTransacao(
              tx,
              auth,
              anterior,
              endereco,
              regiao,
              saida.lidos,
            )
          : false;
        /**
         * Quem não tem `contacts:write` não vê a RAI (C13): o responsável assim
         * perderia a conversa que lhe foi atribuída sem saber por quê. A
         * atribuição sai junto, com a trilha.
         */
        const semResponsavel =
          conversa.assigneeMembershipId !== null &&
          !(await this.permissions.membershipHas(conversa.assigneeMembershipId, 'contacts:write'));
        // o único "uma RAI aberta por (canal, número)": se já existe uma, esta
        // vai a RAI ENCERRADA — continua na área RAI e pode ser identificada
        const raiAberta = await tx.conversation.findFirst({
          where: {
            channelId: conversa.channelId,
            externalAddress: endereco,
            senderStatus: 'unidentified',
            status: { not: 'closed' },
            id: { not: conversa.id },
          },
          select: { id: true },
        });
        await tx.conversation.updateMany({
          where: { id: conversa.id },
          data: {
            contactId: null,
            senderStatus: 'unidentified',
            senderIdentifiedAt: null,
            ...(raiAberta ? { status: 'closed' } : {}),
            ...(semResponsavel ? { assigneeMembershipId: null } : {}),
          },
        });
        await this.limpeza.expirarNaTransacao(tx, workspaceId, conversa.id);
        await this.audit.record(tx, workspaceId, acao, {
          entityType: 'conversationSender',
          entityId: conversa.id,
          actor: this.audit.actorFrom(auth),
          before: { senderStatus: 'identified', contactId: anterior },
          after: {
            senderStatus: 'unidentified',
            contactId: null,
            candidates: candidatos,
            numberRemoved: numeroTirado,
            closed: raiAberta !== null,
            unassigned: semResponsavel,
          },
        });
      },
    );
  }

  /**
   * A conversa, com a regra do C13: a RAI não existe para quem não pode vê-la
   * (404, não 403). Os atos exigem também a conversa de canal externo, com
   * número.
   */
  private async lerVisivel(
    auth: AuthContext,
    conversationId: string,
  ): Promise<ConversaDoRemetente> {
    const conversa = (await this.prisma.db.conversation.findFirst({
      where: { id: conversationId },
      select: SELECAO,
    })) as unknown as ConversaDoRemetente | null;
    if (!conversa) throw new NotFoundException('Conversa não encontrada');
    if (conversa.senderStatus === 'unidentified' && !(await this.podeVerRai(auth))) {
      throw new NotFoundException('Conversa não encontrada');
    }
    if (!conversa.externalAddress) {
      throw new BadRequestException('Esta conversa não tem número de canal externo');
    }
    return conversa;
  }

  /**
   * As travas da religação, ANTES de qualquer linha, e a conversa relida sob
   * elas. Depois, a condição do legado: com atribuição gravada em mensagem ou
   * atividade, a religação é bloqueada, e nada muda.
   */
  private async travarERelear(
    tx: Db,
    workspaceId: string,
    antes: ConversaDoRemetente,
    outrosContatos: readonly (string | null)[],
    chavesQueSaem: readonly string[],
  ): Promise<ConversaDoRemetente> {
    await this.travas.paraIdentificacao(tx, {
      workspaceId,
      chaveDeCoincidencia: chaveDeCoincidencia(antes.externalAddress as string),
      contactIds: [antes.contactId, ...outrosContatos],
      conversationId: antes.id,
      outrasChaves: chavesQueSaem,
    });
    const lida = (await tx.conversation.findFirst({
      where: { id: antes.id },
      select: SELECAO,
    })) as unknown as ConversaDoRemetente | null;
    if (!lida) throw new NotFoundException('Conversa não encontrada');
    /**
     * A LINHA presa (nível 4), com uma escrita sem efeito: a atribuição
     * concorrente, que não pega trava consultiva, ou termina antes — e o
     * responsável dela é lido abaixo — ou espera e cai na condição dela
     * (revisão da F4.1a). Um status mudado no meio é 409.
     */
    const presa = await tx.conversation.updateMany({
      where: { id: lida.id, status: lida.status },
      data: { status: lida.status },
    });
    if (presa.count === 0) throw new ConflictException(MENSAGEM_MUDOU);
    const conversa = (await tx.conversation.findFirst({
      where: { id: antes.id },
      select: SELECAO,
    })) as unknown as ConversaDoRemetente;
    if (conversa.externalAddress !== antes.externalAddress) {
      throw new ConflictException(MENSAGEM_MUDOU);
    }
    const [mensagens, atividades] = await Promise.all([
      tx.message.count({ where: { conversationId: conversa.id, authorContactId: { not: null } } }),
      tx.activity.count({ where: { conversationId: conversa.id, contactId: { not: null } } }),
    ]);
    if (mensagens > 0 || atividades > 0) throw new ConflictException(MENSAGEM_DO_LEGADO);
    return conversa;
  }

  private enderecoDe(conversa: ConversaDoRemetente): string {
    return conversa.externalAddress as string;
  }

  /** Os contatos cujo número coincide com o da conversa, exatos ou possíveis. */
  private async classificar(
    db: Db,
    endereco: string | null,
  ): Promise<{ id: string; name: string; coincidencia: 'exata' | 'possivel' }[]> {
    const chave = endereco ? chaveDeCoincidencia(endereco) : null;
    if (!endereco || !chave) return [];
    const contatos = (await db.contact.findMany({
      where: { phoneMatchKeys: { has: chave } },
      select: { id: true, name: true, phones: true, phonesNormalized: true },
      orderBy: { name: 'asc' },
    })) as unknown as { id: string; name: string; phones: string[]; phonesNormalized: string[] }[];
    return contatos.flatMap((c) => {
      const tipo = coincidencia(endereco, c);
      return tipo === 'nenhuma' ? [] : [{ id: c.id, name: c.name, coincidencia: tipo }];
    });
  }

  private async encerrarAnteriorAberta(
    tx: Db,
    auth: AuthContext,
    conversa: ConversaDoRemetente,
    contactId: string,
    endereco: string,
  ): Promise<void> {
    const anterior = (await tx.conversation.findFirst({
      where: {
        channelId: conversa.channelId,
        contactId,
        externalAddress: endereco,
        status: { not: 'closed' },
        id: { not: conversa.id },
      },
      select: { id: true, status: true },
    })) as unknown as { id: string; status: string } | null;
    if (!anterior) return;
    await tx.conversation.updateMany({ where: { id: anterior.id }, data: { status: 'closed' } });
    await this.audit.record(
      tx,
      auth.workspaceId as string,
      'conversation.closed_by_identification',
      {
        entityType: 'conversationSender',
        entityId: anterior.id,
        actor: this.audit.actorFrom(auth),
        before: { status: anterior.status },
        after: { status: 'closed', replacedBy: conversa.id },
      },
    );
  }
}
