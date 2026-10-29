import { useQuery } from '@tanstack/react-query';
import type { PipelineDto } from '@veyra/contracts';
import {
  horaLocal,
  somarDias,
  type ClinicsConfirmationFunnelDto,
  type ClinicsConversionDto,
  type ClinicsMetricStageDto,
  type ClinicsNoShowGroupDto,
  type ClinicsReactivationDto,
  type ClinicsUnitDto,
} from '@veyra/contracts/verticals/clinics';
import { useState, type ReactNode } from 'react';
import { AvisoDeEnvioSimulado } from '../../../components/envio-simulado';
import { Field, Input, Select } from '../../../components/ui/input';
import { PageHeader, Panel } from '../../../components/ui/page';
import { api, ApiError, toQuery } from '../../../lib/api';
import { hasPermission, useSession } from '../../../lib/session';
import { PortaDaClinica } from '../continuidade';
import { MOTIVO_DA_ETAPA, useEnvioSimuladoDaClinica } from '../envios/rotulos';
import { taxaLegivel } from '../NoShowPage';

/**
 * As métricas do envio (F4.4; ADR-048 adendos 8 e 10): o funil da
 * confirmação, a conversão com janela e o retorno depois da reativação. A
 * tela nunca transforma ausência em zero: a etapa sem dados diz "Sem dados", a
 * omitida diz por quê, e a parcial diz quantos puderam ser apurados. Todas são
 * associação, não causa.
 */
export function ClinicsOutreachMetricsPage() {
  return (
    <PortaDaClinica titulo="Métricas do envio" recusa="Você não tem acesso às métricas da clínica.">
      <MetricasReady />
    </PortaDaClinica>
  );
}

/** Uma etapa na tela: o número só quando há; senão, o motivo. */
export function etapaLegivel(etapa: ClinicsMetricStageDto): { valor: string; nota: string } {
  const motivo = etapa.reason ? MOTIVO_DA_ETAPA[etapa.reason] : '';
  switch (etapa.status) {
    case 'complete':
      return {
        valor: `${etapa.count} de ${etapa.total}`,
        nota: taxaLegivel((etapa.count as number) / etapa.total),
      };
    case 'partial':
      return {
        valor: `${etapa.count} de ${etapa.known} apurados`,
        nota: `Cobertura parcial: ${etapa.known} de ${etapa.total} puderam ser apurados (${motivo}). O número não é de todos.`,
      };
    case 'no_data':
      return { valor: 'Sem dados', nota: motivo ? `Sem dados: ${motivo}.` : 'Sem dados.' };
    case 'omitted':
      return { valor: 'Omitida', nota: `Contagem omitida: ${motivo}.` };
  }
}

function MetricasReady() {
  const unidades = useQuery({
    queryKey: ['clinics', 'catalog', 'units'],
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
  });
  if (unidades.isError) {
    return (
      <p role="alert" className="p-6 text-data text-negative">
        Não foi possível carregar as unidades.
      </p>
    );
  }
  if (!unidades.data) return <p className="p-6 text-body-sm text-muted-fg">Carregando…</p>;
  if (unidades.data.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader eyebrow="Clínica" title="Métricas do envio" />
        <p className="p-6 text-body-sm text-muted-fg">Nenhuma unidade ativa.</p>
      </div>
    );
  }
  return <Metricas unidades={unidades.data} />;
}

function Metricas({ unidades }: { unidades: ClinicsUnitDto[] }) {
  const { data: user } = useSession();
  const lePipelines = hasPermission(user, 'pipelines:read');
  const simulado = useEnvioSimuladoDaClinica();
  const [unidade, setUnidade] = useState(unidades.length === 1 ? unidades[0].id : '');
  const fuso = unidades.find((u) => u.id === unidade)?.timezone ?? unidades[0].timezone;
  const [periodo, setPeriodo] = useState(() => {
    const hoje = horaLocal(new Date(), fuso).data;
    return { de: somarDias(hoje, -29), ate: somarDias(hoje, 1) };
  });
  const pronto =
    unidade !== '' && periodo.de !== '' && periodo.ate !== '' && periodo.de < periodo.ate;
  const consulta = { from: periodo.de, to: periodo.ate, unitId: unidade };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Clínica"
        title="Métricas do envio"
        meta="Pelo início do agendamento, em datas locais da unidade. Associação, não causa."
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-6">
        <AvisoDeEnvioSimulado simulado={simulado} />
        <div className="flex flex-wrap items-end gap-3">
          {unidades.length > 1 ? (
            <Field label="Unidade">
              <Select value={unidade} onChange={(e) => setUnidade(e.target.value)}>
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
          ) : null}
          <Field label="De (inclusive)">
            <Input
              type="date"
              value={periodo.de}
              onChange={(e) => setPeriodo((p) => ({ ...p, de: e.target.value }))}
            />
          </Field>
          <Field label="Até (exclusive)">
            <Input
              type="date"
              value={periodo.ate}
              onChange={(e) => setPeriodo((p) => ({ ...p, ate: e.target.value }))}
            />
          </Field>
        </div>
        {!pronto ? (
          <p className="text-data text-muted-fg">
            Escolha a unidade e um período em que o início venha antes do fim.
          </p>
        ) : (
          <>
            <Funil consulta={consulta} simulado={simulado} />
            {lePipelines ? (
              <Conversao consulta={consulta} />
            ) : (
              <Panel>
                <p className="p-5 text-data text-muted-fg" data-testid="conversao-sem-acesso">
                  A conversão exige ler os pipelines.
                </p>
              </Panel>
            )}
            <Reativacao consulta={consulta} />
          </>
        )}
      </div>
    </div>
  );
}

type Consulta = { from: string; to: string; unitId: string };

function Bloco({
  titulo,
  rotulo,
  children,
}: {
  titulo: string;
  rotulo: string;
  children: ReactNode;
}) {
  return (
    <Panel>
      <section aria-label={rotulo} className="space-y-4 p-5">
        <h2 className="text-display-sm">{titulo}</h2>
        {children}
      </section>
    </Panel>
  );
}

function Erro({ erro, padrao }: { erro: unknown; padrao: string }) {
  return (
    <p role="alert" className="text-data text-negative">
      {erro instanceof ApiError ? erro.message : padrao}
    </p>
  );
}

function Numero({ rotulo, valor, nota }: { rotulo: string; valor: string; nota?: string }) {
  return (
    <div>
      <dt className="eyebrow text-muted-fg">{rotulo}</dt>
      <dd className="num text-display-sm">{valor}</dd>
      {nota ? <dd className="text-data text-muted-fg">{nota}</dd> : null}
    </div>
  );
}

function Etapa({
  rotulo,
  etapa,
  ajuda,
}: {
  rotulo: string;
  etapa: ClinicsMetricStageDto;
  ajuda?: string;
}) {
  const { valor, nota } = etapaLegivel(etapa);
  return (
    <div data-status={etapa.status}>
      <dt className="eyebrow text-muted-fg">{rotulo}</dt>
      <dd className="num text-display-sm">{valor}</dd>
      <dd className="text-data text-muted-fg">{nota}</dd>
      {ajuda ? <dd className="text-data text-muted-fg">{ajuda}</dd> : null}
    </div>
  );
}

function faltaLegivel(g: ClinicsNoShowGroupDto): string {
  const denominador = g.attended + g.noShow;
  return g.rate === null ? 'Sem dados' : `${taxaLegivel(g.rate)} (${g.noShow} em ${denominador})`;
}

function Funil({ consulta, simulado }: { consulta: Consulta; simulado: boolean | null }) {
  const funil = useQuery({
    queryKey: ['clinics', 'metrics', 'confirmation', consulta],
    queryFn: () =>
      api.get<ClinicsConfirmationFunnelDto>(
        `/api/clinics/metrics/confirmation${toQuery(consulta)}`,
      ),
  });
  const f = funil.isError ? null : (funil.data ?? null);
  const semEnvio = f ? f.base - f.sent - f.pending - f.uncertain - f.sentForEarlierSlot : 0;
  // o transporte falso não recebe recibo nem resposta do provedor: dito, sem inventar
  const semProvedor =
    simulado === true
      ? 'No envio simulado, o provedor não confirma entrega nem resposta.'
      : undefined;
  return (
    <Bloco titulo="Confirmação de horário" rotulo="Funil da confirmação">
      {funil.isError ? (
        <Erro erro={funil.error} padrao="Não foi possível calcular o funil." />
      ) : null}
      {funil.isPending ? <p className="text-data text-muted-fg">Calculando…</p> : null}
      {f ? (
        <>
          <dl className="grid gap-4 sm:grid-cols-3">
            <Numero
              rotulo="Agendamentos"
              valor={String(f.base)}
              nota={`${f.canceled} ${f.canceled === 1 ? 'cancelado' : 'cancelados'} à parte`}
            />
            <Numero
              rotulo={
                simulado === false
                  ? 'Enviados para o horário final'
                  : simulado === true
                    ? 'Enviados (simulado) para o horário final'
                    : 'Registrados como enviados para o horário final'
              }
              valor={String(f.sent)}
            />
            <Numero
              rotulo="Incertos"
              valor={String(f.uncertain)}
              nota="Podem ter saído: grupo próprio, nunca reenviados."
            />
            <Numero rotulo="Aprovados aguardando o envio" valor={String(f.pending)} />
            <Numero
              rotulo="Enviados só para um horário anterior"
              valor={String(f.sentForEarlierSlot)}
              nota="Remarcados depois do envio: à parte."
            />
            <Numero rotulo="Sem envio" valor={String(semEnvio)} />
          </dl>
          <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-3">
            <Etapa
              rotulo="Entregues"
              etapa={f.delivered}
              ajuda={f.delivered.reason === 'no_provider_confirmation' ? semProvedor : undefined}
            />
            <Etapa
              rotulo="Com resposta atribuível ao paciente"
              etapa={f.responded}
              ajuda="Conta só a resposta numa conversa identificada e ainda do contato do envio. O resto fica sem resposta atribuível ao paciente segundo os critérios da métrica, o que não prova que ele não respondeu."
            />
            <Etapa
              rotulo="Confirmados pela equipe"
              etapa={f.confirmedByTeam}
              ajuda="Confirmação registrada depois do envio e antes do início."
            />
          </dl>
          <div className="space-y-1 border-t border-border pt-4">
            <p className="eyebrow text-muted-fg">Faltas por grupo (associação, não causa)</p>
            <dl className="grid gap-4 sm:grid-cols-3">
              <Numero rotulo="Faltas com envio" valor={faltaLegivel(f.noShowBySendGroup.sent)} />
              <Numero
                rotulo="Faltas nos incertos"
                valor={faltaLegivel(f.noShowBySendGroup.uncertain)}
              />
              <Numero rotulo="Faltas sem envio" valor={faltaLegivel(f.noShowBySendGroup.notSent)} />
            </dl>
          </div>
        </>
      ) : null}
    </Bloco>
  );
}

const SITUACAO_DA_JANELA = {
  open: 'Em apuração: as janelas ainda não acabaram.',
  window_closed:
    'Janelas encerradas. O resultado é recalculado pelo estado atual e ainda pode mudar.',
} as const;

function Conversao({ consulta }: { consulta: Consulta }) {
  const [pipeline, setPipeline] = useState('');
  const pipelines = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api.get<PipelineDto[]>('/api/pipelines'),
  });
  const escolhido =
    pipeline || (pipelines.data?.find((p) => p.isDefault) ?? pipelines.data?.[0])?.id || '';
  const conversao = useQuery({
    queryKey: ['clinics', 'metrics', 'conversion', consulta, escolhido],
    queryFn: () =>
      api.get<ClinicsConversionDto>(
        `/api/clinics/metrics/conversion${toQuery({ ...consulta, pipelineId: escolhido })}`,
      ),
    enabled: escolhido !== '',
  });
  const c = conversao.isError ? null : (conversao.data ?? null);
  return (
    <Bloco titulo="Conversão" rotulo="Conversão">
      <p className="text-data text-muted-fg">
        As oportunidades do pipeline criadas no período que tiveram um agendamento vinculado, por
        vínculo válido, criado depois delas e atendido na janela. O estado da oportunidade (ganha,
        perdida ou aberta) não muda a conta. A base é a do pipeline; a unidade só define o fuso das
        datas, e o número não é a conversão da unidade.
      </p>
      {pipelines.isError ? (
        <Erro erro={pipelines.error} padrao="Não foi possível carregar os pipelines." />
      ) : (
        <Field label="Pipeline">
          <Select value={escolhido} onChange={(e) => setPipeline(e.target.value)}>
            {(pipelines.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {conversao.isError ? (
        <Erro erro={conversao.error} padrao="Não foi possível calcular a conversão." />
      ) : null}
      {c ? (
        <>
          <dl className="grid gap-4 sm:grid-cols-3">
            <Numero
              rotulo="Taxa"
              valor={taxaLegivel(c.rate)}
              nota={
                c.rate === null
                  ? 'Nenhuma oportunidade criada no período neste pipeline.'
                  : `${c.converted} de ${c.base} oportunidades`
              }
            />
            <Numero rotulo="Janela" valor={`${c.windowDays} dias`} />
          </dl>
          <p className="text-data" data-testid="situacao-da-conversao">
            {SITUACAO_DA_JANELA[c.status]}
          </p>
        </>
      ) : null}
    </Bloco>
  );
}

function Reativacao({ consulta }: { consulta: Consulta }) {
  const reativacao = useQuery({
    queryKey: ['clinics', 'metrics', 'reactivation', consulta],
    queryFn: () =>
      api.get<ClinicsReactivationDto>(`/api/clinics/metrics/reactivation${toQuery(consulta)}`),
  });
  const r = reativacao.isError ? null : (reativacao.data ?? null);
  return (
    <Bloco titulo="Retorno depois da reativação" rotulo="Retorno depois da reativação">
      <p className="text-data text-muted-fg">
        Pacientes com reativação enviada no período que voltaram a ser atendidos na janela.
        Associação temporal, não causa; a soma de períodos não é um total de pacientes.
      </p>
      {reativacao.isError ? (
        <Erro erro={reativacao.error} padrao="Não foi possível calcular a reativação." />
      ) : null}
      {r ? (
        <>
          <dl className="grid gap-4 sm:grid-cols-3">
            <Numero
              rotulo="Taxa"
              valor={taxaLegivel(r.rate)}
              nota={
                r.rate === null
                  ? 'Nenhuma reativação enviada no período.'
                  : `${r.returned} de ${r.base}`
              }
            />
            <Numero
              rotulo="Incertos"
              valor={String(r.uncertain)}
              nota="Envio que pode ter saído: fora da base."
            />
            <Numero rotulo="Janela" valor={`${r.windowDays} dias`} />
          </dl>
          <p className="text-data" data-testid="situacao-da-reativacao">
            {SITUACAO_DA_JANELA[r.status]}
          </p>
        </>
      ) : null}
    </Bloco>
  );
}
