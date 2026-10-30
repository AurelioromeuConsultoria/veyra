import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClinicsPackageDto,
  ClinicsPatientDto,
  ClinicsReturnDto,
  ClinicsServiceDto,
  ClinicsUnitDto,
} from '@veyra/contracts/verticals/clinics';
import { createClinicsPackageSchema } from '@veyra/contracts/verticals/clinics';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Drawer } from '../../components/ui/drawer';
import { Field, Input, Select } from '../../components/ui/input';
import { EmptyState, PageHeader, Panel } from '../../components/ui/page';
import { api, ApiError } from '../../lib/api';
import { formatCents } from '../../lib/format';
import { hasPermission, useSession } from '../../lib/session';
import {
  PACKAGES_KEY,
  PortaDaClinica,
  RETURNS_KEY,
  ROTULO_DO_PACOTE,
  quandoLocal,
} from './continuidade';
import { reaisToCents } from './format';
import { CLINICS_PATIENTS_PATH } from './nav';
import { ListaDeRetornos } from './retornos/ListaDeRetornos';
import { ContatoDaPessoa } from './pessoa/ContatoDaPessoa';

const mensagem = (erro: unknown) =>
  erro instanceof ApiError ? erro.message : 'Não foi possível concluir.';

/**
 * Ficha do paciente (F3.3b; ADR-048 adendo 7). Da agenda, com a mesma projeção
 * da lista de pacientes. Os PACOTES só existem para quem tem `care:read`: sem
 * a chave, a seção não aparece e nenhuma consulta a pacotes é feita.
 */
export function ClinicsPatientPage() {
  return (
    <PortaDaClinica titulo="Paciente" recusa="Você não tem acesso aos pacientes da clínica.">
      <FichaReady />
    </PortaDaClinica>
  );
}

function FichaReady() {
  const [params] = useSearchParams();
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

  return (
    <div className="flex h-full flex-col">
      <PageHeader eyebrow="Clínica · Paciente" title={paciente.data.name}>
        <Link className="text-data underline" to={CLINICS_PATIENTS_PATH}>
          Todos os pacientes
        </Link>
      </PageHeader>
      <div className="min-h-0 flex-1 space-y-6 overflow-auto p-6">
        <section aria-label="Retornos do paciente" className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-display-sm">Retornos</h2>
            {podeCriarRetorno ? (
              <Button size="sm" variant="secondary" onClick={() => setNovoRetorno(true)}>
                Novo retorno
              </Button>
            ) : null}
          </div>
          <ListaDeRetornos filtros={{ patientId: id }} mostrarPaciente={false} />
        </section>
        {lePacotes ? <PacotesDoPaciente pacienteId={id} /> : null}
        {/* o paciente continua na captação: o contato, o consentimento, as
            conversas e as oportunidades, cada um com as suas chaves */}
        {paciente.data.contactId ? <ContatoDaPessoa contactId={paciente.data.contactId} /> : null}
      </div>
      <Drawer open={novoRetorno} onOpenChange={setNovoRetorno} title="Novo retorno">
        {novoRetorno ? <NovoRetorno pacienteId={id} onDone={() => setNovoRetorno(false)} /> : null}
      </Drawer>
    </div>
  );
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
  const servicos = useQuery({
    queryKey: ['clinics', 'catalog', 'services', true],
    queryFn: () => api.get<ClinicsServiceDto[]>('/api/clinics/services?includeArchived=true'),
  });
  // a data de criação, no fuso da unidade, distingue dois pacotes iguais
  const unidades = useQuery({
    queryKey: ['clinics', 'catalog', 'units'],
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
  });
  // um fuso só quando todas as unidades o dividem; com fusos diferentes, a data
  // vai em UTC (e diz), para não divergir do painel de registro da agenda
  const fusos = new Set((unidades.data ?? []).map((u) => u.timezone));
  const fuso = fusos.size === 1 ? [...fusos][0] : null;
  const pacotes = useQuery({
    queryKey: [...PACKAGES_KEY, pacienteId],
    queryFn: () =>
      api.get<ClinicsPackageDto[]>(
        `/api/clinics/packages?patientId=${encodeURIComponent(pacienteId)}`,
      ),
  });
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
    <section aria-label="Pacotes do paciente" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-display-sm">Pacotes</h2>
        {podeCriar ? (
          <Button size="sm" variant="secondary" onClick={() => setCriando(true)}>
            Novo pacote
          </Button>
        ) : null}
      </div>
      {pacotes.isError ? (
        <p role="alert" className="text-data text-negative">
          Não foi possível carregar os pacotes.
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
                  <th key={h} className="eyebrow px-4 py-2 text-left text-muted-fg">
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
                <td className="px-4 py-2">{nomeDo(p.serviceId)}</td>
                <td className="px-4 py-2 num text-data">
                  {p.consumedSessions} de {p.totalSessions}
                </td>
                <td className="px-4 py-2 num text-data">{p.remainingSessions}</td>
                <td className="px-4 py-2 num text-data">
                  {p.totalPriceCents === null ? 'Não informado' : formatCents(p.totalPriceCents)}
                </td>
                <td className="px-4 py-2">{ROTULO_DO_PACOTE[p.status]}</td>
                <td className="px-4 py-2">
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
                  <EmptyState title="Nenhum pacote." />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
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
