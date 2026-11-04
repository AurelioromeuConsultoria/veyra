import { useQuery } from '@tanstack/react-query';
import {
  horaLocal,
  somarDias,
  type ClinicsNoShowDto,
  type ClinicsProfessionalDto,
  type ClinicsServiceDto,
  type ClinicsUnitDto,
} from '@veyra/contracts/verticals/clinics';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Field, Input, Select } from '../../components/ui/input';
import { EmptyState, NumeroGrande, PageHeader } from '../../components/ui/page';
import { api, ApiError, toQuery } from '../../lib/api';
import { dataCurta, PortaDaClinica } from './continuidade';
import { useAbasDosIndicadores } from './metricas/AbasDosIndicadores';
import { CLINICS_AGENDA_PATH } from './nav';

/**
 * Taxa de faltas (F3.3b; ADR-048 adendo 7, item 7 e aprovação da F3.3). Só
 * agregados. "Sem dados" (nenhum atendido nem falta) NUNCA aparece como 0 %:
 * com atendimentos e nenhuma falta, 0 % é legítimo. Os cancelados e os
 * passados sem desfecho ficam à parte, fora da conta.
 */
export function ClinicsNoShowPage() {
  return (
    <PortaDaClinica titulo="Faltas" recusa="Você não tem acesso às faltas da clínica.">
      <FaltasReady />
    </PortaDaClinica>
  );
}

/** A taxa na tela: `null` é "Sem dados", e só ele. */
export function taxaLegivel(rate: number | null): string {
  if (rate === null) return 'Sem dados';
  const pct = rate * 100;
  // uma taxa positiva pequena nunca aparece como o 0 % legítimo (nem a quase
  // total como 100 %): o arredondamento não apaga a diferença
  if (rate > 0 && pct < 0.05) return '< 0,1 %';
  if (rate < 1 && pct >= 99.95) return '> 99,9 %';
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(pct)} %`;
}

function FaltasReady() {
  const unidades = useQuery({
    queryKey: ['clinics', 'catalog', 'units'],
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
  });
  if (!unidades.isError && unidades.data && unidades.data.length > 0)
    return <Faltas unidades={unidades.data} />;
  // a carga, o erro e o vazio moram DENTRO da página, sob o cabeçalho (ADR-062)
  return (
    <div className="flex h-full flex-col">
      <CabecalhoDasFaltas />
      {unidades.isError ? (
        <p role="alert" className="p-7 text-[13.5px] text-negative">
          Não foi possível carregar as unidades.
        </p>
      ) : !unidades.data ? (
        <p className="p-7 text-[13.5px] text-muted-fg">Carregando…</p>
      ) : (
        <EmptyState
          title="Nenhuma unidade ativa."
          hint="As faltas são contadas por unidade. Cadastre a unidade nas Configurações, em Clínica."
        />
      )}
    </div>
  );
}

function Faltas({ unidades }: { unidades: ClinicsUnitDto[] }) {
  const [unidade, setUnidade] = useState(unidades.length === 1 ? unidades[0].id : '');
  const fuso = unidades.find((u) => u.id === unidade)?.timezone ?? unidades[0].timezone;
  // o padrão: os 30 dias até hoje, em datas LOCAIS da unidade; o servidor
  // decide os limites (o início de cada dia local, o fim exclusivo)
  const [periodo, setPeriodo] = useState(() => {
    const hoje = horaLocal(new Date(), fuso).data;
    return { de: somarDias(hoje, -29), ate: somarDias(hoje, 1) };
  });
  const [profissional, setProfissional] = useState('');
  const [servico, setServico] = useState('');
  const profissionais = useQuery({
    queryKey: ['clinics', 'catalog', 'professionals', true],
    queryFn: () =>
      api.get<ClinicsProfessionalDto[]>('/api/clinics/professionals?includeArchived=true'),
  });
  const servicos = useQuery({
    queryKey: ['clinics', 'catalog', 'services', true],
    queryFn: () => api.get<ClinicsServiceDto[]>('/api/clinics/services?includeArchived=true'),
  });
  const pronto =
    unidade !== '' && periodo.de !== '' && periodo.ate !== '' && periodo.de < periodo.ate;
  const taxa = useQuery({
    queryKey: ['clinics', 'metrics', 'no-show', unidade, periodo, profissional, servico],
    queryFn: () =>
      api.get<ClinicsNoShowDto>(
        `/api/clinics/metrics/no-show${toQuery({
          from: periodo.de,
          to: periodo.ate,
          unitId: unidade,
          professionalId: profissional || undefined,
          serviceId: servico || undefined,
        })}`,
      ),
    enabled: pronto,
  });
  // com erro (inclusive numa recarga), nada de número antigo
  const dado = taxa.isError ? null : (taxa.data ?? null);
  const denominador = dado ? dado.attended + dado.noShow : 0;

  return (
    <div className="flex h-full flex-col">
      <CabecalhoDasFaltas />
      <div className="min-h-0 flex-1 space-y-5 overflow-auto p-7">
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
          <Field label="Profissional">
            <Select value={profissional} onChange={(e) => setProfissional(e.target.value)}>
              <option value="">Todos</option>
              {(profissionais.isError ? [] : (profissionais.data ?? [])).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Serviço">
            <Select value={servico} onChange={(e) => setServico(e.target.value)}>
              <option value="">Todos</option>
              {(servicos.isError ? [] : (servicos.data ?? [])).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {!pronto ? (
          <p className="text-data text-muted-fg">
            Escolha a unidade e um período em que o início venha antes do fim.
          </p>
        ) : null}
        {taxa.isError ? (
          <p role="alert" className="text-data text-negative">
            {taxa.error instanceof ApiError
              ? taxa.error.message
              : 'Não foi possível calcular a taxa de faltas.'}
          </p>
        ) : null}
        {pronto && taxa.isPending ? (
          <p className="text-[13.5px] text-muted-fg">Calculando…</p>
        ) : null}
        {dado ? (
          <section className="space-y-2.5">
            {/* o período por extenso, com o último dia INCLUÍDO: o "até" exclusivo
                do filtro não vira dúvida na hora de ler o número */}
            <p className="text-[13.5px] text-muted-fg" data-testid="periodo-das-faltas">
              De <span className="num">{dataCurta(periodo.de)}</span> a{' '}
              <span className="num">{dataCurta(somarDias(periodo.ate, -1))}</span>, pelo início do
              agendamento
              {profissional || servico ? ', com os filtros acima' : ''}.
            </p>
            <dl aria-label="Taxa de faltas" className="grid gap-3.5 sm:grid-cols-3">
              <NumeroGrande
                rotulo="Taxa de faltas"
                valor={taxaLegivel(dado.rate)}
                tom={dado.noShow > 0 ? 'missed' : 'neutro'}
                legenda={
                  dado.rate === null
                    ? 'Nenhum atendido nem falta no período.'
                    : `${dado.noShow} ${dado.noShow === 1 ? 'falta' : 'faltas'} em ${denominador} (atendidos + faltas)`
                }
              />
              <NumeroGrande
                rotulo="Passados sem desfecho"
                valor={String(dado.pendingPast)}
                legenda="Ainda marcados, confirmados ou chegados: fora da conta até o registro."
              >
                {dado.pendingPast > 0 ? (
                  <dd>
                    <Link
                      to={CLINICS_AGENDA_PATH}
                      className="text-[13.5px] font-semibold text-accent hover:underline"
                    >
                      Resolver na agenda
                    </Link>
                  </dd>
                ) : null}
              </NumeroGrande>
              <NumeroGrande
                rotulo="Cancelados"
                valor={String(dado.canceled)}
                legenda="À parte: o cancelado não é falta nem atendimento."
              />
            </dl>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * O cabeçalho dos indicadores (ADR-062): o título e as abas irmãs. O grupo
 * ("Indicadores") já está no rastro do cabeçalho do produto: sem eco aqui.
 */
function CabecalhoDasFaltas() {
  const abas = useAbasDosIndicadores();
  return (
    <PageHeader
      title="Faltas"
      meta="Faltas sobre atendidos + faltas, pelo início do agendamento."
      abas={abas}
    />
  );
}
