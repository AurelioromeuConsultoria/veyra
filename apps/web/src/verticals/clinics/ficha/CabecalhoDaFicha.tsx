import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  ContactConsentsDto,
  ContactDto,
  ConversationDto,
  ConversationPageDto,
} from '@veyra/contracts';
import { MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/ui/button';
import { StatusChip } from '../../../components/ui/status';
import { api, ApiError, toQuery } from '../../../lib/api';
import { alcanca, useSession } from '../../../lib/session';

/**
 * O cabeçalho da ficha (ADR-062 adendo 1, A4): cada item com a chave que já
 * governa o mesmo dado, e só com o contato vinculado. Esconder é usabilidade:
 * o servidor confere tudo.
 */

/**
 * O estado do consentimento, com a MESMA regra e a MESMA consulta do painel de
 * consentimento do contato (`consents:read` e `contacts:read`; a chave de
 * cache é a dele, e as ações de lá recarregam o chip). O pedido de parar ativo
 * vem antes: com ele, nada sai para o número.
 */
export function ChipDoConsentimento({ contactId }: { contactId: string }) {
  const { data: user } = useSession();
  const podeLer = alcanca(user, { permissions: ['consents:read', 'contacts:read'] });
  const dados = useQuery({
    queryKey: ['consents', 'contact', contactId] as const,
    queryFn: () => api.get<ContactConsentsDto>(`/api/contacts/${contactId}/consents`),
    enabled: podeLer,
  });
  if (!podeLer || dados.isPending) return null;
  if (dados.isError) return <StatusChip tom="neutral">Consentimento indisponível</StatusChip>;
  if (dados.data.stopBlocks.length > 0) {
    return <StatusChip tom="missed">Pedido de parar ativo</StatusChip>;
  }
  return dados.data.consents.some((c) => c.revokedAt === null) ? (
    <StatusChip tom="confirmed">Consentimento ativo</StatusChip>
  ) : (
    <StatusChip tom="pending">Sem consentimento</StatusChip>
  );
}

/** A origem do contato (`source`), com `contacts:read` e a consulta da aba Contato. */
export function OrigemDoContato({ contactId }: { contactId: string }) {
  const { data: user } = useSession();
  const leContato = alcanca(user, { permission: 'contacts:read' });
  const contato = useQuery({
    queryKey: ['contact', contactId],
    queryFn: () => api.get<ContactDto>(`/api/contacts/${contactId}`),
    enabled: leContato,
  });
  if (!leContato || contato.isError || !contato.data?.source) return null;
  return (
    <span>
      Origem: <span className="text-foreground">{contato.data.source}</span>
    </span>
  );
}

/** Sem conversa com a pessoa e sem `conversations:write` para iniciar uma. */
class SemConversa extends Error {}

/**
 * "Enviar mensagem": abre a conversa mais recente do contato (a lista do Core
 * já filtra por `contactId`, em todos os estados) ou, sem nenhuma, cria uma
 * (`conversations:write`). Aparece com `conversations:read`.
 */
export function EnviarMensagem({ contactId }: { contactId: string }) {
  const { data: user } = useSession();
  const navigate = useNavigate();
  const podeLer = alcanca(user, { permission: 'conversations:read' });
  const podeCriar = alcanca(user, { permission: 'conversations:write' });
  const abrir = useMutation({
    mutationFn: async () => {
      const pagina = await api.get<ConversationPageDto>(
        `/api/conversations${toQuery({ contactId, status: 'all', limit: 1 })}`,
      );
      const recente = pagina.items[0];
      if (recente) return recente.id;
      if (!podeCriar) throw new SemConversa();
      return (await api.post<ConversationDto>('/api/conversations', { contactId })).id;
    },
    onSuccess: (id) => navigate(`/inbox?c=${encodeURIComponent(id)}`),
  });
  if (!podeLer) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" disabled={abrir.isPending} onClick={() => abrir.mutate()}>
        <MessageSquare size={15} /> {abrir.isPending ? 'Abrindo…' : 'Enviar mensagem'}
      </Button>
      {abrir.error ? (
        <p role="alert" className="max-w-[16rem] text-right text-data text-negative">
          {abrir.error instanceof SemConversa
            ? 'Nenhuma conversa com esta pessoa, e você não pode iniciar uma.'
            : abrir.error instanceof ApiError
              ? abrir.error.message
              : 'Não foi possível abrir a conversa.'}
        </p>
      ) : null}
    </div>
  );
}
