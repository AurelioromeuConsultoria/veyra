import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ApproveBusinessOutboundInput,
  ApproveBusinessOutboundItem,
  BusinessOutboundPreviewDto,
  BusinessOutboundReason,
  BusinessOutboundResultItemDto,
  BusinessOutboundTarget,
  PreviewBusinessOutboundInput,
  TemplateOptionDto,
} from '@veyra/contracts';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../auth/permissions.service';
import { PRAZO_DA_RELEITURA_MS } from '../channels/business-dispatch.port';
import { transporteSimulado } from '../common/transporte-simulado';
import {
  CancelamentoDeDespachos,
  type ResultadoDoCancelamento,
} from '../channels/dispatch-cancellation.service';
import { WhatsappSendService } from '../channels/whatsapp-send.service';
import type { AuthContext } from '../common/decorators';
import { postgresErrorCode } from '../common/prisma-exception.filter';
import { TravasDeIdentidade } from '../content-use/identity-locks';
import { chaveDeCoincidencia } from '../contacts/phone-identity';
import { MudancasDeRestricao, type ExecutorDeTransacao } from '../content-use/restriction-changes';
import {
  OutboundPreconditionService,
  PREFIXO_DO_CORE,
  partesDaOrigem,
} from '../extensions/outbound-precondition';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { TemplateVersionsService } from '../templates/template-versions.service';
import { mesmoHash } from './approval-hash';
import { ConferenciaDoEnvio } from './conferencia';

/**
 * O prazo da aprovação, fixado na prévia pelo relógio do banco (ADR-049), e
 * nunca prorrogado. Os TETOS são explícitos (decisão do usuário, F4.2):
 * - a origem do Core (o Inbox): uma hora, fixa. A pessoa aprova e o envio sai
 *   em segundos; o prazo só limita a retentativa do outbox;
 * - a origem de vertical: o limite que a porta dá (a confirmação, até o início
 *   menos duas horas), no máximo 24 horas.
 */
export const PRAZO_DA_APROVACAO_MS = 60 * 60_000;
export const TETO_DA_ORIGEM_DE_VERTICAL_MS = 24 * 60 * 60_000;

/**
 * O corpo da mensagem do Core na origem de vertical (decisão do usuário,
 * F4.2): genérico, sem os valores, sem citar o vertical e sem afirmar que
 * saiu — quem diz isso é o estado do despacho. O texto renderizado pertence
 * ao armazenamento protegido do vertical.
 */
export const CORPO_NEUTRO = 'Mensagem por template';

/**
 * Por onde a origem entra: a rota genérica do Core aceita só a origem do Core
 * (`conversation:`); a origem de vertical vem pelas rotas do vertical, que
 * chamam este serviço no mesmo processo.
 */
export type RotaDoEnvio = 'core' | 'vertical';

/** O item aprovado, com o texto renderizado só para quem chama no mesmo processo (o vertical). */
export type ItemAprovado = BusinessOutboundResultItemDto & { texto: string | null };

/** Os estados do despacho (o enum `DispatchState` do banco). */
export type EstadoDoDespacho =
  | 'reserved'
  | 'sending'
  | 'sent'
  | 'failed_before_send'
  | 'failed_permanent'
  | 'unknown_after_dispatch'
  | 'canceled';

/**
 * A situação de uma origem APROVADA (F4.2): a mensagem, o número aprovado, o
 * prazo e o despacho. É o que o vertical precisa para derivar o estado do
 * pedido dele, sem ler as tabelas do Core.
 */
export interface SituacaoDaOrigem {
  messageId: string;
  number: string;
  expiresAt: Date;
  estado: EstadoDoDespacho | null;
  errorCode: string | null;
  /** o marcador do despacho: a chamada pode ter começado */
  emVoo: boolean;
  /** o instante do envio (o marcador do despacho), só quando saiu */
  enviadoEm: Date | null;
  /** o marcador do despacho em qualquer estado: o incerto também o tem */
  despachadoEm: Date | null;
}

/** Os recibos do provedor que o Core guarda (`MessageStatusEvent`). */
export type ReciboDoProvedor = 'sent' | 'delivered' | 'read' | 'failed';

/**
 * O desfecho de uma origem ENVIADA, para as métricas do vertical (F4.3): os
 * recibos do provedor e se houve resposta na conversa da mensagem. `respondeu`
 * é `null` quando quem pergunta não pode ler as conversas: a contagem é
 * omitida, nunca zero.
 */
export interface DesfechoDaOrigem {
  enviadoEm: Date;
  recibos: ReciboDoProvedor[];
  respondeu: boolean | null;
}

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
    private readonly permissoes: PermissionsService,
    private readonly cancelamento: CancelamentoDeDespachos,
    private readonly config: ConfigService,
  ) {}

  /**
   * O transporte é o SIMULADO (o falso de staging, ADR-046)? A MESMA função da
   * fábrica do canal: a tela o mostra, e na demonstração nada sai (F4.4).
   */
  envioSimulado(): boolean {
    return transporteSimulado(this.config);
  }

  /**
   * A origem pode entrar por esta rota, com o acesso de quem pede? A do Core,
   * só pela rota do Core. A de vertical, só pela do vertical e com TODAS as
   * permissões que a porta registrada declara, conferidas pela membership
   * autenticada ANTES de consultar a origem ou devolver conteúdo. A origem sem
   * porta, ou sem o acesso, é recusada como inexistente.
   */
  async origemPermitida(auth: AuthContext, originRef: string, rota: RotaDoEnvio): Promise<boolean> {
    const exigidas = this.precondicao.permissoesDaOrigem(originRef);
    if (exigidas === null) return false;
    if (exigidas.length === 0) return rota === 'core';
    if (rota !== 'vertical' || !auth.membershipId) return false;
    for (const chave of exigidas) {
      if (!(await this.permissoes.membershipHas(auth.membershipId, chave as never))) return false;
    }
    return true;
  }

  /** O vencimento efetivo: o menor entre o limite da origem e o teto do Core. */
  private teto(agora: Date, limiteDaOrigem: Date | null): Date {
    if (!limiteDaOrigem) return new Date(agora.getTime() + PRAZO_DA_APROVACAO_MS);
    return new Date(
      Math.min(limiteDaOrigem.getTime(), agora.getTime() + TETO_DA_ORIGEM_DE_VERTICAL_MS),
    );
  }

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
    // as finalidades de um vertical não são opção do Inbox: só a origem dele as usa
    const doVertical = this.precondicao.finalidadesDasPortas();
    const finalidades = new Map(
      (
        await this.prisma.db.consentPurpose.findMany({
          where: {
            id: { in: consentidas.map((c) => c.purposeId) },
            key: { notIn: [...doVertical] },
          },
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
    auth: AuthContext,
    input: PreviewBusinessOutboundInput,
    rota: RotaDoEnvio,
  ): Promise<BusinessOutboundPreviewDto> {
    const workspaceId = auth.workspaceId as string;
    const agora = await this.conferencia.agora();
    const items: BusinessOutboundPreviewDto['items'] = [];
    for (const [index, alvo] of input.items.entries()) {
      if (!(await this.origemPermitida(auth, alvo.originRef, rota))) {
        items.push({ index, ok: false, reason: 'precondition_unknown' });
        continue;
      }
      const c = await this.conferencia.conferir(this.prisma.db, workspaceId, alvo);
      if (!c.ok) {
        items.push({ index, ok: false, reason: c.motivo });
        continue;
      }
      const expiresAt = this.teto(agora, c.conferido.limiteDaOrigem);
      // o limite da origem já passou: o pedido não é mais elegível
      if (expiresAt.getTime() <= agora.getTime()) {
        items.push({ index, ok: false, reason: 'precondition_failed' });
        continue;
      }
      items.push({
        index,
        ok: true,
        text: c.conferido.texto,
        values: { ...c.conferido.forma.values },
        expiresAt: expiresAt.toISOString(),
        approvalHash: this.conferencia.hash(c.conferido.forma, expiresAt),
      });
    }
    return { items };
  }

  async aprovar(
    auth: AuthContext,
    input: ApproveBusinessOutboundInput,
    rota: RotaDoEnvio,
  ): Promise<{ items: ItemAprovado[] }> {
    const items: ItemAprovado[] = [];
    for (const [index, item] of input.items.entries()) {
      try {
        items.push(await this.aprovarItem(auth, index, item, rota));
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
        // a permissão de novo: a falha pode ter sido a própria conferência dela,
        // e o `approved` de uma aprovação existente não sai a quem não a tem
        const permitida = await this.origemPermitida(auth, item.originRef, rota).catch(() => false);
        const gravada = permitida ? await this.aprovacaoDaPrevia(item).catch(() => null) : null;
        items.push(
          gravada && gravada !== 'outro_alvo'
            ? { index, state: 'approved', messageId: gravada.messageId, reason: null, texto: null }
            : { index, state: 'refused', messageId: null, reason: 'not_processed', texto: null },
        );
      }
    }
    return { items };
  }

  private async aprovarItem(
    auth: AuthContext,
    index: number,
    item: ApproveBusinessOutboundItem,
    rota: RotaDoEnvio,
  ): Promise<ItemAprovado> {
    const recusado = (reason: BusinessOutboundReason): ItemAprovado => ({
      index,
      state: 'refused',
      messageId: null,
      reason,
      texto: null,
    });
    const workspaceId = auth.workspaceId as string;
    const membershipId = auth.membershipId as string;
    const { expiresAt: prazo, approvalHash: hashRecebido, ...alvo } = item;
    const expiresAt = new Date(prazo);
    const aprovado = (messageId: string, texto: string | null = null): ItemAprovado => ({
      index,
      state: 'approved',
      messageId,
      reason: null,
      texto,
    });
    // antes de tudo, inclusive da busca pela prévia: a origem e o acesso a ela
    if (!(await this.origemPermitida(auth, alvo.originRef, rota))) {
      return recusado('precondition_unknown');
    }

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
    // UMA aprovação por origem de vertical: outra prévia do mesmo pedido não gera
    // segunda mensagem (o banco tem o único; esta é a resposta clara)
    if (rota === 'vertical' && (await this.origemAprovada(alvo.originRef))) {
      return recusado('origin_already_approved');
    }
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
    const consultaAntesDasTravas = await this.precondicao.consultar(
      this.prisma.db,
      workspaceId,
      alvo.originRef,
    );
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
    const deVertical = consultaAntesDasTravas.tipo !== 'core';
    let resultado: { messageId: string; texto: string } | BusinessOutboundReason;
    try {
      const db = this.prisma.db as unknown as ExecutorDeTransacao;
      resultado = await this.restricao.naTransacaoInterativa(db, async (tx) => {
        // a origem do vertical pode ter de criar a conversa: o nível 0 do número
        const criarConversa = deVertical;
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
        // o prazo pelo relógio do banco: vencido, ou além do teto (o menor
        // entre o limite da origem, relido agora, e o do Core)
        if (expiresAt.getTime() <= agora.getTime()) return 'approval_expired';
        if (expiresAt.getTime() > this.teto(agora, c.conferido.limiteDaOrigem).getTime()) {
          return 'approval_stale';
        }
        // o hash com os dados de AGORA: o que mudou desde a prévia não sai
        if (!mesmoHash(this.conferencia.hash(forma, expiresAt), hashRecebido)) {
          return 'approval_stale';
        }

        const conversationId = await this.conversaDoAlvo(tx, workspaceId, alvo, criarConversa);
        const { messageId } = await this.send.escreverDoNegocioNaTransacao(tx, workspaceId, {
          conversationId,
          channelId: alvo.channelId,
          reservationId: reserva,
          // a origem de vertical não leva o texto à mensagem do Core
          body: deVertical ? CORPO_NEUTRO : c.conferido.texto,
          origemDeVertical: deVertical,
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
        return { messageId, texto: c.conferido.texto };
      });
    } catch (erro) {
      await this.send.releaseReservationId(reserva).catch(() => undefined);
      if (ehEspera(erro)) return recusado('busy');
      // a corrida com a mesma prévia: o único do hash recusou esta, a outra ficou
      if ((erro as { code?: unknown } | null)?.code === 'P2002') {
        const outra = await this.aprovacaoDaPrevia(item);
        if (outra === 'outro_alvo') return recusado('approval_stale');
        if (outra) return aprovado(outra.messageId);
        // a corrida de duas prévias do mesmo pedido: o único da origem decidiu
        if (deVertical && (await this.origemAprovada(alvo.originRef))) {
          return recusado('origin_already_approved');
        }
      }
      throw erro;
    }
    if (typeof resultado === 'string') {
      await this.send.releaseReservationId(reserva).catch(() => undefined);
      return recusado(resultado);
    }
    // o texto vai só a quem chama no mesmo processo, e só na origem de vertical
    return aprovado(resultado.messageId, deVertical ? resultado.texto : null);
  }

  /**
   * O relógio do envio do negócio (ADR-049): o do banco, o mesmo que compara o
   * prazo da aprovação. O vertical o usa para dizer, antes da prévia, que um
   * pedido já não é elegível. Fora de transação.
   */
  agora(): Promise<Date> {
    return this.conferencia.agora();
  }

  /**
   * A situação de cada origem aprovada (F4.2). `db` é o client de quem chama:
   * dentro da transação dele, a leitura vê o que ela trava. A origem sem
   * aprovação não aparece no mapa.
   */
  async situacoesPorOrigem(
    originRefs: readonly string[],
    db: Db = this.prisma.db,
  ): Promise<Map<string, SituacaoDaOrigem>> {
    const situacoes = new Map<string, SituacaoDaOrigem>();
    if (originRefs.length === 0) return situacoes;
    const aprovacoes = await db.outboundApproval.findMany({
      where: { originRef: { in: [...new Set(originRefs)] } },
      select: { originRef: true, messageId: true, number: true, expiresAt: true },
    });
    const despachos = await db.messageDispatch.findMany({
      where: { messageId: { in: aprovacoes.map((a) => a.messageId) } },
      select: { messageId: true, state: true, errorCode: true, dispatchedAt: true },
    });
    const porMensagem = new Map(despachos.map((d) => [d.messageId, d]));
    for (const a of aprovacoes) {
      const d = porMensagem.get(a.messageId);
      situacoes.set(a.originRef, {
        messageId: a.messageId,
        number: a.number,
        expiresAt: a.expiresAt,
        estado: (d?.state ?? null) as EstadoDoDespacho | null,
        errorCode: d?.errorCode ?? null,
        emVoo: d?.state === 'sending' && d.dispatchedAt !== null,
        enviadoEm: d?.state === 'sent' ? (d.dispatchedAt ?? null) : null,
        despachadoEm: d?.dispatchedAt ?? null,
      });
    }
    return situacoes;
  }

  /**
   * O desfecho das origens ENVIADAS (F4.3), a leitura neutra das métricas do
   * vertical: os recibos do provedor e a resposta — uma mensagem de entrada na
   * conversa da mensagem, depois do envio e antes de `ate`. Só o fato, nunca o
   * conteúdo.
   *
   * A resposta exige `conversations:read`; sem ela, `respondeu` é `null` e a
   * contagem é omitida. E só conta a conversa IDENTIFICADA e ainda do contato
   * do envio: a de "remetente a identificar" (RAI) ou a de outro contato não é
   * resposta do paciente, porque não se sabe de quem é (adendo 8, item 7) — é
   * `false` ("sem resposta atribuível ao paciente segundo os critérios da
   * métrica", não prova de que ele não respondeu) para QUALQUER leitor, e o
   * conteúdo dela nunca é lido. Só a contagem agregada usa isto. Assim a
   * existência de uma RAI não aparece na métrica de quem não a pode ver (C13).
   * A origem que não saiu não aparece.
   */
  async desfechosPorOrigem(
    auth: AuthContext,
    consultas: readonly { originRef: string; ate: Date }[],
  ): Promise<Map<string, DesfechoDaOrigem>> {
    const desfechos = new Map<string, DesfechoDaOrigem>();
    const situacoes = await this.situacoesPorOrigem(consultas.map((c) => c.originRef));
    const enviadas = consultas.filter((c) => situacoes.get(c.originRef)?.enviadoEm);
    if (enviadas.length === 0) return desfechos;
    const situacaoDa = (c: { originRef: string }) => situacoes.get(c.originRef) as SituacaoDaOrigem;
    const mensagens = enviadas.map((c) => situacaoDa(c).messageId);
    const [recibos, aprovacoes, linhas, leConversas] = await Promise.all([
      this.prisma.db.messageStatusEvent.findMany({
        where: { messageId: { in: mensagens } },
        select: { messageId: true, status: true },
      }),
      this.prisma.db.outboundApproval.findMany({
        where: { messageId: { in: mensagens } },
        select: { messageId: true, contactId: true },
      }),
      this.prisma.db.message.findMany({
        where: { id: { in: mensagens } },
        select: { id: true, conversationId: true },
      }),
      this.permissoes.has(auth, 'conversations:read'),
    ]);
    const contatoDoEnvio = new Map(aprovacoes.map((a) => [a.messageId, a.contactId]));
    const conversaDa = new Map(linhas.map((m) => [m.id, m.conversationId]));
    const conversas = new Map(
      (
        await this.prisma.db.conversation.findMany({
          where: { id: { in: [...new Set(conversaDa.values())] } },
          select: { id: true, senderStatus: true, contactId: true },
        })
      ).map((c) => [c.id, c]),
    );
    // a conversa conta só se identificada e ainda do contato do envio
    const atribuivel = (messageId: string): string | null => {
      const id = conversaDa.get(messageId);
      const conversa = id ? conversas.get(id) : undefined;
      return conversa?.senderStatus === 'identified' &&
        conversa.contactId === contatoDoEnvio.get(messageId)
        ? (id as string)
        : null;
    };
    // as entradas das conversas atribuíveis, numa consulta só, na janela inteira
    const contadas = leConversas
      ? [...new Set(mensagens.map(atribuivel).filter((id): id is string => id !== null))]
      : [];
    const entradas =
      contadas.length > 0
        ? await this.prisma.db.message.findMany({
            where: {
              conversationId: { in: contadas },
              direction: 'inbound',
              createdAt: {
                gt: new Date(Math.min(...enviadas.map((c) => situacaoDa(c).enviadoEm!.getTime()))),
                lt: new Date(Math.max(...enviadas.map((c) => c.ate.getTime()))),
              },
            },
            select: { conversationId: true, createdAt: true },
          })
        : [];
    for (const consulta of enviadas) {
      const situacao = situacaoDa(consulta);
      const enviadoEm = situacao.enviadoEm as Date;
      const conversa = atribuivel(situacao.messageId);
      const respondeu = !leConversas
        ? null
        : conversa !== null &&
          entradas.some(
            (e) =>
              e.conversationId === conversa &&
              e.createdAt.getTime() > enviadoEm.getTime() &&
              e.createdAt.getTime() < consulta.ate.getTime(),
          );
      desfechos.set(consulta.originRef, {
        enviadoEm,
        recibos: recibos
          .filter((r) => r.messageId === situacao.messageId)
          .map((r) => r.status as ReciboDoProvedor),
        respondeu,
      });
    }
    return desfechos;
  }

  /**
   * A origem de vertical deixou de valer (F4.2): o cancelamento neutro dos
   * despachos das mensagens aprovadas por estas origens, com o motivo
   * `origin_invalidated`. Pré-condição: quem chama segura, EXCLUSIVA, a
   * `validity:` das chaves que o despacho pega compartilhada — é a
   * serialização que o cancelamento por lista exige. Devolve as contagens, para
   * a trilha de quem chama, e a situação de cada origem depois dele.
   */
  async invalidarOrigensNaTransacao(
    tx: Db,
    workspaceId: string,
    originRefs: readonly string[],
  ): Promise<{ resultado: ResultadoDoCancelamento; situacoes: Map<string, SituacaoDaOrigem> }> {
    // só origens de vertical: a do Core (o Inbox) não tem quem a invalide
    for (const originRef of originRefs) {
      const partes = partesDaOrigem(originRef);
      if (!partes || partes.prefixo === PREFIXO_DO_CORE) {
        throw new Error('Invalidação de origem fora do formato de vertical');
      }
    }
    const antes = await this.situacoesPorOrigem(originRefs, tx);
    const messageIds = [...antes.values()].map((s) => s.messageId);
    const resultado =
      messageIds.length > 0
        ? await this.cancelamento.cancelarNaTransacao(
            tx,
            workspaceId,
            { messageIds },
            'origin_invalidated',
          )
        : { cancelados: 0, pedidos: 0, emVoo: 0 };
    return { resultado, situacoes: await this.situacoesPorOrigem(originRefs, tx) };
  }

  /** A origem de vertical já tem aprovação (o único do banco é por origem). */
  private async origemAprovada(originRef: string): Promise<boolean> {
    const linha = await this.prisma.db.outboundApproval.findFirst({
      where: { originRef },
      select: { messageId: true },
    });
    return linha !== null;
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
