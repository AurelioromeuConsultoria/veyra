import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  ApproveBusinessOutboundInput,
  ApproveBusinessOutboundItem,
  BusinessOutboundPreviewDto,
  BusinessOutboundReason,
  BusinessOutboundResultDto,
  BusinessOutboundResultItemDto,
  BusinessOutboundTarget,
  PreviewBusinessOutboundInput,
  TemplateOptionDto,
} from '@veyra/contracts';
import { AuditService } from '../audit/audit.service';
import { PRAZO_DA_RELEITURA_MS } from '../channels/business-dispatch.port';
import { WhatsappSendService } from '../channels/whatsapp-send.service';
import type { AuthContext } from '../common/decorators';
import { postgresErrorCode } from '../common/prisma-exception.filter';
import { TravasDeIdentidade } from '../content-use/identity-locks';
import { chaveDeCoincidencia } from '../contacts/phone-identity';
import { MudancasDeRestricao, type ExecutorDeTransacao } from '../content-use/restriction-changes';
import { OutboundPreconditionService, partesDaOrigem } from '../extensions/outbound-precondition';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { TemplateVersionsService } from '../templates/template-versions.service';
import { mesmoHash } from './approval-hash';
import { ConferenciaDoEnvio } from './conferencia';

/**
 * O prazo da aprovação, fixado na prévia pelo relógio do banco (ADR-049): uma
 * hora (recomendação da F4.1c-3). A pessoa aprova e o envio sai em segundos; o
 * prazo só limita a retentativa do outbox. O do vertical vem com a origem, na
 * F4.2.
 */
export const PRAZO_DA_APROVACAO_MS = 60 * 60_000;

function mesmasChaves(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/** A espera estourou (a trava ou a transação): o item não nasce, e tenta-se de novo. */
function ehEspera(erro: unknown): boolean {
  return erro instanceof ConflictException || postgresErrorCode(erro) === '55P03';
}

/**
 * O envio iniciado pelo negócio, do lado da pessoa (ADR-052 itens 6 a 8,
 * F4.1c-3): a PRÉVIA, sem efeito, e a APROVAÇÃO em lote, cada destinatário por
 * si. A aprovação relê o template na Meta antes das travas, pega as travas do
 * destinatário, RECONFERE tudo com leituras novas e recalcula o hash com os
 * dados de agora: o que divergir da prévia é recusado com o motivo, e nada é
 * atualizado em silêncio. O lote não é uma transação com N travas.
 */
@Injectable()
export class EnvioDoNegocioService {
  private readonly logger = new Logger(EnvioDoNegocioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conferencia: ConferenciaDoEnvio,
    private readonly send: WhatsappSendService,
    private readonly versoes: TemplateVersionsService,
    private readonly precondicao: OutboundPreconditionService,
    private readonly restricao: MudancasDeRestricao,
    private readonly travas: TravasDeIdentidade,
    private readonly audit: AuditService,
  ) {}

  /**
   * As opções do compositor do Inbox com a janela fechada (item 6 do plano da
   * F4.1c): as versões ATIVAS do canal da conversa com revisão — do mesmo hash
   * — para uma finalidade com consentimento vigente do número exato da
   * conversa. É só o cardápio: a prévia confere tudo de novo. A conversa RAI,
   * sem contato ou sem número não tem opção nenhuma. O alvo vai pronto.
   */
  async opcoes(conversationId: string): Promise<TemplateOptionDto[]> {
    const conversa = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId },
      select: {
        id: true,
        channelId: true,
        contactId: true,
        externalAddress: true,
        senderStatus: true,
      },
    });
    // a conversa RAI não existe para esta rota, como nas de conversa sem `contacts:write` (C13)
    if (!conversa || conversa.senderStatus !== 'identified') {
      throw new NotFoundException('Conversa não encontrada');
    }
    const { contactId, externalAddress } = conversa;
    if (!contactId || !externalAddress) return [];
    const consentidas = await this.prisma.db.consent.findMany({
      where: { contactId, channelId: conversa.channelId, number: externalAddress, revokedAt: null },
      select: { purposeId: true },
    });
    if (consentidas.length === 0) return [];
    const finalidades = new Map(
      (
        await this.prisma.db.consentPurpose.findMany({
          where: { id: { in: consentidas.map((c) => c.purposeId) } },
          select: { id: true, key: true, version: true, description: true },
        })
      ).map((f) => [f.id, f]),
    );
    const versoes = new Map(
      (
        await this.prisma.db.messageTemplateVersion.findMany({
          where: { channelId: conversa.channelId, status: 'active' },
          select: {
            id: true,
            name: true,
            language: true,
            version: true,
            category: true,
            contentHash: true,
          },
        })
      ).map((v) => [v.id, v]),
    );
    if (versoes.size === 0) return [];
    const revisoes = await this.prisma.db.templateReview.findMany({
      where: {
        templateVersionId: { in: [...versoes.keys()] },
        purposeId: { in: [...finalidades.keys()] },
      },
      select: { templateVersionId: true, purposeId: true, contentHash: true },
    });
    const opcoes: TemplateOptionDto[] = [];
    for (const r of revisoes) {
      const v = versoes.get(r.templateVersionId);
      const f = finalidades.get(r.purposeId);
      // a revisão vale só para o hash que a pessoa viu
      if (!v || !f || r.contentHash !== v.contentHash) continue;
      opcoes.push({
        target: {
          originRef: `conversation:${conversa.id}`,
          channelId: conversa.channelId,
          contactId,
          number: externalAddress,
          templateVersionId: v.id,
          purposeId: f.id,
        },
        templateVersionId: v.id,
        name: v.name,
        language: v.language,
        version: v.version,
        category: v.category as TemplateOptionDto['category'],
        purposeId: f.id,
        purposeKey: f.key,
        purposeVersion: f.version,
        purposeDescription: f.description,
      });
    }
    return opcoes.sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.language.localeCompare(b.language) ||
        b.version - a.version ||
        a.purposeKey.localeCompare(b.purposeKey),
    );
  }

  async previa(
    workspaceId: string,
    input: PreviewBusinessOutboundInput,
  ): Promise<BusinessOutboundPreviewDto> {
    const agora = await this.conferencia.agora();
    const expiresAt = new Date(agora.getTime() + PRAZO_DA_APROVACAO_MS);
    const items: BusinessOutboundPreviewDto['items'] = [];
    for (const [index, alvo] of input.items.entries()) {
      const c = await this.conferencia.conferir(this.prisma.db, workspaceId, alvo);
      items.push(
        c.ok
          ? {
              index,
              ok: true,
              text: c.conferido.texto,
              values: { ...c.conferido.forma.values },
              expiresAt: expiresAt.toISOString(),
              approvalHash: this.conferencia.hash(c.conferido.forma, expiresAt),
            }
          : { index, ok: false, reason: c.motivo },
      );
    }
    return { items };
  }

  async aprovar(
    auth: AuthContext,
    input: ApproveBusinessOutboundInput,
  ): Promise<BusinessOutboundResultDto> {
    const items: BusinessOutboundResultItemDto[] = [];
    for (const [index, item] of input.items.entries()) {
      try {
        items.push(await this.aprovarItem(auth, index, item));
      } catch (erro) {
        /**
         * Uma falha inesperada NAQUELE item. O lote não vira 500 depois de os
         * itens anteriores terem comitado — o 500 liberaria a chave de
         * idempotência, e a repetição refaria o lote. Só o tipo e o código no
         * log. A conexão pode ter caído no COMMIT, com a aprovação gravada:
         * antes de dizer "nada foi gravado", o hash é procurado.
         */
        const { name, code } = (erro ?? {}) as { name?: string; code?: string };
        this.logger.error(
          `Item ${index} do envio do negócio não processado (${name ?? 'Error'} ${code ?? 'sem código'})`,
        );
        const gravada = await this.aprovacaoDaPrevia(item).catch(() => null);
        items.push(
          gravada && gravada !== 'outro_alvo'
            ? { index, state: 'approved', messageId: gravada.messageId, reason: null }
            : { index, state: 'refused', messageId: null, reason: 'not_processed' },
        );
      }
    }
    return { items };
  }

  private async aprovarItem(
    auth: AuthContext,
    index: number,
    item: ApproveBusinessOutboundItem,
  ): Promise<BusinessOutboundResultItemDto> {
    const recusado = (reason: BusinessOutboundReason): BusinessOutboundResultItemDto => ({
      index,
      state: 'refused',
      messageId: null,
      reason,
    });
    const workspaceId = auth.workspaceId as string;
    const membershipId = auth.membershipId as string;
    const { expiresAt: prazo, approvalHash: hashRecebido, ...alvo } = item;
    const expiresAt = new Date(prazo);
    const aprovado = (messageId: string): BusinessOutboundResultItemDto => ({
      index,
      state: 'approved',
      messageId,
      reason: null,
    });

    /**
     * UMA aprovação por prévia: o hash cobre o prazo com milissegundos, e o
     * banco o tem como único. A mesma prévia aprovada de novo — repetida no
     * lote, numa repetição do lote depois de uma falha, com outra chave —
     * devolve a mensagem que já existe, e nada nasce de novo. O hash de uma
     * aprovação mandado com OUTRO alvo é recusado: a resposta afirmaria que
     * este item saiu, quando saiu o outro.
     */
    const existente = await this.aprovacaoDaPrevia(item);
    if (existente === 'outro_alvo') return recusado('approval_stale');
    if (existente) return aprovado(existente.messageId);
    // sem a chave do número não há travas a pegar: recusa antes delas
    if (!chaveDeCoincidencia(alvo.number)) return recusado('address_changed');

    // 1. a releitura na Meta, ANTES das travas, sem cache e com prazo absoluto (item 4)
    let releitura: Awaited<ReturnType<TemplateVersionsService['reler']>>;
    try {
      releitura = await this.versoes.reler(
        alvo.templateVersionId,
        AbortSignal.timeout(PRAZO_DA_RELEITURA_MS),
      );
    } catch (erro) {
      // a versão de outro workspace não existe: a mesma recusa da que sumiu
      if (erro instanceof NotFoundException) return recusado('template_unavailable');
      throw erro;
    }
    if (releitura === 'divergente') return recusado('template_changed');
    if (releitura === 'indisponivel') return recusado('template_unavailable');
    if (releitura === 'falha') return recusado('template_unverified');

    // as chaves de validade do E7, para travá-las ANTES de reconferir; a
    // reconferência, já sob elas, precisa achar as mesmas
    const consultaAntesDasTravas = await this.precondicao.consultar(workspaceId, alvo.originRef);
    const chaves = consultaAntesDasTravas.tipo === 'vale' ? consultaAntesDasTravas.chaves : [];
    /**
     * O relógio do banco (ADR-049), lido ANTES da transação: dentro dela, a
     * leitura prenderia uma segunda conexão do pool principal por aprovação. O
     * despacho confere o prazo de novo, sob a guarda.
     */
    const agora = await this.conferencia.agora();

    // 2. a quota, fora da transação; devolvida se o item não nascer
    const reserva = await this.send.reservarDoNegocio(workspaceId);
    if (reserva === 'quota_exceeded') return recusado('quota_exceeded');
    let resultado: { messageId: string } | BusinessOutboundReason;
    try {
      const db = this.prisma.db as unknown as ExecutorDeTransacao;
      resultado = await this.restricao.naTransacaoInterativa(db, async (tx) => {
        // a origem do vertical pode ter de criar a conversa: o nível 0 do número
        const criarConversa = consultaAntesDasTravas.tipo !== 'core';
        await this.travas.paraEnvioDoNegocio(tx, {
          workspaceId,
          contactId: alvo.contactId,
          numero: alvo.number,
          validityKeys: chaves,
          criarConversa,
        });
        // 3. a reconferência, com leituras novas, sob as travas
        const c = await this.conferencia.conferir(tx, workspaceId, alvo);
        if (!c.ok) return c.motivo;
        const { forma } = c.conferido;
        if (!mesmasChaves(forma.validityKeys, chaves)) return 'approval_stale';
        // o prazo pelo relógio do banco: vencido, ou além do máximo
        if (expiresAt.getTime() <= agora.getTime()) return 'approval_expired';
        if (expiresAt.getTime() > agora.getTime() + PRAZO_DA_APROVACAO_MS) return 'approval_stale';
        // o hash com os dados de AGORA: o que mudou desde a prévia não sai
        if (!mesmoHash(this.conferencia.hash(forma, expiresAt), hashRecebido)) {
          return 'approval_stale';
        }

        const conversationId = await this.conversaDoAlvo(tx, workspaceId, alvo, criarConversa);
        const { messageId } = await this.send.escreverDoNegocioNaTransacao(tx, workspaceId, {
          conversationId,
          channelId: alvo.channelId,
          reservationId: reserva,
          body: c.conferido.texto,
          aprovacao: {
            contactId: forma.contactId,
            number: forma.number,
            phoneNumberId: forma.phoneNumberId,
            templateVersionId: forma.templateVersionId,
            templateReviewId: forma.templateReviewId,
            purposeId: forma.purposeId,
            consentId: forma.consentId,
            originRef: forma.originRef,
            validityKeys: forma.validityKeys,
            expiresAt,
            approvalHash: hashRecebido,
            approvedByMembershipId: membershipId,
          },
        });
        // a trilha: os ids, a origem e o prazo — nunca o número nem os valores
        await this.audit.record(tx, workspaceId, 'business_outbound.approved', {
          entityType: 'outboundApproval',
          entityId: messageId,
          actor: this.audit.actorFrom(auth),
          after: {
            contactId: forma.contactId,
            channelId: forma.channelId,
            templateVersionId: forma.templateVersionId,
            templateReviewId: forma.templateReviewId,
            purposeId: forma.purposeId,
            consentId: forma.consentId,
            originRef: forma.originRef,
            expiresAt: expiresAt.toISOString(),
          },
        });
        return { messageId };
      });
    } catch (erro) {
      await this.send.releaseReservationId(reserva).catch(() => undefined);
      if (ehEspera(erro)) return recusado('busy');
      // a corrida com a mesma prévia: o único do hash recusou esta, a outra ficou
      if ((erro as { code?: unknown } | null)?.code === 'P2002') {
        const outra = await this.aprovacaoDaPrevia(item);
        if (outra === 'outro_alvo') return recusado('approval_stale');
        if (outra) return aprovado(outra.messageId);
      }
      throw erro;
    }
    if (typeof resultado === 'string') {
      await this.send.releaseReservationId(reserva).catch(() => undefined);
      return recusado(resultado);
    }
    return aprovado(resultado.messageId);
  }

  /**
   * A aprovação desta prévia, se já existe — pelo hash, que é único no
   * workspace —, e só se for do MESMO alvo e do mesmo prazo do item.
   */
  private async aprovacaoDaPrevia(
    item: ApproveBusinessOutboundItem,
  ): Promise<{ messageId: string } | 'outro_alvo' | null> {
    const linha = await this.prisma.db.outboundApproval.findFirst({
      where: { approvalHash: item.approvalHash },
      select: {
        messageId: true,
        originRef: true,
        channelId: true,
        contactId: true,
        number: true,
        templateVersionId: true,
        purposeId: true,
        expiresAt: true,
      },
    });
    if (!linha) return null;
    const mesmoAlvo =
      linha.originRef === item.originRef &&
      linha.channelId === item.channelId &&
      linha.contactId === item.contactId &&
      linha.number === item.number &&
      linha.templateVersionId === item.templateVersionId &&
      linha.purposeId === item.purposeId &&
      linha.expiresAt.getTime() === new Date(item.expiresAt).getTime();
    return mesmoAlvo ? { messageId: linha.messageId } : 'outro_alvo';
  }

  /**
   * A conversa do envio: no Inbox, a da origem (a conferência provou que é a do
   * alvo); na origem do vertical, a aberta e identificada de (canal, contato,
   * número), ou uma nova — sob o nível 0 do número, serial com a ingestão.
   */
  private async conversaDoAlvo(
    tx: Db,
    workspaceId: string,
    alvo: BusinessOutboundTarget,
    criarConversa: boolean,
  ): Promise<string> {
    if (!criarConversa) return (partesDaOrigem(alvo.originRef) as { id: string }).id;
    const aberta = await tx.conversation.findFirst({
      where: {
        channelId: alvo.channelId,
        contactId: alvo.contactId,
        externalAddress: alvo.number,
        senderStatus: 'identified',
        status: { not: 'closed' },
      },
      select: { id: true },
    });
    if (aberta) return aberta.id;
    const criada = await tx.conversation.create({
      data: {
        channelId: alvo.channelId,
        contactId: alvo.contactId,
        externalAddress: alvo.number,
        // sempre preenchido: o keyset do inbox não tem caso especial de null
        lastMessageAt: new Date(),
      },
      select: { id: true },
    } as never);
    return (criada as unknown as { id: string }).id;
  }
}
