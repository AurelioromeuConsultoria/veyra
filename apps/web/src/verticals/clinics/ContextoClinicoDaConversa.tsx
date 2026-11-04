import { useQuery } from '@tanstack/react-query';
import {
  CLINICS_APPOINTMENTS_MAX_RANGE_DAYS,
  CLINICS_RESCHEDULABLE_STATUSES,
  horaLocal,
  somarDias,
  type ClinicsAppointmentDto,
  type ClinicsAppointmentStatus,
  type ClinicsPackageDto,
  type ClinicsPatientDto,
  type ClinicsServiceDto,
} from '@veyra/contracts/verticals/clinics';
import { ArrowUpRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { StatusChip } from '../../components/ui/status';
import { api, toQuery } from '../../lib/api';
import type { ContextoDaConversaProps } from '../../lib/experience';
import { hasPermission, useSession } from '../../lib/session';
import { useClinicsAccess } from './access';
import { ROTULO_DO_ESTADO, TOM_DO_ESTADO } from './agenda/slots';
import { PACKAGES_KEY, dataCurta } from './continuidade';
import { useAgendamentosDoPaciente } from './ficha/AtendimentosDoPaciente';
import { fichaDoPaciente } from './nav';
import { TETO_DOS_RETORNOS, useRetornos } from './retornos/ListaDeRetornos';
import { SugestaoDeRemarcacao } from './SugestaoDeRemarcacao';

/**
 * O contexto clínico no painel das Conversas (ADR-062, adendo 1, item 5): o
 * Clinics preenche o encaixe `contextoDaConversa` do manifesto; o Core o
 * desenha sem saber o que é.
 *
 * A chave que revela quem é paciente é `clinics:schedule:read`. Sem ela —
 * ou sem `contacts:read`, que o servidor exige para filtrar pacientes por
 * contato —, o encaixe não consulta NADA e não desenha NADA: a mesma ausência
 * para paciente, interessado e RAI. Com elas, cada bloco tem a sua chave:
 *
 * - a ficha: as chaves da porta da ficha (agenda e catálogo);
 * - o próximo horário e os retornos pendentes: a agenda;
 * - os pacotes ativos: o atendimento (`clinics:care:read`), com o alcance
 *   clínico do D8 decidido no servidor;
 * - a sugestão "Remarcar" sem IA (ADR-062 adendo 1, parte B): quem escreve na
 *   agenda (`clinics:schedule:write`), com o próximo agendamento remarcável.
 *
 * As consultas usam as MESMAS chaves de cache da ficha e da agenda: abrir a
 * ficha depois não pede de novo, e uma mudança lá se reflete aqui.
 */
export function ContextoClinicoDaConversa({ contactId }: ContextoDaConversaProps) {
  const { data: user } = useSession();
  const agenda = useClinicsAccess('clinics:schedule:read');
  const consulta = agenda === 'ready' && contactId !== null && hasPermission(user, 'contacts:read');
  const vinculo = useQuery({
    // a mesma chave da pessoa (`PessoaPage`): um pedido só
    queryKey: ['clinics', 'patients', 'by-contact', [contactId]],
    queryFn: () =>
      api.get<ClinicsPatientDto[]>(
        `/api/clinics/patients${toQuery({ contactIds: contactId ?? undefined })}`,
      ),
    enabled: consulta,
  });

  if (!consulta) return null;
  if (vinculo.isError) {
    return (
      <Bloco titulo="Clínica">
        <p className="text-data text-negative">Dados da clínica indisponíveis agora.</p>
      </Bloco>
    );
  }
  if (!vinculo.data) {
    return (
      <Bloco titulo="Clínica">
        <Espera />
      </Bloco>
    );
  }
  const paciente = vinculo.data[0];
  if (!paciente) {
    return (
      <Bloco titulo="Clínica">
        <p className="text-[13px] text-muted-fg">Sem ficha de paciente.</p>
      </Bloco>
    );
  }
  const abreFicha = hasPermission(user, 'clinics:catalog:read');
  const lePacotes = hasPermission(user, 'clinics:care:read');
  const remarca = hasPermission(user, 'clinics:schedule:write');
  return (
    <section aria-label="Contexto clínico" className="flex flex-col gap-3">
      <ProximoHorario pacienteId={paciente.id} />
      {remarca ? <Remarcacao key={paciente.id} pacienteId={paciente.id} /> : null}
      <RetornosPendentes pacienteId={paciente.id} />
      {lePacotes ? <PacotesAtivos pacienteId={paciente.id} /> : null}
      {abreFicha ? (
        <Link
          to={fichaDoPaciente(paciente.id)}
          className="inline-flex items-center justify-center gap-1.5 rounded-control border border-border-strong px-3 py-2 text-[13px] font-medium text-foreground transition-colors duration-150 hover:bg-surface-2"
        >
          Abrir a ficha do paciente <ArrowUpRight size={13} aria-hidden />
        </Link>
      ) : null}
    </section>
  );
}

function Bloco({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={titulo}
      className="flex flex-col gap-1 rounded-[12px] bg-surface-2 p-3.5"
    >
      <h3 className="text-[12.5px] font-normal text-muted-fg">{titulo}</h3>
      {children}
    </div>
  );
}

function Espera() {
  return (
    <span
      aria-hidden
      className="block h-3.5 w-2/3 animate-pulse rounded bg-border motion-reduce:animate-none"
    />
  );
}

/** Os estados que ainda vão acontecer: o horário marcado, confirmado ou em curso. */
const ESTADOS_DO_PROXIMO: readonly ClinicsAppointmentStatus[] = [
  'scheduled',
  'confirmed',
  'arrived',
];

/** O dia de hoje no fuso do navegador (a unidade pede o catálogo, que este bloco não exige). */
function hojeNoNavegador(): string {
  return horaLocal(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone).data;
}

/**
 * Os dias à frente que a janela cobre, contando hoje: o intervalo tem o teto do
 * servidor (31 dias, as duas pontas incluídas, ADR-062 adendo 1, item 1), e o
 * primeiro deles é ontem.
 */
const DIAS_A_FRENTE = CLINICS_APPOINTMENTS_MAX_RANGE_DAYS - 1;

/**
 * Os horários do paciente na janela do bloco. A janela começa ONTEM porque o
 * fuso do navegador pode estar um dia à frente do da unidade. São 31 dias:
 * ontem, hoje e os 29 seguintes, ou seja, os próximos 30 dias contando hoje
 * (no fuso do navegador, que pode diferir do da unidade em um dia na borda
 * final). A MESMA consulta (e a mesma chave) da ficha: qualquer erro, inclusive
 * um 400, aparece como indisponível.
 */
function useHorariosDaJanela(pacienteId: string) {
  const hoje = hojeNoNavegador();
  const de = somarDias(hoje, -1);
  const ate = somarDias(de, CLINICS_APPOINTMENTS_MAX_RANGE_DAYS - 1);
  return useAgendamentosDoPaciente(pacienteId, de, ate);
}

/** Em ordem de início. */
const porInicio = (a: { startsAt: string }, b: { startsAt: string }) =>
  Date.parse(a.startsAt) - Date.parse(b.startsAt);

function ProximoHorario({ pacienteId }: { pacienteId: string }) {
  const horarios = useHorariosDaJanela(pacienteId);
  // o que já terminou sai pelo instante
  const agora = Date.now();
  const proximo = (horarios.data ?? [])
    .filter((a) => ESTADOS_DO_PROXIMO.includes(a.status) && Date.parse(a.endsAt) > agora)
    .sort(porInicio)[0];
  return (
    <Bloco titulo="Próximo horário">
      {horarios.isError ? (
        <p className="text-data text-negative">Agenda indisponível agora.</p>
      ) : !horarios.data ? (
        <Espera />
      ) : !proximo ? (
        <p className="text-[13px] text-muted-fg">
          Nenhum horário nos próximos {DIAS_A_FRENTE} dias.
        </p>
      ) : (
        <>
          <p className="text-[14px] font-semibold">
            <span className="num">{dataCurta(proximo.localDate)}</span> ·{' '}
            <span className="num">{proximo.localStart}</span>
          </p>
          <p className="text-[13px] text-muted-fg">
            {proximo.serviceName} · {proximo.professionalName}
          </p>
          <StatusChip tom={TOM_DO_ESTADO[proximo.status]} className="mt-1 self-start">
            {ROTULO_DO_ESTADO[proximo.status]}
          </StatusChip>
        </>
      )}
    </Bloco>
  );
}

/**
 * A sugestão de remarcação (só montada com `clinics:schedule:write`): o
 * próximo agendamento que AINDA não começou e está marcado ou confirmado, o
 * mesmo critério do servidor (que confere de novo pelo relógio do banco). Sem
 * ele, ou com a agenda indisponível (o bloco do próximo horário já diz), nada.
 *
 * Do clique em "Confirmar" até o usuário dispensar o resultado, o agendamento
 * fica FIXADO: a invalidação da agenda depois da remarcação pode trocar o
 * próximo remarcável (o remarcado foi para depois de outro, ou o 409 de
 * estado o tirou da lista) e, com o `key`, remontar o cartão e sumir com o
 * resultado. Sair da conversa solta tudo: o Inbox remonta o painel por
 * conversa.
 */
function Remarcacao({ pacienteId }: { pacienteId: string }) {
  const horarios = useHorariosDaJanela(pacienteId);
  const [fixado, setFixado] = useState<ClinicsAppointmentDto | null>(null);
  const agora = Date.now();
  const remarcavel = (horarios.isError ? [] : (horarios.data ?? []))
    .filter(
      (a) =>
        (CLINICS_RESCHEDULABLE_STATUSES as readonly string[]).includes(a.status) &&
        Date.parse(a.startsAt) > agora,
    )
    .sort(porInicio)[0];
  const atual = fixado ?? remarcavel;
  if (!atual) return null;
  // a chave pelo agendamento: outro agendamento começa do zero
  return <SugestaoDeRemarcacao key={atual.id} agendamento={atual} fixar={setFixado} />;
}

function RetornosPendentes({ pacienteId }: { pacienteId: string }) {
  // a MESMA consulta da ficha (mesma chave): um pedido só
  const retornos = useRetornos({ patientId: pacienteId });
  const todos = retornos.isError ? [] : (retornos.data ?? []);
  const pendentes = todos.slice(0, TETO_DOS_RETORNOS).filter((r) => r.status === 'pending');
  const parcial = todos.length > TETO_DOS_RETORNOS;
  const vencidos = pendentes.filter((r) => r.overdue).length;
  const primeiro = pendentes[0];
  return (
    <Bloco titulo="Retornos pendentes">
      {retornos.isError ? (
        <p className="text-data text-negative">Retornos indisponíveis agora.</p>
      ) : !retornos.data ? (
        <Espera />
      ) : !primeiro ? (
        <p className="text-[13px] text-muted-fg">Nenhum retorno pendente.</p>
      ) : (
        <>
          <p className="text-[14px] font-semibold">
            <span className="num">
              {pendentes.length}
              {parcial ? '+' : ''}
            </span>{' '}
            {pendentes.length === 1 ? 'pendente' : 'pendentes'}
            {vencidos > 0 ? (
              <>
                {' · '}
                <span className="num">{vencidos}</span> vencido{vencidos > 1 ? 's' : ''}
              </>
            ) : null}
          </p>
          <p className="text-[13px] text-muted-fg">
            {primeiro.serviceName} · vence{' '}
            <span className="num">{dataCurta(primeiro.dueDate)}</span>
          </p>
        </>
      )}
    </Bloco>
  );
}

/** Só montado com `clinics:care:read`: sem ele, a consulta nem existe. */
function PacotesAtivos({ pacienteId }: { pacienteId: string }) {
  const { data: user } = useSession();
  // o nome do serviço vem do catálogo; sem a chave dele, o rótulo genérico
  const leCatalogo = hasPermission(user, 'clinics:catalog:read');
  const pacotes = useQuery({
    // a MESMA chave da ficha
    queryKey: [...PACKAGES_KEY, pacienteId],
    queryFn: () =>
      api.get<ClinicsPackageDto[]>(
        `/api/clinics/packages?patientId=${encodeURIComponent(pacienteId)}`,
      ),
  });
  const servicos = useQuery({
    queryKey: ['clinics', 'catalog', 'services', true],
    queryFn: () => api.get<ClinicsServiceDto[]>('/api/clinics/services?includeArchived=true'),
    enabled: leCatalogo,
  });
  // com erro, nada de dado antigo: é dado de atendimento
  const ativos = pacotes.isError ? [] : (pacotes.data ?? []).filter((p) => p.status === 'active');
  const nomeDo = (serviceId: string) =>
    servicos.data?.find((s) => s.id === serviceId)?.name ?? 'Pacote';
  return (
    <Bloco titulo="Pacotes ativos">
      {pacotes.isError ? (
        <p className="text-data text-negative">Pacotes indisponíveis agora.</p>
      ) : !pacotes.data ? (
        <Espera />
      ) : ativos.length === 0 ? (
        <p className="text-[13px] text-muted-fg">Nenhum pacote ativo.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {ativos.map((p) => (
            <li key={p.id} className="text-[14px] font-semibold">
              {nomeDo(p.serviceId)} · <span className="num">{p.remainingSessions}</span> de{' '}
              <span className="num">{p.totalSessions}</span>{' '}
              {p.remainingSessions === 1 ? 'restante' : 'restantes'}
            </li>
          ))}
        </ul>
      )}
    </Bloco>
  );
}
