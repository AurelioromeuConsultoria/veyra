import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  horaLocal,
  somarDias,
  type ClinicsAppointmentDto,
  type ClinicsPatientDto,
  type ClinicsProfessionalDto,
  type ClinicsServiceDto,
  type ClinicsUnitDto,
} from '@veyra/contracts/verticals/clinics';
import { clsx } from 'clsx';
import { CalendarPlus, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Drawer } from '../../components/ui/drawer';
import { Field, Input, Select } from '../../components/ui/input';
import { EmptyState, PageHeader } from '../../components/ui/page';
import { api, ApiError, toQuery } from '../../lib/api';
import { hasPermission, useSession } from '../../lib/session';
import { useClinicsAccess } from './access';
import { GradeDoDia, type ColunaDaGrade } from './agenda/GradeDoDia';
import { diasDaSemana, unirIntervalos } from './agenda/grade';
import { PainelDoAgendamento } from './agenda/PainelDoAgendamento';
import { AGENDA_KEY, ESTADOS_ATIVOS, diaDaSemana, horariosLivres } from './agenda/slots';

/**
 * `AAAA-MM-DD` que existe no calendário, na faixa que o servidor aceita (anos
 * 2000 a 2100) — o que vier diferente na URL é ignorado.
 */
function dataValida(valor: string | null): valor is string {
  if (!valor || !/^(20\d{2}|2100)-\d{2}-\d{2}$/.test(valor)) return false;
  try {
    return somarDias(valor, 0) === valor;
  } catch {
    return false;
  }
}

const formatoDoDia = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});
function diaLegivel(data: string): string {
  const [ano, mes, dia] = data.split('-').map(Number);
  return formatoDoDia.format(new Date(Date.UTC(ano, mes - 1, dia)));
}

/**
 * Agenda da clínica (ADR-048 adendo 5). PORTA antes de tudo, como no
 * catálogo: nada é montado nem consultado sem o status ATIVO confirmado e as
 * chaves da agenda e do catálogo. Horários sempre na hora local da UNIDADE.
 */
export function ClinicsAgendaPage() {
  const { data: user } = useSession();
  const access = useClinicsAccess('clinics:schedule:read');
  if (access === 'loading') {
    return <p className="p-6 text-body-sm text-muted-fg">Carregando…</p>;
  }
  const efetivo =
    access === 'ready' && !hasPermission(user, 'clinics:catalog:read') ? 'forbidden' : access;
  if (efetivo !== 'ready') {
    const mensagem = {
      error: {
        title: 'Não foi possível verificar o Clinics agora.',
        hint: 'Tente de novo em instantes.',
      },
      inactive: {
        title: 'O Clinics não está ativo neste workspace.',
        hint: 'A ativação é feita pela equipe da Veyra.',
      },
      forbidden: {
        title: 'Você não tem acesso à agenda da clínica.',
        hint: 'Exige ler a agenda e o catálogo. Peça a quem administra o workspace.',
      },
    }[efetivo];
    return (
      <div className="flex h-full flex-col">
        <PageHeader eyebrow="Clínica" title="Agenda da clínica" />
        <EmptyState title={mensagem.title} hint={mensagem.hint} />
      </div>
    );
  }
  return <AgendaReady />;
}

type Coluna = { id: string; nome: string; profissional: ClinicsProfessionalDto | null };

/** A visão da Agenda (ADR-062 adendo 1), na URL: `?visao=semana`; sem ela, o Dia. */
type Visao = 'dia' | 'semana';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const formatoDoDiaDaSemana = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  timeZone: 'UTC',
});
/** `segunda-feira, 04/11`: o nome de uma coluna da Semana. */
function diaDaSemanaLegivel(data: string): string {
  const [ano, mes, dia] = data.split('-').map(Number);
  return formatoDoDiaDaSemana.format(new Date(Date.UTC(ano, mes - 1, dia)));
}
/** `04/11 a 10/11/2030`. */
function semanaLegivel(dias: string[]): string {
  const curta = (d: string) => `${d.slice(8)}/${d.slice(5, 7)}`;
  return `${curta(dias[0])} a ${curta(dias[6])}/${dias[6].slice(0, 4)}`;
}

function AgendaReady() {
  const { data: user } = useSession();
  const podeMarcar = hasPermission(user, 'clinics:schedule:write');
  const podeAtender = hasPermission(user, 'clinics:care:write');
  // a correção do consumo pede as mesmas chaves do registro com pacote (ADR-059)
  const podeCorrigir = podeAtender && hasPermission(user, 'clinics:care:read');
  // o vínculo com a oportunidade (F4.4): ler exige os pipelines
  const podeVerOportunidade = hasPermission(user, 'pipelines:read');
  const minhaConta = user?.activeMembership?.membershipId ?? null;
  const [params, setParams] = useSearchParams();
  const [soMinha, setSoMinha] = useState(false);
  /** o agendamento aberto da grade, pelo id: o painel segue o dado recarregado */
  const [aberto, setAberto] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<
    | { kind: 'novo'; pacienteId?: string }
    | { kind: 'remarcar'; agendamento: ClinicsAppointmentDto }
    | null
  >(null);

  /** Muda só o que se pede na URL: o dia, a visão e o profissional ficam. */
  const mudar = (mudancas: Record<string, string | null>) =>
    setParams(
      (atual) => {
        const proximos = new URLSearchParams(atual);
        for (const [chave, valor] of Object.entries(mudancas)) {
          if (valor === null) proximos.delete(chave);
          else proximos.set(chave, valor);
        }
        return proximos;
      },
      { replace: true },
    );

  // "Agendar" da ficha (ADR-062 adendo 1): o formulário abre com o paciente
  // escolhido, uma vez; o parâmetro sai da URL para não reabrir ao recarregar
  const agendarPara = params.get('agendar');
  useEffect(() => {
    if (agendarPara === null) return;
    if (podeMarcar && UUID.test(agendarPara)) {
      setDrawer({ kind: 'novo', pacienteId: agendarPara });
    }
    mudar({ agendar: null });
    // `mudar` é recriada a cada render; o efeito segue só o parâmetro
  }, [agendarPara, podeMarcar]);

  const unidades = useQuery({
    queryKey: ['clinics', 'catalog', 'units'],
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
  });
  const profissionais = useQuery({
    queryKey: ['clinics', 'catalog', 'professionals', false],
    queryFn: () => api.get<ClinicsProfessionalDto[]>('/api/clinics/professionals'),
  });
  const servicos = useQuery({
    queryKey: ['clinics', 'catalog', 'services', false],
    queryFn: () => api.get<ClinicsServiceDto[]>('/api/clinics/services'),
  });
  const unidade = unidades.data?.[0];
  const hoje = unidade ? horaLocal(new Date(), unidade.timezone).data : null;
  const pedido = params.get('dia');
  const dia = dataValida(pedido) ? pedido : hoje;
  const visao: Visao = params.get('visao') === 'semana' ? 'semana' : 'dia';
  const dias = dia ? diasDaSemana(dia) : null;

  const ativos = (profissionais.data ?? []).filter((p) => p.archivedAt === null);
  const meus = ativos.filter((p) => p.account?.membershipId === minhaConta);
  // o profissional escolhido só vale se está entre os ativos
  const escolhido = ativos.find((p) => p.id === params.get('profissional')) ?? null;
  /** os profissionais na tela; `null` = todos os da unidade (inclusive arquivados) */
  const recorte: string[] | null = soMinha
    ? meus.map((p) => p.id)
    : escolhido
      ? [escolhido.id]
      : null;
  // a Semana de UM profissional pede só a dele ao servidor; a de vários, a da unidade
  const soUm = recorte?.length === 1 ? recorte[0] : undefined;

  const agenda = useQuery({
    queryKey:
      visao === 'dia' ? [...AGENDA_KEY, dia] : [...AGENDA_KEY, 'semana', dias?.[0], soUm ?? null],
    queryFn: () =>
      api.get<ClinicsAppointmentDto[]>(
        `/api/clinics/appointments${
          visao === 'dia'
            ? toQuery({ date: dia ?? '' })
            : toQuery({ from: dias?.[0], to: dias?.[6], professionalId: soUm })
        }`,
      ),
    // sem unidade ativa a tela não mostra a agenda: então nem a consulta (classe S)
    // e a Semana espera o catálogo, que diz de quem ela é
    enabled:
      dia !== null &&
      unidade !== undefined &&
      (visao === 'dia' || profissionais.data !== undefined),
  });

  if (unidades.isError || profissionais.isError || servicos.isError) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader eyebrow="Clínica" title="Agenda da clínica" />
        <p role="alert" className="p-6 text-data text-negative">
          Não foi possível carregar a unidade, os profissionais ou os serviços.
        </p>
      </div>
    );
  }
  if (unidades.data && unidades.data.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader eyebrow="Clínica" title="Agenda da clínica" />
        <EmptyState
          title="Nenhuma unidade ativa."
          hint="A agenda precisa de uma unidade da clínica."
        />
      </div>
    );
  }
  if (!unidade || !dia || !dias || !profissionais.data || !servicos.data) {
    return <p className="p-6 text-body-sm text-muted-fg">Carregando…</p>;
  }

  // com erro, NADA de dado antigo na tela (dado classe S) — nem no painel aberto
  const doPeriodo = (agenda.isError ? [] : (agenda.data ?? [])).filter(
    (a) => recorte === null || recorte.includes(a.professionalId),
  );
  const colunas: Coluna[] = (
    recorte === null ? ativos : ativos.filter((p) => recorte.includes(p.id))
  ).map((p) => ({ id: p.id, nome: p.name, profissional: p }));
  // agendamento de profissional ARQUIVADO (ou fora da lista) não pode sumir da tela:
  // a recepção ainda precisa vê-lo, cancelá-lo ou registrá-lo
  if (recorte === null && agenda.data && !agenda.isError) {
    const comColuna = new Set(colunas.map((c) => c.id));
    for (const a of agenda.data) {
      if (!comColuna.has(a.professionalId)) {
        comColuna.add(a.professionalId);
        colunas.push({
          id: a.professionalId,
          nome: `${a.professionalName} (arquivado)`,
          profissional: null,
        });
      }
    }
  }
  const passo = visao === 'dia' ? 1 : 7;
  const irPara = (data: string) => mudar({ dia: data });
  const selecionado = aberto ? doPeriodo.find((a) => a.id === aberto) : undefined;
  // o aberto sumiu do período (remarcado para longe, erro na recarga): o painel fecha
  if (aberto && !selecionado && (agenda.data !== undefined || agenda.isError)) setAberto(null);

  /** O expediente de um dia da semana, na unidade, de quem está na tela. */
  const expedienteDe = (pessoas: readonly ClinicsProfessionalDto[], semana: number) =>
    unirIntervalos(
      pessoas.flatMap((p) =>
        p.workingHours
          .filter((h) => h.weekday === semana && h.unitId === unidade.id)
          .map((h) => ({ inicio: h.startMinute, fim: h.endMinute })),
      ),
    );
  const naSemana = colunas.flatMap((c) => (c.profissional ? [c.profissional] : []));

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Agenda"
        meta={`${
          visao === 'dia' ? diaLegivel(dia) : `Semana de ${semanaLegivel(dias)}`
        } · hora local da unidade (${unidade.timezone})`}
      >
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={visao === 'dia' ? 'Dia anterior' : 'Semana anterior'}
            onClick={() => irPara(somarDias(dia, -passo))}
          >
            <ChevronLeft size={14} />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => hoje && irPara(hoje)}>
            Hoje
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={visao === 'dia' ? 'Próximo dia' : 'Próxima semana'}
            onClick={() => irPara(somarDias(dia, passo))}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
        <div
          role="group"
          aria-label="Visualização"
          className="flex overflow-hidden rounded-control border border-border"
        >
          {(['dia', 'semana'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={visao === v}
              onClick={() => mudar({ visao: v === 'semana' ? 'semana' : null })}
              className={clsx(
                'h-8 px-3 text-[13px] font-medium',
                visao === v
                  ? 'bg-frame text-frame-fg'
                  : 'bg-surface text-muted-fg hover:bg-surface-2',
              )}
            >
              {v === 'dia' ? 'Dia' : 'Semana'}
            </button>
          ))}
        </div>
        <Select
          size="sm"
          aria-label="Filtrar por profissional"
          value={escolhido?.id ?? ''}
          disabled={soMinha}
          onChange={(e) => mudar({ profissional: e.target.value || null })}
        >
          <option value="">Todos os profissionais</option>
          {ativos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        {meus.length > 0 ? (
          <label className="flex items-center gap-2 text-body-sm text-muted-fg">
            <input
              type="checkbox"
              checked={soMinha}
              onChange={(e) => setSoMinha(e.target.checked)}
            />
            Minha agenda
          </label>
        ) : null}
        {podeMarcar ? (
          <Button variant="primary" size="sm" onClick={() => setDrawer({ kind: 'novo' })}>
            <CalendarPlus size={14} /> Agendar
          </Button>
        ) : null}
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-7">
        {agenda.isError ? (
          <p role="alert" className="text-data text-negative">
            {/* a recusa acima do teto diz o porquê (ADR-055, adendo 4) */}
            {agenda.error instanceof ApiError && agenda.error.status === 422
              ? agenda.error.message
              : visao === 'dia'
                ? 'Não foi possível carregar a agenda do dia.'
                : 'Não foi possível carregar a agenda da semana.'}
          </p>
        ) : null}
        {agenda.isPending ? (
          <p className="text-body-sm text-muted-fg">
            {visao === 'dia' ? 'Carregando a agenda do dia…' : 'Carregando a agenda da semana…'}
          </p>
        ) : null}
        {colunas.length === 0 ? (
          <EmptyState
            title="Nenhum profissional ativo."
            hint="Cadastre profissionais e o expediente deles no catálogo."
          />
        ) : visao === 'dia' ? (
          <GradeDoDia
            colunas={colunas.map((coluna): ColunaDaGrade => ({
              id: coluna.id,
              nome: coluna.nome,
              expediente: coluna.profissional
                ? coluna.profissional.workingHours
                    .filter((h) => h.weekday === diaDaSemana(dia) && h.unitId === unidade.id)
                    .map((h) => ({ inicio: h.startMinute, fim: h.endMinute }))
                : null,
              agendamentos: doPeriodo.filter((a) => a.professionalId === coluna.id),
            }))}
            carregado={agenda.data !== undefined && !agenda.isError}
            dia={dia}
            fuso={unidade.timezone}
            onAbrir={setAberto}
          />
        ) : (
          <GradeDoDia
            colunas={dias.map((data): ColunaDaGrade => ({
              id: data,
              nome: diaDaSemanaLegivel(data),
              data,
              expediente: expedienteDe(naSemana, diaDaSemana(data)),
              agendamentos: doPeriodo.filter((a) => a.localDate === data),
            }))}
            carregado={agenda.data !== undefined && !agenda.isError}
            dia={dias[0]}
            fuso={unidade.timezone}
            onAbrir={setAberto}
            onAbrirDia={(data) => mudar({ dia: data, visao: null })}
            mostrarProfissional={soUm === undefined}
          />
        )}
      </div>

      {selecionado ? (
        <PainelDoAgendamento
          key={selecionado.id}
          agendamento={selecionado}
          podeMarcar={podeMarcar}
          podeAtender={podeAtender}
          podeCorrigir={podeCorrigir}
          podeVerOportunidade={podeVerOportunidade}
          fuso={unidade.timezone}
          // profissional arquivado: o drawer de remarcar não teria serviços nem horários
          podeRemarcar={podeMarcar && ativos.some((p) => p.id === selecionado.professionalId)}
          onRemarcar={() => {
            setAberto(null);
            setDrawer({ kind: 'remarcar', agendamento: selecionado });
          }}
          profissionais={ativos}
          onFechar={() => setAberto(null)}
        />
      ) : null}

      <Drawer
        open={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        title={drawer?.kind === 'remarcar' ? 'Remarcar' : 'Agendar'}
      >
        {drawer ? (
          <FormularioDeAgenda
            unidade={unidade}
            diaInicial={drawer.kind === 'remarcar' ? drawer.agendamento.localDate : dia}
            profissionais={ativos}
            servicos={servicos.data.filter((s) => s.archivedAt === null)}
            remarcando={drawer.kind === 'remarcar' ? drawer.agendamento : null}
            pacienteInicialId={drawer.kind === 'novo' ? drawer.pacienteId : undefined}
            onDone={(data) => {
              setDrawer(null);
              irPara(data);
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

function FormularioDeAgenda({
  unidade,
  diaInicial,
  profissionais,
  servicos,
  remarcando,
  pacienteInicialId,
  onDone,
}: {
  unidade: ClinicsUnitDto;
  diaInicial: string;
  profissionais: ClinicsProfessionalDto[];
  servicos: ClinicsServiceDto[];
  remarcando: ClinicsAppointmentDto | null;
  /** o "Agendar" da ficha: o paciente já escolhido (ADR-062 adendo 1) */
  pacienteInicialId?: string;
  onDone: (data: string) => void;
}) {
  const queryClient = useQueryClient();
  const [termo, setTermo] = useState('');
  const [busca, setBusca] = useState('');
  const [escolhidoNaBusca, setEscolhidoNaBusca] = useState<ClinicsPatientDto | null>(null);
  /** a pessoa trocou o paciente que veio da ficha: vale a busca */
  const [trocou, setTrocou] = useState(false);
  const vindoDaFicha = remarcando === null && pacienteInicialId !== undefined && !trocou;
  // o mesmo pedido (e a mesma chave) da ficha: o paciente pela rota da agenda
  const inicial = useQuery({
    queryKey: ['clinics', 'patients', 'one', pacienteInicialId],
    queryFn: () => api.get<ClinicsPatientDto>(`/api/clinics/patients/${pacienteInicialId}`),
    enabled: vindoDaFicha,
  });
  // com erro, ninguém escolhido por engano
  const paciente = vindoDaFicha
    ? inicial.isError
      ? null
      : (inicial.data ?? null)
    : escolhidoNaBusca;
  // serviço original arquivado: o servidor recusaria; a pessoa escolhe outro
  const servicoOriginalAtivo =
    remarcando !== null && servicos.some((s) => s.id === remarcando.serviceId);
  const [serviceId, setServiceId] = useState(servicoOriginalAtivo ? remarcando!.serviceId : '');
  const [professionalId, setProfessionalId] = useState(remarcando?.professionalId ?? '');
  const [data, setData] = useState(diaInicial);
  const [horario, setHorario] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setBusca(termo.trim()), 250);
    return () => clearTimeout(timer);
  }, [termo]);

  // escolher UM paciente sem baixar a lista inteira (minimização, classe S)
  const encontrados = useQuery({
    queryKey: ['clinics', 'patients', 'search', busca],
    queryFn: () =>
      api.get<ClinicsPatientDto[]>(`/api/clinics/patients${toQuery({ search: busca, limit: 20 })}`),
    enabled: remarcando === null && busca.length >= 2,
    staleTime: 30_000,
  });
  const doDia = useQuery({
    queryKey: [...AGENDA_KEY, data],
    queryFn: () =>
      api.get<ClinicsAppointmentDto[]>(`/api/clinics/appointments${toQuery({ date: data })}`),
    enabled: dataValida(data),
  });

  const profissional = profissionais.find((p) => p.id === professionalId);
  // remarcar mantém o profissional: só os serviços que ele faz
  const servicosPossiveis = remarcando
    ? servicos.filter((s) => profissional?.serviceIds.includes(s.id))
    : servicos;
  const servico = servicos.find((s) => s.id === serviceId);
  const habilitados = profissionais.filter((p) => serviceId && p.serviceIds.includes(serviceId));
  const duracao =
    remarcando && serviceId === remarcando.serviceId
      ? (Date.parse(remarcando.endsAt) - Date.parse(remarcando.startsAt)) / 60_000
      : servico?.durationMin;
  const opcoes = useMemo(
    () =>
      profissional && duracao && doDia.data && dataValida(data)
        ? horariosLivres({
            data,
            timezone: unidade.timezone,
            duracaoMin: duracao,
            intervalos: profissional.workingHours.filter((h) => h.unitId === unidade.id),
            ocupados: doDia.data.filter(
              (a) =>
                a.professionalId === professionalId &&
                ESTADOS_ATIVOS.includes(a.status) &&
                a.id !== remarcando?.id,
            ),
          })
        : [],
    [profissional, duracao, doDia.data, data, unidade, professionalId, remarcando],
  );
  const escolhida = opcoes.find((o) => o.valor === horario);

  const salvar = useMutation({
    mutationFn: () => {
      const quando = {
        date: data,
        time: escolhida!.hora,
        ...(escolhida!.utcOffset ? { utcOffset: escolhida!.utcOffset } : {}),
      };
      return remarcando
        ? api.post<ClinicsAppointmentDto>(`/api/clinics/appointments/${remarcando.id}/reschedule`, {
            ...quando,
            ...(serviceId !== remarcando.serviceId ? { serviceId } : {}),
            // a cobertura de uma colega (ADR-061): outro profissional, só antes do atendimento
            ...(professionalId !== remarcando.professionalId ? { professionalId } : {}),
          })
        : api.post<ClinicsAppointmentDto>('/api/clinics/appointments', {
            patientId: paciente!.id,
            professionalId,
            serviceId,
            ...quando,
          });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
      onDone(data);
    },
    // ocupado por outra pessoa no meio do caminho: recarrega os horários livres
    onError: () => void queryClient.invalidateQueries({ queryKey: AGENDA_KEY }),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (escolhida) salvar.mutate();
      }}
    >
      {remarcando ? (
        <p className="text-body-sm text-muted-fg">
          {remarcando.patientName} com {remarcando.professionalName}.{' '}
          {servicoOriginalAtivo
            ? 'A duração registrada é mantida; trocar o serviço usa a duração dele.'
            : `O serviço ${remarcando.serviceName} foi arquivado: escolha outro.`}
        </p>
      ) : vindoDaFicha ? (
        <div role="group" aria-label="Paciente" className="space-y-1.5">
          <p className="text-body-sm font-medium">Paciente</p>
          {inicial.isError ? (
            <p role="alert" className="text-data text-negative">
              Não foi possível carregar o paciente. Busque pelo nome.
            </p>
          ) : !inicial.data ? (
            <p className="text-body-sm text-muted-fg">Carregando o paciente…</p>
          ) : (
            <p className="text-body-sm">{inicial.data.name}</p>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => setTrocou(true)}>
            Escolher outro paciente
          </Button>
        </div>
      ) : (
        <>
          <Field label="Buscar paciente" hint="Pelo nome (mínimo 2 letras).">
            <Input
              autoFocus
              maxLength={80}
              value={termo}
              onChange={(e) => {
                setTermo(e.target.value);
                setEscolhidoNaBusca(null);
              }}
            />
          </Field>
          {/* com erro (inclusive numa recarga), nada da busca anterior fica escolhível */}
          {encontrados.isError ? (
            <p role="alert" className="text-data text-negative">
              Não foi possível buscar pacientes.
            </p>
          ) : null}
          {encontrados.data && !encontrados.isError ? (
            <fieldset className="space-y-1">
              <legend className="sr-only">Paciente</legend>
              {encontrados.data.length === 0 ? (
                <p className="text-body-sm text-muted-fg">
                  Nenhum paciente com esse nome. Cadastre em Pacientes.
                </p>
              ) : null}
              {encontrados.data.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-body-sm">
                  <input
                    type="radio"
                    name="paciente"
                    checked={paciente?.id === p.id}
                    onChange={() => setEscolhidoNaBusca(p)}
                  />
                  {p.name}
                </label>
              ))}
            </fieldset>
          ) : null}
        </>
      )}
      <Field label="Serviço">
        <Select
          full
          value={serviceId}
          onChange={(e) => {
            setServiceId(e.target.value);
            setHorario('');
            if (!remarcando) setProfessionalId('');
          }}
        >
          <option value="" disabled>
            Escolha o serviço
          </option>
          {servicosPossiveis.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.durationMin} min
            </option>
          ))}
        </Select>
      </Field>
      {
        <Field
          label="Profissional"
          hint={
            remarcando
              ? 'Para cobrir uma colega, troque o profissional antes do atendimento.'
              : 'Só quem está habilitado para o serviço.'
          }
        >
          <Select
            full
            value={professionalId}
            onChange={(e) => {
              setProfessionalId(e.target.value);
              setHorario('');
              // remarcando, os serviços seguem o profissional escolhido
              const outro = profissionais.find((p) => p.id === e.target.value);
              if (remarcando && serviceId && !outro?.serviceIds.includes(serviceId)) {
                setServiceId('');
              }
            }}
          >
            <option value="" disabled>
              Escolha o profissional
            </option>
            {habilitados.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      }
      <Field label="Data" hint="Na hora local da unidade.">
        <Input
          type="date"
          value={data}
          onChange={(e) => {
            setData(e.target.value);
            setHorario('');
          }}
        />
      </Field>
      <Field label="Horário" hint="Só horários livres dentro do expediente.">
        <Select full value={horario} onChange={(e) => setHorario(e.target.value)}>
          <option value="" disabled>
            {opcoes.length === 0 ? 'Nenhum horário livre' : 'Escolha o horário'}
          </option>
          {opcoes.map((o) => (
            <option key={o.valor} value={o.valor}>
              {o.rotulo}
            </option>
          ))}
        </Select>
      </Field>
      {salvar.error ? (
        <p role="alert" className="text-data text-negative">
          {salvar.error instanceof ApiError ? salvar.error.message : 'Não foi possível salvar.'}
        </p>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        disabled={!escolhida || (!remarcando && !paciente) || salvar.isPending}
      >
        {salvar.isPending ? 'Salvando…' : remarcando ? 'Remarcar' : 'Agendar'}
      </Button>
    </form>
  );
}
