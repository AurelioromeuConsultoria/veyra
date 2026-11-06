import { useQuery } from '@tanstack/react-query';
import {
  CLINICS_PAYMENT_MAX_CENTS,
  type ClinicsPackageBalanceDto,
  type ClinicsPackagePaymentDto,
  type ClinicsPackagePaymentsDto,
  type ClinicsPaymentMethod,
  type ClinicsPaymentUnitOptionDto,
  type ClinicsPaymentVoidReason,
  horaLocal,
} from '@veyra/contracts/verticals/clinics';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Drawer } from '../../../components/ui/drawer';
import { Field, Input, Select } from '../../../components/ui/input';
import { EmptyState, Panel } from '../../../components/ui/page';
import { StatusChip, type Tom } from '../../../components/ui/status';
import { ApiError, api } from '../../../lib/api';
import { hasPermission, useSession } from '../../../lib/session';
import { ROTULO_DO_PACOTE, dataCurta } from '../continuidade';
import { centsToReaisInput, reaisToCents } from '../format';
import {
  PAYMENTS_KEY,
  chaveDoPacote,
  lerPacote,
  useTemTentativa,
  useTentativaDoPacote,
  type Tentativa,
} from './tentativa-pendente';

export { PAYMENTS_KEY };

export const ROTULO_DA_FORMA: Record<ClinicsPaymentMethod, string> = {
  cash: 'Dinheiro',
  pix: 'Pix',
  debit_card: 'Cartão de débito',
  credit_card: 'Cartão de crédito',
  bank_transfer: 'Transferência',
  other: 'Outra',
};

export const ROTULO_DO_MOTIVO_DA_ANULACAO: Record<ClinicsPaymentVoidReason, string> = {
  wrong_entry: 'Lançado errado',
  wrong_amount: 'Valor errado',
  duplicate: 'Duplicado',
};

const SEM_PRECO = 'Saldo não calculável — preço não registrado';

const TOM_DO_PACOTE: Record<ClinicsPackageBalanceDto['status'], Tom> = {
  active: 'confirmed',
  completed: 'done',
  canceled: 'neutral',
};

/** Centavos na moeda do pacote: `150050` → "R$ 1.500,50". */
export function valor(cents: number, moeda: string): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: moeda }).format(cents / 100);
}

/**
 * Um instante do banco na hora LOCAL de uma unidade, sempre com o fuso usado:
 * "05/11/2026 às 14:32 (America/Sao_Paulo)". Sem fuso de unidade, na hora do
 * navegador — e dito: "(fuso do navegador, America/Sao_Paulo)".
 */
export function quando(iso: string, fuso: string | null): string {
  if (fuso) {
    const h = horaLocal(new Date(iso), fuso);
    return `${dataCurta(h.data)} às ${h.hora} (${fuso})`;
  }
  const doNavegador = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const h = horaLocal(new Date(iso), doNavegador);
  return `${dataCurta(h.data)} às ${h.hora} (fuso do navegador, ${doNavegador})`;
}

/**
 * O fuso dos instantes de um pagamento (ADR-063 adendo 1): o da unidade dele;
 * sem unidade registrada (o lançamento anterior), o da única unidade ativa, se
 * houver — `quando` diz qual foi usado.
 */
const fusoDoPagamento = (pg: ClinicsPackagePaymentDto, daUnicaAtiva: string | null) =>
  pg.unit?.timezone ?? daUnicaAtiva;

/** Ativo ou concluído com saldo a receber: o que a recepção precisa ver primeiro. */
const pendente = (p: ClinicsPackageBalanceDto) =>
  p.status !== 'canceled' && p.balanceCents !== null && p.balanceCents > 0;

/** Os pacotes (visão financeira) do paciente: a MESMA consulta da aba e do resumo. */
export function useSaldosDoPaciente(pacienteId: string) {
  return useQuery({
    queryKey: [...PAYMENTS_KEY, 'patient', pacienteId],
    queryFn: () =>
      api.get<ClinicsPackageBalanceDto[]>(
        `/api/clinics/patients/${encodeURIComponent(pacienteId)}/package-payments`,
      ),
  });
}

export interface ResumoDoSaldo {
  /** por moeda, o total a receber dos pacotes ativos ou concluídos COM preço registrado */
  aReceber: { moeda: string; totalCents: number; pacotes: number }[];
  /** ativos ou concluídos sem preço registrado: saldo não calculável */
  semPreco: number;
}

/**
 * O saldo pendente do paciente (ADR-063 adendo 1): cancelados fora; o total
 * só dos pacotes com preço, separado por moeda; os sem preço, à parte.
 */
export function resumoDoSaldo(pacotes: readonly ClinicsPackageBalanceDto[]): ResumoDoSaldo {
  const porMoeda = new Map<string, { totalCents: number; pacotes: number }>();
  let semPreco = 0;
  for (const p of pacotes) {
    if (p.status === 'canceled') continue;
    if (p.balanceCents === null) {
      semPreco += 1;
      continue;
    }
    if (p.balanceCents <= 0) continue;
    const atual = porMoeda.get(p.currency) ?? { totalCents: 0, pacotes: 0 };
    porMoeda.set(p.currency, {
      totalCents: atual.totalCents + p.balanceCents,
      pacotes: atual.pacotes + 1,
    });
  }
  return {
    aReceber: [...porMoeda.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([moeda, v]) => ({ moeda, ...v })),
    semPreco,
  };
}

// memberships não são apagadas: o nome vem sempre; vazio só no caso defensivo
const quem = (nome: string) => nome || 'pessoa não identificada';

/**
 * A aba "Pagamentos" da ficha (ADR-063, F6.1a; a recepção na F6.1b). Só montada
 * com `clinics:payments:read`. A visão FINANCEIRA de cada pacote — estado, preço,
 * recebido e saldo — sem sessões nem atendimentos. Clicar abre o painel do
 * pacote, com o histórico e as ações que a pessoa tem.
 */
export function PagamentosDoPaciente({ pacienteId }: { pacienteId: string }) {
  const [aberto, setAberto] = useState<ClinicsPackageBalanceDto | null>(null);
  const pacotes = useSaldosDoPaciente(pacienteId);
  // com erro, nada de dado antigo: é dado financeiro
  const linhas = pacotes.isError ? [] : (pacotes.data ?? []);

  return (
    <section aria-label="Pagamentos do paciente" className="space-y-3">
      <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em]">Pagamentos</h2>
      {pacotes.isError ? (
        <p role="alert" className="text-data text-negative">
          Não foi possível carregar os pagamentos.
        </p>
      ) : null}
      <Panel>
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2/50">
              {['Pacote', 'Estado', 'Preço', 'Recebido', 'Saldo', ''].map((h) => (
                <th key={h} className="eyebrow px-5 py-3 text-left text-muted-fg">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {linhas.map((p) => (
              <tr
                key={p.packageId}
                aria-label={`Pacote de ${p.serviceName}`}
                className={
                  pendente(p)
                    ? 'border-b border-border/60 bg-state-pending/40 last:border-b-0'
                    : 'border-b border-border/60 last:border-b-0'
                }
              >
                <td className="px-5 py-3">
                  <span className="font-semibold">{p.serviceName}</span>
                  <span className="block text-[13px] text-muted-fg">
                    criado em {new Date(p.createdAt).toLocaleDateString('pt-BR')}
                  </span>
                  <SinalDePendencia packageId={p.packageId} />
                </td>
                <td className="px-5 py-3">
                  <StatusChip tom={TOM_DO_PACOTE[p.status]}>
                    {ROTULO_DO_PACOTE[p.status]}
                  </StatusChip>
                </td>
                <td className="px-5 py-3 num text-data">
                  {p.totalPriceCents === null
                    ? 'Não registrado'
                    : valor(p.totalPriceCents, p.currency)}
                </td>
                <td className="px-5 py-3 num text-data">{valor(p.receivedCents, p.currency)}</td>
                <td className="px-5 py-3 text-data">
                  {p.balanceCents === null ? (
                    <span className="text-muted-fg">{SEM_PRECO}</span>
                  ) : pendente(p) ? (
                    <StatusChip tom="pending">
                      {/* o chip é flex: o texto solto perderia o espaço inicial */}
                      <span>
                        <span className="num">{valor(p.balanceCents, p.currency)}</span> a receber
                      </span>
                    </StatusChip>
                  ) : (
                    <span className="num">{valor(p.balanceCents, p.currency)}</span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Pagamentos do pacote de ${p.serviceName}`}
                    onClick={() => setAberto(p)}
                  >
                    Ver pagamentos
                  </Button>
                </td>
              </tr>
            ))}
            {pacotes.data && !pacotes.isError && linhas.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState title="Nenhum pacote." />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
      <Drawer
        open={aberto !== null}
        onOpenChange={(abrir) => !abrir && setAberto(null)}
        title={aberto ? `Pagamentos · ${aberto.serviceName}` : 'Pagamentos'}
      >
        {aberto ? <PainelDoPacote packageId={aberto.packageId} /> : null}
      </Drawer>
    </section>
  );
}

/**
 * Na linha da lista: o pacote tem operação sem resultado confirmado (ou à espera
 * da releitura). É o caminho de volta ao painel, onde só "Tentar de novo" resolve.
 */
function SinalDePendencia({ packageId }: { packageId: string }) {
  if (!useTemTentativa(packageId)) return null;
  return (
    <span className="mt-1 block">
      <StatusChip tom="pending">Operação pendente de confirmação</StatusChip>
    </span>
  );
}

type Acao = { tipo: 'registrar' } | { tipo: 'anular'; pagamento: ClinicsPackagePaymentDto } | null;

type Envio = ReturnType<typeof useTentativaDoPacote>;

/**
 * O painel de um pacote: o saldo, o histórico e as ações. A tentativa pendente
 * (o resultado que não chegou) vem antes de tudo e bloqueia o pacote: nem fechar
 * o painel nem a recarga (que falhe ou que venha vazia) a tiram da tela — só
 * "Tentar de novo", com a mesma chave. Com o resultado definitivo, as ações só
 * voltam depois de o histórico e o saldo serem relidos com sucesso.
 */
function PainelDoPacote({ packageId }: { packageId: string }) {
  const { data: user } = useSession();
  const podeRegistrar = hasPermission(user, 'clinics:payments:write');
  const podeAnular = hasPermission(user, 'clinics:payments:void');
  const [acao, setAcao] = useState<Acao>(null);
  const envio = useTentativaDoPacote(packageId);
  const detalhe = useQuery({
    queryKey: chaveDoPacote(packageId),
    queryFn: () => lerPacote(packageId),
  });
  // confirmado o envio, volta ao histórico com o recibo
  const acaoAtual = envio.feito ? null : acao;
  const abrir = (a: Acao) => {
    envio.limparAvisos();
    setAcao(a);
  };
  const erroDaCarga = detalhe.isError ? (
    <p role="alert" className="text-data text-negative">
      {detalhe.error instanceof ApiError && detalhe.error.status === 404
        ? 'Pacote não encontrado.'
        : 'Não foi possível carregar os pagamentos do pacote.'}
    </p>
  ) : null;

  // a tentativa pendente: com a ação aberta, em voo ou relendo, o formulário
  // fica montado (ocupado); fora isso, a pendência toma o lugar da ação
  const formularioOcupado = acaoAtual !== null && (envio.emVoo || envio.relendo);
  if (envio.pendente && !formularioOcupado) {
    return (
      <div className="space-y-4">
        {envio.pendente.desfecho ? (
          <Releitura
            falhou={envio.releituraFalhou}
            mensagem={envio.pendente.desfecho.mensagem}
            onRecarregar={envio.recarregar}
          />
        ) : (
          <TentativaPendente
            tentativa={envio.pendente}
            emVoo={envio.emVoo}
            onRepetir={envio.repetir}
          />
        )}
        {erroDaCarga ?? (detalhe.data ? <Resumo dados={detalhe.data} podeAnular={false} /> : null)}
      </div>
    );
  }
  // a ação aberta continua montada mesmo se a recarga falhar (o dado fica)
  if (acaoAtual && detalhe.data) {
    const { package: p, units } = detalhe.data;
    return acaoAtual.tipo === 'registrar' ? (
      <RegistrarPagamento pacote={p} unidades={units} envio={envio} onFim={() => setAcao(null)} />
    ) : (
      <AnularPagamento
        pagamento={acaoAtual.pagamento}
        moeda={p.currency}
        envio={envio}
        onFim={() => setAcao(null)}
      />
    );
  }
  if (erroDaCarga) return erroDaCarga;
  if (!detalhe.data) return <p className="text-data text-muted-fg">Carregando…</p>;
  const p = detalhe.data.package;
  const quitado = p.balanceCents !== null && p.balanceCents <= 0;
  // sem unidade ativa não há "hoje" para a data do recebimento (ADR-063 adendo 1)
  const semUnidade = detalhe.data.units.length === 0;
  const semRegistro = p.status === 'canceled' || quitado || semUnidade;

  return (
    <div className="space-y-4">
      {envio.feito ? (
        <p role="status" className="text-body-sm font-medium">
          {envio.feito}
        </p>
      ) : null}
      {envio.erro ? (
        <p role="alert" className="text-data text-negative">
          {envio.erro}
        </p>
      ) : null}
      {podeRegistrar ? (
        <div className="space-y-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={semRegistro}
            aria-describedby={semRegistro ? 'motivo-sem-registro' : undefined}
            onClick={() => abrir({ tipo: 'registrar' })}
          >
            Registrar pagamento
          </Button>
          {p.status === 'canceled' ? (
            <p id="motivo-sem-registro" className="text-data text-muted-fg">
              Pacote cancelado: não recebe pagamento novo. Os registrados podem ser anulados.
            </p>
          ) : quitado ? (
            <p id="motivo-sem-registro" className="text-data text-muted-fg">
              Pacote quitado: o recebido cobre o preço.
            </p>
          ) : semUnidade ? (
            <p id="motivo-sem-registro" className="text-data text-muted-fg">
              A clínica não tem unidade ativa: a data do recebimento segue o fuso da unidade, então
              o registro fica indisponível.
            </p>
          ) : null}
        </div>
      ) : null}
      <Resumo
        dados={detalhe.data}
        podeAnular={podeAnular}
        onAnular={(pagamento) => abrir({ tipo: 'anular', pagamento })}
        orientarCorrecao={!podeAnular}
      />
    </div>
  );
}

/** O pedido sem resultado confirmado, com a única saída: o mesmo pedido de novo. */
function TentativaPendente({
  tentativa,
  emVoo,
  onRepetir,
}: {
  tentativa: Tentativa;
  emVoo: boolean;
  onRepetir: () => void;
}) {
  const titulo =
    tentativa.tipo === 'registrar'
      ? 'Registro pendente de confirmação'
      : 'Anulação pendente de confirmação';
  return (
    <section
      aria-label={titulo}
      className="space-y-2 rounded-control border border-border bg-state-pending/40 p-3"
    >
      <h3 className="font-display text-[15px] font-semibold">{titulo}</h3>
      <p className="text-body-sm">{tentativa.resumo}</p>
      {emVoo ? (
        <p role="status" className="text-data text-muted-fg">
          Enviando…
        </p>
      ) : (
        <p role="alert" className="text-data">
          O resultado não chegou:{' '}
          {tentativa.tipo === 'registrar'
            ? 'o pagamento pode já ter sido registrado.'
            : 'a anulação pode já ter sido gravada.'}{' '}
          Só “Tentar de novo” confirma: repete o mesmo pedido, sem criar outro lançamento. Até lá,
          este pacote não aceita outra operação.
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={emVoo} onClick={onRepetir}>
          Tentar de novo
        </Button>
      </div>
    </section>
  );
}

/**
 * O resultado definitivo chegou; as ações voltam só depois de o histórico e o
 * saldo serem relidos com sucesso. Se a leitura falha, "Recarregar".
 */
function Releitura({
  falhou,
  mensagem,
  onRecarregar,
}: {
  falhou: boolean;
  mensagem: string;
  onRecarregar: () => void;
}) {
  return (
    <section
      aria-label="Atualizando o histórico"
      className="space-y-2 rounded-control border border-border bg-state-pending/40 p-3"
    >
      <p className="text-body-sm">Resposta recebida: {mensagem}</p>
      {falhou ? (
        <>
          <p role="alert" className="text-data text-negative">
            Não foi possível reler o histórico e o saldo. Este pacote não aceita outra operação até
            a leitura dar certo.
          </p>
          <Button size="sm" variant="primary" onClick={onRecarregar}>
            Recarregar
          </Button>
        </>
      ) : (
        <p role="status" className="text-data text-muted-fg">
          Atualizando o histórico e o saldo…
        </p>
      )}
    </section>
  );
}

/**
 * O saldo e o histórico; "Anular" só para quem tem a chave e sem tentativa
 * pendente. `orientarCorrecao`: quem não tem a chave lê a quem pedir.
 */
function Resumo({
  dados,
  podeAnular,
  onAnular,
  orientarCorrecao = false,
}: {
  dados: ClinicsPackagePaymentsDto;
  podeAnular: boolean;
  onAnular?: (pagamento: ClinicsPackagePaymentDto) => void;
  orientarCorrecao?: boolean;
}) {
  const { package: p, payments, timezone } = dados;
  // quem não anula vê por que o botão não existe (ADR-063 adendo 1)
  const algumAnulavel = payments.some((pg) => pg.void === null);
  return (
    <>
      <dl className="grid grid-cols-3 gap-3 text-body-sm">
        <div>
          <dt className="eyebrow text-muted-fg">Preço</dt>
          <dd className="num">
            {p.totalPriceCents === null ? 'Não registrado' : valor(p.totalPriceCents, p.currency)}
          </dd>
        </div>
        <div>
          <dt className="eyebrow text-muted-fg">Recebido</dt>
          <dd className="num">{valor(p.receivedCents, p.currency)}</dd>
        </div>
        <div>
          <dt className="eyebrow text-muted-fg">Saldo</dt>
          <dd className="num">
            {p.balanceCents === null ? SEM_PRECO : valor(p.balanceCents, p.currency)}
          </dd>
        </div>
      </dl>
      <section aria-label="Histórico de pagamentos" className="space-y-2">
        <h3 className="eyebrow text-muted-fg">Histórico</h3>
        {payments.length === 0 ? (
          <p className="text-data text-muted-fg">Nenhum pagamento registrado.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {payments.map((pg) => (
              <li key={pg.id} className="space-y-1 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className={
                      pg.void ? 'num font-semibold text-muted-fg line-through' : 'num font-semibold'
                    }
                  >
                    {valor(pg.amountCents, pg.currency)} · {ROTULO_DA_FORMA[pg.method]}
                  </span>
                  <span className="num text-[13px] text-muted-fg">
                    recebido em {dataCurta(pg.receivedOn)}
                  </span>
                </div>
                <p className="text-[13px] text-muted-fg">
                  {pg.unit
                    ? `na ${pg.unit.name}${pg.unit.archived ? ' (arquivada)' : ''}`
                    : 'Unidade não registrada (lançamento anterior)'}
                </p>
                <p className="text-[13px] text-muted-fg">
                  registrado por {quem(pg.createdBy.name)} em{' '}
                  {quando(pg.createdAt, fusoDoPagamento(pg, timezone))}
                </p>
                {pg.void ? (
                  <p className="text-[13px] text-negative">
                    anulado por {quem(pg.void.voidedBy.name)} em{' '}
                    {quando(pg.void.createdAt, fusoDoPagamento(pg, timezone))}, motivo:{' '}
                    {ROTULO_DO_MOTIVO_DA_ANULACAO[pg.void.reason].toLowerCase()}
                  </p>
                ) : podeAnular && onAnular ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Anular o pagamento de ${valor(pg.amountCents, pg.currency)} recebido em ${dataCurta(pg.receivedOn)}`}
                    onClick={() => onAnular(pg)}
                  >
                    Anular
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {orientarCorrecao && algumAnulavel ? (
          <p className="text-data text-muted-fg">
            Para corrigir um lançamento, peça a quem administra a clínica.
          </p>
        ) : null}
      </section>
    </>
  );
}

/**
 * Registrar: o valor vem preenchido com o saldo (editável), a unidade é a única
 * ativa ou escolhida sem sugestão (ADR-063 adendo 1), a data é hoje no fuso
 * dela e a forma é escolhida. Revisar mostra o que será gravado; a
 * confirmação manda com `Idempotency-Key`. O resultado que não chega vira a
 * tentativa pendente do pacote, repetida com a MESMA chave.
 */
function RegistrarPagamento({
  pacote,
  unidades,
  envio,
  onFim,
}: {
  pacote: ClinicsPackageBalanceDto;
  unidades: ClinicsPaymentUnitOptionDto[];
  envio: Envio;
  onFim: () => void;
}) {
  const [texto, setTexto] = useState(
    pacote.balanceCents !== null && pacote.balanceCents > 0
      ? centsToReaisInput(pacote.balanceCents)
      : '',
  );
  // uma unidade ativa: ela, sem campo; várias: a escolha, sem nada pré-selecionado
  const unica = unidades.length === 1 ? unidades[0] : null;
  const [unidadeId, setUnidadeId] = useState(unica?.id ?? '');
  const unidade = unidades.find((u) => u.id === unidadeId) ?? null;
  const hoje = unidade?.today ?? null;
  const [data, setData] = useState(unica?.today ?? '');
  // enquanto a pessoa não mexeu na data, ela acompanha o hoje da unidade escolhida
  const [dataTocada, setDataTocada] = useState(false);
  const [forma, setForma] = useState<ClinicsPaymentMethod | ''>('');
  const [revisando, setRevisando] = useState(false);
  const ocupado = envio.pendente !== null;
  const centavos = reaisToCents(texto);
  const valorValido =
    typeof centavos === 'number' && centavos > 0 && centavos <= CLINICS_PAYMENT_MAX_CENTS;
  const acimaDoSaldo =
    valorValido && pacote.balanceCents !== null && (centavos as number) > pacote.balanceCents;
  const dataValida = hoje !== null && /^\d{4}-\d{2}-\d{2}$/.test(data) && data <= hoje;
  const pronto = unidade !== null && valorValido && !acimaDoSaldo && dataValida && forma !== '';

  return (
    <div className="space-y-3">
      <h3 className="font-display text-[15px] font-semibold">Registrar pagamento</h3>
      {envio.erro ? (
        <p role="alert" className="text-data text-negative">
          {envio.erro}
        </p>
      ) : null}
      {revisando && pronto ? (
        <>
          <p className="text-body-sm">
            Registrar o recebimento de{' '}
            <strong className="num">{valor(centavos as number, pacote.currency)}</strong> em{' '}
            {ROTULO_DA_FORMA[forma as ClinicsPaymentMethod].toLowerCase()}, recebido em{' '}
            {dataCurta(data)} na {unidade?.name}, no pacote de {pacote.serviceName}. O registro não
            se edita depois: para corrigir, anule e registre de novo.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={ocupado}
              onClick={() => {
                const quanto = valor(centavos as number, pacote.currency);
                const comoFoi = ROTULO_DA_FORMA[forma as ClinicsPaymentMethod].toLowerCase();
                envio.enviar({
                  tipo: 'registrar',
                  caminho: `/api/clinics/packages/${encodeURIComponent(pacote.packageId)}/payments`,
                  corpo: {
                    amountCents: centavos,
                    receivedOn: data,
                    method: forma,
                    unitId: unidade?.id,
                  },
                  resumo: `Pagamento de ${quanto} em ${comoFoi}, recebido em ${dataCurta(data)} na ${unidade?.name ?? 'unidade'}, no pacote de ${pacote.serviceName}.`,
                  confirmacao: `Pagamento de ${quanto} registrado.`,
                });
              }}
            >
              Confirmar registro
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={ocupado}
              onClick={() => setRevisando(false)}
            >
              Voltar
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field
            label="Valor recebido"
            hint={
              pacote.balanceCents === null
                ? 'Em reais. O pacote não tem preço registrado.'
                : `Em reais. Saldo do pacote: ${valor(pacote.balanceCents, pacote.currency)}.`
            }
          >
            <Input inputMode="decimal" value={texto} onChange={(e) => setTexto(e.target.value)} />
          </Field>
          {texto.trim() !== '' && !valorValido ? (
            <p role="alert" className="text-data text-negative">
              Use um valor em reais maior que zero, como 150,00.
            </p>
          ) : acimaDoSaldo ? (
            <p role="alert" className="text-data text-negative">
              O valor passa do saldo do pacote.
            </p>
          ) : null}
          {unica ? (
            <p className="text-body-sm">
              <span className="eyebrow mr-2 text-muted-fg">Unidade</span>
              {unica.name}
            </p>
          ) : (
            <Field label="Unidade" hint="Onde o pagamento foi recebido: a data segue o fuso dela.">
              <Select
                value={unidadeId}
                onChange={(e) => {
                  const escolhida = unidades.find((u) => u.id === e.target.value);
                  setUnidadeId(e.target.value);
                  // a data não tocada (ou vazia) acompanha o hoje da unidade escolhida
                  if (escolhida && (!dataTocada || data === '')) setData(escolhida.today);
                }}
              >
                <option value="" disabled>
                  Escolha a unidade
                </option>
                {unidades.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field
            label="Data do recebimento"
            hint={
              unidade
                ? 'Na data da unidade; não pode ser futura.'
                : 'Escolha a unidade primeiro: a data segue o fuso dela.'
            }
          >
            <Input
              type="date"
              value={data}
              disabled={unidade === null}
              max={hoje ?? undefined}
              onChange={(e) => {
                setDataTocada(true);
                setData(e.target.value);
              }}
            />
          </Field>
          {unidade && data !== '' && hoje !== null && data > hoje ? (
            <p role="alert" className="text-data text-negative">
              A data não pode ser futura na {unidade.name}.
            </p>
          ) : null}
          <Field label="Forma">
            <Select
              value={forma}
              onChange={(e) => setForma(e.target.value as ClinicsPaymentMethod)}
            >
              <option value="" disabled>
                Escolha a forma
              </option>
              {(Object.keys(ROTULO_DA_FORMA) as ClinicsPaymentMethod[]).map((m) => (
                <option key={m} value={m}>
                  {ROTULO_DA_FORMA[m]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!pronto || ocupado}
              onClick={() => setRevisando(true)}
            >
              Revisar pagamento
            </Button>
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={onFim}>
              Cancelar
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Anular: o motivo, a confirmação e a `Idempotency-Key`. O original fica no histórico. */
function AnularPagamento({
  pagamento,
  moeda,
  envio,
  onFim,
}: {
  pagamento: ClinicsPackagePaymentDto;
  moeda: string;
  envio: Envio;
  onFim: () => void;
}) {
  const [motivo, setMotivo] = useState<ClinicsPaymentVoidReason | ''>('');
  const ocupado = envio.pendente !== null;
  const descricao = `${valor(pagamento.amountCents, moeda)} recebido em ${dataCurta(pagamento.receivedOn)}`;

  return (
    <div className="space-y-3">
      <h3 className="font-display text-[15px] font-semibold">Anular pagamento</h3>
      {envio.erro ? (
        <p role="alert" className="text-data text-negative">
          {envio.erro}
        </p>
      ) : null}
      <p className="text-body-sm">
        O pagamento de {descricao} fica no histórico, marcado como anulado, e deixa de contar no
        recebido. Anular não é devolver ao paciente.
      </p>
      <Field label="Motivo">
        <Select
          value={motivo}
          onChange={(e) => setMotivo(e.target.value as ClinicsPaymentVoidReason)}
        >
          <option value="" disabled>
            Escolha o motivo
          </option>
          {(Object.keys(ROTULO_DO_MOTIVO_DA_ANULACAO) as ClinicsPaymentVoidReason[]).map((m) => (
            <option key={m} value={m}>
              {ROTULO_DO_MOTIVO_DA_ANULACAO[m]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="danger"
          disabled={motivo === '' || ocupado}
          onClick={() =>
            envio.enviar({
              tipo: 'anular',
              caminho: `/api/clinics/package-payments/${encodeURIComponent(pagamento.id)}/void`,
              corpo: { reason: motivo },
              resumo: `Anular o pagamento de ${descricao}, motivo: ${ROTULO_DO_MOTIVO_DA_ANULACAO[motivo as ClinicsPaymentVoidReason].toLowerCase()}.`,
              confirmacao: `Pagamento de ${descricao} anulado.`,
            })
          }
        >
          Confirmar anulação
        </Button>
        <Button size="sm" variant="ghost" disabled={ocupado} onClick={onFim}>
          Voltar
        </Button>
      </div>
    </div>
  );
}
