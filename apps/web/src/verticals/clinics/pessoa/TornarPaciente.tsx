import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ClinicsPatientDto } from '@veyra/contracts/verticals/clinics';
import { Button } from '../../../components/ui/button';
import { api, ApiError } from '../../../lib/api';
import { CONSEQUENCIAS_DO_PACIENTE } from '../PatientsPage';

/**
 * A passagem EXPLÍCITA de interessado para paciente (ADR-055, adendo 3, item
 * 4): as mesmas consequências do "Novo paciente", ditas antes de confirmar, e a
 * mesma rota. Nunca acontece sozinha.
 */
export function TornarPaciente({
  contactId,
  nome,
  onDone,
}: {
  contactId: string;
  nome: string;
  onDone: (paciente: ClinicsPatientDto) => void;
}) {
  const queryClient = useQueryClient();
  const criar = useMutation({
    mutationFn: () => api.post<ClinicsPatientDto>('/api/clinics/patients', { contactId }),
    onSuccess: (paciente) => {
      void queryClient.invalidateQueries({ queryKey: ['clinics', 'patients'] });
      void queryClient.invalidateQueries({ queryKey: ['clinics', 'leads'] });
      // a busca não pode mostrar "Interessado" para quem já tem ficha
      void queryClient.invalidateQueries({ queryKey: ['global-search'] });
      onDone(paciente);
    },
  });
  return (
    <div className="space-y-4">
      <p className="text-body-sm">
        <span className="font-medium">{nome}</span> passa a ter ficha de paciente.
      </p>
      <section aria-label="Consequências" className="rounded-control border border-border p-3">
        <p className="mb-1.5 text-body-sm font-medium">Ao tornar paciente:</p>
        <ul className="list-disc space-y-1 pl-5 text-body-sm text-muted-fg">
          {CONSEQUENCIAS_DO_PACIENTE.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>
      {criar.error ? (
        <p role="alert" className="text-data text-negative">
          {criar.error instanceof ApiError
            ? criar.error.message
            : 'Não foi possível criar o paciente.'}
        </p>
      ) : null}
      <Button variant="primary" disabled={criar.isPending} onClick={() => criar.mutate()}>
        {criar.isPending ? 'Salvando…' : 'Confirmar: tornar paciente'}
      </Button>
    </div>
  );
}
