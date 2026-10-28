import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { BusinessOutboundReason, BusinessOutboundTarget } from '@veyra/contracts';
import {
  CLINICS_OUTREACH_PURPOSES,
  horaLocal,
  inicioDoDiaLocal,
  somarDias,
  type ApproveClinicsOutreachInput,
  type ClinicsOutreachCandidateDto,
  type ClinicsOutreachKind,
  type ClinicsOutreachPrepareDto,
  type ClinicsOutreachPrepareItemDto,
  type ClinicsOutreachPreviewDto,
  type ClinicsOutreachPreviewItemDto,
  type ClinicsOutreachReason,
  type ClinicsOutreachRequestDto,
  type ClinicsOutreachResultDto,
  type ClinicsOutreachResultItemDto,
  type ClinicsOutreachState,
  type ListClinicsOutreachCandidatesInput,
  type PrepareClinicsOutreachInput,
  type PreviewClinicsOutreachInput,
} from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../../audit/audit.service';
import { PermissionsService } from '../../../auth/permissions.service';
import {
  EnvioDoNegocioService,
  type SituacaoDaOrigem,
} from '../../../business-outbound/business-outbound.service';
import type { AuthContext } from '../../../common/decorators';
import { postgresErrorCode } from '../../../common/prisma-exception.filter';
import { numerosExatos } from '../../../contacts/phone-identity';
import {
  MudancasDeRestricao,
  type ExecutorDeTransacao,
} from '../../../content-use/restriction-changes';
import { PrismaService, type Db } from '../../../prisma/prisma.service';
import {
  ANTECEDENCIA_DA_CONFIRMACAO_MS,
  chaveDoAgendamento,
  chaveDoRetorno,
  origemDoPedido,
} from './clinics-outreach.precondition';
import {
  CAMPOS_DO_ESTADO,
  ValidadeDosPedidos,
  comprovadamenteNaoEnviado,
  estadoDoPedido,
  type PedidoParaEstado,
} from './clinics-outreach.validity';

/** O dia de uma unidade não passa de algumas dezenas; o teto é defesa. */
const TETO_DE_CANDIDATOS = 500;

/** Os estados em que o pedido ainda conta e bloqueia um novo para o mesmo alvo. */
const BLOQUEIAM: readonly ClinicsOutreachState[] = ['pending', 'sent', 'uncertain'];

type ContatoDoPaciente = {
  id: string;
  name: string;
  phones: string[];
  phonesNormalized: string[];
};
const COM_CONTATO = {
  patient: {
    select: {
      contact: { select: { id: true, name: true, phones: true, phonesNormalized: true } },
    },
  },
} as const;

/** O texto como a comparação o vê: sem acento, minúsculo, espaços simples. */
function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** O número sem os dígitos do meio, para quem não lê contatos. */
function mascarar(numero: string): string {
  return `•••${numero.slice(-4)}`;
}

/**
 * O envio iniciado pela clínica (ADR-048 adendos 8 e 9, F4.2): os candidatos,
 * o pedido — que nasce ANTES da prévia, com o alvo —, a prévia e a aprovação
 * pelo serviço do Core no mesmo processo (a rota do vertical), e a leitura do
 * pedido. O Core confere as permissões da porta, a origem, o destinatário, o
 * consentimento e o conteúdo; aqui ficam o alvo, a finalidade do tipo, a
 * conferência de apoio contra o catálogo e o texto, que mora no pedido até o
 * desfecho terminal.
 */
@Injectable()
export class ClinicsOutreachService {
  private readonly logger = new Logger(ClinicsOutreachService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly envio: EnvioDoNegocioService,
    private readonly validade: ValidadeDosPedidos,
    private readonly restricao: MudancasDeRestricao,
    private readonly permissions: PermissionsService,
  ) {}

  // ── Os candidatos ───────────────────────────────────────────────────────

  async candidatos(
    query: ListClinicsOutreachCandidatesInput,
  ): Promise<ClinicsOutreachCandidateDto[]> {
    const agora = await this.envio.agora();
    return query.kind === 'confirmation'
      ? this.candidatosDaConfirmacao(query, agora)
      : this.candidatosDaReativacao(query, agora);
  }

  /** Os agendamentos marcados ou confirmados dos dias locais pedidos (hoje e amanhã, por padrão). */
  private async candidatosDaConfirmacao(
    query: ListClinicsOutreachCandidatesInput,
    agora: Date,
  ): Promise<ClinicsOutreachCandidateDto[]> {
    const unidade = await unidadeDaConsulta(this.prisma.db, query.unitId);
    const de = query.date ?? horaLocal(agora, unidade.timezone).data;
    const agendamentos = (await this.prisma.db.clinicsAppointment.findMany({
      where: {
        unitId: unidade.id,
        status: { in: ['scheduled', 'confirmed'] },
        startsAt: {
          gte: inicioDoDiaLocal(de, unidade.timezone),
          lt: inicioDoDiaLocal(somarDias(de, query.days ?? 2), unidade.timezone),
        },
      },
      select: { id: true, startsAt: true, patientId: true, ...COM_CONTATO },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: TETO_DE_CANDIDATOS,
    } as never)) as unknown as {
      id: string;
      startsAt: Date;
      patientId: string;
      patient: { contact: ContatoDoPaciente };
    }[];
    const pedidos = await this.pedidosQueContam({
      appointmentId: { in: agendamentos.map((a) => a.id) },
    });
    const { estados } = await this.estados(pedidos, agora);
    const porAlvo = new Map(
      pedidos.map((p) => [`${p.appointmentId}:${p.startsAt?.getTime()}`, p] as const),
    );
    return agendamentos.map((ag) => {
      const pedido = porAlvo.get(`${ag.id}:${ag.startsAt.getTime()}`);
      const estado = pedido ? (estados.get(pedido.id) as ClinicsOutreachState) : null;
      const local = horaLocal(ag.startsAt, unidade.timezone);
      return {
        kind: 'confirmation',
        appointmentId: ag.id,
        returnId: null,
        startsAt: ag.startsAt.toISOString(),
        localDate: local.data,
        localStart: local.hora,
        dueDate: null,
        patientId: ag.patientId,
        patientName: ag.patient.contact.name,
        contactId: ag.patient.contact.id,
        numbers: numerosExatos(ag.patient.contact),
        blocked:
          estado && BLOQUEIAM.includes(estado)
            ? 'request_exists'
            : ag.startsAt.getTime() - ANTECEDENCIA_DA_CONFIRMACAO_MS <= agora.getTime()
              ? 'starts_too_soon'
              : null,
        request: pedido && estado ? { id: pedido.id, state: estado } : null,
      };
    });
  }

  /** Os retornos pendentes, sem agendamento, vencidos na data local da unidade. */
  private async candidatosDaReativacao(
    query: ListClinicsOutreachCandidatesInput,
    agora: Date,
  ): Promise<ClinicsOutreachCandidateDto[]> {
    const unidades = (await this.prisma.db.clinicsUnit.findMany({
      select: { id: true, timezone: true },
    })) as unknown as { id: string; timezone: string }[];
    const hojeDa = new Map(unidades.map((u) => [u.id, horaLocal(agora, u.timezone).data]));
    const retornos = (await this.prisma.db.clinicsReturn.findMany({
      where: {
        status: 'pending',
        appointmentId: null,
        ...(query.unitId ? { unitId: query.unitId } : {}),
      },
      select: { id: true, dueDate: true, unitId: true, patientId: true, ...COM_CONTATO },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: TETO_DE_CANDIDATOS,
    } as never)) as unknown as {
      id: string;
      dueDate: Date;
      unitId: string;
      patientId: string;
      patient: { contact: ContatoDoPaciente };
    }[];
    const vencidos = retornos.filter((r) => {
      const hoje = hojeDa.get(r.unitId);
      return hoje !== undefined && r.dueDate.toISOString().slice(0, 10) < hoje;
    });
    const pedidos = await this.pedidosQueContam({ returnId: { in: vencidos.map((r) => r.id) } });
    const { estados } = await this.estados(pedidos, agora);
    const porAlvo = new Map(pedidos.map((p) => [p.returnId, p] as const));
    return vencidos.map((r) => {
      const pedido = porAlvo.get(r.id);
      const estado = pedido ? (estados.get(pedido.id) as ClinicsOutreachState) : null;
      return {
        kind: 'reactivation',
        appointmentId: null,
        returnId: r.id,
        startsAt: null,
        localDate: null,
        localStart: null,
        dueDate: r.dueDate.toISOString().slice(0, 10),
        patientId: r.patientId,
        patientName: r.patient.contact.name,
        contactId: r.patient.contact.id,
        numbers: numerosExatos(r.patient.contact),
        blocked: estado && BLOQUEIAM.includes(estado) ? 'request_exists' : null,
        request: pedido && estado ? { id: pedido.id, state: estado } : null,
      };
    });
  }

  // ── O pedido ────────────────────────────────────────────────────────────

  /**
   * Um pedido por alvo, cada um na sua transação, com a `validity:` exclusiva
   * do alvo ANTES de qualquer linha (é a ordem das mudanças). O rascunho que já
   * conta para o alvo é devolvido de novo (repetir não duplica); o que
   * comprovadamente não saiu perde a marca e dá lugar ao novo; o aguardando, o
   * enviado e o incerto bloqueiam (C5).
   */
  async preparar(
    auth: AuthContext,
    input: PrepareClinicsOutreachInput,
  ): Promise<ClinicsOutreachPrepareDto> {
    const agora = await this.envio.agora();
    const items: ClinicsOutreachPrepareItemDto[] = [];
    for (const [index, alvo] of input.targets.entries()) {
      try {
        items.push(await this.prepararItem(auth, index, input.kind, alvo, agora));
      } catch (erro) {
        // a mudança do mesmo alvo segurava a trava: nada deste item mudou
        if (erro instanceof ConflictException || postgresErrorCode(erro) === '55P03') {
          items.push({ index, ok: false, reason: 'busy' });
          continue;
        }
        throw erro;
      }
    }
    return { items };
  }

  private async prepararItem(
    auth: AuthContext,
    index: number,
    kind: ClinicsOutreachKind,
    alvo: { appointmentId: string } | { returnId: string },
    agora: Date,
  ): Promise<ClinicsOutreachPrepareItemDto> {
    type Recusa = Extract<ClinicsOutreachPrepareItemDto, { ok: false }>['reason'];
    const recusa = (reason: Recusa): ClinicsOutreachPrepareItemDto => ({
      index,
      ok: false,
      reason,
    });
    const workspaceId = auth.workspaceId as string;
    const confirmacao = kind === 'confirmation';
    const id = confirmacao
      ? 'appointmentId' in alvo
        ? alvo.appointmentId
        : null
      : 'returnId' in alvo
        ? alvo.returnId
        : null;
    if (!id) return recusa('target_not_found');

    return this.restricao.naTransacaoInterativa(
      this.prisma.db as unknown as ExecutorDeTransacao,
      async (tx) => {
        await this.validade.travar(tx, workspaceId, [
          confirmacao ? chaveDoAgendamento(id) : chaveDoRetorno(id),
        ]);
        // o alvo, lido DEPOIS da trava: a mudança que comitou antes vale aqui
        let startsAt: Date | null = null;
        if (confirmacao) {
          const ag = (await tx.clinicsAppointment.findFirst({
            where: { id },
            select: { status: true, startsAt: true },
          })) as { status: string; startsAt: Date } | null;
          if (!ag) return recusa('target_not_found');
          if (ag.status !== 'scheduled' && ag.status !== 'confirmed') {
            return recusa('target_invalid');
          }
          if (ag.startsAt.getTime() - ANTECEDENCIA_DA_CONFIRMACAO_MS <= agora.getTime()) {
            return recusa('starts_too_soon');
          }
          startsAt = ag.startsAt;
        } else {
          const retorno = (await tx.clinicsReturn.findFirst({
            where: { id },
            select: { status: true, appointmentId: true },
          })) as { status: string; appointmentId: string | null } | null;
          if (!retorno) return recusa('target_not_found');
          if (retorno.status !== 'pending' || retorno.appointmentId !== null) {
            return recusa('target_invalid');
          }
        }

        const existente = (await tx.clinicsOutreachRequest.findFirst({
          where: confirmacao
            ? { appointmentId: id, startsAt, activeMark: true }
            : { returnId: id, activeMark: true },
          select: CAMPOS_DO_ESTADO,
        } as never)) as unknown as PedidoParaEstado | null;
        if (existente) {
          const origem = origemDoPedido(existente.id);
          let situacao = (await this.envio.situacoesPorOrigem([origem], tx)).get(origem);
          const estado = estadoDoPedido(existente, situacao, agora);
          if (estado === 'draft') {
            return { index, ok: true, request: dto(existente, situacao, agora, null, false) };
          }
          if (BLOQUEIAM.includes(estado)) return recusa('request_exists');
          // o aprovado que venceu sem sair: o cancelamento neutro o encerra
          // antes de a marca sair (o verificador já o recusaria)
          if (!comprovadamenteNaoEnviado(situacao)) {
            situacao = (
              await this.envio.invalidarOrigensNaTransacao(tx, workspaceId, [origem])
            ).situacoes.get(origem);
            if (!comprovadamenteNaoEnviado(situacao)) return recusa('request_exists');
          }
          await tx.clinicsOutreachRequest.updateMany({
            where: { id: existente.id, activeMark: true },
            data: { activeMark: null },
          });
          await this.audit.record(tx, workspaceId, 'clinics.outreach.superseded', {
            entityType: 'clinicsOutreachRequest',
            entityId: existente.id,
            actor: this.audit.actorFrom(auth),
            after: { state: 'not_sent', activeMark: null },
          });
        }

        const criado = (await tx.clinicsOutreachRequest.create({
          data: {
            kind,
            ...(confirmacao ? { appointmentId: id, startsAt } : { returnId: id }),
            createdByMembershipId: auth.membershipId as string,
          },
          select: CAMPOS_DO_ESTADO,
        } as never)) as unknown as PedidoParaEstado;
        await this.audit.record(tx, workspaceId, 'clinics.outreach.created', {
          entityType: 'clinicsOutreachRequest',
          entityId: criado.id,
          actor: this.audit.actorFrom(auth),
          after: {
            kind,
            appointmentId: criado.appointmentId,
            startsAt: criado.startsAt?.toISOString() ?? null,
            returnId: criado.returnId,
            state: 'draft',
            activeMark: true,
          },
        });
        return { index, ok: true, request: dto(criado, undefined, agora, null, false) };
      },
    );
  }

  // ── A prévia e a aprovação ──────────────────────────────────────────────

  /**
   * A prévia de cada pedido EM RASCUNHO, pelo serviço do Core na rota do
   * vertical. O texto aprovável fica no pedido — o armazenamento protegido —,
   * e só depois da conferência de apoio contra o catálogo.
   */
  async previa(
    auth: AuthContext,
    input: PreviewClinicsOutreachInput,
  ): Promise<ClinicsOutreachPreviewDto> {
    const agora = await this.envio.agora();
    const items: ClinicsOutreachPreviewItemDto[] = [];
    for (const [index, item] of input.items.entries()) {
      const recusa = (
        reason: ClinicsOutreachReason | BusinessOutboundReason,
      ): ClinicsOutreachPreviewItemDto => ({ index, ok: false, reason });
      const pedido = await this.pedido(item.requestId);
      if (!pedido) {
        items.push(recusa('request_not_found'));
        continue;
      }
      const origem = origemDoPedido(pedido.id);
      const situacao = (await this.envio.situacoesPorOrigem([origem])).get(origem);
      if (estadoDoPedido(pedido, situacao, agora) !== 'draft') {
        items.push(recusa('request_not_draft'));
        continue;
      }
      if (!(await this.finalidadePermitida(pedido.kind, item.purposeId))) {
        items.push(recusa('purpose_not_allowed'));
        continue;
      }
      const alvo = await this.alvoDoCore(pedido, item);
      if (!alvo) {
        items.push(recusa('request_not_found'));
        continue;
      }
      const {
        items: [r],
      } = await this.envio.previa(auth, { items: [alvo] }, 'vertical');
      if (!r.ok) {
        items.push(recusa(r.reason));
        continue;
      }
      if (await this.temNomeDoCatalogo(r.text)) {
        items.push(recusa('catalog_name_in_text'));
        continue;
      }
      await this.gravarTextoDaPrevia(auth, pedido, r.text);
      items.push({
        index,
        ok: true,
        text: r.text,
        values: r.values,
        expiresAt: r.expiresAt,
        approvalHash: r.approvalHash,
      });
    }
    return { items };
  }

  /**
   * A aprovação em lote, cada item por si, pelo serviço do Core na rota do
   * vertical: o Core recalcula o hash com os dados de agora, e uma aprovação
   * só por pedido (a mesma prévia repetida devolve a mesma mensagem). A
   * falha inesperada num item vira recusa dele: o lote não vira 500 depois de
   * itens anteriores aprovados.
   */
  async aprovar(
    auth: AuthContext,
    input: ApproveClinicsOutreachInput,
  ): Promise<ClinicsOutreachResultDto> {
    const items: ClinicsOutreachResultItemDto[] = [];
    for (const [index, item] of input.items.entries()) {
      const recusa = (
        reason: ClinicsOutreachReason | BusinessOutboundReason,
      ): ClinicsOutreachResultItemDto => ({
        index,
        requestId: item.requestId,
        state: 'refused',
        messageId: null,
        reason,
      });
      try {
        const pedido = await this.pedido(item.requestId);
        if (!pedido) {
          items.push(recusa('request_not_found'));
          continue;
        }
        if (!(await this.finalidadePermitida(pedido.kind, item.purposeId))) {
          items.push(recusa('purpose_not_allowed'));
          continue;
        }
        const alvo = await this.alvoDoCore(pedido, item);
        if (!alvo) {
          items.push(recusa('request_not_found'));
          continue;
        }
        // o catálogo pode ter mudado desde a prévia, e a última prévia guardada
        // pode ser de outro item: o texto EXATO deste item, com os dados de agora,
        // é conferido de novo (o hash prova que é o que sai)
        const {
          items: [atual],
        } = await this.envio.previa(auth, { items: [alvo] }, 'vertical');
        // sem o texto de agora, a conferência não pode ser feita: a porta
        // indisponível recusa (tente de novo); os outros motivos seguem ao Core,
        // que responde a repetição de uma aprovação existente
        if (!atual.ok && atual.reason === 'precondition_unavailable') {
          items.push(recusa('precondition_unavailable'));
          continue;
        }
        if (atual.ok && (await this.temNomeDoCatalogo(atual.text))) {
          items.push(recusa('catalog_name_in_text'));
          continue;
        }
        const {
          items: [r],
        } = await this.envio.aprovar(
          auth,
          { items: [{ ...alvo, expiresAt: item.expiresAt, approvalHash: item.approvalHash }] },
          'vertical',
        );
        if (r.state === 'approved' && r.texto) {
          // o texto aprovado, do Core: o mesmo da prévia, pelo hash. A mensagem
          // já existe: uma falha aqui não pode virar "nada foi gravado"
          await this.prisma.db.clinicsOutreachRequest
            .updateMany({
              where: { id: pedido.id, textClearedAt: null },
              data: { renderedText: r.texto },
            })
            .catch((erro: unknown) =>
              this.logger.error(
                `Texto do pedido aprovado não gravado (${(erro as Error)?.name ?? 'Error'})`,
              ),
            );
        }
        items.push({
          index,
          requestId: item.requestId,
          state: r.state,
          messageId: r.messageId,
          reason: r.reason,
        });
      } catch (erro) {
        const { name, code } = (erro ?? {}) as { name?: string; code?: string };
        this.logger.error(
          `Item ${index} do envio da clínica não processado (${name ?? 'Error'} ${code ?? 'sem código'})`,
        );
        items.push(recusa('not_processed'));
      }
    }
    return { items };
  }

  // ── A leitura ───────────────────────────────────────────────────────────

  /**
   * O pedido, com `clinics:schedule:read`. O número completo só com
   * `contacts:read`; o motivo do não envio só com `contacts:read` e
   * `consents:read` — ele pode revelar o consentimento (adendo 9, decisão 3).
   */
  async ler(auth: AuthContext, id: string): Promise<ClinicsOutreachRequestDto> {
    const pedido = await this.pedido(id);
    if (!pedido) throw new NotFoundException('Pedido não encontrado');
    const agora = await this.envio.agora();
    const origem = origemDoPedido(pedido.id);
    const situacao = (await this.envio.situacoesPorOrigem([origem])).get(origem);
    const verNumero = await this.permissions.has(auth, 'contacts:read');
    const verMotivo = verNumero && (await this.permissions.has(auth, 'consents:read'));
    const base = dto(pedido, situacao, agora, pedido.renderedText, verMotivo);
    return {
      ...base,
      number: situacao ? (verNumero ? situacao.number : mascarar(situacao.number)) : null,
    };
  }

  // ── auxiliares ──────────────────────────────────────────────────────────

  private async pedido(
    id: string,
  ): Promise<(PedidoParaEstado & { renderedText: string | null }) | null> {
    return (await this.prisma.db.clinicsOutreachRequest.findFirst({
      where: { id },
      select: { ...CAMPOS_DO_ESTADO, renderedText: true },
    } as never)) as unknown as (PedidoParaEstado & { renderedText: string | null }) | null;
  }

  private async pedidosQueContam(where: Record<string, unknown>): Promise<PedidoParaEstado[]> {
    return (await this.prisma.db.clinicsOutreachRequest.findMany({
      where: { ...where, activeMark: true },
      select: CAMPOS_DO_ESTADO,
    } as never)) as unknown as PedidoParaEstado[];
  }

  private async estados(
    pedidos: PedidoParaEstado[],
    agora: Date,
  ): Promise<{ estados: Map<string, ClinicsOutreachState> }> {
    const situacoes = await this.envio.situacoesPorOrigem(pedidos.map((p) => origemDoPedido(p.id)));
    return {
      estados: new Map(
        pedidos.map((p) => [p.id, estadoDoPedido(p, situacoes.get(origemDoPedido(p.id)), agora)]),
      ),
    };
  }

  /** A finalidade é a do tipo, pela chave, e não permite campo além do conteúdo mínimo. */
  private async finalidadePermitida(
    kind: ClinicsOutreachKind,
    purposeId: string,
  ): Promise<boolean> {
    const finalidade = (await this.prisma.db.consentPurpose.findFirst({
      where: { id: purposeId },
      select: { key: true, fields: true },
    })) as { key: string; fields: string[] } | null;
    const regra = CLINICS_OUTREACH_PURPOSES[kind];
    // nenhum campo além do conteúdo mínimo, e TODOS os do vertical que a porta
    // devolve: a finalidade sem eles seria recusada adiante, com outro motivo
    return (
      !!finalidade &&
      finalidade.key === regra.key &&
      finalidade.fields.every((campo) => regra.fields.includes(campo)) &&
      regra.fields
        .filter((campo) => campo.startsWith('clinics.'))
        .every((campo) => finalidade.fields.includes(campo))
    );
  }

  /**
   * O texto da prévia, no pedido que ainda é RASCUNHO: sob a `validity:` do
   * alvo, a mesma que a aprovação pega compartilhada, e só sem aprovação. Uma
   * prévia que corre com a aprovação não sobrescreve o texto aprovado.
   */
  private async gravarTextoDaPrevia(
    auth: AuthContext,
    pedido: PedidoParaEstado,
    texto: string,
  ): Promise<void> {
    const origem = origemDoPedido(pedido.id);
    await this.restricao.naTransacaoInterativa(
      this.prisma.db as unknown as ExecutorDeTransacao,
      async (tx) => {
        await this.validade.travar(tx, auth.workspaceId as string, [
          pedido.kind === 'confirmation'
            ? chaveDoAgendamento(pedido.appointmentId as string)
            : chaveDoRetorno(pedido.returnId as string),
        ]);
        if ((await this.envio.situacoesPorOrigem([origem], tx)).has(origem)) return;
        await tx.clinicsOutreachRequest.updateMany({
          where: { id: pedido.id, activeMark: true, textClearedAt: null },
          data: { renderedText: texto },
        });
      },
    );
  }

  /** O alvo do Core: a origem é o pedido, e o contato é o do paciente do alvo. */
  private async alvoDoCore(
    pedido: PedidoParaEstado,
    item: { channelId: string; number: string; templateVersionId: string; purposeId: string },
  ): Promise<BusinessOutboundTarget | null> {
    const patientId =
      pedido.kind === 'confirmation'
        ? (
            (await this.prisma.db.clinicsAppointment.findFirst({
              where: { id: pedido.appointmentId as string },
              select: { patientId: true },
            })) as { patientId: string } | null
          )?.patientId
        : (
            (await this.prisma.db.clinicsReturn.findFirst({
              where: { id: pedido.returnId as string },
              select: { patientId: true },
            })) as { patientId: string } | null
          )?.patientId;
    if (!patientId) return null;
    const paciente = (await this.prisma.db.clinicsPatient.findFirst({
      where: { id: patientId },
      select: { contactId: true },
    })) as { contactId: string } | null;
    if (!paciente) return null;
    return {
      originRef: origemDoPedido(pedido.id),
      channelId: item.channelId,
      contactId: paciente.contactId,
      number: item.number,
      templateVersionId: item.templateVersionId,
      purposeId: item.purposeId,
    };
  }

  /**
   * A conferência de APOIO (adendo 8, item 2): o texto com o nome de um
   * serviço ou de um profissional do catálogo, inteiro e como palavra, é
   * recusado. Inclui os arquivados. Não garante a ausência de informação
   * clínica: quem libera o texto fixo é a revisão humana.
   */
  private async temNomeDoCatalogo(texto: string): Promise<boolean> {
    const [servicos, profissionais] = await Promise.all([
      this.prisma.db.clinicsService.findMany({ select: { name: true } }),
      this.prisma.db.clinicsProfessional.findMany({ select: { name: true } }),
    ]);
    const alvo = normalizar(texto);
    return [...servicos, ...profissionais].some(({ name }) => {
      const nome = normalizar(name as string);
      if (nome.length < 3) return false;
      const escapado = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${escapado}([^a-z0-9]|$)`).test(alvo);
    });
  }
}

/** A unidade pedida, ou a ÚNICA ativa (MVP: uma por workspace). */
async function unidadeDaConsulta(
  db: Db,
  unitId?: string,
): Promise<{ id: string; timezone: string }> {
  const unidades = (await db.clinicsUnit.findMany({
    where: { archivedAt: null, ...(unitId ? { id: unitId } : {}) },
    select: { id: true, timezone: true },
    take: 2,
  })) as unknown as { id: string; timezone: string }[];
  if (unitId && unidades.length === 0) throw new NotFoundException('Unidade não encontrada');
  if (unidades.length !== 1) throw new NotFoundException('Informe a unidade');
  return unidades[0];
}

/** O pedido como sai: o texto e o motivo só quando quem chama decide que podem. */
function dto(
  pedido: PedidoParaEstado,
  situacao: SituacaoDaOrigem | undefined,
  agora: Date,
  texto: string | null,
  verMotivo: boolean,
): ClinicsOutreachRequestDto {
  return {
    id: pedido.id,
    kind: pedido.kind,
    appointmentId: pedido.appointmentId,
    startsAt: pedido.startsAt?.toISOString() ?? null,
    returnId: pedido.returnId,
    state: estadoDoPedido(pedido, situacao, agora),
    text: texto,
    number: null,
    reason: verMotivo ? (situacao?.errorCode ?? null) : null,
    createdAt: pedido.createdAt.toISOString(),
  };
}
