import { useQuery } from '@tanstack/react-query';
import {
  horaLocal,
  somarDias,
  type ClinicsAppointmentDto,
  type ClinicsAppointmentStatus,
  type ClinicsPackageDto,
  type ClinicsPatientDto,
  type ClinicsServiceDto,
} from '@veyra/contracts/verticals/clinics';
import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { StatusChip } from '../../components/ui/status';
import { api, ApiError, toQuery } from '../../lib/api';
import type { ContextoDaConversaProps } from '../../lib/experience';
import { hasPermission, useSession } from '../../lib/session';
import { useClinicsAccess } from './access';
import { AGENDA_KEY, ROTULO_DO_ESTADO, TOM_DO_ESTADO } from './agenda/slots';
import { PACKAGES_KEY, dataCurta } from './continuidade';
import { fichaDoPaciente } from './nav';
import { TETO_DOS_RETORNOS, useRetornos } from './retornos/ListaDeRetornos';

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
 *   clínico do D8 decidido no servidor.
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
  return (
    <section aria-label="Contexto clínico" className="flex flex-col gap-3">
      <ProximoHorario pacienteId={paciente.id} />
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

function ProximoHorario({ pacienteId }: { pacienteId: string }) {
  // a janela começa ONTEM: o fuso do navegador pode estar um dia à frente da
  // unidade. O intervalo segue com 30 dias de distância (o teto do servidor é
  // 31 dias, ADR-062 adendo 1, item 1); o que já passou sai pelo instante
  const hoje = hojeNoNavegador();
  const from = somarDias(hoje, -1);
  const to = somarDias(hoje, 29);
  const horarios = useQuery({
    queryKey: [...AGENDA_KEY, 'patient', pacienteId, from, to],
    queryFn: () =>
      api.get<ClinicsAppointmentDto[]>(
        `/api/clinics/appointments${toQuery({ patientId: pacienteId, from, to })}`,
      ),
    // um 400 (o servidor que ainda não aceita o intervalo) não melhora repetindo
    retry: false,
  });
  // 400 = a consulta por paciente não existe neste servidor: sem dado, sem bloco
  if (horarios.error instanceof ApiError && horarios.error.status === 400) return null;
  const agora = Date.now();
  const proximo = (horarios.data ?? [])
    .filter((a) => ESTADOS_DO_PROXIMO.includes(a.status) && Date.parse(a.endsAt) > agora)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
  return (
    <Bloco titulo="Próximo horário">
      {horarios.isError ? (
        <p className="text-data text-negative">Agenda indisponível agora.</p>
      ) : !horarios.data ? (
        <Espera />
      ) : !proximo ? (
        <p className="text-[13px] text-muted-fg">Nenhum horário nos próximos 30 dias.</p>
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
