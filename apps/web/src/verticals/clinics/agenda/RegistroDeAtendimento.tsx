import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClinicsAppointmentDto, ClinicsPackageDto } from '@veyra/contracts/verticals/clinics';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { api, ApiError } from '../../../lib/api';
import { hasPermission, useSession } from '../../../lib/session';
import { PACKAGES_KEY, RETURNS_KEY, quandoLocal } from '../continuidade';

/** A escolha: `undefined` = nada escolhido; `null` = avulso; texto = o pacote. */
type Escolha = string | null | undefined;

/**
 * Registro de atendimento com o consumo EXPLÍCITO (ADR-048 adendo 7, item 4, e
 * aprovação da F3.3, condição 2):
 * - nada vem marcado, nem com um pacote só; a pessoa escolhe "avulso" ou um
 *   pacote, e vê o pacote e o saldo antes e depois;
 * - enquanto os pacotes carregam, ou se a consulta falha, não se confirma: a
 *   falha nunca vira "avulso";
 * - a recusa do servidor aparece como veio, as opções são recarregadas e a
 *   escolha é desfeita: nada troca de pacote nem vira "avulso" em silêncio;
 * - sem `care:read`, nenhuma consulta a pacotes: só "avulso", com o aviso.
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
  const pacotes = useQuery({
    queryKey: [...PACKAGES_KEY, agendamento.patientId],
    queryFn: () =>
      api.get<ClinicsPackageDto[]>(
        `/api/clinics/packages?patientId=${encodeURIComponent(agendamento.patientId)}`,
      ),
    enabled: lePacotes,
  });
  const elegiveis = (pacotes.isError ? [] : (pacotes.data ?? [])).filter(
    (p) =>
      p.status === 'active' && p.serviceId === agendamento.serviceId && p.remainingSessions > 0,
  );
  const listaPronta = !lePacotes || (pacotes.isSuccess && !pacotes.isFetching);
  const registrar = useMutation({
    mutationFn: (packageId: string | null) =>
      api.post(`/api/clinics/appointments/${agendamento.id}/attendance`, { packageId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PACKAGES_KEY });
      // o registro pode criar ou concluir retornos
      void queryClient.invalidateQueries({ queryKey: RETURNS_KEY });
      onDone();
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

  return (
    <div className="space-y-3 p-5">
      <p className="text-body-sm">
        {agendamento.localStart} · {agendamento.patientName} · {agendamento.serviceName}
      </p>
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
