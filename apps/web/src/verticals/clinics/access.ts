import { useQuery } from '@tanstack/react-query';
import type { ClinicsStatusDto } from '@veyra/contracts/verticals/clinics';
import { api } from '../../lib/api';
import { hasPermission, useSession } from '../../lib/session';

/**
 * O vertical está ATIVO no workspace da sessão? A chave inclui a membership:
 * trocar de workspace nunca reaproveita a resposta de outro.
 */
export function useClinicsStatus() {
  const { data: user } = useSession();
  const membershipId = user?.activeMembership?.membershipId ?? null;
  return useQuery({
    queryKey: ['clinics', 'status', membershipId],
    queryFn: () => api.get<ClinicsStatusDto>('/api/clinics/status'),
    enabled: membershipId !== null,
    staleTime: 60_000,
    retry: false,
  });
}

export type ClinicsAccess = 'loading' | 'error' | 'inactive' | 'forbidden' | 'ready';

/**
 * Pode-se mostrar e CONSULTAR o vertical? Só com o status confirmado como ativo
 * E a permissão da seção (ADR-048 adendo 1, item 21). Enquanto o status carrega
 * ou se ele falhar, a resposta é não: nada do vertical aparece nem é consultado.
 * Esconder é usabilidade — quem garante o acesso é o servidor.
 */
export function useClinicsAccess(permission: string): ClinicsAccess {
  const { data: user } = useSession();
  const status = useClinicsStatus();
  if (status.isError) return 'error';
  if (!status.data) return 'loading';
  if (!status.data.active) return 'inactive';
  if (!hasPermission(user, permission)) return 'forbidden';
  return 'ready';
}
