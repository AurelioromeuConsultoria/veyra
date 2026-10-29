import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  horaLocal,
  type ClinicsOutreachCandidateDto,
  type ClinicsOutreachKind,
  type ClinicsOutreachOptionDto,
  type ClinicsOutreachPrepareDto,
  type ClinicsOutreachPreviewDto,
  type ClinicsOutreachRequestDto,
  type ClinicsOutreachResultDto,
  type ClinicsUnitDto,
} from '@veyra/contracts/verticals/clinics';
import { useState } from 'react';
import { AvisoDeEnvioSimulado } from '../../../components/envio-simulado';
import { Button } from '../../../components/ui/button';
import { Drawer } from '../../../components/ui/drawer';
import { Field, Input, Select } from '../../../components/ui/input';
import { EmptyState, PageHeader, Panel } from '../../../components/ui/page';
import { api, ApiError, toQuery } from '../../../lib/api';
import { hasPermission, useSession } from '../../../lib/session';
import { PortaDaClinica, dataCurta, instanteLocal } from '../continuidade';
import { textoDaAprovacao } from '../../../pages/InboxTemplate';
import {
  ROTULO_DO_TIPO,
  motivoLegivel,
  rotuloDoEstado,
  useEnvioSimuladoDaClinica,
} from './rotulos';

/**
 * Os envios da clínica (F4.4; ADR-048 adendos 8 a 10): os candidatos, o pedido,
 * a prévia de cada destinatário, a aprovação em lote e o acompanhamento. A
 * tela só oferece o que o servidor dá — os candidatos com os números do
 * contato, as versões revisadas para a finalidade do tipo — e nunca monta
 * destinatário nem parâmetro. Aprovar manda o hash da prévia: o que mudou
 * desde então é recusado com o motivo.
 *
 * A chave de idempotência nasce com a prévia: repetir a aprovação da MESMA
 * prévia (a rede caiu) devolve o resultado guardado, sem segunda mensagem.
 */
export function ClinicsOutreachPage() {
  return (
    <PortaDaClinica titulo="Envios" recusa="Você não tem acesso aos envios da clínica.">
      <EnviosReady />
    </PortaDaClinica>
  );
}

export const OUTREACH_KEY = ['clinics', 'outreach'] as const;

const chaveDoAlvo = (c: ClinicsOutreachCandidateDto) => (c.appointmentId ?? c.returnId) as string;
const chaveDaOpcao = (o: ClinicsOutreachOptionDto) => `${o.templateVersionId}:${o.purposeId}`;

type ItemDaPrevia = {
  chave: string;
  paciente: string;
  requestId: string | null;
  numero: string;
  resultado:
    | { ok: true; text: string; expiresAt: string; approvalHash: string }
    | { ok: false; motivo: string };
};

function EnviosReady() {
  const { data: user } = useSession();
  // os candidatos mostram o número e a situação: contatos e consentimentos
  const podeVer = hasPermission(user, 'contacts:read') && hasPermission(user, 'consents:read');
  const podeEnviar =
    podeVer &&
    hasPermission(user, 'clinics:schedule:write') &&
    hasPermission(user, 'conversations:write');
  const unidades = useQuery({
    queryKey: ['clinics', 'catalog', 'units'],
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
    enabled: podeVer,
  });

  if (!podeVer) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader eyebrow="Clínica" title="Envios" />
        <EmptyState
          title="Os envios mostram o número do paciente e a situação do consentimento."
          hint="Exige ler os contatos e os consentimentos. Peça a quem administra o workspace."
        />
      </div>
    );
  }
  if (unidades.isError) {
    return (
      <p role="alert" className="p-6 text-data text-negative">
        Não foi possível carregar as unidades.
      </p>
    );
  }
  if (!unidades.data) return <p className="p-6 text-body-sm text-muted-fg">Carregando…</p>;
  return <Envios unidades={unidades.data} podeEnviar={podeEnviar} />;
}

function Envios({ unidades, podeEnviar }: { unidades: ClinicsUnitDto[]; podeEnviar: boolean }) {
  const queryClient = useQueryClient();
  const simulado = useEnvioSimuladoDaClinica();
  const [tipo, setTipo] = useState<ClinicsOutreachKind>('confirmation');
  const [unidade, setUnidade] = useState(unidades.length === 1 ? unidades[0].id : '');
  const fuso = unidades.find((u) => u.id === unidade)?.timezone ?? unidades[0]?.timezone ?? null;
  const [dia, setDia] = useState(() => horaLocal(new Date(), fuso ?? 'UTC').data);
  const [dias, setDias] = useState(2);
  /** o alvo escolhido → o número exato escolhido */
  const [escolhidos, setEscolhidos] = useState<Map<string, string>>(new Map());
  const [opcaoEscolhida, setOpcaoEscolhida] = useState('');
  const [previa, setPrevia] = useState<{
    itens: ItemDaPrevia[];
    opcao: ClinicsOutreachOptionDto;
    chave: string;
  } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{ paciente: string; texto: string }[]>([]);
  /** a aprovação ficou sem resposta definitiva: só a MESMA pode ser repetida */
  const [incerto, setIncerto] = useState(false);
  const [detalhe, setDetalhe] = useState<string | null>(null);

  const pronto = unidade !== '' || unidades.length <= 1;
  const candidatos = useQuery({
    queryKey: [...OUTREACH_KEY, 'candidates', tipo, unidade, dia, dias],
    queryFn: () =>
      api.get<ClinicsOutreachCandidateDto[]>(
        `/api/clinics/outreach/candidates${toQuery({
          kind: tipo,
          unitId: unidade || undefined,
          ...(tipo === 'confirmation' ? { date: dia, days: dias } : {}),
        })}`,
      ),
    enabled: pronto,
  });
  const opcoes = useQuery({
    queryKey: [...OUTREACH_KEY, 'options', tipo],
    queryFn: () =>
      api.get<ClinicsOutreachOptionDto[]>(
        `/api/clinics/outreach/options${toQuery({ kind: tipo })}`,
      ),
    enabled: podeEnviar,
  });
  const opcao = opcoes.data?.find((o) => chaveDaOpcao(o) === opcaoEscolhida) ?? null;
  const lista = candidatos.isError ? [] : (candidatos.data ?? []);
  const doAlvo = new Map(lista.map((c) => [chaveDoAlvo(c), c]));

  const recomecar = () => {
    setPrevia(null);
    setAviso(null);
  };
  /** outro filtro, outra lista: a escolha de antes não vale para ela */
  const mudarFiltro = (aplicar: () => void) => {
    aplicar();
    setEscolhidos(new Map());
    recomecar();
  };
  const mudarTipo = (novo: ClinicsOutreachKind) =>
    mudarFiltro(() => {
      setTipo(novo);
      setOpcaoEscolhida('');
      setResultado([]);
    });

  const verPrevia = useMutation({
    mutationFn: async (o: ClinicsOutreachOptionDto): Promise<ItemDaPrevia[]> => {
      const alvos = [...escolhidos.entries()];
      const preparado = await api.post<ClinicsOutreachPrepareDto>(
        '/api/clinics/outreach/requests',
        {
          kind: tipo,
          targets: alvos.map(([chave]) => {
            const c = doAlvo.get(chave);
            if (!c) throw new Error('A lista de candidatos mudou: escolha de novo.');
            return c.appointmentId ? { appointmentId: c.appointmentId } : { returnId: c.returnId };
          }),
        },
      );
      const itens: ItemDaPrevia[] = alvos.map(([chave, numero], i) => {
        const p = preparado.items.find((x) => x.index === i);
        const paciente = doAlvo.get(chave)?.patientName ?? '';
        return p?.ok
          ? {
              chave,
              paciente,
              numero,
              requestId: p.request.id,
              resultado: { ok: false, motivo: '' },
            }
          : {
              chave,
              paciente,
              numero,
              requestId: null,
              resultado: { ok: false, motivo: p ? motivoLegivel(p.reason) : 'não preparado' },
            };
      });
      const paraPrevia = itens.filter((i) => i.requestId !== null);
      if (paraPrevia.length > 0) {
        const res = await api.post<ClinicsOutreachPreviewDto>('/api/clinics/outreach/preview', {
          items: paraPrevia.map((i) => ({
            requestId: i.requestId,
            channelId: o.channelId,
            number: i.numero,
            templateVersionId: o.templateVersionId,
            purposeId: o.purposeId,
          })),
        });
        paraPrevia.forEach((item, i) => {
          const r = res.items.find((x) => x.index === i);
          item.resultado = r?.ok
            ? { ok: true, text: r.text, expiresAt: r.expiresAt, approvalHash: r.approvalHash }
            : { ok: false, motivo: r ? motivoLegivel(r.reason) : 'sem prévia' };
        });
      }
      return itens;
    },
    onSuccess: (itens, o) => {
      setPrevia({ itens, opcao: o, chave: crypto.randomUUID() });
      setAviso(null);
      setResultado([]);
      void queryClient.invalidateQueries({ queryKey: [...OUTREACH_KEY, 'candidates'] });
    },
    onError: (e) =>
      setAviso(e instanceof ApiError || e instanceof Error ? e.message : 'Falha ao gerar a prévia'),
  });

  const aprovaveis = previa?.itens.filter((i) => i.resultado.ok) ?? [];
  const aprovar = useMutation({
    mutationFn: async (p: NonNullable<typeof previa>) => {
      const res = await api.postIdempotente<ClinicsOutreachResultDto>(
        '/api/clinics/outreach/approve',
        {
          items: p.itens
            .filter((i) => i.resultado.ok)
            .map((i) => {
              const r = i.resultado as Extract<ItemDaPrevia['resultado'], { ok: true }>;
              return {
                requestId: i.requestId,
                channelId: p.opcao.channelId,
                number: i.numero,
                templateVersionId: p.opcao.templateVersionId,
                purposeId: p.opcao.purposeId,
                expiresAt: r.expiresAt,
                approvalHash: r.approvalHash,
              };
            }),
        },
        p.chave,
      );
      /**
       * A conciliação (adendo 12, item 4): na repetição, um item já aprovado
       * pode voltar recusado (o residual do adendo 11). Cada recusa é conferida
       * no acompanhamento do pedido; a leitura que falha fica sem confirmação.
       */
      const conferidos = new Map<string, ClinicsOutreachRequestDto | null>();
      await Promise.all(
        res.items
          .filter((r) => r.state !== 'approved')
          .map(async (r) => {
            const lido = await api
              .get<ClinicsOutreachRequestDto>(`/api/clinics/outreach/requests/${r.requestId}`)
              .catch(() => null);
            conferidos.set(r.requestId, lido);
          }),
      );
      return { res, conferidos };
    },
    onSuccess: ({ res, conferidos }, p) => {
      const aprovados = p.itens.filter((i) => i.resultado.ok);
      let semConfirmacao = 0;
      setResultado(
        res.items.map((r) => {
          const paciente = aprovados[r.index]?.paciente ?? '';
          if (r.state === 'approved') return { paciente, texto: textoDaAprovacao(simulado) };
          const lido = conferidos.get(r.requestId) ?? null;
          if (lido === null) {
            semConfirmacao += 1;
            return { paciente, texto: 'Não foi possível confirmar no acompanhamento do pedido' };
          }
          // ainda em rascunho: a recusa vale; aprovado antes, o acompanhamento manda
          return lido.state === 'draft'
            ? { paciente, texto: `Recusado: ${r.reason ? motivoLegivel(r.reason) : 'sem motivo'}` }
            : {
                paciente,
                texto: `${rotuloDoEstado(lido.state, simulado)} (conforme o acompanhamento do pedido)`,
              };
        }),
      );
      void queryClient.invalidateQueries({ queryKey: [...OUTREACH_KEY, 'candidates'] });
      if (semConfirmacao > 0) {
        // a tentativa original fica, travada: nenhuma prévia nova, nenhum envio novo
        setIncerto(true);
        setPrevia(p);
        setAviso(
          'Não foi possível confirmar o resultado no acompanhamento. A tentativa original fica preservada, sem nova prévia nem novo envio: confira o acompanhamento de cada pedido.',
        );
        return;
      }
      setIncerto(false);
      setAviso(null);
      setPrevia(null);
      setEscolhidos(new Map());
    },
    onError: (e, p) => {
      // 4xx definitivo (a não ser o 409 de "em processamento"): nada foi gravado
      const definitivo =
        e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 409;
      setIncerto(!definitivo);
      // a prévia na tela é a da tentativa: a repetição sai com a MESMA chave e os mesmos itens
      if (!definitivo) setPrevia(p);
      // incerto: recarrega os candidatos, para a pessoa ver o estado de cada pedido
      if (!definitivo)
        void queryClient.invalidateQueries({ queryKey: [...OUTREACH_KEY, 'candidates'] });
      setAviso(
        definitivo
          ? e.message
          : 'O resultado da aprovação não chegou. Repita a aprovação desta prévia: ela não gera mensagens a mais.',
      );
    },
  });

  /**
   * Nada que troque a prévia enquanto ela está em jogo: a aprovação em voo, a
   * incerta (só a MESMA se repete) e a prévia sendo gerada.
   */
  const travado = incerto || aprovar.isPending || verPrevia.isPending;

  const alternar = (c: ClinicsOutreachCandidateDto, marcado: boolean) => {
    recomecar();
    setEscolhidos((atual) => {
      const novo = new Map(atual);
      if (marcado) novo.set(chaveDoAlvo(c), c.numbers[0]);
      else novo.delete(chaveDoAlvo(c));
      return novo;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Clínica"
        title="Envios"
        meta="Confirmação de horário e reativação de retorno, com a prévia de cada mensagem e a aprovação de uma pessoa."
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-6">
        <AvisoDeEnvioSimulado simulado={simulado} />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Tipo de envio">
            <Select
              value={tipo}
              disabled={travado}
              onChange={(e) => mudarTipo(e.target.value as ClinicsOutreachKind)}
            >
              {(Object.keys(ROTULO_DO_TIPO) as ClinicsOutreachKind[]).map((k) => (
                <option key={k} value={k}>
                  {ROTULO_DO_TIPO[k]}
                </option>
              ))}
            </Select>
          </Field>
          {unidades.length > 1 ? (
            <Field label="Unidade">
              <Select
                value={unidade}
                disabled={travado}
                onChange={(e) => mudarFiltro(() => setUnidade(e.target.value))}
              >
                <option value="">Escolha a unidade</option>
                {unidades.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {tipo === 'confirmation' ? (
            <>
              <Field label="A partir de">
                <Input
                  type="date"
                  value={dia}
                  disabled={travado}
                  onChange={(e) => mudarFiltro(() => setDia(e.target.value))}
                />
              </Field>
              <Field label="Dias">
                <Select
                  value={String(dias)}
                  disabled={travado}
                  onChange={(e) => mudarFiltro(() => setDias(Number(e.target.value)))}
                >
                  {[1, 2, 3, 7].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : null}
        </div>

        {candidatos.isError ? (
          <p role="alert" className="text-data text-negative">
            Não foi possível carregar os candidatos.
          </p>
        ) : !candidatos.data ? (
          <p className="text-body-sm text-muted-fg">Carregando…</p>
        ) : lista.length === 0 ? (
          <EmptyState
            title={
              tipo === 'confirmation'
                ? 'Nenhum agendamento marcado ou confirmado nesses dias.'
                : 'Nenhum retorno vencido, pendente e sem agendamento.'
            }
          />
        ) : (
          <Panel>
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2/50">
                  {[
                    ...(podeEnviar ? ['Enviar'] : []),
                    'Paciente',
                    tipo === 'confirmation' ? 'Horário' : 'Vencimento',
                    'Número',
                    'Situação',
                  ].map((h) => (
                    <th key={h} className="eyebrow px-4 py-2 text-left text-muted-fg">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lista.map((c) => {
                  const chave = chaveDoAlvo(c);
                  const marcado = escolhidos.has(chave);
                  const quando =
                    c.startsAt && fuso
                      ? instanteLocal(c.startsAt, fuso)
                      : c.dueDate
                        ? dataCurta(c.dueDate)
                        : '—';
                  return (
                    <tr
                      key={chave}
                      aria-label={`Candidato ${c.patientName}, ${quando}`}
                      className="border-b border-border/60 last:border-b-0"
                    >
                      {podeEnviar ? (
                        <td className="px-4 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Escolher ${c.patientName}, ${quando}`}
                            checked={marcado}
                            disabled={travado || c.blocked !== null || c.numbers.length === 0}
                            onChange={(e) => alternar(c, e.target.checked)}
                          />
                        </td>
                      ) : null}
                      <td className="px-4 py-2">{c.patientName}</td>
                      <td className="px-4 py-2 num text-data">{quando}</td>
                      <td className="px-4 py-2 num text-data">
                        {c.numbers.length === 0 ? (
                          <span className="text-negative">sem número</span>
                        ) : c.numbers.length === 1 || !marcado ? (
                          c.numbers.join(', ')
                        ) : (
                          <Select
                            size="sm"
                            aria-label={`Número de ${c.patientName}`}
                            value={escolhidos.get(chave)}
                            disabled={travado}
                            onChange={(e) => {
                              recomecar();
                              setEscolhidos((atual) => new Map(atual).set(chave, e.target.value));
                            }}
                          >
                            {c.numbers.map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </Select>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {c.request ? (
                          <button
                            type="button"
                            className="underline"
                            aria-label={`Acompanhar o pedido de ${c.patientName}`}
                            onClick={() => setDetalhe(c.request?.id ?? null)}
                          >
                            {rotuloDoEstado(c.request.state, simulado)}
                          </button>
                        ) : c.blocked === 'starts_too_soon' ? (
                          <span className="text-muted-fg">
                            Faltam duas horas ou menos: não é mais elegível
                          </span>
                        ) : (
                          <span className="text-muted-fg">Sem pedido</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        )}

        {podeEnviar ? (
          <div className="space-y-2" data-testid="envio-da-clinica">
            {opcoes.isError ? (
              <p className="text-data text-negative">Não foi possível carregar os templates.</p>
            ) : opcoes.data && opcoes.data.length === 0 ? (
              <p className="text-data text-muted-fg">
                Nenhum template revisado para a finalidade deste tipo de envio.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Template revisado">
                  <Select
                    value={opcaoEscolhida}
                    disabled={travado}
                    onChange={(e) => {
                      setOpcaoEscolhida(e.target.value);
                      recomecar();
                    }}
                  >
                    <option value="">Escolha o canal e o template…</option>
                    {opcoes.data?.map((o) => (
                      <option key={chaveDaOpcao(o)} value={chaveDaOpcao(o)}>
                        {o.channelName} · {o.name} ({o.language}) v{o.version} ·{' '}
                        {o.purposeDescription}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  type="button"
                  size="sm"
                  disabled={!opcao || escolhidos.size === 0 || travado}
                  onClick={() => opcao && verPrevia.mutate(opcao)}
                >
                  Preparar e ver a prévia ({escolhidos.size})
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="text-data text-muted-fg">
            Preparar e aprovar envios exige também escrever na agenda e nas conversas.
          </p>
        )}

        {aviso ? (
          <p role="status" className="text-data">
            {aviso}
          </p>
        ) : null}

        {previa ? (
          <Panel>
            <div className="space-y-3 p-4" data-testid="previa-da-clinica">
              <p className="eyebrow text-muted-fg">Prévia: o texto exato de cada mensagem</p>
              {previa.itens.map((i) => (
                <div
                  key={i.chave}
                  className="space-y-1 border-b border-border/60 pb-2 last:border-0"
                >
                  <p className="text-body-sm font-medium">
                    {i.paciente} <span className="num text-data text-muted-fg">{i.numero}</span>
                  </p>
                  {i.resultado.ok ? (
                    <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-2 text-data">
                      {i.resultado.text}
                    </p>
                  ) : (
                    <p className="text-data text-negative">Não sai: {i.resultado.motivo}</p>
                  )}
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={aprovaveis.length === 0 || aprovar.isPending || verPrevia.isPending}
                  onClick={() => aprovar.mutate(previa)}
                >
                  Aprovar e enviar ({aprovaveis.length})
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={travado}
                  onClick={recomecar}
                >
                  Descartar a prévia
                </Button>
              </div>
            </div>
          </Panel>
        ) : null}

        {resultado.length > 0 ? (
          <ul role="status" className="space-y-1 text-data">
            {resultado.map((r, i) => (
              <li key={i}>
                {r.paciente}: {r.texto}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <Drawer
        open={detalhe !== null}
        onOpenChange={(open) => !open && setDetalhe(null)}
        title="Acompanhamento do pedido"
      >
        {detalhe ? <DetalheDoPedido id={detalhe} simulado={simulado} fuso={fuso} /> : null}
      </Drawer>
    </div>
  );
}

/**
 * Um pedido: o estado derivado do despacho, o texto até o desfecho terminal e o
 * número e o motivo conforme o acesso de quem lê (o servidor mascara e omite).
 */
function DetalheDoPedido({
  id,
  simulado,
  fuso,
}: {
  id: string;
  simulado: boolean | null;
  fuso: string | null;
}) {
  const pedido = useQuery({
    queryKey: [...OUTREACH_KEY, 'request', id],
    queryFn: () => api.get<ClinicsOutreachRequestDto>(`/api/clinics/outreach/requests/${id}`),
  });
  if (pedido.isError) {
    return (
      <p role="alert" className="text-data text-negative">
        Não foi possível carregar o pedido.
      </p>
    );
  }
  if (!pedido.data) return <p className="text-body-sm text-muted-fg">Carregando…</p>;
  const p = pedido.data;
  return (
    <dl className="space-y-2 text-data" data-testid="detalhe-do-pedido">
      <div>
        <dt className="eyebrow text-muted-fg">Tipo</dt>
        <dd>{ROTULO_DO_TIPO[p.kind]}</dd>
      </div>
      <div>
        <dt className="eyebrow text-muted-fg">Situação</dt>
        <dd>{rotuloDoEstado(p.state, simulado)}</dd>
      </div>
      {p.startsAt && fuso ? (
        <div>
          <dt className="eyebrow text-muted-fg">Horário</dt>
          <dd className="num">{instanteLocal(p.startsAt, fuso)}</dd>
        </div>
      ) : null}
      <div>
        <dt className="eyebrow text-muted-fg">Número</dt>
        <dd className="num">{p.number ?? '—'}</dd>
      </div>
      <div>
        <dt className="eyebrow text-muted-fg">Motivo</dt>
        <dd>{p.reason ? motivoLegivel(p.reason) : '—'}</dd>
      </div>
      <div>
        <dt className="eyebrow text-muted-fg">Texto</dt>
        <dd className="whitespace-pre-wrap">
          {p.text ??
            'Sem texto guardado: ele só existe entre a prévia e o desfecho do envio (minimização).'}
        </dd>
      </div>
    </dl>
  );
}
