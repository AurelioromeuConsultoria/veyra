import { useQuery } from '@tanstack/react-query';
import type { ContactDto, Paginated } from '@veyra/contracts';
import { api, toQuery } from '../lib/api';
import type { SearchProvider } from '../lib/experience';

const MAX_CONTATOS = 6;

/**
 * A busca de contatos do Core (`GET /api/contacts?search=`), para os produtos
 * que a oferecem. A consulta só sai com `ativo` — o termo com 2 letras ou mais
 * e a permissão `contacts:read` —, e o destino é o do produto (`destino`).
 */
export function buscaDeContatos(destino: (contactId: string) => string): SearchProvider {
  return {
    label: 'Contatos',
    singular: 'contato',
    permission: 'contacts:read',
    useResultados(termo, ativo) {
      const contatos = useQuery({
        queryKey: ['global-search', 'contacts', termo],
        queryFn: () =>
          api.get<Paginated<ContactDto>>(
            `/api/contacts${toQuery({ search: termo, pageSize: MAX_CONTATOS, status: 'active' })}`,
          ),
        enabled: ativo,
        staleTime: 30_000,
      });
      return {
        resultados: (contatos.data?.items ?? []).map((contact) => ({
          id: `contact:${contact.id}`,
          // abre a ficha direto, no lugar onde se age sobre ela
          to: destino(contact.id),
          label: contact.name,
          hint: contact.emails[0] ?? contact.companyName ?? 'Contato',
        })),
        buscando: ativo && contatos.isFetching,
      };
    },
  };
}
