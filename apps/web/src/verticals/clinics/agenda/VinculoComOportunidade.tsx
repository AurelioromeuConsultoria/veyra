import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClinicsAppointmentDealDto,
  ClinicsAppointmentDto,
  ClinicsDealOptionDto,
} from '@veyra/contracts/verticals/clinics';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Field, Select } from '../../../components/ui/input';
import { api, ApiError } from '../../../lib/api';

const vinculoKey = (id: string) => ['clinics', 'appointments', id, 'deal'] as const;

/**
 * O vínculo do agendamento com uma oportunidade (F4.4; ADR-048 adendo 10,
 * decisões 2 e 3). Ler exige os pipelines e a agenda; escolher e trocar, também
 * escrever na agenda, e só antes do atendimento — depois, o servidor recusa.
 * A referência a uma oportunidade que deixou de ser do contato do paciente
 * continua, mas aparece como vínculo que NÃO vale e não conta nas métricas.
 */
export function VinculoComOportunidade({
  agendamento,
  podeMudar,
}: {
  agendamento: ClinicsAppointmentDto;
  podeMudar: boolean;
}) {
  const queryClient = useQueryClient();
  const [escolhida, setEscolhida] = useState('');
  const vinculo = useQuery({
    queryKey: vinculoKey(agendamento.id),
    queryFn: () =>
      api.get<ClinicsAppointmentDealDto>(`/api/clinics/appointments/${agendamento.id}/deal`),
  });
  const mutavel = podeMudar && agendamento.status !== 'attended';
  const opcoes = useQuery({
    queryKey: [...vinculoKey(agendamento.id), 'options'],
    queryFn: () =>
      api.get<ClinicsDealOptionDto[]>(`/api/clinics/appointments/${agendamento.id}/deal-options`),
    enabled: mutavel,
  });
  const atualizar = (dto: ClinicsAppointmentDealDto) => {
    queryClient.setQueryData(vinculoKey(agendamento.id), dto);
    setEscolhida('');
  };
  const vincular = useMutation({
    mutationFn: (dealId: string) =>
      api.put<ClinicsAppointmentDealDto>(`/api/clinics/appointments/${agendamento.id}/deal`, {
        dealId,
      }),
    onSuccess: atualizar,
  });
  const desvincular = useMutation({
    mutationFn: () =>
      api.post<ClinicsAppointmentDealDto>(
        `/api/clinics/appointments/${agendamento.id}/deal/unlink`,
      ),
    onSuccess: atualizar,
  });
  const erro = vincular.error ?? desvincular.error;
  const ocupado = vincular.isPending || desvincular.isPending;

  if (vinculo.isError) {
    return (
      <p role="alert" className="text-data text-negative">
        Não foi possível carregar o vínculo.
      </p>
    );
  }
  if (!vinculo.data) return <p className="text-body-sm text-muted-fg">Carregando…</p>;
  const v = vinculo.data;

  return (
    <div className="space-y-4" data-testid="vinculo-com-oportunidade">
      <div className="space-y-1">
        <p className="eyebrow text-muted-fg">Oportunidade vinculada</p>
        {v.dealId === null ? (
          <p className="text-body-sm">Nenhuma.</p>
        ) : (
          <>
            {/* o vínculo sem efeito volta sem o título: a oportunidade é de outro contato */}
            <p className="text-body-sm font-medium">
              {v.dealTitle ?? 'Oportunidade de outro contato'}
            </p>
            {v.valid === false ? (
              <p role="note" className="text-data text-negative">
                Vínculo sem efeito: a oportunidade não é mais do contato do paciente. Ela não conta
                na conversão até ser trocada.
              </p>
            ) : null}
          </>
        )}
        <p className="text-data text-muted-fg">
          Na conversão, a oportunidade conta quando tem um agendamento vinculado, criado depois dela
          e atendido na janela. O estado da oportunidade (ganha, perdida ou aberta) não muda a
          conta. É associação, não causa.
        </p>
      </div>

      {erro ? (
        <p role="alert" className="text-data text-negative">
          {erro instanceof ApiError ? erro.message : 'Não foi possível concluir.'}
        </p>
      ) : null}

      {!podeMudar ? null : agendamento.status === 'attended' ? (
        <p className="text-data text-muted-fg">Depois do atendimento, o vínculo não muda mais.</p>
      ) : opcoes.isError ? (
        <p className="text-data text-negative">Não foi possível carregar as oportunidades.</p>
      ) : opcoes.data && opcoes.data.length === 0 ? (
        <p className="text-data text-muted-fg">
          Nenhuma oportunidade deste contato. Crie uma no pipeline para vincular.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={v.dealId ? 'Trocar por' : 'Vincular a'}>
            <Select value={escolhida} onChange={(e) => setEscolhida(e.target.value)}>
              <option value="">Escolha a oportunidade…</option>
              {opcoes.data
                ?.filter((o) => o.id !== v.dealId)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title} · criada em {new Date(o.createdAt).toLocaleDateString('pt-BR')}
                  </option>
                ))}
            </Select>
          </Field>
          <Button
            size="sm"
            variant="primary"
            disabled={!escolhida || ocupado}
            onClick={() => vincular.mutate(escolhida)}
          >
            {v.dealId ? 'Trocar' : 'Vincular'}
          </Button>
          {v.dealId ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={ocupado}
              onClick={() => desvincular.mutate()}
            >
              Desvincular
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
