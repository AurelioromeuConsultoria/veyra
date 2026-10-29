import { useQuery } from '@tanstack/react-query';
import type { BusinessOutboundTransportDto } from '@veyra/contracts';
import { api } from '../lib/api';
import { hasPermission, useSession } from '../lib/session';

/**
 * O envio é SIMULADO (o transporte falso de staging, ADR-046)? Três valores:
 * `true`, `false` e `null` = desconhecido (sem a permissão da rota, carregando
 * ou com erro). Quem mostra um estado do envio usa texto neutro no
 * desconhecido, nunca o do envio real (revisão da F4.4). Cada tela pergunta
 * pela rota que a pessoa pode ler: o Inbox, pela do Core
 * (`conversations:write`); um vertical, pela dele.
 */
export function useTransporte(caminho: string, permissao: string): boolean | null {
  const { data: user } = useSession();
  const pode = hasPermission(user, permissao);
  const transporte = useQuery({
    queryKey: ['transport', caminho, user?.activeMembership?.membershipId ?? null],
    queryFn: () => api.get<BusinessOutboundTransportDto>(caminho),
    enabled: pode,
    staleTime: 5 * 60_000,
  });
  if (!pode || transporte.isError || !transporte.data) return null;
  return transporte.data.simulated;
}

/** O transporte pela rota do Core, para quem escreve nas conversas. */
export function useEnvioSimulado(): boolean | null {
  return useTransporte('/api/business-outbound/transport', 'conversations:write');
}

/**
 * O aviso sempre visível da demonstração (F4.4): nada sai para o WhatsApp, e
 * entrega e resposta não são confirmadas pelo provedor. Nenhum evento é criado
 * para parecer o contrário.
 */
export function AvisoDeEnvioSimulado({ simulado }: { simulado: boolean | null }) {
  if (simulado !== true) return null;
  return (
    <p
      role="note"
      data-testid="envio-simulado"
      className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-data"
    >
      <strong>Envio simulado.</strong> Nesta demonstração nada sai para o WhatsApp: o envio é
      registrado, mas entrega e resposta não são confirmadas pelo provedor.
    </p>
  );
}
