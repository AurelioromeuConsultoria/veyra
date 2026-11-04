import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClinicsPackageDto,
  ClinicsPackageStatus,
  ClinicsPatientDto,
  ClinicsReturnDto,
  ClinicsServiceDto,
  ClinicsUnitDto,
} from '@veyra/contracts/verticals/clinics';
import { createClinicsPackageSchema } from '@veyra/contracts/verticals/clinics';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Avatar } from '../../components/ui/avatar';
import { Button } from '../../components/ui/button';
import { StatusChip, type Tom } from '../../components/ui/status';
import { Abas, idDaAba, idDoPainel, type Aba } from '../../components/ui/tabs';
import { Drawer } from '../../components/ui/drawer';
import { Field, Input, Select } from '../../components/ui/input';
import { EmptyState, PageHeader, Panel, PanelHeader } from '../../components/ui/page';
import { api, ApiError } from '../../lib/api';
import { formatCents } from '../../lib/format';
import { alcanca, hasPermission, useSession } from '../../lib/session';
import {
  PACKAGES_KEY,
  PortaDaClinica,
  RETURNS_KEY,
  ROTULO_DO_PACOTE,
  dataCurta,
  quandoLocal,
} from './continuidade';
import { reaisToCents } from './format';
import { CLINICS_AGENDA_PATH, CLINICS_PATIENTS_PATH } from './nav';
import { NotasETarefasDoPaciente } from './NotasETarefasDoPaciente';
import { ListaDeRetornos, TETO_DOS_RETORNOS, useRetornos } from './retornos/ListaDeRetornos';
import { SessoesDoPacote } from './SessoesDoPacote';
import { ContatoDaPessoa } from './pessoa/ContatoDaPessoa';

const mensagem = (erro: unknown) =>
  erro instanceof ApiError ? erro.message : 'Não foi possível concluir.';

/** o título de seção da linguagem nova (ADR-062): display, 17px */
const TITULO_DE_SECAO = 'font-display text-[17px] font-semibold tracking-[-0.01em]';

/** a cor do estado do pacote (ADR-062): em uso, concluído, encerrado */
const TOM_DO_PACOTE: Record<ClinicsPackageStatus, Tom> = {
  active: 'confirmed',
  completed: 'done',
  canceled: 'neutral',
};

type ChaveDaAba = 'pacotes' | 'retornos' | 'notas' | 'contato';
const BASE_DAS_ABAS = 'ficha';

/**
 * Ficha do paciente (F3.3b; ADR-048 adendo 7; ADR-062). Da agenda, com a mesma
 * projeção da lista de pacientes. O corpo é dividido em abas, e um resumo fica
 * ao lado. Os PACOTES só existem para quem tem `care:read`: sem a chave, nem a
 * aba nem o resumo dos pacotes aparecem, e nenhuma consulta a pacotes é feita.
 */
export function ClinicsPatientPage() {
  return (
    <PortaDaClinica titulo="Paciente" recusa="Você não tem acesso aos pacientes da clínica.">
      <FichaReady />
    </PortaDaClinica>
  );
}

function FichaReady() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id') ?? '';
  // um id que não é UUID nem chega ao servidor
  const idValido = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const { data: user } = useSession();
  const lePacotes = hasPermission(user, 'clinics:care:read');
  const podeCriarRetorno =
    lePacotes &&
    hasPermission(user, 'clinics:care:write') &&
    hasPermission(user, 'clinics:schedule:read');
  const [novoRetorno, setNovoRetorno] = useState(false);
  const paciente = useQuery({
    queryKey: ['clinics', 'patients', 'one', id],
    queryFn: () => api.get<ClinicsPatientDto>(`/api/clinics/patients/${id}`),
    enabled: idValido,
  });

  if (!idValido || paciente.isError) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader eyebrow="Clínica" title="Paciente" />
        <EmptyState
          title={
            !idValido || (paciente.error instanceof ApiError && paciente.error.status === 404)
              ? 'Paciente não encontrado.'
              : 'Não foi possível carregar o paciente.'
          }
          hint="Volte à lista de pacientes."
        />
      </div>
    );
  }
  if (!paciente.data) return <p className="p-6 text-body-sm text-muted-fg">Carregando…</p>;

  const contactId = paciente.data.contactId;
  // só as abas que a pessoa pode ver: as mesmas condições das seções de antes
  // (a aba que não existe não monta, e o que ela consulta não é consultado)
  const abas: Aba<ChaveDaAba>[] = [
    ...(lePacotes ? [{ chave: 'pacotes' as const, rotulo: 'Pacotes' }] : []),
    { chave: 'retornos', rotulo: 'Retornos' },
    ...(contactId && alcanca(user, { permission: 'tasks:read' })
      ? [{ chave: 'notas' as const, rotulo: 'Notas e tarefas' }]
      : []),
    ...(contactId && alcanca(user, { permission: 'contacts:read' })
      ? [{ chave: 'contato' as const, rotulo: 'Contato' }]
      : []),
  ];
  // a aba vem da URL (`?aba=`); a que não existe para esta pessoa cai na primeira
  const ativa = abas.find((a) => a.chave === params.get('aba'))?.chave ?? abas[0].chave;
  const abrirAba = (chave: ChaveDaAba) =>
    setParams(
      (atual) => {
        // o `?id=` fica: só a aba muda
        const proximos = new URLSearchParams(atual);
        proximos.set('aba', chave);
        return proximos;
      },
      { replace: true },
    );

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border bg-surface px-7">
        {/* o cabeçalho da PESSOA (ADR-062): quem é, desde quando, e as ações */}
        <header className="flex flex-wrap items-center gap-x-5 gap-y-3 pb-4 pt-6">
          <Avatar nome={paciente.data.name} chave={paciente.data.id} tamanho="xl" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-[28px] font-semibold leading-tight tracking-[-0.02em]">
              {paciente.data.name}
            </h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-muted-fg">
              <StatusChip tom="accent">
                Paciente desde {new Date(paciente.data.createdAt).toLocaleDateString('pt-BR')}
              </StatusChip>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to={CLINICS_PATIENTS_PATH}
              className="inline-flex h-10 items-center rounded-control border border-border-strong bg-surface px-4 text-[14px] font-medium hover:bg-surface-2"
            >
              Todos os pacientes
            </Link>
            <Link
              to={CLINICS_AGENDA_PATH}
              className="inline-flex h-10 items-center rounded-control border border-accent bg-accent px-4 text-[14px] font-semibold text-accent-fg hover:bg-accent-hover"
            >
              Abrir a agenda
            </Link>
          </div>
        </header>
        <Abas
          base={BASE_DAS_ABAS}
          rotulo="Partes da ficha"
          abas={abas}
          ativa={ativa}
          onChange={abrirAba}
          className="flex-wrap"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-wrap items-start gap-5 p-7">
          <div
            role="tabpanel"
            id={idDoPainel(BASE_DAS_ABAS)}
            aria-labelledby={idDaAba(BASE_DAS_ABAS, ativa)}
            className="min-w-0 flex-[999_1_520px]"
          >
            {ativa === 'pacotes' ? <PacotesDoPaciente pacienteId={id} /> : null}
            {ativa === 'retornos' ? (
              <section aria-label="Retornos do paciente" className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className={TITULO_DE_SECAO}>Retornos</h2>
                  {podeCriarRetorno ? (
                    <Button size="sm" variant="secondary" onClick={() => setNovoRetorno(true)}>
                      Novo retorno
                    </Button>
                  ) : null}
                </div>
                <ListaDeRetornos filtros={{ patientId: id }} mostrarPaciente={false} />
              </section>
            ) : null}
            {ativa === 'notas' && contactId ? (
              <NotasETarefasDoPaciente contactId={contactId} />
            ) : null}
            {/* o paciente continua na captação: o contato, o consentimento, as
                conversas e as oportunidades, cada um com as suas chaves */}
            {ativa === 'contato' && contactId ? <ContatoDaPessoa contactId={contactId} /> : null}
          </div>
          <aside
            aria-label="Resumo do paciente"
            className="flex min-w-[280px] flex-[1_1_300px] flex-col gap-5"
          >
            <RetornosPendentes pacienteId={id} onVer={() => abrirAba('retornos')} />
            {lePacotes ? <PacotesAtivos pacienteId={id} onVer={() => abrirAba('pacotes')} /> : null}
          </aside>
        </div>
      </div>
      <Drawer open={novoRetorno} onOpenChange={setNovoRetorno} title="Novo retorno">
        {novoRetorno ? <NovoRetorno pacienteId={id} onDone={() => setNovoRetorno(false)} /> : null}
      </Drawer>
    </div>
  );
}

// ── O resumo ao lado (ADR-062) ─────────────────────────────────────────────
// Só o que a ficha JÁ consulta, com as mesmas chaves de consulta: nenhum pedido
// novo, nenhum dado que a ficha não mostrava. O "próximo horário" do desenho
// não entra: não há consulta de agendamentos por paciente.

/** Linha de espera do resumo: a moldura fica, o dado chega dentro dela. */
function CarregandoNoResumo() {
  return (
    <div aria-hidden className="space-y-2 px-5 py-4">
      <span className="block h-3.5 w-2/3 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
      <span className="block h-3 w-1/3 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
    </div>
  );
}

function CartaoDoResumo({
  titulo,
  meta,
  verRotulo,
  onVer,
  children,
}: {
  titulo: string;
  meta?: ReactNode;
  verRotulo: string;
  onVer: () => void;
  children: ReactNode;
}) {
  return (
    <Panel aria-label={titulo}>
      <PanelHeader title={titulo} meta={meta}>
        <Button size="sm" variant="ghost" onClick={onVer}>
          {verRotulo}
        </Button>
      </PanelHeader>
      {children}
    </Panel>
  );
}

/** Os pendentes, na ordem do servidor (o vencimento): os primeiros três. */
const NO_RESUMO = 3;

function RetornosPendentes({ pacienteId, onVer }: { pacienteId: string; onVer: () => void }) {
  // a MESMA consulta da aba Retornos (mesma chave): um pedido só
  const retornos = useRetornos({ patientId: pacienteId });
  // com erro, nada de dado antigo
  const todas = retornos.isError ? [] : (retornos.data ?? []);
  const pendentes = todas.slice(0, TETO_DOS_RETORNOS).filter((r) => r.status === 'pending');
  // a lista tem teto: além dele, a contagem é só do que veio, e diz
  const parcial = todas.length > TETO_DOS_RETORNOS;
  const vencidos = pendentes.filter((r) => r.overdue).length;
  return (
    <CartaoDoResumo
      titulo="Retornos pendentes"
      meta={
        retornos.data && !retornos.isError ? (
          <span className="num">
            {pendentes.length}
            {parcial ? '+' : ''}
            {vencidos > 0 ? ` · ${vencidos} vencido${vencidos > 1 ? 's' : ''}` : ''}
          </span>
        ) : null
      }
      verRotulo="Ver retornos"
      onVer={onVer}
    >
      {retornos.isError ? (
        <p className="px-5 py-4 text-data text-negative">Retornos indisponíveis agora.</p>
      ) : !retornos.data ? (
        <CarregandoNoResumo />
      ) : pendentes.length === 0 ? (
        <p className="px-5 py-4 text-[13.5px] text-muted-fg">Nenhum retorno pendente.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {pendentes.slice(0, NO_RESUMO).map((r) => (
            <RetornoNoResumo key={r.id} retorno={r} />
          ))}
          {pendentes.length > NO_RESUMO ? (
            <li className="px-5 py-2.5 text-[13px] text-muted-fg">
              e mais <span className="num">{pendentes.length - NO_RESUMO}</span> na aba Retornos
            </li>
          ) : null}
        </ul>
      )}
    </CartaoDoResumo>
  );
}

function RetornoNoResumo({ retorno: r }: { retorno: ClinicsReturnDto }) {
  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold">{r.serviceName}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[13px] text-muted-fg">
          vence <span className="num text-foreground">{dataCurta(r.dueDate)}</span>
          {r.assignee ? (
            <>
              <span aria-hidden>·</span>
              <Avatar nome={r.assignee.name} chave={r.assignee.membershipId} tamanho="sm" />
              <span className="truncate">{r.assignee.name}</span>
            </>
          ) : null}
        </p>
      </div>
      <StatusChip tom={r.overdue ? 'missed' : 'pending'}>
        {r.overdue ? 'Vencido' : 'Pendente'}
      </StatusChip>
    </li>
  );
}

/** Só montado com `care:read` (como a aba): sem ele, nem a consulta existe. */
function PacotesAtivos({ pacienteId, onVer }: { pacienteId: string; onVer: () => void }) {
  const pacotes = usePacotes(pacienteId);
  const servicos = useServicos();
  // com erro (inclusive numa recarga), nada de dado antigo: é dado de atendimento
  const falhou = pacotes.isError || servicos.isError;
  const ativos = falhou ? [] : (pacotes.data ?? []).filter((p) => p.status === 'active');
  const nomeDo = (serviceId: string) =>
    servicos.data?.find((s) => s.id === serviceId)?.name ?? 'Serviço';
  return (
    <CartaoDoResumo
      titulo="Pacotes ativos"
      meta={pacotes.data && !falhou ? <span className="num">{ativos.length}</span> : null}
      verRotulo="Ver pacotes"
      onVer={onVer}
    >
      {falhou ? (
        <p className="px-5 py-4 text-data text-negative">Pacotes indisponíveis agora.</p>
      ) : !pacotes.data || !servicos.data ? (
        <CarregandoNoResumo />
      ) : ativos.length === 0 ? (
        <p className="px-5 py-4 text-[13.5px] text-muted-fg">Nenhum pacote ativo.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {ativos.map((p) => (
            <li key={p.id} className="space-y-2.5 px-5 py-3.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-[14px] font-semibold">
                  {nomeDo(p.serviceId)} · <span className="num">{p.totalSessions}</span> sessões
                </span>
                <span className="text-[13px] text-muted-fg">
                  <strong className="num font-semibold text-foreground">
                    {p.remainingSessions}
                  </strong>{' '}
                  {p.remainingSessions === 1 ? 'restante' : 'restantes'}
                </span>
              </div>
              <BarraDeSessoes usadas={p.consumedSessions} total={p.totalSessions} />
            </li>
          ))}
        </ul>
      )}
    </CartaoDoResumo>
  );
}

/** As sessões usadas: um segmento por sessão até 20; acima disso, uma barra. */
function BarraDeSessoes({ usadas, total }: { usadas: number; total: number }) {
  const rotulo = `${usadas} de ${total} sessões usadas`;
  if (total > 0 && total <= 20) {
    return (
      <div
        role="img"
        aria-label={rotulo}
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={i < usadas ? 'h-2 rounded-full bg-accent' : 'h-2 rounded-full bg-border'}
          />
        ))}
      </div>
    );
  }
  const fracao = total > 0 ? Math.min(1, usadas / total) : 0;
  return (
    <div role="img" aria-label={rotulo} className="h-2 overflow-hidden rounded-full bg-border">
      <span className="block h-full bg-accent" style={{ width: `${fracao * 100}%` }} />
    </div>
  );
}

// ── Pacotes ────────────────────────────────────────────────────────────────

/** Os pacotes do paciente: a mesma chave na aba e no resumo (um pedido só). */
function usePacotes(pacienteId: string) {
  return useQuery({
    queryKey: [...PACKAGES_KEY, pacienteId],
    queryFn: () =>
      api.get<ClinicsPackageDto[]>(
        `/api/clinics/packages?patientId=${encodeURIComponent(pacienteId)}`,
      ),
  });
}

function useServicos() {
  return useQuery({
    queryKey: ['clinics', 'catalog', 'services', true],
    queryFn: () => api.get<ClinicsServiceDto[]>('/api/clinics/services?includeArchived=true'),
  });
}

/** Só montado com `care:read`: sem ele, nem a consulta existe. */
function PacotesDoPaciente({ pacienteId }: { pacienteId: string }) {
  const { data: user } = useSession();
  const podeCriar =
    hasPermission(user, 'clinics:care:write') && hasPermission(user, 'clinics:schedule:read');
  const podeCancelar = hasPermission(user, 'clinics:care:write');
  const queryClient = useQueryClient();
  const [criando, setCriando] = useState(false);
  const [cancelando, setCancelando] = useState<ClinicsPackageDto | null>(null);
  const [vendoSessoes, setVendoSessoes] = useState<ClinicsPackageDto | null>(null);
  const servicos = useServicos();
  // a data de criação, no fuso da unidade, distingue dois pacotes iguais
  const unidades = useQuery({
    queryKey: ['clinics', 'catalog', 'units'],
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
  });
  // um fuso só quando todas as unidades o dividem; com fusos diferentes, a data
  // vai em UTC (e diz), para não divergir do painel de registro da agenda
  const fusos = new Set((unidades.data ?? []).map((u) => u.timezone));
  const fuso = fusos.size === 1 ? [...fusos][0] : null;
  const pacotes = usePacotes(pacienteId);
  const cancelar = useMutation({
    mutationFn: (id: string) => api.post(`/api/clinics/packages/${id}/cancel`),
    onSuccess: () => setCancelando(null),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: PACKAGES_KEY }),
  });
  // com erro (inclusive numa recarga), nada de dado antigo: é dado de atendimento
  const falhou = pacotes.isError || servicos.isError;
  const linhas = falhou ? [] : (pacotes.data ?? []);
  const descricao = (p: ClinicsPackageDto) =>
    `Pacote de ${p.totalSessions} sessões de ${nomeDo(p.serviceId)}, criado em ${quandoLocal(p.createdAt, fuso)}`;
  const nomeDo = (serviceId: string) =>
    servicos.data?.find((s) => s.id === serviceId)?.name ?? 'Serviço';

  return (
    <section aria-label="Pacotes do paciente" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className={TITULO_DE_SECAO}>Pacotes</h2>
        {podeCriar ? (
          <Button size="sm" variant="secondary" onClick={() => setCriando(true)}>
            Novo pacote
          </Button>
        ) : null}
      </div>
      {pacotes.isError ? (
        <p role="alert" className="text-data text-negative">
          {/* sem vínculo com um profissional (D8, ADR-061): o motivo do servidor */}
          {pacotes.error instanceof ApiError && pacotes.error.status === 403
            ? pacotes.error.message
            : 'Não foi possível carregar os pacotes.'}
        </p>
      ) : servicos.isError ? (
        <p role="alert" className="text-data text-negative">
          Não foi possível carregar os serviços; os pacotes ficam ocultos até recarregar.
        </p>
      ) : null}
      <Panel>
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2/50">
              {['Serviço', 'Sessões', 'Restantes', 'Preço total registrado', 'Estado', ''].map(
                (h) => (
                  <th key={h} className="eyebrow px-5 py-3 text-left text-muted-fg">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {linhas.map((p) => (
              <tr
                key={p.id}
                aria-label={descricao(p)}
                className="border-b border-border/60 last:border-b-0"
              >
                <td className="px-5 py-3 font-semibold">{nomeDo(p.serviceId)}</td>
                <td className="px-5 py-3 num text-data">
                  {p.consumedSessions} de {p.totalSessions}
                </td>
                <td className="px-5 py-3 num text-data">{p.remainingSessions}</td>
                <td className="px-5 py-3 num text-data">
                  {p.totalPriceCents === null ? 'Não informado' : formatCents(p.totalPriceCents)}
                </td>
                <td className="px-5 py-3">
                  <StatusChip tom={TOM_DO_PACOTE[p.status]}>
                    {ROTULO_DO_PACOTE[p.status]}
                  </StatusChip>
                </td>
                <td className="px-5 py-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Sessões: ${descricao(p)}`}
                    onClick={() => setVendoSessoes(p)}
                  >
                    Sessões
                  </Button>
                  {podeCancelar && p.status === 'active' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Cancelar: ${descricao(p)}`}
                      onClick={() => {
                        // a recusa de um pacote não reaparece no painel de outro
                        cancelar.reset();
                        setCancelando(p);
                      }}
                    >
                      Cancelar pacote
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
            {pacotes.data && !falhou && linhas.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    title="Nenhum pacote."
                    hint={podeCriar ? 'Crie o primeiro em "Novo pacote".' : undefined}
                  />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
      <Drawer
        open={vendoSessoes !== null}
        onOpenChange={(aberto) => !aberto && setVendoSessoes(null)}
        title="Sessões do pacote"
      >
        {vendoSessoes ? <SessoesDoPacote pacote={vendoSessoes} fuso={fuso} /> : null}
      </Drawer>
      <Drawer open={criando} onOpenChange={setCriando} title="Novo pacote">
        {criando ? <NovoPacote pacienteId={pacienteId} onDone={() => setCriando(false)} /> : null}
      </Drawer>
      <Drawer
        open={cancelando !== null}
        onOpenChange={(aberto) => !aberto && setCancelando(null)}
        title="Cancelar pacote"
      >
        {cancelando ? (
          <div className="space-y-3 p-5">
            {cancelar.error ? (
              <p role="alert" className="text-data text-negative">
                {mensagem(cancelar.error)}
              </p>
            ) : null}
            <p className="text-body-sm">
              O pacote de {cancelando.totalSessions} sessões de {nomeDo(cancelando.serviceId)},
              criado em {quandoLocal(cancelando.createdAt, fuso)}, será encerrado. As{' '}
              {cancelando.consumedSessions} sessões consumidas continuam registradas, e não há
              reabertura.
            </p>
            <Button
              variant="danger"
              size="sm"
              disabled={cancelar.isPending}
              onClick={() => cancelar.mutate(cancelando.id)}
            >
              Confirmar cancelamento do pacote
            </Button>
          </div>
        ) : null}
      </Drawer>
    </section>
  );
}

/**
 * Pacote novo: o total de sessões e o preço TOTAL, opcional, digitado em reais
 * e enviado em centavos inteiros. A confirmação mostra o que fica congelado.
 * Preço registrado não é pagamento (D1 em aberto).
 */
function NovoPacote({ pacienteId, onDone }: { pacienteId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [servico, setServico] = useState('');
  const [sessoes, setSessoes] = useState('');
  const [preco, setPreco] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const servicos = useQuery({
    queryKey: ['clinics', 'catalog', 'services', true],
    queryFn: () => api.get<ClinicsServiceDto[]>('/api/clinics/services?includeArchived=true'),
  });
  const ativos = servicos.isError ? [] : (servicos.data ?? []).filter((s) => !s.archivedAt);
  const total = /^\d+$/.test(sessoes) ? Number(sessoes) : NaN;
  const centavos = reaisToCents(preco);
  // os limites são os do contrato (sessões e teto do preço), sem repetir aqui
  const precoValido =
    centavos !== undefined &&
    createClinicsPackageSchema.pick({ totalPriceCents: true }).safeParse({
      totalPriceCents: centavos,
    }).success;
  const valido =
    precoValido &&
    createClinicsPackageSchema.safeParse({
      patientId: pacienteId,
      serviceId: servico,
      totalSessions: total,
      totalPriceCents: centavos,
    }).success;
  const criar = useMutation({
    mutationFn: () =>
      api.post<ClinicsPackageDto>('/api/clinics/packages', {
        patientId: pacienteId,
        serviceId: servico,
        totalSessions: total,
        totalPriceCents: centavos ?? null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PACKAGES_KEY });
      onDone();
    },
  });
  const nome = ativos.find((s) => s.id === servico)?.name ?? '';

  return (
    <div className="space-y-3 p-5">
      {servicos.isError ? (
        <p role="alert" className="text-data text-negative">
          Não foi possível carregar os serviços.
        </p>
      ) : null}
      {criar.error ? (
        <p role="alert" className="text-data text-negative">
          {mensagem(criar.error)}
        </p>
      ) : null}
      {confirmando ? (
        <>
          <p className="text-body-sm">
            {total} sessões de {nome}, com preço total{' '}
            {centavos === null || centavos === undefined
              ? 'não informado'
              : `registrado de ${formatCents(centavos)}`}
            . O total e o preço ficam congelados depois de criar. O preço é só um registro: não é
            pagamento.
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={criar.isPending}
              onClick={() => criar.mutate()}
            >
              Confirmar e criar pacote
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmando(false)}>
              Voltar
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field label="Serviço">
            <Select value={servico} onChange={(e) => setServico(e.target.value)}>
              <option value="" disabled>
                Escolha o serviço
              </option>
              {ativos.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Total de sessões" hint="Quantas sessões o pacote tem.">
            <Input
              inputMode="numeric"
              value={sessoes}
              onChange={(e) => setSessoes(e.target.value)}
            />
          </Field>
          <Field label="Preço total (opcional)" hint="Em reais, para o pacote inteiro.">
            <Input value={preco} onChange={(e) => setPreco(e.target.value)} />
          </Field>
          {preco.trim() !== '' && !precoValido ? (
            <p role="alert" className="text-data text-negative">
              Use um valor em reais, como 1.500,50, dentro do limite do preço de um pacote.
            </p>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled={!valido}
            onClick={() => setConfirmando(true)}
          >
            Revisar pacote
          </Button>
        </>
      )}
    </div>
  );
}

/** Retorno manual: decisão clínica (`care:write`), com o paciente já escolhido. */
function NovoRetorno({ pacienteId, onDone }: { pacienteId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [servico, setServico] = useState('');
  const [vencimento, setVencimento] = useState('');
  const [unidade, setUnidade] = useState('');
  const servicos = useQuery({
    queryKey: ['clinics', 'catalog', 'services', true],
    queryFn: () => api.get<ClinicsServiceDto[]>('/api/clinics/services?includeArchived=true'),
  });
  const unidades = useQuery({
    queryKey: ['clinics', 'catalog', 'units'],
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
  });
  const falhou = servicos.isError || unidades.isError;
  const ativos = falhou ? [] : (servicos.data ?? []).filter((s) => !s.archivedAt);
  const lista = falhou ? [] : (unidades.data ?? []);
  const unidadeEfetiva = lista.length === 1 ? lista[0].id : unidade;
  const criar = useMutation({
    mutationFn: () =>
      api.post<ClinicsReturnDto>('/api/clinics/returns', {
        patientId: pacienteId,
        serviceId: servico,
        unitId: unidadeEfetiva,
        dueDate: vencimento,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RETURNS_KEY });
      onDone();
    },
  });
  return (
    <div className="space-y-3 p-5">
      {falhou ? (
        <p role="alert" className="text-data text-negative">
          Não foi possível carregar o catálogo.
        </p>
      ) : null}
      {criar.error ? (
        <p role="alert" className="text-data text-negative">
          {mensagem(criar.error)}
        </p>
      ) : null}
      <Field label="Serviço">
        <Select value={servico} onChange={(e) => setServico(e.target.value)}>
          <option value="" disabled>
            Escolha o serviço
          </option>
          {ativos.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      {lista.length > 1 ? (
        <Field label="Unidade">
          <Select value={unidade} onChange={(e) => setUnidade(e.target.value)}>
            <option value="" disabled>
              Escolha a unidade
            </option>
            {lista.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Vencimento">
        <Input type="date" value={vencimento} onChange={(e) => setVencimento(e.target.value)} />
      </Field>
      <Button
        variant="primary"
        size="sm"
        disabled={!servico || !vencimento || !unidadeEfetiva || criar.isPending}
        onClick={() => criar.mutate()}
      >
        Criar retorno
      </Button>
    </div>
  );
}
