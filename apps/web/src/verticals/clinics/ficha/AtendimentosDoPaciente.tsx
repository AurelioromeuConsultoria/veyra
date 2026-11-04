import { useQuery } from '@tanstack/react-query';
import {
  CLINICS_APPOINTMENTS_MAX_RANGE_DAYS,
  horaLocal,
  somarDias,
  type ClinicsAppointmentDto,
  type ClinicsAppointmentStatus,
  type ClinicsUnitDto,
} from '@veyra/contracts/verticals/clinics';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/ui/button';
import { EmptyState, Panel } from '../../../components/ui/page';
import { StatusChip } from '../../../components/ui/status';
import { api, ApiError, toQuery } from '../../../lib/api';
import { AGENDA_KEY, ROTULO_DO_ESTADO, ROTULO_DO_MOTIVO, TOM_DO_ESTADO } from '../agenda/slots';
import { dataCurta } from '../continuidade';
import { CLINICS_AGENDA_PATH } from '../nav';

/**
 * Os agendamentos do paciente na ficha (ADR-062 adendo 1, A4): o próximo
 * horário e a aba Atendimentos, pela MESMA rota da agenda (`patientId` e
 * intervalo), com a mesma chave (`clinics:schedule:read`, a da porta da ficha)
 * e o mesmo recorte de campo do servidor. Nada aqui é dado de atendimento:
 * o estado é o operacional da agenda.
 */

/**
 * O dia de HOJE na unidade (a mesma consulta do catálogo que a ficha já faz).
 * Com unidades em fusos diferentes, vale a primeira: o dia é só o ponto de
 * partida do intervalo, e cada horário vem lido no fuso da sua unidade.
 */
export function useHojeDaUnidade(): { hoje: string | null; falhou: boolean } {
  const unidades = useQuery({
    queryKey: ['clinics', 'catalog', 'units'],
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
  });
  const fuso = unidades.data?.[0]?.timezone ?? 'America/Sao_Paulo';
  return {
    hoje: unidades.data && !unidades.isError ? horaLocal(new Date(), fuso).data : null,
    falhou: unidades.isError,
  };
}

/** Os horários do paciente num intervalo local (até 31 dias, o teto do contrato). */
export function useAgendamentosDoPaciente(
  pacienteId: string,
  de: string | null,
  ate: string | null,
) {
  return useQuery({
    // debaixo da chave da agenda: marcar, remarcar ou mudar o estado recarrega
    queryKey: [...AGENDA_KEY, 'paciente', pacienteId, de, ate],
    queryFn: () =>
      api.get<ClinicsAppointmentDto[]>(
        `/api/clinics/appointments${toQuery({
          patientId: pacienteId,
          from: de ?? undefined,
          to: ate ?? undefined,
        })}`,
      ),
    enabled: de !== null && ate !== null,
  });
}

/** Estados de um horário que ainda vai acontecer (ou está acontecendo). */
const AINDA_VAI: readonly ClinicsAppointmentStatus[] = ['scheduled', 'confirmed', 'arrived'];

/**
 * O próximo horário do paciente: o primeiro, dentro de 31 dias a partir de
 * hoje, que ainda não terminou e não foi cancelado nem marcado como falta.
 */
export function useProximoHorario(pacienteId: string) {
  const { hoje, falhou } = useHojeDaUnidade();
  const ate = hoje ? somarDias(hoje, CLINICS_APPOINTMENTS_MAX_RANGE_DAYS - 1) : null;
  const consulta = useAgendamentosDoPaciente(pacienteId, hoje, ate);
  const agora = Date.now();
  const proximo = consulta.isError
    ? undefined
    : consulta.data?.find((a) => AINDA_VAI.includes(a.status) && Date.parse(a.endsAt) > agora);
  return {
    falhou: falhou || consulta.isError,
    carregado: consulta.data !== undefined && !consulta.isError,
    proximo: proximo ?? null,
  };
}

const formatoDoProximo = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  timeZone: 'UTC',
});
const formatoDoMesCurto = new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' });
const utc = (data: string) => {
  const [ano, mes, dia] = data.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia));
};

/** O estado do horário em português, com o motivo do cancelamento. */
export function estadoDoHorario(a: ClinicsAppointmentDto): string {
  return `${ROTULO_DO_ESTADO[a.status]}${a.cancelReason ? ` · ${ROTULO_DO_MOTIVO[a.cancelReason]}` : ''}`;
}

/** O conteúdo do cartão "Próximo horário" (o cartão em si é o do resumo da ficha). */
export function ConteudoDoProximoHorario({
  estado,
}: {
  estado: ReturnType<typeof useProximoHorario>;
}) {
  if (estado.falhou) {
    return <p className="px-5 py-4 text-data text-negative">Próximo horário indisponível agora.</p>;
  }
  if (!estado.carregado) return null;
  const a = estado.proximo;
  if (!a) {
    return (
      <p className="px-5 py-4 text-[13.5px] text-muted-fg">
        Nenhum horário nos próximos {CLINICS_APPOINTMENTS_MAX_RANGE_DAYS} dias.
      </p>
    );
  }
  const dia = utc(a.localDate);
  return (
    <div className="flex items-center gap-3.5 px-5 py-4">
      <div
        aria-hidden
        className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-[10px] bg-accent/10 text-accent"
      >
        <span className="text-[10.5px] font-semibold uppercase leading-none">
          {formatoDoMesCurto.format(dia).replace('.', '')}
        </span>
        <span className="num text-[18px] font-semibold leading-tight">{a.localDate.slice(8)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold first-letter:uppercase">
          {formatoDoProximo.format(dia)} às <span className="num">{a.localStart}</span>
        </p>
        <p className="mt-0.5 truncate text-[13px] text-muted-fg">
          {a.serviceName} · {a.professionalName}
        </p>
        <Link
          to={`${CLINICS_AGENDA_PATH}?dia=${a.localDate}`}
          className="mt-1 inline-block text-[13px] text-accent hover:underline"
        >
          Ver na agenda
        </Link>
      </div>
      <StatusChip tom={TOM_DO_ESTADO[a.status]}>{ROTULO_DO_ESTADO[a.status]}</StatusChip>
    </div>
  );
}

const formatoDoMes = new Intl.DateTimeFormat('pt-BR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** O primeiro e o último dia do mês de `data` (no máximo 31 dias: cabe no contrato). */
function mesDe(data: string): { de: string; ate: string } {
  const de = `${data.slice(0, 8)}01`;
  const [ano, mes] = de.split('-').map(Number);
  const proximo = new Date(Date.UTC(ano, mes, 1)).toISOString().slice(0, 10);
  return { de, ate: somarDias(proximo, -1) };
}

/**
 * A aba Atendimentos: o histórico dos horários do paciente, mês a mês (o
 * intervalo da rota vai até 31 dias), com o estado de cada um.
 */
export function AtendimentosDoPaciente({ pacienteId }: { pacienteId: string }) {
  const { hoje, falhou: semHoje } = useHojeDaUnidade();
  /** um dia qualquer do mês mostrado; até escolher, o mês de hoje */
  const [mostrado, setMostrado] = useState<string | null>(null);
  const referencia = mostrado ?? hoje;
  const mes = referencia ? mesDe(referencia) : null;
  const consulta = useAgendamentosDoPaciente(pacienteId, mes?.de ?? null, mes?.ate ?? null);
  // com erro (inclusive numa recarga), nada de dado antigo (classe S)
  const linhas = consulta.isError ? [] : (consulta.data ?? []);

  return (
    <section aria-label="Atendimentos do paciente" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em]">Atendimentos</h2>
        {mes ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Mês anterior"
              onClick={() => setMostrado(somarDias(mes.de, -1))}
            >
              <ChevronLeft size={14} />
            </Button>
            <span className="min-w-[9rem] text-center text-[14px] font-medium first-letter:uppercase">
              {formatoDoMes.format(utc(mes.de))}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Próximo mês"
              onClick={() => setMostrado(somarDias(mes.ate, 1))}
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        ) : null}
      </div>
      {semHoje || consulta.isError ? (
        <p role="alert" className="text-data text-negative">
          {consulta.error instanceof ApiError && consulta.error.status === 422
            ? consulta.error.message
            : 'Não foi possível carregar os atendimentos.'}
        </p>
      ) : null}
      {!semHoje && consulta.isPending ? (
        <p className="text-body-sm text-muted-fg">Carregando os atendimentos…</p>
      ) : null}
      <Panel>
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2/50">
              {['Data', 'Horário', 'Serviço', 'Profissional', 'Estado'].map((h) => (
                <th key={h} className="px-5 py-3 text-left text-[13px] font-medium text-muted-fg">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {linhas.map((a) => (
              <tr
                key={a.id}
                aria-label={`${dataCurta(a.localDate)} ${a.localStart}, ${a.serviceName} com ${a.professionalName}`}
                className="border-b border-border/60 last:border-b-0"
              >
                <td className="num px-5 py-3 text-data">{dataCurta(a.localDate)}</td>
                <td className="num px-5 py-3 text-data">
                  {a.localStart}–{a.localEnd}
                </td>
                <td className="px-5 py-3 font-semibold">{a.serviceName}</td>
                <td className="px-5 py-3">{a.professionalName}</td>
                <td className="px-5 py-3">
                  <StatusChip tom={TOM_DO_ESTADO[a.status]}>{estadoDoHorario(a)}</StatusChip>
                </td>
              </tr>
            ))}
            {consulta.data && !consulta.isError && linhas.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <EmptyState title="Nenhum horário neste mês." />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}
