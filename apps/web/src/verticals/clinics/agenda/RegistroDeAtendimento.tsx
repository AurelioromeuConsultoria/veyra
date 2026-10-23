import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClinicsAppointmentDto, ClinicsPackageDto } from '@veyra/contracts/verticals/clinics';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { api, ApiError } from '../../../lib/api';
import { hasPermission, useSession } from '../../../lib/session';
import { PACKAGES_KEY, RETURNS_KEY, ROTULO_DO_PACOTE, quandoLocal } from '../continuidade';

/** A escolha: `undefined` = nada escolhido; `null` = avulso; texto = o pacote. */
type Escolha = string | null | undefined;

/** O registro feito, e quantas leituras dos pacotes havia ANTES dele. */
type Registrado = { packageId: string | null; leiturasAntes: number };

/**
 * Registro de atendimento com o consumo EXPLÍCITO (ADR-048 adendo 7, item 4, e
 * aprovação da F3.3, condição 2):
 * - nada vem marcado, nem com um pacote só; a pessoa escolhe "avulso" ou um
 *   pacote, e vê o pacote e o saldo antes e depois;
 * - enquanto os pacotes carregam, ou se a consulta falha, não se confirma: a
 *   falha nunca vira "avulso";
 * - a recusa do servidor aparece como veio, as opções são recarregadas e a
 *   escolha é desfeita: nada troca de pacote nem vira "avulso" em silêncio;
 * - sem `care:read`, nenhuma consulta a pacotes: só "avulso", com o aviso;
 * - o saldo mostrado é o lido agora, não uma reserva, e o painel diz isso
 *   (ajuste A1, decisão 2): a confirmação autoriza uma sessão do pacote
 *   escolhido, o servidor confere o saldo e nada é substituído;
 * - depois do sucesso, o saldo é o de uma leitura POSTERIOR ao registro, por
 *   quem ainda lê pacotes; nunca o de antes nem "antes − 1".
 */
export function RegistroDeAtendimento({
  agendamento,
  fuso,
  onDone,
  onAgendaMudou,
}: {
  agendamento: ClinicsAppointmentDto;
  /** o fuso da unidade, para a data de criação que distingue os pacotes */
  fuso: string | null;
  onDone: () => void;
  /** a agenda é relida no sucesso E na recusa (outra pessoa pode ter registrado) */
  onAgendaMudou: () => void;
}) {
  const { data: user } = useSession();
  const lePacotes = hasPermission(user, 'clinics:care:read');
  const queryClient = useQueryClient();
  const [escolha, setEscolha] = useState<Escolha>(undefined);
  const [registrado, setRegistrado] = useState<Registrado | undefined>(undefined);
  const chaveDosPacotes = [...PACKAGES_KEY, agendamento.patientId];
  /** Leituras bem-sucedidas desta consulta (o contador não depende do relógio). */
  const leiturasDosPacotes = () => queryClient.getQueryState(chaveDosPacotes)?.dataUpdateCount ?? 0;
  const pacotes = useQuery({
    queryKey: chaveDosPacotes,
    queryFn: () =>
      api.get<ClinicsPackageDto[]>(
        `/api/clinics/packages?patientId=${encodeURIComponent(agendamento.patientId)}`,
      ),
    enabled: lePacotes,
  });
  // sem `care:read` (inclusive se deixou de valer agora), nenhum pacote do cache
  const elegiveis = (lePacotes && !pacotes.isError ? (pacotes.data ?? []) : []).filter(
    (p) =>
      p.status === 'active' && p.serviceId === agendamento.serviceId && p.remainingSessions > 0,
  );
  const listaPronta = !lePacotes || (pacotes.isSuccess && !pacotes.isFetching);
  const registrar = useMutation({
    mutationFn: (packageId: string | null) =>
      api.post(`/api/clinics/appointments/${agendamento.id}/attendance`, { packageId }),
    onSuccess: (_registro, packageId) => {
      setRegistrado({ packageId, leiturasAntes: leiturasDosPacotes() });
      // a invalidação cancela a leitura em curso e refaz a deste painel: o
      // saldo mostrado a seguir é o que o servidor devolve DEPOIS do registro
      void queryClient.invalidateQueries({ queryKey: PACKAGES_KEY });
      // o registro pode criar ou concluir retornos
      void queryClient.invalidateQueries({ queryKey: RETURNS_KEY });
    },
    onSettled: () => onAgendaMudou(),
    onError: () => {
      // a recusa (saldo, pacote encerrado, outra escolha já registrada): as
      // opções voltam do servidor e a escolha é desfeita, sem trocar nada
      setEscolha(undefined);
      if (lePacotes) void queryClient.invalidateQueries({ queryKey: PACKAGES_KEY });
    },
  });
  const escolhido = elegiveis.find((p) => p.id === escolha);
  // a data e a hora de criação distinguem dois pacotes iguais do mesmo serviço
  const criadoEm = (p: ClinicsPackageDto) => quandoLocal(p.createdAt, fuso);
  const rotuloDoBotao =
    escolha === null
      ? 'Registrar atendimento avulso'
      : escolhido
        ? `Registrar e consumir 1 sessão do pacote criado em ${criadoEm(escolhido)} (restam ${escolhido.remainingSessions} → ${escolhido.remainingSessions - 1})`
        : 'Escolha avulso ou um pacote';
  const podeConfirmar =
    listaPronta &&
    !registrar.isPending &&
    (escolha === null || (typeof escolha === 'string' && escolhido !== undefined));
  const nome = `escolha-${agendamento.id}`;
  const cabecalho = (
    <p className="text-body-sm">
      {agendamento.localStart} · {agendamento.patientName} · {agendamento.serviceName}
    </p>
  );

  if (registrado !== undefined) {
    // só uma leitura POSTERIOR ao registro. Sem `care:read` e durante a
    // releitura (os ramos abaixo vêm antes), com erro, ou sem releitura (uma
    // leitura cancelada volta ao dado de antes), nenhum saldo: nem o antigo
    // nem um calculado aqui
    const relido = pacotes.isSuccess && leiturasDosPacotes() > registrado.leiturasAntes;
    const atual =
      registrado.packageId !== null && relido
        ? pacotes.data.find((p) => p.id === registrado.packageId)
        : undefined;
    return (
      <div className="space-y-3 p-5">
        {cabecalho}
        <p role="status" className="text-body-sm font-medium">
          {registrado.packageId === null
            ? 'Atendimento registrado como avulso.'
            : 'Atendimento registrado, com 1 sessão do pacote escolhido.'}
        </p>
        {registrado.packageId === null ? null : !lePacotes ? (
          <p className="text-data text-muted-fg">
            Os pacotes deste paciente deixaram de estar visíveis para você: o saldo não é mostrado.
          </p>
        ) : pacotes.isFetching ? (
          <p className="text-data text-muted-fg">Conferindo o saldo no servidor…</p>
        ) : !atual ? (
          <div className="space-y-2">
            <p role="alert" className="text-data text-negative">
              Não foi possível conferir o saldo atualizado. O atendimento já está registrado.
            </p>
            <Button size="sm" variant="ghost" onClick={() => void pacotes.refetch()}>
              Conferir de novo
            </Button>
          </div>
        ) : (
          <p className="text-body-sm">
            Saldo no servidor: pacote de {atual.totalSessions} sessões, criado em {criadoEm(atual)}:
            restam {atual.remainingSessions}
            {atual.status === 'active' ? '' : ` (${ROTULO_DO_PACOTE[atual.status]})`}.
          </p>
        )}
        <Button variant="primary" size="sm" onClick={onDone}>
          Concluir
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-5">
      {cabecalho}
      {registrar.error ? (
        <p role="alert" className="text-data text-negative">
          {registrar.error instanceof ApiError
            ? registrar.error.message
            : 'Não foi possível registrar o atendimento.'}
        </p>
      ) : null}
      {!lePacotes ? (
        <p className="text-data text-muted-fg">
          Os pacotes deste paciente não estão visíveis para você: o registro só pode ser avulso.
        </p>
      ) : null}
      {lePacotes && pacotes.isError ? (
        <div className="space-y-2">
          <p role="alert" className="text-data text-negative">
            Não foi possível carregar os pacotes. Sem eles, o atendimento não é registrado.
          </p>
          <Button size="sm" variant="ghost" onClick={() => void pacotes.refetch()}>
            Tentar de novo
          </Button>
        </div>
      ) : null}
      {lePacotes && !listaPronta && !pacotes.isError ? (
        <p className="text-data text-muted-fg">Carregando os pacotes…</p>
      ) : null}
      {listaPronta && !pacotes.isError ? (
        <fieldset className="space-y-2">
          <legend className="eyebrow text-muted-fg">Como registrar</legend>
          {elegiveis.map((p) => (
            <label key={p.id} className="flex items-start gap-2 text-body-sm">
              <input
                type="radio"
                name={nome}
                checked={escolha === p.id}
                onChange={() => setEscolha(p.id)}
              />
              <span>
                Pacote de {p.totalSessions} sessões, criado em {criadoEm(p)}: restam{' '}
                {p.remainingSessions}, ficam {p.remainingSessions - 1} depois deste atendimento
              </span>
            </label>
          ))}
          <label className="flex items-start gap-2 text-body-sm">
            <input
              type="radio"
              name={nome}
              checked={escolha === null}
              onChange={() => setEscolha(null)}
            />
            <span>Avulso (sem pacote)</span>
          </label>
          {elegiveis.length > 0 ? (
            <p className="text-data text-muted-fg">
              O saldo mostrado foi lido agora e não é uma reserva: pode mudar até a confirmação. Ao
              registrar, o servidor confere de novo e, sem sessão, recusa; nenhum outro pacote é
              usado no lugar, e nada vira avulso.
            </p>
          ) : null}
        </fieldset>
      ) : null}
      <Button
        variant="primary"
        size="sm"
        disabled={!podeConfirmar}
        onClick={() => escolha !== undefined && registrar.mutate(escolha)}
      >
        {rotuloDoBotao}
      </Button>
    </div>
  );
}
