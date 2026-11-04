import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationPageDto } from '@veyra/contracts';
import {
  horaLocal,
  somarDias,
  type ClinicsAppointmentDto,
  type ClinicsNoShowDto,
  type ClinicsOutreachCandidateDto,
  type ClinicsProfessionalDto,
  type ClinicsReturnDto,
  type ClinicsUnitDto,
} from '@veyra/contracts/verticals/clinics';
import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/ui/button';
import { Drawer } from '../../../components/ui/drawer';
import { Select } from '../../../components/ui/input';
import { PageHeader, Panel } from '../../../components/ui/page';
import { api, ApiError, toQuery } from '../../../lib/api';
import { alcanca, useSession, type Exige } from '../../../lib/session';
import { useClinicsStatus } from '../access';
import { ATENDIVEIS, diaDaSemana, ROTULO_DO_ESTADO, TOM_DO_ESTADO } from '../agenda/slots';
import { Avatar } from '../../../components/ui/avatar';
import { StatusChip } from '../../../components/ui/status';
import { RegistroDeAtendimento } from '../agenda/RegistroDeAtendimento';
import {
  CLINICS_AGENDA_PATH,
  CLINICS_NO_SHOW_PATH,
  CLINICS_OUTREACH_PATH,
  CLINICS_RETURNS_PATH,
} from '../nav';

/** Os cinco primeiros de cada lista; o total vem à parte, quando é sabido. */
const MOSTRA = 5;
/** A seleção das conversas: a primeira página, declarada como seleção. */
const CONVERSAS_CONSULTADAS = 50;

/** As chaves de cada cartão e de cada ação (ADR-055, adendo 4): TODAS. */
export const CHAVES = {
  agendaDeHoje: { permissions: ['clinics:schedule:read', 'clinics:catalog:read'] },
  confirmarAmanha: {
    permissions: ['clinics:schedule:read', 'clinics:schedule:write', 'clinics:catalog:read'],
  },
  pedidosDeEnvio: { permissions: ['clinics:schedule:read', 'contacts:read', 'consents:read'] },
  retornosVencidos: { permissions: ['clinics:schedule:read'] },
  conversasComJanela: { permissions: ['conversations:read'] },
  faltasDaSemana: { permissions: ['clinics:schedule:read', 'clinics:catalog:read'] },
  marcar: { permission: 'clinics:schedule:write' },
  atender: { permissions: ['clinics:care:write', 'clinics:schedule:read'] },
  telaDeRetornos: { permissions: ['clinics:schedule:read', 'clinics:catalog:read'] },
  telaDeFaltas: { permissions: ['clinics:schedule:read', 'clinics:catalog:read'] },
} satisfies Record<string, Exige>;

const DIA_LEGIVEL = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
function diaLegivel(data: string): string {
  const [ano, mes, dia] = data.split('-').map(Number);
  return DIA_LEGIVEL.format(new Date(Date.UTC(ano, mes - 1, dia)));
}
/** "1 falta", "2 faltas". */
/** Bom dia, boa tarde ou boa noite, pela hora do navegador de quem lê. */
function saudacao(): string {
  const hora = new Date().getHours();
  return hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
}

function contagem(quantos: number, um: string, varios: string): string {
  return `${quantos} ${quantos === 1 ? um : varios}`;
}
function dataCurta(data: string): string {
  const [, mes, dia] = data.split('-');
  return `${dia}/${mes}`;
}

/**
 * O Hoje da clínica (ADR-055, adendos 3 e 4): o dia da clínica, e não um
 * painel comercial. Cada cartão declara TODAS as suas chaves: sem elas, ele não
 * monta e a consulta dele não sai. As datas ("hoje", "amanhã", "a semana") são
 * as da UNIDADE, nunca as do navegador. Cada cartão diz exatamente o que sabe:
 * cinco registros mostrados nunca viram "cinco no total".
 */
export function ClinicsTodayPage() {
  const { data: user } = useSession();
  const status = useClinicsStatus();
  // nada do vertical é consultado sem o status ATIVO confirmado
  const ativo = status.data?.active === true;
  const comCatalogo = ativo && alcanca(user, { permission: 'clinics:catalog:read' });
  const [unidadeEscolhida, setUnidadeEscolhida] = useState('');

  const unidades = useQuery({
    queryKey: ['clinics', 'catalog', 'units'],
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
    enabled: comCatalogo,
  });
  const unidade =
    unidades.data?.find((u) => u.id === unidadeEscolhida) ?? unidades.data?.[0] ?? null;
  const hoje = unidade ? horaLocal(new Date(), unidade.timezone).data : null;
  const pode = (exige: Exige) => alcanca(user, exige);
  const doVertical = (exige: Exige) => ativo && pode(exige);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Hoje"
        meta={
          hoje ? (
            <>
              {saudacao()}, {user?.name?.split(/\s+/)[0] ?? ''}.{' '}
              {diaLegivel(hoje).replace(/^./, (c) => c.toUpperCase())}
            </>
          ) : undefined
        }
      >
        {unidades.data && unidades.data.length > 1 ? (
          <Select
            aria-label="Unidade"
            value={unidade?.id ?? ''}
            onChange={(e) => setUnidadeEscolhida(e.target.value)}
          >
            {unidades.data.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        ) : null}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto p-7">
        <div className="grid max-w-6xl gap-5 lg:grid-cols-2">
          {/* sem a unidade, os cartões do dia não somem em silêncio */}
          {comCatalogo && unidades.isError ? (
            <div className="lg:col-span-2">
              <Cartao titulo="A unidade">
                <Falhou />
              </Cartao>
            </div>
          ) : null}
          {comCatalogo && unidades.data?.length === 0 ? (
            <div className="lg:col-span-2">
              <Cartao titulo="A unidade">
                <Vazio>
                  A clínica ainda não tem unidade. A agenda do dia aparece aqui depois de ela ser
                  cadastrada em Configurações › Clínica.
                </Vazio>
              </Cartao>
            </div>
          ) : null}
          {unidade && hoje && doVertical(CHAVES.agendaDeHoje) ? (
            <div className="lg:col-span-2">
              <AgendaDeHoje unidade={unidade} hoje={hoje} />
            </div>
          ) : null}
          {unidade && hoje && doVertical(CHAVES.confirmarAmanha) ? (
            <ConfirmarAmanha unidade={unidade} amanha={somarDias(hoje, 1)} />
          ) : null}
          {doVertical(CHAVES.retornosVencidos) && !(comCatalogo && unidades.isPending) ? (
            <RetornosVencidos unidade={unidade} />
          ) : null}
          {pode(CHAVES.conversasComJanela) ? <ConversasComJanela /> : null}
          {unidade && hoje && doVertical(CHAVES.faltasDaSemana) ? (
            <FaltasDaSemana unidade={unidade} hoje={hoje} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Cartao({
  titulo,
  resumo,
  children,
  rodape,
}: {
  titulo: string;
  resumo?: ReactNode;
  children: ReactNode;
  rodape?: ReactNode;
}) {
  return (
    <Panel className="flex flex-col">
      <section aria-label={titulo} className="flex flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-3.5">
          <h2 className="mr-auto font-display text-[17px] font-semibold tracking-[-0.01em]">
            {titulo}
          </h2>
          {resumo ? (
            <span className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-fg">
              {resumo}
            </span>
          ) : null}
        </header>
        <div className="flex-1 px-5 py-4">{children}</div>
        {rodape ? (
          <footer className="border-t border-border px-5 py-3 text-[13px]">{rodape}</footer>
        ) : null}
      </section>
    </Panel>
  );
}

function Vazio({ children }: { children: ReactNode }) {
  return <p className="text-body-sm text-muted-fg">{children}</p>;
}

function Falhou({ erro }: { erro?: unknown }) {
  // a recusa do servidor (o dia acima do teto, por exemplo) diz o porquê
  return (
    <p className="text-data text-negative">
      {erro instanceof ApiError && erro.status === 422
        ? erro.message
        : 'Não foi possível carregar agora.'}
    </p>
  );
}

/** A agenda de um dia inteiro da unidade (a rota devolve o dia inteiro, até o teto). */
function useAgendaDoDia(unidadeId: string, data: string) {
  return useQuery({
    queryKey: ['clinics', 'appointments', data, unidadeId],
    queryFn: () =>
      api.get<ClinicsAppointmentDto[]>(
        `/api/clinics/appointments${toQuery({ date: data, unitId: unidadeId })}`,
      ),
  });
}

// ── Agenda de hoje ───────────────────────────────────────────────────────────

const PENDENTE = new Set(['scheduled', 'confirmed']);

function AgendaDeHoje({ unidade, hoje }: { unidade: ClinicsUnitDto; hoje: string }) {
  const { data: user } = useSession();
  const agenda = useAgendaDoDia(unidade.id, hoje);
  const profissionais = useQuery({
    queryKey: ['clinics', 'catalog', 'professionals', false],
    queryFn: () => api.get<ClinicsProfessionalDto[]>('/api/clinics/professionals'),
  });
  // "Minha agenda" só com a conta LIGADA a um profissional do catálogo: a
  // associação nunca é inventada. É organização, não privacidade (D8)
  const minhaConta = user?.activeMembership?.membershipId ?? null;
  const meu = profissionais.data?.find(
    (p) => p.account?.membershipId === minhaConta && p.account.active,
  );

  if (agenda.isError) {
    return (
      <Cartao titulo="Agenda de hoje">
        <Falhou erro={agenda.error} />
      </Cartao>
    );
  }
  if (!agenda.data) {
    return (
      <Cartao titulo="Agenda de hoje">
        <Vazio>Carregando…</Vazio>
      </Cartao>
    );
  }
  const agora = Date.now();
  // a rota devolve o dia INTEIRO ou recusa (acima do teto): as contagens são exatas
  const dia = agenda.data.filter((a) => a.status !== 'canceled');
  const contar = (f: (a: ClinicsAppointmentDto) => boolean) => dia.filter(f).length;
  const pendentes = (a: ClinicsAppointmentDto) =>
    PENDENTE.has(a.status) && Date.parse(a.startsAt) < agora;
  // o resumo do dia em chips de estado (ADR-062): a mesma cor da linha
  const resumo = (
    <>
      <StatusChip tom="done">
        {contagem(
          contar((a) => a.status === 'attended'),
          'atendido',
          'atendidos',
        )}
      </StatusChip>
      <StatusChip tom="missed">
        {contagem(
          contar((a) => a.status === 'no_show'),
          'falta',
          'faltas',
        )}
      </StatusChip>
      <StatusChip tom="arrived">
        {contagem(
          contar((a) => a.status === 'arrived'),
          'chegou',
          'chegaram',
        )}
      </StatusChip>
      <StatusChip tom="pending">{contagem(contar(pendentes), 'pendente', 'pendentes')}</StatusChip>
      <StatusChip tom="neutral">
        {`${contar((a) => PENDENTE.has(a.status) && Date.parse(a.startsAt) >= agora)} a seguir`}
      </StatusChip>
    </>
  );

  const meus = meu ? dia.filter((a) => a.professionalId === meu.id) : [];
  const daEquipe = meu ? dia.filter((a) => a.professionalId !== meu.id) : dia;
  return (
    <Cartao
      titulo="Agenda de hoje"
      resumo={resumo}
      rodape={
        <Link to={`${CLINICS_AGENDA_PATH}?dia=${hoje}`} className="text-accent hover:underline">
          Abrir a Agenda
        </Link>
      }
    >
      {dia.length === 0 ? (
        <Vazio>Nenhum horário marcado para hoje.</Vazio>
      ) : meu ? (
        <div className="space-y-4">
          <BlocoDaAgenda titulo="Minha agenda" itens={meus} agora={agora} unidade={unidade} />
          <BlocoDaAgenda
            titulo="Agenda da equipe"
            itens={daEquipe}
            agora={agora}
            unidade={unidade}
            recolhido
          />
        </div>
      ) : (
        <BlocoDaAgenda titulo="Agenda da equipe" itens={daEquipe} agora={agora} unidade={unidade} />
      )}
    </Cartao>
  );
}

/**
 * Um bloco da agenda do dia, separado pelo que se SABE: pendentes (o horário
 * passou, sem desfecho), chegaram (o estado `arrived` — não prova atendimento
 * começado) e a seguir. Atendidos e faltas ficam só na contagem.
 */
function BlocoDaAgenda({
  titulo,
  itens,
  agora,
  unidade,
  recolhido = false,
}: {
  titulo: string;
  itens: ClinicsAppointmentDto[];
  agora: number;
  unidade: ClinicsUnitDto;
  recolhido?: boolean;
}) {
  const [aberto, setAberto] = useState(!recolhido);
  const porInicio = [...itens].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const pendentes = porInicio.filter(
    (a) => PENDENTE.has(a.status) && Date.parse(a.startsAt) < agora,
  );
  const chegaram = porInicio.filter((a) => a.status === 'arrived');
  const aSeguir = porInicio.filter(
    (a) => PENDENTE.has(a.status) && Date.parse(a.startsAt) >= agora,
  );
  return (
    <div>
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        className="flex items-center gap-1.5 text-[14px] font-semibold"
      >
        <ChevronRight
          size={13}
          aria-hidden
          className={aberto ? 'rotate-90 transition-transform' : 'transition-transform'}
        />
        {titulo}
        <span className="font-normal text-muted-fg">({itens.length})</span>
      </button>
      {aberto ? (
        <div className="mt-3 space-y-4">
          <Grupo
            rotulo="Pendentes — o horário passou, sem desfecho registrado"
            itens={pendentes}
            unidade={unidade}
          />
          <Grupo rotulo="Chegaram" itens={chegaram} unidade={unidade} />
          <Grupo rotulo="A seguir" itens={aSeguir} unidade={unidade} limite={MOSTRA} />
          {pendentes.length + chegaram.length + aSeguir.length === 0 ? (
            <Vazio>Nada pendente nem por vir.</Vazio>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Grupo({
  rotulo,
  itens,
  unidade,
  limite,
}: {
  rotulo: string;
  itens: ClinicsAppointmentDto[];
  unidade: ClinicsUnitDto;
  limite?: number;
}) {
  if (itens.length === 0) return null;
  const mostrados = limite ? itens.slice(0, limite) : itens;
  return (
    <div>
      <p className="eyebrow mb-1 text-muted-fg">{rotulo}</p>
      <ul className="divide-y divide-border/70">
        {mostrados.map((a) => (
          <LinhaDoHorario key={a.id} agendamento={a} unidade={unidade} />
        ))}
      </ul>
      {limite && itens.length > limite ? (
        <p className="mt-1 text-[13px] text-muted-fg">e mais {itens.length - limite}</p>
      ) : null}
    </div>
  );
}

/** As ações de um horário, cada uma com a sua chave (ADR-055, adendo 4). */
function LinhaDoHorario({
  agendamento: a,
  unidade,
}: {
  agendamento: ClinicsAppointmentDto;
  unidade: ClinicsUnitDto;
}) {
  const { data: user } = useSession();
  const queryClient = useQueryClient();
  const [registrando, setRegistrando] = useState(false);
  const podeMarcar = alcanca(user, CHAVES.marcar);
  const podeAtender = alcanca(user, CHAVES.atender);
  const passou = Date.parse(a.startsAt) < Date.now();
  // o que muda o dia muda também as faltas da semana (os pendentes e a taxa)
  const atualizar = () => {
    void queryClient.invalidateQueries({ queryKey: ['clinics', 'appointments'] });
    void queryClient.invalidateQueries({ queryKey: ['clinics', 'metrics', 'no-show'] });
    // confirmar à mão muda quem é candidato ao envio de confirmação
    void queryClient.invalidateQueries({ queryKey: ['clinics', 'outreach', 'candidates'] });
  };
  const mudar = useMutation({
    mutationFn: (to: 'confirmed' | 'arrived' | 'no_show') =>
      api.post<ClinicsAppointmentDto>(`/api/clinics/appointments/${a.id}/status`, { to }),
    onSettled: atualizar,
  });
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[14px]">
      <span className="num w-12 shrink-0 text-[13px] text-foreground/80">{a.localStart}</span>
      <Avatar nome={a.patientName} chave={a.patientId} tamanho="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold">{a.patientName}</span>
        <span className="truncate text-[13px] text-muted-fg">
          {a.serviceName} · {a.professionalName}
        </span>
      </span>
      <StatusChip tom={TOM_DO_ESTADO[a.status]}>{ROTULO_DO_ESTADO[a.status]}</StatusChip>
      {podeMarcar && a.status === 'scheduled' ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={mudar.isPending}
          onClick={() => mudar.mutate('confirmed')}
        >
          Marcar como confirmado
        </Button>
      ) : null}
      {podeMarcar && a.status === 'confirmed' ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={mudar.isPending}
          onClick={() => mudar.mutate('arrived')}
        >
          Registrar chegada
        </Button>
      ) : null}
      {podeMarcar && passou && PENDENTE.has(a.status) ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={mudar.isPending}
          onClick={() => mudar.mutate('no_show')}
        >
          Marcar falta
        </Button>
      ) : null}
      {podeAtender &&
      a.status === 'arrived' &&
      ATENDIVEIS.includes(a.status) &&
      // D8 (ADR-061): só o horário no alcance clínico de quem atende
      a.careInScope === true ? (
        <Button size="sm" variant="primary" onClick={() => setRegistrando(true)}>
          Registrar atendimento
        </Button>
      ) : null}
      {mudar.error ? (
        <span role="alert" className="w-full text-data text-negative">
          {mudar.error instanceof ApiError ? mudar.error.message : 'Não foi possível mudar.'}
        </span>
      ) : null}
      <Drawer open={registrando} onOpenChange={setRegistrando} title="Registrar atendimento">
        {registrando ? (
          <RegistroDeAtendimento
            agendamento={a}
            fuso={unidade.timezone}
            onAgendaMudou={atualizar}
            onDone={() => setRegistrando(false)}
          />
        ) : null}
      </Drawer>
    </li>
  );
}

// ── Confirmar amanhã ─────────────────────────────────────────────────────────

/**
 * "Marcar como confirmado" muda o agendamento à mão. O envio da confirmação por
 * WhatsApp é OUTRA coisa: fica nos Envios, e a linha dos pedidos só aparece com
 * TODAS as chaves da rota dos candidatos.
 */
function ConfirmarAmanha({ unidade, amanha }: { unidade: ClinicsUnitDto; amanha: string }) {
  const { data: user } = useSession();
  const agenda = useAgendaDoDia(unidade.id, amanha);
  const vePedidos = alcanca(user, CHAVES.pedidosDeEnvio);
  const candidatos = useQuery({
    queryKey: ['clinics', 'outreach', 'candidates', 'confirmation', amanha, unidade.id],
    queryFn: () =>
      api.get<ClinicsOutreachCandidateDto[]>(
        `/api/clinics/outreach/candidates${toQuery({
          kind: 'confirmation',
          date: amanha,
          days: 1,
          unitId: unidade.id,
        })}`,
      ),
    enabled: vePedidos,
  });
  if (agenda.isError) {
    return (
      <Cartao titulo="Confirmar amanhã">
        <Falhou erro={agenda.error} />
      </Cartao>
    );
  }
  if (!agenda.data) {
    return (
      <Cartao titulo="Confirmar amanhã">
        <Vazio>Carregando…</Vazio>
      </Cartao>
    );
  }
  const naoConfirmados = agenda.data
    .filter((a) => a.status === 'scheduled')
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const rascunhos = (candidatos.data ?? []).filter((c) => c.request?.state === 'draft').length;
  return (
    <Cartao
      titulo="Confirmar amanhã"
      resumo={`${contagem(naoConfirmados.length, 'ainda não confirmado', 'ainda não confirmados')} · ${dataCurta(amanha)}`}
      rodape={
        vePedidos && candidatos.data ? (
          <span>
            {rascunhos === 0
              ? 'Nenhum pedido de confirmação por WhatsApp esperando aprovação.'
              : `${rascunhos} ${rascunhos === 1 ? 'pedido' : 'pedidos'} de confirmação por WhatsApp esperando aprovação.`}{' '}
            <Link to={CLINICS_OUTREACH_PATH} className="text-accent hover:underline">
              Revisar envios
            </Link>
          </span>
        ) : null
      }
    >
      {naoConfirmados.length === 0 ? (
        <Vazio>Todos os horários de amanhã estão confirmados.</Vazio>
      ) : (
        <>
          <ul className="divide-y divide-border/70">
            {naoConfirmados.slice(0, MOSTRA).map((a) => (
              <LinhaDoHorario key={a.id} agendamento={a} unidade={unidade} />
            ))}
          </ul>
          {naoConfirmados.length > MOSTRA ? (
            <p className="mt-1 text-[13px] text-muted-fg">
              e mais {naoConfirmados.length - MOSTRA}
            </p>
          ) : null}
        </>
      )}
    </Cartao>
  );
}

// ── Retornos vencidos ────────────────────────────────────────────────────────

/** Pede um a mais que o teto: até 100 a contagem é exata; acima, diz "mais de 100". */
const TETO_DOS_RETORNOS = 100;

/** Da unidade escolhida; sem o catálogo (a unidade não é conhecida), de todas, e o cartão diz. */
function RetornosVencidos({ unidade }: { unidade: ClinicsUnitDto | null }) {
  const { data: user } = useSession();
  const retornos = useQuery({
    queryKey: ['clinics', 'returns', 'overdue', 'hoje', unidade?.id ?? 'todas'],
    queryFn: () =>
      api.get<ClinicsReturnDto[]>(
        `/api/clinics/returns${toQuery({
          status: 'pending',
          overdue: 'true',
          unitId: unidade?.id,
          limit: TETO_DOS_RETORNOS + 1,
        })}`,
      ),
  });
  const total = retornos.data?.length ?? 0;
  return (
    <Cartao
      titulo="Retornos vencidos"
      resumo={
        retornos.data
          ? `${total > TETO_DOS_RETORNOS ? `mais de ${TETO_DOS_RETORNOS}` : `${total} no total`}${unidade ? '' : ' · todas as unidades'}`
          : undefined
      }
      rodape={
        alcanca(user, CHAVES.telaDeRetornos) ? (
          <Link to={CLINICS_RETURNS_PATH} className="text-accent hover:underline">
            Ver todos os retornos
          </Link>
        ) : null
      }
    >
      {retornos.isError ? (
        <Falhou />
      ) : !retornos.data ? (
        <Vazio>Carregando…</Vazio>
      ) : total === 0 ? (
        <Vazio>Nenhum retorno vencido.</Vazio>
      ) : (
        <ul className="divide-y divide-border/70">
          {retornos.data.slice(0, MOSTRA).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2.5 text-[14px]">
              <Avatar nome={r.patientName} chave={r.patientId} tamanho="sm" />
              <span className="min-w-0 flex-1 truncate font-semibold">{r.patientName}</span>
              <StatusChip tom="missed">venceu {dataCurta(r.dueDate)}</StatusChip>
              <span className="text-[13px] text-muted-fg">
                {r.assignee ? r.assignee.name : 'sem responsável'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Cartao>
  );
}

// ── Conversas com janela aberta ──────────────────────────────────────────────

const RELATIVO = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
function fechaEm(instante: string, agora: number): string {
  const minutos = Math.round((Date.parse(instante) - agora) / 60_000);
  return minutos < 60
    ? RELATIVO.format(minutos, 'minute')
    : RELATIVO.format(Math.round(minutos / 60), 'hour');
}

/**
 * Nada prova pendência de resposta: o cartão diz só o que sabe — conversas
 * abertas cuja janela de 24h ainda não fechou, numa SELEÇÃO declarada (as mais
 * recentes da primeira página), na ordem do servidor, sem total.
 */
function ConversasComJanela() {
  const conversas = useQuery({
    queryKey: ['conversations', 'hoje', 'open', CONVERSAS_CONSULTADAS],
    queryFn: () =>
      api.get<ConversationPageDto>(
        `/api/conversations${toQuery({ status: 'open', limit: CONVERSAS_CONSULTADAS })}`,
      ),
  });
  const agora = Date.now();
  const comJanela = (conversas.data?.items ?? []).filter(
    (c) => c.windowExpiresAt !== null && Date.parse(c.windowExpiresAt) > agora,
  );
  return (
    <Cartao
      titulo="Conversas com janela aberta"
      resumo={`entre as ${CONVERSAS_CONSULTADAS} abertas mais recentes`}
      rodape={
        <Link to="/inbox" className="text-accent hover:underline">
          Abrir Conversas
        </Link>
      }
    >
      {conversas.isError ? (
        <Falhou />
      ) : !conversas.data ? (
        <Vazio>Carregando…</Vazio>
      ) : comJanela.length === 0 ? (
        <Vazio>Nenhuma delas com a janela aberta.</Vazio>
      ) : (
        <ul className="divide-y divide-border/70">
          {comJanela.slice(0, MOSTRA).map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2.5 text-[14px]">
              <Avatar nome={c.contactName ?? '?'} chave={c.contactId ?? c.id} tamanho="sm" />
              <Link
                to={`/inbox?c=${encodeURIComponent(c.id)}`}
                className="min-w-0 flex-1 truncate font-semibold hover:underline"
              >
                {c.contactName ?? 'Remetente a identificar'}
              </Link>
              <span className="text-[13px] text-muted-fg">
                a janela fecha {fechaEm(c.windowExpiresAt!, agora)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Cartao>
  );
}

// ── Faltas da semana ─────────────────────────────────────────────────────────

const PORCENTAGEM = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });

/** A semana local da unidade, de segunda a hoje (o fim da rota é exclusivo). */
function FaltasDaSemana({ unidade, hoje }: { unidade: ClinicsUnitDto; hoje: string }) {
  const { data: user } = useSession();
  // `diaDaSemana` é ISO (1 = segunda)
  const segunda = somarDias(hoje, 1 - diaDaSemana(hoje));
  const faltas = useQuery({
    queryKey: ['clinics', 'metrics', 'no-show', 'semana', unidade.id, segunda, hoje],
    queryFn: () =>
      api.get<ClinicsNoShowDto>(
        `/api/clinics/metrics/no-show${toQuery({
          from: segunda,
          to: somarDias(hoje, 1),
          unitId: unidade.id,
        })}`,
      ),
  });
  return (
    <Cartao
      titulo="Faltas da semana"
      resumo={`${dataCurta(segunda)} a ${dataCurta(hoje)}`}
      rodape={
        alcanca(user, CHAVES.telaDeFaltas) ? (
          <Link to={CLINICS_NO_SHOW_PATH} className="text-accent hover:underline">
            Ver faltas
          </Link>
        ) : null
      }
    >
      {faltas.isError ? (
        <Falhou />
      ) : !faltas.data ? (
        <Vazio>Carregando…</Vazio>
      ) : (
        <div className="space-y-1.5 text-[14px]">
          <p>
            <span className="font-display text-[28px] font-semibold tracking-[-0.02em]">
              {faltas.data.noShow}
            </span>{' '}
            {faltas.data.noShow === 1 ? 'falta' : 'faltas'}
            {faltas.data.rate !== null ? (
              <span className="num text-muted-fg"> · {PORCENTAGEM.format(faltas.data.rate)}</span>
            ) : null}
          </p>
          <p className="text-[13px] text-muted-fg">
            {faltas.data.pendingPast === 1
              ? '1 horário já passado sem atendimento ou falta registrados'
              : `${faltas.data.pendingPast} horários já passados sem atendimento ou falta registrados`}{' '}
            (inclui quem chegou).
          </p>
        </div>
      )}
    </Cartao>
  );
}
