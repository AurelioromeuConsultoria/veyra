import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  inicioDoDiaLocal,
  type ClinicsAppointmentStatus,
  type ClinicsNoShowDto,
  type ClinicsNoShowQuery,
} from '@veyra/contracts/verticals/clinics';
import { PrismaService } from '../../../prisma/prisma.service';
import { agoraDoBanco } from '../../../prisma/relogio-do-banco';

/** Ainda sem desfecho: com o início já passado, é um "passado sem desfecho". */
const SEM_DESFECHO: ClinicsAppointmentStatus[] = ['scheduled', 'confirmed', 'arrived'];

/**
 * Taxa de faltas (ADR-048 adendo 7, item 7 e aprovação da F3.3; F3.3a). Só
 * agregados, sem persistência, sobre o índice `(workspaceId, unitId, startsAt)`.
 *
 * - O período são datas LOCAIS da unidade, `from` inclusivo e `to` exclusivo,
 *   pelo INÍCIO do agendamento. Os limites são o início de cada dia local
 *   (`inicioDoDiaLocal`): um dia nem sempre tem 24 horas.
 * - A taxa é `faltas / (atendidos + faltas)`. "Sem dados" (`null`) só quando
 *   atendidos + faltas = 0; com atendidos e nenhuma falta, é 0, legítima.
 * - Os cancelados e os passados sem desfecho ficam à parte, fora da conta.
 *   "Passado" é pelo relógio do BANCO: um instante por operação.
 *
 * As duas contagens são consultas separadas: uma mudança de estado entre elas
 * pode deslocar uma contagem em um, o que se aceita numa métrica operacional.
 */
@Injectable()
export class ClinicsNoShowService {
  constructor(private readonly prisma: PrismaService) {}

  async apurar(query: ClinicsNoShowQuery): Promise<ClinicsNoShowDto> {
    const unidade = await this.unidade(query.unitId);
    const inicio = inicioDoDiaLocal(query.from, unidade.timezone);
    const fim = inicioDoDiaLocal(query.to, unidade.timezone);
    // fora de transação, uma leitura só (a exceção do `raw`, como implementada)
    const agora = await agoraDoBanco(this.prisma);
    const base = {
      unitId: unidade.id,
      ...(query.professionalId ? { professionalId: query.professionalId } : {}),
      ...(query.serviceId ? { serviceId: query.serviceId } : {}),
    };
    const porEstado = (await this.prisma.db.clinicsAppointment.groupBy({
      by: ['status'],
      where: { ...base, startsAt: { gte: inicio, lt: fim } },
      _count: { _all: true },
    } as never)) as unknown as { status: ClinicsAppointmentStatus; _count: { _all: number } }[];
    const corte = agora.getTime() < fim.getTime() ? agora : fim;
    const pendingPast =
      corte.getTime() > inicio.getTime()
        ? await this.prisma.db.clinicsAppointment.count({
            where: { ...base, status: { in: SEM_DESFECHO }, startsAt: { gte: inicio, lt: corte } },
          } as never)
        : 0;
    const conta = (estado: ClinicsAppointmentStatus) =>
      porEstado.find((linha) => linha.status === estado)?._count._all ?? 0;
    const attended = conta('attended');
    const noShow = conta('no_show');
    const denominador = attended + noShow;
    return {
      from: query.from,
      to: query.to,
      unitId: unidade.id,
      attended,
      noShow,
      rate: denominador === 0 ? null : noShow / denominador,
      pendingPast,
      canceled: conta('canceled'),
    };
  }

  /**
   * A unidade: a informada (mesmo arquivada, porque o histórico dela continua
   * valendo) ou, sem ela, a única ativa.
   */
  private async unidade(unitId?: string): Promise<{ id: string; timezone: string }> {
    if (unitId) {
      const unidade = (await this.prisma.db.clinicsUnit.findFirst({
        where: { id: unitId },
        select: { id: true, timezone: true },
      })) as unknown as { id: string; timezone: string } | null;
      if (!unidade) throw new NotFoundException('Unidade não encontrada');
      return unidade;
    }
    const ativas = (await this.prisma.db.clinicsUnit.findMany({
      where: { archivedAt: null },
      select: { id: true, timezone: true },
      take: 2,
    })) as unknown as { id: string; timezone: string }[];
    if (ativas.length !== 1) throw new BadRequestException('Informe a unidade');
    return ativas[0];
  }
}
