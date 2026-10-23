import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClinicsReturnAssigneeDto,
  ClinicsReturnCancelReason,
  ClinicsReturnCandidatesPageDto,
  ClinicsReturnDto,
  ClinicsUnitDto,
} from '@veyra/contracts/verticals/clinics';
import { horaLocal, somarDias } from '@veyra/contracts/verticals/clinics';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/ui/button';
import { Drawer } from '../../../components/ui/drawer';
import { Field, Select } from '../../../components/ui/input';
import { EmptyState, Panel } from '../../../components/ui/page';
import { api, ApiError, toQuery } from '../../../lib/api';
import { hasPermission, useSession } from '../../../lib/session';
import { ROTULO_DO_ESTADO } from '../agenda/slots';
import {
  RETURNS_KEY,
  ROTULO_DO_MOTIVO_DO_RETORNO,
  ROTULO_DO_RETORNO,
  dataCurta,
  instanteLocal,
  motivosPermitidos,
  quandoLocal,
} from '../continuidade';
import { fichaDoPaciente } from '../nav';

export interface FiltrosDeRetorno {
  status?: string;
  overdue?: string;
  assignee?: string;
  dueFrom?: string;
  dueTo?: string;
  patientId?: string;
}

/** O teto que a tela pede (o servidor aceita até 200): mais que isso, avisa. */
export const TETO_DOS_RETORNOS = 100;

type Acao =
  | { kind: 'vincular'; retorno: ClinicsReturnDto }
  | { kind: 'atribuir'; retorno: ClinicsReturnDto }
  | { kind: 'cancelar'; retorno: ClinicsReturnDto };

/** Quem e o quê, no nome acessível de cada ação da linha. */
const contexto = (r: ClinicsReturnDto) =>
  `${r.patientName}, ${r.serviceName}, vence ${dataCurta(r.dueDate)}`;

const mensagem = (erro: unknown) =>
  erro instanceof ApiError ? erro.message : 'Não foi possível concluir.';

/**
 * Retornos (F3.3b): a lista da tela de retornos e da ficha do paciente. A
 * projeção é do servidor: para quem tem só a agenda, o cancelado vem sem o
 * motivo, e a tela mostra só o que veio. Com erro, nenhum dado antigo.
 */
export function ListaDeRetornos({
  filtros,
  mostrarPaciente,
}: {
  filtros: FiltrosDeRetorno;
  mostrarPaciente: boolean;
}) {
  const { data: user } = useSession();
  const podeAgir =
    hasPermission(user, 'clinics:schedule:write') || hasPermission(user, 'clinics:care:write');
  const queryClient = useQueryClient();
  const [acao, setAcao] = useState<Acao | null>(null);
  const unidades = useQuery({
    queryKey: ['clinics', 'catalog', 'units'],
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
  });
  const retornos = useQuery({
    queryKey: [...RETURNS_KEY, 'list', filtros],
    queryFn: () =>
      api.get<ClinicsReturnDto[]>(
        `/api/clinics/returns${toQuery({ ...filtros, limit: TETO_DOS_RETORNOS + 1 })}`,
      ),
  });
  const fusoDe = (unitId: string) => unidades.data?.find((u) => u.id === unitId)?.timezone ?? null;
  const desvincular = useMutation({
    mutationFn: (id: string) => api.post(`/api/clinics/returns/${id}/unlink`),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: RETURNS_KEY }),
  });
  // com erro (inclusive numa RECARGA depois de um sucesso), nada de dado antigo
  const falhou = retornos.isError || unidades.isError;
  // pede UM a mais que o teto: só avisa quando há mesmo mais retornos
  const todas = falhou ? [] : (retornos.data ?? []);
  const linhas = todas.slice(0, TETO_DOS_RETORNOS);
  const haMais = todas.length > TETO_DOS_RETORNOS;
  const fechar = () => setAcao(null);

  return (
    <>
      {falhou ? (
        <p role="alert" className="mb-3 text-data text-negative">
          Não foi possível carregar os retornos.
        </p>
      ) : null}
      {desvincular.error ? (
        <p role="alert" className="mb-3 text-data text-negative">
          {mensagem(desvincular.error)}
        </p>
      ) : null}
      <Panel>
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2/50">
              {[
                ...(mostrarPaciente ? ['Paciente'] : []),
                'Serviço',
                'Vencimento',
                'Responsável',
                'Agendamento',
                'Estado',
                ...(podeAgir ? ['Ações'] : []),
              ].map((h) => (
                <th key={h} className="eyebrow px-4 py-2 text-left text-muted-fg">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {linhas.map((r) => {
              const fuso = fusoDe(r.unitId);
              return (
                <tr
                  key={r.id}
                  aria-label={`Retorno de ${r.patientName}, ${r.serviceName}, vence ${dataCurta(r.dueDate)}`}
                  className="border-b border-border/60 last:border-b-0"
                >
                  {mostrarPaciente ? (
                    <td className="px-4 py-2">
                      <Link className="underline" to={fichaDoPaciente(r.patientId)}>
                        {r.patientName}
                      </Link>
                    </td>
                  ) : null}
                  <td className="px-4 py-2">{r.serviceName}</td>
                  <td className="px-4 py-2 num text-data">
                    {dataCurta(r.dueDate)}
                    {r.overdue ? <span className="ml-2 text-negative">Vencido</span> : null}
                  </td>
                  <td className="px-4 py-2">
                    {r.assignee ? (
                      <>
                        {r.assignee.name}
                        {r.assignee.hasAccess ? null : (
                          <span className="ml-2 text-negative">sem acesso</span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-fg">Sem responsável</span>
                    )}
                  </td>
                  <td className="px-4 py-2 num text-data">
                    {r.appointment
                      ? `${fuso ? instanteLocal(r.appointment.startsAt, fuso) : 'horário indisponível (unidade fora do catálogo ativo)'} · ${ROTULO_DO_ESTADO[r.appointment.status]}`
                      : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {ROTULO_DO_RETORNO[r.status]}
                    {r.cancelReason ? ` · ${ROTULO_DO_MOTIVO_DO_RETORNO[r.cancelReason]}` : ''}
                  </td>
                  {podeAgir ? (
                    <td className="px-4 py-2">
                      {r.status === 'pending' ? (
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`${r.appointment ? 'Trocar agendamento' : 'Vincular agendamento'}: ${contexto(r)}`}
                            onClick={() => setAcao({ kind: 'vincular', retorno: r })}
                          >
                            {r.appointment ? 'Trocar agendamento' : 'Vincular agendamento'}
                          </Button>
                          {r.appointment ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Desvincular: ${contexto(r)}`}
                              disabled={desvincular.isPending}
                              onClick={() => desvincular.mutate(r.id)}
                            >
                              Desvincular
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Responsável: ${contexto(r)}`}
                            onClick={() => setAcao({ kind: 'atribuir', retorno: r })}
                          >
                            Responsável
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Cancelar: ${contexto(r)}`}
                            onClick={() => setAcao({ kind: 'cancelar', retorno: r })}
                          >
                            Cancelar
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {haMais ? (
              <tr>
                <td colSpan={7} className="px-4 py-2 text-data text-muted-fg">
                  Mostrando os {TETO_DOS_RETORNOS} primeiros por vencimento. Use os filtros para ver
                  os outros.
                </td>
              </tr>
            ) : null}
            {retornos.data && !falhou && linhas.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <EmptyState title="Nenhum retorno com esses filtros." />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
      <Drawer
        open={acao?.kind === 'vincular'}
        onOpenChange={(aberto) => !aberto && fechar()}
        title="Vincular agendamento"
      >
        {acao?.kind === 'vincular' ? (
          <VincularRetorno
            retorno={acao.retorno}
            fuso={fusoDe(acao.retorno.unitId)}
            onDone={fechar}
          />
        ) : null}
      </Drawer>
      <Drawer
        open={acao?.kind === 'atribuir'}
        onOpenChange={(aberto) => !aberto && fechar()}
        title="Responsável pelo retorno"
      >
        {acao?.kind === 'atribuir' ? (
          <AtribuirRetorno retorno={acao.retorno} onDone={fechar} />
        ) : null}
      </Drawer>
      <Drawer
        open={acao?.kind === 'cancelar'}
        onOpenChange={(aberto) => !aberto && fechar()}
        title="Cancelar retorno"
      >
        {acao?.kind === 'cancelar' ? (
          <CancelarRetorno retorno={acao.retorno} onDone={fechar} />
        ) : null}
      </Drawer>
    </>
  );
}

/**
 * Os candidatos (F3.3a): só critérios visíveis na agenda, paginados. É uma
 * seleção, não uma garantia: o servidor reconfere tudo no vínculo.
 */
function VincularRetorno({
  retorno,
  fuso,
  onDone,
}: {
  retorno: ClinicsReturnDto;
  fuso: string | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  // um padrão da tela, a partir de 30 dias antes de hoje (o servidor decide)
  const [desde] = useState(() => (fuso ? somarDias(horaLocal(new Date(), fuso).data, -30) : ''));
  const candidatos = useInfiniteQuery({
    queryKey: [...RETURNS_KEY, retorno.id, 'candidates', desde],
    queryFn: ({ pageParam }) =>
      api.get<ClinicsReturnCandidatesPageDto>(
        `/api/clinics/returns/${retorno.id}/candidates${toQuery({
          from: desde || undefined,
          cursor: pageParam,
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (ultima) => ultima.nextCursor ?? undefined,
  });
  const vincular = useMutation({
    mutationFn: (appointmentId: string) =>
      api.post<ClinicsReturnDto>(`/api/clinics/returns/${retorno.id}/link`, { appointmentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RETURNS_KEY });
      onDone();
    },
  });
  const itens = candidatos.isError ? [] : (candidatos.data?.pages.flatMap((p) => p.items) ?? []);

  return (
    <div className="space-y-3 p-5">
      <p className="text-data text-muted-fg">
        Agendamentos de {retorno.patientName} para {retorno.serviceName}, na mesma unidade, que
        ainda não cumprem outro retorno. Vincular uma consulta já atendida pode concluir o retorno,
        se o atendimento foi registrado depois da criação dele; o sistema confere ao vincular.
      </p>
      {candidatos.isError ? (
        <p role="alert" className="text-data text-negative">
          Não foi possível carregar os agendamentos.
        </p>
      ) : null}
      {vincular.error ? (
        <p role="alert" className="text-data text-negative">
          {mensagem(vincular.error)}
        </p>
      ) : null}
      {candidatos.isPending ? <p className="text-data text-muted-fg">Carregando…</p> : null}
      <ul className="space-y-1">
        {itens.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2">
            <span className="num text-data">
              {quandoLocal(c.startsAt, fuso)} · {c.professionalName} · {ROTULO_DO_ESTADO[c.status]}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={vincular.isPending}
              aria-label={`Vincular o agendamento de ${quandoLocal(c.startsAt, fuso)}`}
              onClick={() => vincular.mutate(c.id)}
            >
              Vincular
            </Button>
          </li>
        ))}
      </ul>
      {candidatos.data && !candidatos.isError && itens.length === 0 ? (
        <p className="text-data text-muted-fg">Nenhum agendamento disponível.</p>
      ) : null}
      {candidatos.hasNextPage && !candidatos.isError ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={candidatos.isFetchingNextPage}
          onClick={() => void candidatos.fetchNextPage()}
        >
          Carregar mais
        </Button>
      ) : null}
    </div>
  );
}

/** O seletor próprio: só os candidatos operacionais, só id e nome. */
function AtribuirRetorno({ retorno, onDone }: { retorno: ClinicsReturnDto; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [escolha, setEscolha] = useState(retorno.assignee?.membershipId ?? '');
  const candidatos = useQuery({
    queryKey: [...RETURNS_KEY, 'assignees'],
    queryFn: () => api.get<ClinicsReturnAssigneeDto[]>('/api/clinics/returns/assignees'),
  });
  const atribuir = useMutation({
    mutationFn: () =>
      api.post(`/api/clinics/returns/${retorno.id}/assign`, { membershipId: escolha || null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RETURNS_KEY });
      onDone();
    },
  });
  const opcoes = candidatos.isError ? [] : (candidatos.data ?? []);
  return (
    <div className="space-y-3 p-5">
      {candidatos.isError ? (
        <p role="alert" className="text-data text-negative">
          Não foi possível carregar quem pode ser responsável.
        </p>
      ) : null}
      {atribuir.error ? (
        <p role="alert" className="text-data text-negative">
          {mensagem(atribuir.error)}
        </p>
      ) : null}
      <Field label="Responsável">
        <Select
          value={escolha}
          disabled={!candidatos.data || candidatos.isError}
          onChange={(e) => setEscolha(e.target.value)}
        >
          <option value="">Sem responsável</option>
          {opcoes.map((c) => (
            <option key={c.membershipId} value={c.membershipId}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button
        variant="primary"
        size="sm"
        disabled={!candidatos.data || candidatos.isError || atribuir.isPending}
        onClick={() => atribuir.mutate()}
      >
        Salvar responsável
      </Button>
    </div>
  );
}

function CancelarRetorno({ retorno, onDone }: { retorno: ClinicsReturnDto; onDone: () => void }) {
  const { data: user } = useSession();
  const queryClient = useQueryClient();
  const motivos = motivosPermitidos(
    hasPermission(user, 'clinics:schedule:write'),
    hasPermission(user, 'clinics:care:write'),
    retorno.origin,
  );
  const [motivo, setMotivo] = useState<ClinicsReturnCancelReason | ''>('');
  const cancelar = useMutation({
    mutationFn: () => api.post(`/api/clinics/returns/${retorno.id}/cancel`, { reason: motivo }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RETURNS_KEY });
      onDone();
    },
  });
  return (
    <div className="space-y-3 p-5">
      {cancelar.error ? (
        <p role="alert" className="text-data text-negative">
          {mensagem(cancelar.error)}
        </p>
      ) : null}
      <Field label="Motivo do cancelamento">
        <Select
          value={motivo}
          onChange={(e) => setMotivo(e.target.value as ClinicsReturnCancelReason)}
        >
          <option value="" disabled>
            Escolha o motivo
          </option>
          {motivos.map((m) => (
            <option key={m} value={m}>
              {ROTULO_DO_MOTIVO_DO_RETORNO[m]}
            </option>
          ))}
        </Select>
      </Field>
      <Button
        variant="danger"
        size="sm"
        disabled={!motivo || cancelar.isPending}
        onClick={() => cancelar.mutate()}
      >
        Confirmar cancelamento
      </Button>
    </div>
  );
}
