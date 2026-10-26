import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContactsService } from '../contacts/contacts.service';
import {
  chaveDeCoincidencia,
  coincidencia,
  decidirRemetente,
  type DecisaoDoRemetente,
} from '../contacts/phone-identity';
import { MENSAGEM_LOTE_SEM_PRAZO, TravasDeIdentidade } from '../content-use/identity-locks';
import { UsageService } from '../usage/usage.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { verifyMetaSignature } from './whatsapp.signature';
import {
  contactItemSchema,
  messageSchema,
  STATUS_MAP,
  statusSchema,
  SUPPORTED_MESSAGE_TYPES,
  whatsappWebhookSchema,
  type WhatsappMessageItem,
  type WhatsappStatusItem,
} from './whatsapp.types';

/**
 * Ingestão do WhatsApp (ADR-037/038).
 *
 * `prisma.raw` é a regra AQUI, com `workspaceId` explícito em cada operação: não
 * existe sessão nem CLS neste caminho — o workspace é DERIVADO do
 * `phone_number_id` já verificado pela assinatura. É o mesmo padrão justificado
 * do worker (SECURITY.md §2).
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly contacts: ContactsService,
    private readonly usage: UsageService,
    private readonly travas: TravasDeIdentidade,
  ) {}

  /** Assinatura sobre o CORPO BRUTO, antes de qualquer parse de domínio. */
  verifySignature(rawBody: Buffer | undefined, header: string | undefined): boolean {
    const secret = this.config.get<string>('META_APP_SECRET');
    if (!secret || !rawBody) return false;
    return verifyMetaSignature(rawBody, header, secret);
  }

  /**
   * Processa o payload JÁ verificado. Devolve o que foi feito, para observação —
   * nunca lança por conteúdo desconhecido: a Meta reentrega o que não recebe
   * 2xx, e erro em evento que não sabemos tratar viraria reentrega infinita.
   *
   * Falha TRANSITÓRIA não é conteúdo desconhecido (ADR-052, C11): erro de banco,
   * prazo ou trava não obtida PROPAGA, o webhook responde erro e a Meta
   * reentrega — no fim do lote, depois dos itens dos outros workspaces
   * (F4.1c-1). Cada mensagem é a sua transação, então o que já entrou fica, e a
   * reentrega é deduplicada (mensagens pelo `externalId`, recibos pelo único).
   */
  async ingest(payload: unknown): Promise<{ messages: number; statuses: number; ignored: number }> {
    const parsed = whatsappWebhookSchema.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn('Payload do WhatsApp fora da forma esperada — ignorado');
      return { messages: 0, statuses: 0, ignored: 1 };
    }

    let messages = 0;
    let statuses = 0;
    let ignored = 0;
    /**
     * O TETO do payload inteiro (ADR-052 item 3), abaixo do prazo do webhook da
     * Meta. Estourado, o próximo item não começa: o webhook responde erro, e a
     * reentrega do lote é deduplicada — o que já entrou fica.
     */
    const fimDoLote = this.travas.fimDoLote();
    const dentroDoPrazo = () => {
      if (Date.now() >= fimDoLote) throw new ServiceUnavailableException(MENSAGEM_LOTE_SEM_PRAZO);
    };
    /**
     * A falha de um item — a trava que não veio no prazo durante a importação
     * ou a normalização de um workspace, por exemplo — não segura os OUTROS
     * workspaces do mesmo POST (F4.1c-1). Os itens seguintes do workspace que
     * falhou ficam para a reentrega, na ordem; os outros seguem; e o webhook
     * responde o erro no fim. A reentrega é deduplicada.
     */
    const adiados = new Set<string>();
    let primeiraFalha: unknown = null;
    const noWorkspace = async (workspaceId: string, item: () => Promise<boolean>) => {
      if (adiados.has(workspaceId)) return null;
      dentroDoPrazo();
      try {
        return await item();
      } catch (erro) {
        adiados.add(workspaceId);
        primeiraFalha ??= erro;
        // só o tipo e o código: a mensagem de um erro do Prisma traria valores,
        // e entre eles o número
        const { name, code } = (erro ?? {}) as { name?: string; code?: string };
        this.logger.warn(
          `Ingestão do workspace ${workspaceId} adiada para a reentrega (${name ?? 'Error'} ${code ?? 'sem código'})`,
        );
        return null;
      }
    };

    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        const value = change.value;
        // ROTEAMENTO pelo número (ADR-037): é isto que localiza o canal e, por
        // consequência, o workspace. Nunca um campo escolhido pelo cliente.
        const credential = await this.prisma.raw.channelCredential.findUnique({
          where: { phoneNumberId: value.metadata.phone_number_id },
        });
        if (!credential) {
          this.logger.warn('Evento para número não configurado — ignorado');
          ignored += 1;
          continue;
        }

        // item a item: o que não passa é contado, SEM conteúdo no registro
        // (nem o número, nem o BSUID, nem o corpo), e os outros seguem
        const contatos = (value.contacts ?? []).flatMap((item) => {
          const contato = contactItemSchema.safeParse(item);
          if (contato.success) return [contato.data];
          this.logger.warn('Contato do payload fora da forma esperada — ignorado');
          ignored += 1;
          return [];
        });
        for (const item of value.messages ?? []) {
          const message = messageSchema.safeParse(item);
          if (!message.success) {
            this.logger.warn('Mensagem do payload fora da forma esperada — ignorada');
            ignored += 1;
            continue;
          }
          const nome = contatos.find((c) => c.wa_id === message.data.from)?.profile?.name;
          const feito = await noWorkspace(credential.workspaceId, () =>
            this.ingestMessage(credential, message.data, fimDoLote, nome),
          );
          if (feito) messages += 1;
          else if (feito === false) ignored += 1;
        }
        for (const item of value.statuses ?? []) {
          const status = statusSchema.safeParse(item);
          if (!status.success) {
            this.logger.warn('Recibo do payload fora da forma esperada — ignorado');
            ignored += 1;
            continue;
          }
          const feito = await noWorkspace(credential.workspaceId, () =>
            this.ingestStatus(credential, status.data),
          );
          if (feito) statuses += 1;
          else if (feito === false) ignored += 1;
        }
      }
    }
    if (primeiraFalha) throw primeiraFalha;
    return { messages, statuses, ignored };
  }

  private async ingestMessage(
    credential: { workspaceId: string; channelId: string },
    message: WhatsappMessageItem,
    fimDoLote: number,
    profileName?: string,
  ): Promise<boolean> {
    if (!SUPPORTED_MESSAGE_TYPES.has(message.type)) {
      this.logger.warn(`Tipo de mensagem não suportado (${message.type}) — ignorado`);
      return false;
    }
    const { workspaceId, channelId } = credential;
    const occurredAt = this.clampToNow(new Date(Number(message.timestamp) * 1000));
    const media = this.extractMedia(message);
    const body = message.text?.body?.trim() || (media ? `[${message.type}]` : '');
    if (!body) return false;
    const phone = `+${message.from.replace(/\D/g, '')}`;
    const chave = chaveDeCoincidencia(phone);
    // a linha do contador precisa existir antes da transação: criá-la lá dentro
    // exporia a corrida da primeira escrita a um P2002, que aborta a transação
    // inteira no Postgres
    await this.usage.ensureCounterRow(workspaceId, 'contacts');
    const regiao = await this.contacts.regiaoDoWorkspace(workspaceId);

    /**
     * TUDO numa transação, sob as travas da identidade (ADR-052 item 3): o nível
     * 0 por (workspace, chave de coincidência), SEM o canal, e o endereço
     * compartilhado. Com prazo curto: sem a trava, o erro propaga e a Meta
     * reentrega.
     *
     * Sem o nível 0, duas entregas simultâneas do mesmo evento — que a Meta faz
     * — criavam dois contatos e uma delas estourava no unique da mensagem;
     * agora também duas mensagens do mesmo número por dois canais. O endereço
     * compartilhado faz quem escreve telefone (exclusivo) esperar a ingestão, e
     * a decisão "sem candidato, cria o contato" fica estável sob a trava.
     */
    await this.prisma.raw.$transaction(async (tx) => {
      await this.travas.paraIngestao(tx, workspaceId, chave, fimDoLote);

      // DEDUPE dentro do lock: agora "não existe" é uma afirmação estável
      const existente = await tx.message.findFirst({
        where: { workspaceId, channelId, externalId: message.id },
        select: { id: true },
      });
      if (existente) return;

      const decisao = await this.decidirRemetente(tx, workspaceId, phone, chave);
      const contactId =
        decisao.tipo === 'contato'
          ? decisao.contactId
          : decisao.tipo === 'novo'
            ? // o contato de id FRESCO, sob as travas desta transação
              await this.contacts.createFromExternalChannel(tx as unknown as Db, workspaceId, {
                name: profileName?.trim() || phone,
                phone,
                source: 'whatsapp',
                regiao,
              })
            : null;
      const conversation = contactId
        ? await this.resolveConversation(tx, workspaceId, channelId, contactId, occurredAt, phone)
        : await this.resolveUnidentified(tx, workspaceId, channelId, occurredAt, phone);

      const created = await tx.message.create({
        data: {
          workspaceId,
          conversationId: conversation.id,
          channelId,
          direction: 'inbound',
          // a AUTORIA não muda (é do contato que escreveu); a ATRIBUIÇÃO ao
          // contato deixa de ser gravada e passa a vir da conversa (C12)
          authorType: 'contact',
          body,
          externalId: message.id,
          deliveredAt: occurredAt,
        },
      });

      /**
       * NUNCA REGREDIR, de forma ATÔMICA. Calcular o máximo em JavaScript
       * depois de ler a conversa era corrida: o lock consultivo serializa por
       * telefone, mas uma mensagem HUMANA de saída toca a mesma conversa por
       * outro caminho, sem passar por ele. Se ela commitasse entre a leitura e
       * a escrita, a ingestão sobrescreveria o horário novo por um timestamp
       * antigo do provedor.
       *
       * `GREATEST` e `CASE` deixam a decisão no banco, sob o lock da própria
       * linha. SQL cru é obrigatório aqui (o Prisma não expressa GREATEST) e
       * está no client `raw` deste caminho, com workspaceId explícito.
       */
      await tx.$executeRawUnsafe(
        `UPDATE "Conversation"
            SET "externalAddress" = COALESCE("externalAddress", $4),
                "lastMessageAt" = GREATEST("lastMessageAt", $3::timestamptz),
                "lastInboundAt" = CASE
                  WHEN "lastInboundAt" IS NULL OR "lastInboundAt" < $3::timestamptz
                    THEN $3::timestamptz
                  ELSE "lastInboundAt"
                END,
                "status" = CASE WHEN "status" = 'closed' THEN 'open'::"ConversationStatus" ELSE "status" END
          WHERE "workspaceId" = $1::uuid AND "id" = $2::uuid`,
        workspaceId,
        conversation.id,
        occurredAt.toISOString(),
        phone,
      );
      // sem `contactId`: a timeline do contato vem da conversa (C12)
      await tx.activity.create({
        data: {
          workspaceId,
          type: 'message_received',
          actorType: 'system',
          payload: {},
          occurredAt,
          conversationId: conversation.id,
        },
      });

      if (media) {
        // REFERÊNCIA em tabela, não evento interno sem consumidor: o dispatcher
        // marcaria o evento como entregue e a mídia desapareceria. A coleta
        // autenticada acontece na 9.1.b.
        await tx.inboundMedia.create({
          data: {
            workspaceId,
            messageId: created.id,
            providerMediaId: media.mediaId,
            mimeType: media.mimeType,
            fileName: media.fileName ?? null,
          },
        });
      }
    });
    return true;
  }

  /**
   * O instante do provedor, limitado ao presente. Timestamp no FUTURO (relógio
   * adiantado do outro lado) travaria a conversa à frente de tudo: o carimbo
   * `now()` de uma mensagem humana nunca mais apareceria como o mais recente.
   */
  private clampToNow(candidate: Date): Date {
    const agora = new Date();
    return candidate.getTime() > agora.getTime() ? agora : candidate;
  }

  private async ingestStatus(
    credential: { workspaceId: string; channelId: string },
    status: WhatsappStatusItem,
  ): Promise<boolean> {
    const mapped = STATUS_MAP[status.status];
    if (!mapped) {
      this.logger.warn(`Status desconhecido (${status.status}) — ignorado`);
      return false;
    }
    const { workspaceId, channelId } = credential;
    // o recibo referencia o wamid, que vive no DISPATCH (Message é append-only).
    // O `message.channelId` no filtro garante que o recibo é do MESMO canal que
    // a credencial resolveu — sem isso, um número aceitaria recibo de mensagem
    // enviada por outro canal do mesmo workspace.
    const dispatch = await this.prisma.raw.messageDispatch.findFirst({
      where: { workspaceId, externalId: status.id, message: { channelId } },
      select: { messageId: true },
    });
    if (!dispatch) {
      this.logger.warn('Recibo sem dispatch correspondente neste canal — ignorado');
      return false;
    }
    try {
      await this.prisma.raw.messageStatusEvent.create({
        data: {
          workspaceId,
          messageId: dispatch.messageId,
          status: mapped,
          // ORDEM é a do PROVEDOR, não a de chegada (ADR-039)
          occurredAt: new Date(Number(status.timestamp) * 1000),
          errorCode: status.errors?.[0]?.code ? String(status.errors[0].code) : null,
        },
      });
    } catch (error) {
      // reentrega do MESMO recibo: o unique deduplica e o fato continua um só
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
    return true;
  }

  /**
   * Quem escreveu (ADR-052 item 2). Os candidatos vêm pela chave de
   * coincidência (o índice GIN), INCLUSIVE os arquivados, e cada um é
   * classificado. Só um único candidato exato, sem nenhum possível, atribui.
   * Nenhum candidato: o contato é criado PELO DOMÍNIO — com quota, Activity e
   * `contact.created` no outbox, para que um lead chegando por WhatsApp dispare
   * automação como qualquer outro (ADR-040). O resto é "remetente a
   * identificar": nada é escolhido em silêncio, e nada por nome de perfil.
   */
  private async decidirRemetente(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    phone: string,
    chave: string | null,
  ): Promise<DecisaoDoRemetente> {
    if (!chave) return { tipo: 'novo' };
    const candidatos = await tx.contact.findMany({
      where: { workspaceId, phoneMatchKeys: { has: chave } },
      select: { id: true, phones: true, phonesNormalized: true },
    });
    return decidirRemetente(
      candidatos.map((c) => ({ contactId: c.id, coincidencia: coincidencia(phone, c) })),
    );
  }

  /** A conversa RAI aberta de (canal, número), ou uma nova — sempre SEM contato. */
  private async resolveUnidentified(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    channelId: string,
    occurredAt: Date,
    externalAddress: string,
  ): Promise<{ id: string }> {
    const aberta = await tx.conversation.findFirst({
      where: {
        workspaceId,
        channelId,
        externalAddress,
        senderStatus: 'unidentified',
        status: { not: 'closed' },
      },
      select: { id: true },
    });
    if (aberta) return aberta;
    return tx.conversation.create({
      data: {
        workspaceId,
        channelId,
        contactId: null,
        senderStatus: 'unidentified',
        lastMessageAt: occurredAt,
        lastInboundAt: occurredAt,
        externalAddress,
      },
      select: { id: true },
    });
  }

  private async resolveConversation(
    // a transação do client CRU (não há CLS neste caminho): o tipo vem do
    // próprio Prisma, e cada operação leva workspaceId explícito
    tx: Prisma.TransactionClient,
    workspaceId: string,
    channelId: string,
    contactId: string,
    /** instante da mensagem: conversa NOVA nasce com ele, não com `now()` */
    occurredAt: Date,
    /** endereço externo exato (E.164 do wa_id que entrou) */
    externalAddress: string,
  ): Promise<{ id: string; status: string; lastMessageAt: Date; lastInboundAt: Date | null }> {
    /**
     * A conversa é por (canal, contato, NÚMERO) (ADR-052 item 2, D-b): quem
     * escreve de outro número abre outra conversa, e responder vai para o
     * número de onde veio — não para o primeiro, que pode ser de outra pessoa.
     * A conversa anterior à 9.1, sem endereço, é aproveitada e ganha o endereço
     * pelo COALESCE abaixo, como antes.
     */
    const aberta =
      (await tx.conversation.findFirst({
        where: { workspaceId, channelId, contactId, externalAddress, status: { not: 'closed' } },
        select: { id: true, status: true, lastMessageAt: true, lastInboundAt: true },
      })) ??
      (await tx.conversation.findFirst({
        where: {
          workspaceId,
          channelId,
          contactId,
          externalAddress: null,
          status: { not: 'closed' },
        },
        orderBy: { lastMessageAt: 'desc' },
        select: { id: true, status: true, lastMessageAt: true, lastInboundAt: true },
      }));
    if (aberta) return aberta;
    // o default `now()` serve para conversa criada à mão; aqui o instante é o
    // da mensagem, senão a regra de "não regredir" fixaria a conversa no agora
    return tx.conversation.create({
      data: {
        workspaceId,
        channelId,
        contactId,
        lastMessageAt: occurredAt,
        lastInboundAt: occurredAt,
        // ENDEREÇO EXATO de quem falou: o envio responde para este número, e
        // não para um telefone qualquer do contato. Conversas anteriores a esta
        // entrega são preenchidas pelo COALESCE do UPDATE acima.
        externalAddress,
      },
      select: { id: true, status: true, lastMessageAt: true, lastInboundAt: true },
    });
  }

  private extractMedia(message: {
    type: string;
    image?: { id?: string; mime_type?: string };
    document?: { id?: string; mime_type?: string; filename?: string };
    audio?: { id?: string; mime_type?: string };
  }): { mediaId: string; mimeType: string; fileName?: string } | null {
    const fonte = message.image ?? message.document ?? message.audio;
    if (!fonte?.id) return null;
    return {
      mediaId: fonte.id,
      mimeType: fonte.mime_type ?? 'application/octet-stream',
      fileName: (message.document as { filename?: string } | undefined)?.filename,
    };
  }
}
