import { useQuery } from '@tanstack/react-query';
import type { NoteDto, Paginated, TaskDto } from '@veyra/contracts';
import { Panel } from '../../components/ui/page';
import { api, ApiError, toQuery } from '../../lib/api';
import { alcanca, useSession } from '../../lib/session';

const NA_FICHA = 20;
const dataCurta = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });

/** a chave que libera as notas e tarefas de quem é paciente (ADR-061, adendo 2) */
export const CHAVE_DO_CONTEUDO = 'clinics:patient-content:read';

/**
 * As notas e as tarefas do paciente, na ficha (F5.3b; ADR-061, adendo 2). Só
 * leitura. A permissão do recurso (`tasks:read`) decide se a seção existe; a
 * chave da clínica, somada a ela, decide se o conteúdo aparece. Sem a chave,
 * "Conteúdo restrito" e NENHUMA consulta. O servidor confere de novo: um 403
 * (a chave retirada no meio da sessão) também vira "Conteúdo restrito".
 */
export function NotasETarefasDoPaciente({ contactId }: { contactId: string }) {
  const { data: user } = useSession();
  const temRecurso = alcanca(user, { permission: 'tasks:read' });
  const leConteudo = temRecurso && alcanca(user, { permission: CHAVE_DO_CONTEUDO });

  const tarefas = useQuery({
    queryKey: ['tasks', 'by-contact', contactId],
    queryFn: () =>
      api.get<Paginated<TaskDto>>(
        `/api/tasks${toQuery({ contactId, status: 'all', pageSize: NA_FICHA })}`,
      ),
    enabled: leConteudo,
  });
  const notas = useQuery({
    queryKey: ['notes', 'by-contact', contactId],
    queryFn: () => api.get<NoteDto[]>(`/api/notes${toQuery({ contactId })}`),
    enabled: leConteudo,
  });

  if (!temRecurso) return null;
  const recusado = [tarefas.error, notas.error].some(
    (e) => e instanceof ApiError && e.status === 403,
  );
  return (
    <section aria-label="Notas e tarefas do paciente" className="space-y-2">
      <h2 className="text-display-sm">Notas e tarefas</h2>
      {!leConteudo || recusado ? (
        <Panel className="p-4 text-body-sm">
          <p className="font-medium">Conteúdo restrito</p>
          <p className="text-data text-muted-fg">
            As notas e as tarefas de pacientes aparecem só para quem tem a permissão de lê-las. A
            agenda e as conversas continuam disponíveis.
          </p>
        </Panel>
      ) : tarefas.isError || notas.isError ? (
        <p className="text-data text-negative">Não foi possível carregar as notas e tarefas.</p>
      ) : !tarefas.data || !notas.data ? (
        <p className="text-data text-muted-fg">Carregando…</p>
      ) : (
        <Panel className="space-y-3 p-4 text-body-sm">
          <div className="space-y-1">
            <h3 className="font-medium">Tarefas</h3>
            {tarefas.data.items.length === 0 ? (
              <p className="text-data text-muted-fg">Nenhuma tarefa.</p>
            ) : (
              <ul className="space-y-1">
                {tarefas.data.items.map((t) => (
                  <li key={t.id}>
                    {t.title}{' '}
                    <span className="text-data text-muted-fg">
                      · {t.status === 'done' ? 'concluída' : 'aberta'}
                      {t.dueAt ? ` · prazo ${dataCurta.format(new Date(t.dueAt))}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {tarefas.data.total > tarefas.data.items.length ? (
              <p className="text-data text-muted-fg">
                As primeiras {tarefas.data.items.length} de {tarefas.data.total}, as abertas antes.
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <h3 className="font-medium">Notas</h3>
            {notas.data.length === 0 ? (
              <p className="text-data text-muted-fg">Nenhuma nota.</p>
            ) : (
              <ul className="space-y-1">
                {notas.data.map((n) => (
                  <li key={n.id} className="whitespace-pre-wrap">
                    {n.body}{' '}
                    <span className="text-data text-muted-fg">
                      · {n.authorName ?? 'Sistema'}, {dataCurta.format(new Date(n.createdAt))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      )}
    </section>
  );
}
