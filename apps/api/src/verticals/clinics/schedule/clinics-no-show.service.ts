import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  inicioDoDiaLocal,
  segundaDaSemana,
  somarDias,
  type ClinicsAppointmentStatus,
  type ClinicsNoShowCountsDto,
  type ClinicsNoShowDto,
  type ClinicsNoShowProfessionalDto,
  type ClinicsNoShowQuery,
  type ClinicsNoShowWeekDto,
} from '@veyra/contracts/verticals/clinics';
import { PrismaService } from '../../../prisma/prisma.service';
import { agoraDoBanco } from '../../../prisma/relogio-do-banco';

/** Ainda sem desfecho: com o início já passado, é um "passado sem desfecho". */
const SEM_DESFECHO: ClinicsAppointmentStatus[] = ['scheduled', 'confirmed', 'arrived'];

/** O filtro comum a todas as consultas da apuração (unidade e recortes). */
interface Base {
  unitId: string;
  professionalId?: string;
  serviceId?: string;
}

/** As contagens cruas de um grupo, antes da taxa. */
interface Contagem {
  attended: number;
  noShow: number;
  pendingPast: number;
  canceled: number;
}

const zerada = (): Contagem => ({ attended: 0, noShow: 0, pendingPast: 0, canceled: 0 });

/** A MESMA conta do total, para o total e para cada item de uma série. */
function comTaxa(c: Contagem): ClinicsNoShowCountsDto {
  const denominador = c.attended + c.noShow;
  return {
    attended: c.attended,
    noShow: c.noShow,
    rate: denominador === 0 ? null : c.noShow / denominador,
    pendingPast: c.pendingPast,
    canceled: c.canceled,
  };
}

/** O total como SOMA da série: a soma bate com o total por construção. */
function somar(itens: Contagem[]): Contagem {
  return itens.reduce(
    (t, c) => ({
      attended: t.attended + c.attended,
      noShow: t.noShow + c.noShow,
      pendingPast: t.pendingPast + c.pendingPast,
      canceled: t.canceled + c.canceled,
    }),
    zerada(),
  );
}

/**
 * Soma `n` agendamentos de um estado à contagem. "Passado sem desfecho" é o
 * estado sem desfecho com o início antes do `corte` (o agora do banco, ou o
 * fim do período, o que vier antes), como no total.
 */
function contar(
  c: Contagem,
  status: ClinicsAppointmentStatus,
  n: number,
  startsAt: Date,
  corte: Date,
) {
  if (status === 'attended') c.attended += n;
  else if (status === 'no_show') c.noShow += n;
  else if (status === 'canceled') c.canceled += n;
  else if (SEM_DESFECHO.includes(status) && startsAt.getTime() < corte.getTime()) {
    c.pendingPast += n;
  }
}

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
 *
 * Com `groupBy` (ADR-062 adendo 1, item A2), a resposta traz também a série,
 * por semana ou por profissional, com a mesma conta; o total é então a SOMA da
 * série, apurada nas mesmas leituras, e por isso a soma sempre bate.
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
    const base: Base = {
      unitId: unidade.id,
      ...(query.professionalId ? { professionalId: query.professionalId } : {}),
      ...(query.serviceId ? { serviceId: query.serviceId } : {}),
    };
    const corte = agora.getTime() < fim.getTime() ? agora : fim;
    const cabeca = { from: query.from, to: query.to, unitId: unidade.id };

    if (query.groupBy === 'week') {
      const weeks = await this.porSemana(query, unidade.timezone, base, inicio, fim, corte);
      return {
        ...cabeca,
        ...comTaxa(somar(weeks.map((s) => s.contagem))),
        weeks: weeks.map((s) => s.dto),
      };
    }
    if (query.groupBy === 'professional') {
      const professionals = await this.porProfissional(base, inicio, fim, corte);
      return {
        ...cabeca,
        ...comTaxa(somar(professionals.map((p) => p.contagem))),
        professionals: professionals.map((p) => p.dto),
      };
    }

    const porEstado = (await this.prisma.db.clinicsAppointment.groupBy({
      by: ['status'],
      where: { ...base, startsAt: { gte: inicio, lt: fim } },
      _count: { _all: true },
    } as never)) as unknown as { status: ClinicsAppointmentStatus; _count: { _all: number } }[];
    const pendingPast =
      corte.getTime() > inicio.getTime()
        ? await this.prisma.db.clinicsAppointment.count({
            where: { ...base, status: { in: SEM_DESFECHO }, startsAt: { gte: inicio, lt: corte } },
          } as never)
        : 0;
    const conta = (estado: ClinicsAppointmentStatus) =>
      porEstado.find((linha) => linha.status === estado)?._count._all ?? 0;
    return {
      ...cabeca,
      ...comTaxa({
        attended: conta('attended'),
        noShow: conta('no_show'),
        pendingPast,
        canceled: conta('canceled'),
      }),
    };
  }

  /**
   * A série por SEMANA, de segunda a domingo em datas locais, recortada ao
   * período. Os limites de cada semana são o início do dia local, como os do
   * período: a primeira começa no início de `from`, a última termina no de
   * `to`, e as vizinhas compartilham o limite. Uma leitura só, agrupada por
   * início e estado; a semana de cada grupo sai do instante.
   */
  private async porSemana(
    query: ClinicsNoShowQuery,
    fuso: string,
    base: Base,
    inicio: Date,
    fim: Date,
    corte: Date,
  ): Promise<{ dto: ClinicsNoShowWeekDto; contagem: Contagem }[]> {
    // `AAAA-MM-DD` compara como data
    const semanas: { weekStart: string; from: string; to: string; ate: number }[] = [];
    for (let seg = segundaDaSemana(query.from); seg < query.to; seg = somarDias(seg, 7)) {
      const proxima = somarDias(seg, 7);
      const ate = proxima < query.to ? proxima : query.to;
      semanas.push({
        weekStart: seg,
        from: seg < query.from ? query.from : seg,
        to: ate,
        ate: inicioDoDiaLocal(ate, fuso).getTime(),
      });
    }
    const contagens = semanas.map(zerada);
    const grupos = (await this.prisma.db.clinicsAppointment.groupBy({
      by: ['startsAt', 'status'],
      where: { ...base, startsAt: { gte: inicio, lt: fim } },
      _count: { _all: true },
    } as never)) as unknown as {
      startsAt: Date;
      status: ClinicsAppointmentStatus;
      _count: { _all: number };
    }[];
    for (const g of grupos) {
      // a primeira semana cujo fim (exclusivo) vem depois do início; existe,
      // porque a leitura só traz o que começa antes do fim do período
      const t = g.startsAt.getTime();
      let lo = 0;
      let hi = semanas.length - 1;
      while (lo < hi) {
        const meio = (lo + hi) >> 1;
        if (semanas[meio].ate > t) hi = meio;
        else lo = meio + 1;
      }
      contar(contagens[lo], g.status, g._count._all, g.startsAt, corte);
    }
    return semanas.map((s, i) => ({
      dto: { weekStart: s.weekStart, from: s.from, to: s.to, ...comTaxa(contagens[i]) },
      contagem: contagens[i],
    }));
  }

  /**
   * A série por PROFISSIONAL: os que têm algum agendamento no período,
   * arquivados inclusive, em ordem de nome. As mesmas duas leituras do total,
   * agrupadas por profissional.
   */
  private async porProfissional(
    base: Base,
    inicio: Date,
    fim: Date,
    corte: Date,
  ): Promise<{ dto: ClinicsNoShowProfessionalDto; contagem: Contagem }[]> {
    const porEstado = (await this.prisma.db.clinicsAppointment.groupBy({
      by: ['professionalId', 'status'],
      where: { ...base, startsAt: { gte: inicio, lt: fim } },
      _count: { _all: true },
    } as never)) as unknown as {
      professionalId: string;
      status: ClinicsAppointmentStatus;
      _count: { _all: number };
    }[];
    const pendentes =
      corte.getTime() > inicio.getTime()
        ? ((await this.prisma.db.clinicsAppointment.groupBy({
            by: ['professionalId'],
            where: { ...base, status: { in: SEM_DESFECHO }, startsAt: { gte: inicio, lt: corte } },
            _count: { _all: true },
          } as never)) as unknown as { professionalId: string; _count: { _all: number } }[])
        : [];
    const contagens = new Map<string, Contagem>();
    const de = (id: string) => {
      let c = contagens.get(id);
      if (!c) contagens.set(id, (c = zerada()));
      return c;
    };
    for (const g of porEstado) {
      const c = de(g.professionalId);
      if (g.status === 'attended') c.attended += g._count._all;
      else if (g.status === 'no_show') c.noShow += g._count._all;
      else if (g.status === 'canceled') c.canceled += g._count._all;
      // os sem desfecho entram pela segunda leitura, que tem o corte do "passado";
      // aqui só garantem que o profissional aparece na série
    }
    for (const p of pendentes) de(p.professionalId).pendingPast += p._count._all;
    if (contagens.size === 0) return [];
    const nomes = new Map(
      (
        (await this.prisma.db.clinicsProfessional.findMany({
          where: { id: { in: [...contagens.keys()] } },
          select: { id: true, name: true },
        })) as unknown as { id: string; name: string }[]
      ).map((p) => [p.id, p.name]),
    );
    return [...contagens.entries()]
      .map(([id, contagem]) => ({
        dto: { professionalId: id, professionalName: nomes.get(id) ?? '', ...comTaxa(contagem) },
        contagem,
      }))
      .sort(
        (a, b) =>
          a.dto.professionalName.localeCompare(b.dto.professionalName, 'pt-BR') ||
          a.dto.professionalId.localeCompare(b.dto.professionalId),
      );
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
