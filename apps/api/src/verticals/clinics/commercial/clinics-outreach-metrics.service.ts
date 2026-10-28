import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  horaLocal,
  inicioDoDiaLocal,
  somarDias,
  type ClinicsConfirmationFunnelDto,
  type ClinicsConversionDto,
  type ClinicsConversionQuery,
  type ClinicsMetricPeriodQuery,
  type ClinicsMetricStageDto,
  type ClinicsNoShowGroupDto,
  type ClinicsReactivationDto,
} from '@veyra/contracts/verticals/clinics';
import { PermissionsService } from '../../../auth/permissions.service';
import {
  EnvioDoNegocioService,
  type DesfechoDaOrigem,
} from '../../../business-outbound/business-outbound.service';
import type { AuthContext } from '../../../common/decorators';
import { PrismaService, type Db } from '../../../prisma/prisma.service';
import { PRAZO_DA_REATIVACAO_MS, origemDoPedido } from '../outreach/clinics-outreach.precondition';
import {
  CAMPOS_DO_ESTADO,
  estadoDoPedido,
  type PedidoParaEstado,
} from '../outreach/clinics-outreach.validity';

/** A janela da conversão (V5, adendo 8 7.2) e a da reativação (7.3), em dias locais. */
export const JANELA_DA_CONVERSAO_DIAS = 90;
export const JANELA_DA_REATIVACAO_DIAS = 60;

type Unidade = { id: string; timezone: string };

type Agendamento = {
  id: string;
  status: string;
  startsAt: Date;
  confirmedAt: Date | null;
  confirmationTracked: boolean;
};

/**
 * As métricas do envio da clínica (ADR-048 adendo 8, item 7; adendo 10).
 * Associação, não causa. Só agregados, sem persistência, recalculados pelo
 * estado ATUAL — "janela encerrada" não congela o resultado.
 *
 * Regras comuns: o período em datas locais da unidade, `[from, to)`; as
 * janelas também em datas locais, semiabertas; "sem dados" é diferente de 0;
 * a etapa que não pode ser apurada por inteiro sai com a cobertura parcial; a
 * que quem pergunta não pode ver é omitida, nunca zero.
 */
@Injectable()
export class ClinicsOutreachMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly envio: EnvioDoNegocioService,
    private readonly permissions: PermissionsService,
  ) {}

  // ── O funil da confirmação (7.1) ──────────────────────────────────────────

  async funil(
    auth: AuthContext,
    query: ClinicsMetricPeriodQuery,
  ): Promise<ClinicsConfirmationFunnelDto> {
    const unidade = await unidadeDaMetrica(this.prisma.db, query.unitId);
    const doPeriodo = (await this.prisma.db.clinicsAppointment.findMany({
      where: {
        unitId: unidade.id,
        startsAt: {
          gte: inicioDoDiaLocal(query.from, unidade.timezone),
          lt: inicioDoDiaLocal(query.to, unidade.timezone),
        },
      },
      select: {
        id: true,
        status: true,
        startsAt: true,
        confirmedAt: true,
        confirmationTracked: true,
      },
    } as never)) as unknown as Agendamento[];
    const base = doPeriodo.filter((a) => a.status !== 'canceled');
    const pedidos = (await this.prisma.db.clinicsOutreachRequest.findMany({
      where: { kind: 'confirmation', appointmentId: { in: base.map((a) => a.id) } },
      select: CAMPOS_DO_ESTADO,
    } as never)) as unknown as PedidoParaEstado[];
    const agora = await this.envio.agora();
    const situacoes = await this.envio.situacoesPorOrigem(pedidos.map((p) => origemDoPedido(p.id)));
    const estado = (p: PedidoParaEstado) =>
      estadoDoPedido(p, situacoes.get(origemDoPedido(p.id)), agora);

    // o grupo de cada agendamento, pelo pedido do horário FINAL. Fora dos três
    // grupos da falta ficam o pendente do horário final e o que teve envio
    // (enviado, incerto ou em curso) só para um horário anterior: a pessoa
    // pode ter recebido, e o grupo "sem solicitação" não pode ser contaminado
    type Grupo = 'sent' | 'uncertain' | 'pending' | 'earlier' | 'notSent';
    const COM_ENVIO = ['sent', 'uncertain', 'pending'];
    const grupoDe = new Map<string, Grupo>();
    const enviadoDe = new Map<string, PedidoParaEstado>();
    for (const ag of base) {
      const doAgendamento = pedidos.filter((p) => p.appointmentId === ag.id);
      const doFinal = doAgendamento.filter((p) => p.startsAt?.getTime() === ag.startsAt.getTime());
      const enviado = doFinal.find((p) => estado(p) === 'sent');
      if (enviado) {
        grupoDe.set(ag.id, 'sent');
        enviadoDe.set(ag.id, enviado);
      } else if (doFinal.some((p) => estado(p) === 'uncertain')) {
        grupoDe.set(ag.id, 'uncertain');
      } else if (doFinal.some((p) => estado(p) === 'pending')) {
        grupoDe.set(ag.id, 'pending');
      } else if (doAgendamento.some((p) => COM_ENVIO.includes(estado(p)))) {
        grupoDe.set(ag.id, 'earlier');
      } else {
        grupoDe.set(ag.id, 'notSent');
      }
    }
    const enviados = base.filter((a) => grupoDe.get(a.id) === 'sent');
    const desfechos = await this.envio.desfechosPorOrigem(
      auth,
      enviados.map((a) => ({
        originRef: origemDoPedido((enviadoDe.get(a.id) as PedidoParaEstado).id),
        ate: a.startsAt,
      })),
    );
    const desfechoDe = (a: Agendamento): DesfechoDaOrigem | undefined =>
      desfechos.get(origemDoPedido((enviadoDe.get(a.id) as PedidoParaEstado).id));
    const comRecibo = (d: DesfechoDaOrigem | undefined) => !!d && d.recibos.length > 0;

    // a entrega: só o recibo do provedor (`delivered` ou `read`) prova
    const delivered = etapa(
      enviados.length,
      enviados.filter((a) => comRecibo(desfechoDe(a))).length,
      enviados.filter((a) => {
        const d = desfechoDe(a);
        return !!d && (d.recibos.includes('delivered') || d.recibos.includes('read'));
      }).length,
      'no_provider_confirmation',
    );

    // a resposta: sem a leitura das conversas, a contagem é omitida (nunca
    // zero); a conversa RAI ou de outro contato não é resposta do paciente, e o
    // Core já a dá como "não respondeu" para qualquer leitor
    const leConversas = await this.permissions.has(auth, 'conversations:read');
    const semAcesso = enviados.some((a) => desfechoDe(a)?.respondeu === null);
    const responded: ClinicsMetricStageDto =
      !leConversas || semAcesso
        ? {
            status: 'omitted',
            count: null,
            known: 0,
            total: enviados.length,
            reason: 'no_conversation_access',
          }
        : etapa(
            enviados.length,
            // a resposta prova a entrega: também conta como apurada
            enviados.filter((a) => {
              const d = desfechoDe(a);
              return comRecibo(d) || d?.respondeu === true;
            }).length,
            enviados.filter((a) => desfechoDe(a)?.respondeu === true).length,
            'no_provider_confirmation',
          );

    // a confirmação pela equipe: depois do envio e antes do início; o
    // agendamento sem rastreio da confirmação (anterior à F4.3) é desconhecido
    const confirmedByTeam = etapa(
      enviados.length,
      enviados.filter((a) => a.confirmationTracked).length,
      enviados.filter((a) => {
        const enviadoEm = desfechoDe(a)?.enviadoEm;
        return (
          a.confirmationTracked &&
          !!a.confirmedAt &&
          !!enviadoEm &&
          a.confirmedAt.getTime() > enviadoEm.getTime() &&
          a.confirmedAt.getTime() < a.startsAt.getTime()
        );
      }).length,
      'confirmation_time_unknown',
    );

    const faltaDo = (grupo: Grupo): ClinicsNoShowGroupDto =>
      taxaDeFalta(base.filter((a) => grupoDe.get(a.id) === grupo));
    return {
      from: query.from,
      to: query.to,
      unitId: unidade.id,
      base: base.length,
      canceled: doPeriodo.length - base.length,
      sent: enviados.length,
      sentForEarlierSlot: base.filter((a) => grupoDe.get(a.id) === 'earlier').length,
      pending: base.filter((a) => grupoDe.get(a.id) === 'pending').length,
      uncertain: base.filter((a) => grupoDe.get(a.id) === 'uncertain').length,
      delivered,
      responded,
      confirmedByTeam,
      noShowBySendGroup: {
        sent: faltaDo('sent'),
        uncertain: faltaDo('uncertain'),
        notSent: faltaDo('notSent'),
      },
    };
  }

  // ── A conversão, com janela por deal (7.2) ────────────────────────────────

  /**
   * A base é a do pipeline: os deals criados no período, com contato. A
   * unidade só dá o fuso das datas locais e da janela — o resultado não é a
   * conversão daquela unidade. O deal converte com um agendamento vinculado,
   * por vínculo VÁLIDO (o deal ainda do contato do paciente), atendido, criado
   * na criação do deal ou depois, e com início dentro da janela.
   */
  async conversao(query: ClinicsConversionQuery): Promise<ClinicsConversionDto> {
    const unidade = await unidadeDaMetrica(this.prisma.db, query.unitId);
    const pipeline = await this.prisma.db.pipeline.findFirst({
      where: { id: query.pipelineId },
      select: { id: true },
    });
    if (!pipeline) throw new NotFoundException('Pipeline não encontrado');
    const tz = unidade.timezone;
    const deals = (await this.prisma.db.deal.findMany({
      where: {
        pipelineId: query.pipelineId,
        contactId: { not: null },
        createdAt: { gte: inicioDoDiaLocal(query.from, tz), lt: inicioDoDiaLocal(query.to, tz) },
      },
      select: { id: true, contactId: true, createdAt: true },
    })) as { id: string; contactId: string; createdAt: Date }[];
    const vinculos = (await this.prisma.db.clinicsAppointmentDeal.findMany({
      where: { dealId: { in: deals.map((d) => d.id) } },
      select: { dealId: true, appointmentId: true },
    })) as { dealId: string; appointmentId: string }[];
    const atendidos = (await this.prisma.db.clinicsAppointment.findMany({
      where: { id: { in: vinculos.map((v) => v.appointmentId) }, status: 'attended' },
      select: { id: true, patientId: true, createdAt: true, startsAt: true },
    } as never)) as unknown as {
      id: string;
      patientId: string;
      createdAt: Date;
      startsAt: Date;
    }[];
    const contatoDo = new Map(
      (
        (await this.prisma.db.clinicsPatient.findMany({
          where: { id: { in: [...new Set(atendidos.map((a) => a.patientId))] } },
          select: { id: true, contactId: true },
        })) as { id: string; contactId: string }[]
      ).map((p) => [p.id, p.contactId]),
    );
    const agendamento = new Map(atendidos.map((a) => [a.id, a]));
    const converted = deals.filter((deal) => {
      const dia = horaLocal(deal.createdAt, tz).data;
      const de = inicioDoDiaLocal(dia, tz).getTime();
      const ate = inicioDoDiaLocal(somarDias(dia, JANELA_DA_CONVERSAO_DIAS), tz).getTime();
      return vinculos.some((v) => {
        const a = v.dealId === deal.id ? agendamento.get(v.appointmentId) : undefined;
        return (
          !!a &&
          contatoDo.get(a.patientId) === deal.contactId &&
          a.createdAt.getTime() >= deal.createdAt.getTime() &&
          a.startsAt.getTime() >= de &&
          a.startsAt.getTime() < ate
        );
      });
    }).length;
    return {
      from: query.from,
      to: query.to,
      unitId: unidade.id,
      pipelineId: query.pipelineId,
      windowDays: JANELA_DA_CONVERSAO_DIAS,
      base: deals.length,
      converted,
      rate: deals.length === 0 ? null : converted / deals.length,
      status: await this.situacaoDaJanela(query.to, JANELA_DA_CONVERSAO_DIAS, tz),
    };
  }

  // ── Os pacientes com retorno depois da reativação (7.3) ───────────────────

  /**
   * A base: os pacientes com ao menos uma reativação ENVIADA no período (os
   * retornos da unidade). A âncora: a primeira enviada no período. O numerador:
   * os com um atendimento cujo agendamento (na unidade) foi criado DEPOIS da
   * âncora e começa em `[D, D + 60)` local. Cada paciente conta uma vez.
   */
  async reativacao(query: ClinicsMetricPeriodQuery): Promise<ClinicsReactivationDto> {
    const unidade = await unidadeDaMetrica(this.prisma.db, query.unitId);
    const tz = unidade.timezone;
    const inicio = inicioDoDiaLocal(query.from, tz).getTime();
    const fim = inicioDoDiaLocal(query.to, tz).getTime();
    // só os pedidos que podem ter saído no período: nenhum criado depois dele,
    // e nenhum vencido antes dele (a reativação vale 24 horas; uma de folga)
    const pedidos = (await this.prisma.db.clinicsOutreachRequest.findMany({
      where: {
        kind: 'reactivation',
        return: { unitId: unidade.id },
        createdAt: {
          gte: new Date(inicio - PRAZO_DA_REATIVACAO_MS - 60 * 60_000),
          lt: new Date(fim),
        },
      },
      select: { id: true, returnId: true },
    } as never)) as unknown as { id: string; returnId: string }[];
    const situacoes = await this.envio.situacoesPorOrigem(pedidos.map((p) => origemDoPedido(p.id)));
    const pacienteDo = new Map(
      (
        (await this.prisma.db.clinicsReturn.findMany({
          where: { id: { in: pedidos.map((p) => p.returnId) } },
          select: { id: true, patientId: true },
        })) as { id: string; patientId: string }[]
      ).map((r) => [r.id, r.patientId]),
    );
    // a âncora de cada paciente: a primeira reativação enviada NO período; o
    // incerto não conta como enviado e é grupo próprio (adendo 8, item 7)
    const ancora = new Map<string, Date>();
    const incertos = new Set<string>();
    const noPeriodo = (d: Date) => d.getTime() >= inicio && d.getTime() < fim;
    for (const p of pedidos) {
      const situacao = situacoes.get(origemDoPedido(p.id));
      const paciente = pacienteDo.get(p.returnId);
      if (!situacao || !paciente) continue;
      if (
        situacao.estado === 'unknown_after_dispatch' &&
        situacao.despachadoEm &&
        noPeriodo(situacao.despachadoEm)
      ) {
        incertos.add(paciente);
      }
      const enviadoEm = situacao.enviadoEm;
      if (!enviadoEm) continue;
      if (enviadoEm.getTime() < inicio || enviadoEm.getTime() >= fim) continue;
      const atual = ancora.get(paciente);
      if (!atual || enviadoEm.getTime() < atual.getTime()) ancora.set(paciente, enviadoEm);
    }
    const atendidos = (await this.prisma.db.clinicsAppointment.findMany({
      where: { patientId: { in: [...ancora.keys()] }, unitId: unidade.id, status: 'attended' },
      select: { patientId: true, createdAt: true, startsAt: true },
    } as never)) as unknown as { patientId: string; createdAt: Date; startsAt: Date }[];
    const returned = [...ancora.entries()].filter(([paciente, quando]) => {
      const dia = horaLocal(quando, tz).data;
      const de = inicioDoDiaLocal(dia, tz).getTime();
      const ate = inicioDoDiaLocal(somarDias(dia, JANELA_DA_REATIVACAO_DIAS), tz).getTime();
      return atendidos.some(
        (a) =>
          a.patientId === paciente &&
          a.createdAt.getTime() > quando.getTime() &&
          a.startsAt.getTime() >= de &&
          a.startsAt.getTime() < ate,
      );
    }).length;
    return {
      from: query.from,
      to: query.to,
      unitId: unidade.id,
      windowDays: JANELA_DA_REATIVACAO_DIAS,
      base: ancora.size,
      uncertain: [...incertos].filter((paciente) => !ancora.has(paciente)).length,
      returned,
      rate: ancora.size === 0 ? null : returned / ancora.size,
      status: await this.situacaoDaJanela(query.to, JANELA_DA_REATIVACAO_DIAS, tz),
    };
  }

  /** Em apuração até o fim do período mais a janela, pelo relógio do banco. */
  private async situacaoDaJanela(
    to: string,
    dias: number,
    tz: string,
  ): Promise<'open' | 'window_closed'> {
    const agora = await this.envio.agora();
    return agora.getTime() < inicioDoDiaLocal(somarDias(to, dias), tz).getTime()
      ? 'open'
      : 'window_closed';
  }
}

/**
 * Uma etapa: `total` na base dela, `known` apurados e `count` dos apurados.
 * A base vazia e nenhum apurado são "sem dados" (nunca zero: a taxa é
 * indefinida); parte apurada é cobertura parcial.
 */
function etapa(
  total: number,
  known: number,
  count: number,
  motivo: Exclude<ClinicsMetricStageDto['reason'], null>,
): ClinicsMetricStageDto {
  if (total === 0)
    return { status: 'no_data', count: null, known: 0, total: 0, reason: 'empty_base' };
  if (known === 0) return { status: 'no_data', count: null, known: 0, total, reason: motivo };
  return known < total
    ? { status: 'partial', count, known, total, reason: motivo }
    : { status: 'complete', count, known, total, reason: null };
}

/** A taxa de falta da F3.3a: faltas sobre atendidos mais faltas; sem os dois, sem dados. */
function taxaDeFalta(agendamentos: { status: string }[]): ClinicsNoShowGroupDto {
  const attended = agendamentos.filter((a) => a.status === 'attended').length;
  const noShow = agendamentos.filter((a) => a.status === 'no_show').length;
  return { attended, noShow, rate: attended + noShow === 0 ? null : noShow / (attended + noShow) };
}

/**
 * A unidade: a informada (mesmo arquivada, o histórico dela vale) ou, sem ela,
 * a única ativa. Com mais de uma ativa, a escolha é obrigatória.
 */
async function unidadeDaMetrica(db: Db, unitId?: string): Promise<Unidade> {
  if (unitId) {
    const unidade = (await db.clinicsUnit.findFirst({
      where: { id: unitId },
      select: { id: true, timezone: true },
    })) as Unidade | null;
    if (!unidade) throw new NotFoundException('Unidade não encontrada');
    return unidade;
  }
  const ativas = (await db.clinicsUnit.findMany({
    where: { archivedAt: null },
    select: { id: true, timezone: true },
    take: 2,
  })) as Unidade[];
  if (ativas.length !== 1) throw new BadRequestException('Informe a unidade');
  return ativas[0];
}
