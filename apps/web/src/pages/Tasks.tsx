import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated, TaskDto } from '@veyra/contracts';
import { clsx } from 'clsx';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Input, Select } from '../components/ui/input';
import { EmptyState, PageBody, PageHeader, Panel } from '../components/ui/page';
import { api, ApiError, toQuery } from '../lib/api';
import { hasPermission, useSession } from '../lib/session';

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const priorityLabels: Record<string, string> = { low: 'Baixa', normal: 'Normal', high: 'Alta' };

export function TasksPage() {
  const { data: user } = useSession();
  const canWrite = hasPermission(user, 'tasks:write');
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'open' | 'done' | 'all'>('open');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const params = { status, pageSize: 100 };
  const tasks = useQuery({
    queryKey: ['tasks', params],
    queryFn: () => api.get<Paginated<TaskDto>>(`/api/tasks${toQuery(params)}`),
    placeholderData: keepPreviousData,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['tasks'] });

  const create = useMutation({
    mutationFn: () => api.post<TaskDto>('/api/tasks', { title }),
    onSuccess: () => {
      setTitle('');
      setError(null);
      void invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao criar'),
  });
  const toggle = useMutation({
    mutationFn: (task: TaskDto) =>
      api.patch<TaskDto>(`/api/tasks/${task.id}`, {
        status: task.status === 'open' ? 'done' : 'open',
      }),
    onSuccess: () => void invalidate(),
  });

  const items = tasks.data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* o cabeçalho era um clone à mão do PageHeader — duas versões do mesmo
          bloco divergem na primeira mexida; agora é o primitivo */}
      <PageHeader
        title="Tarefas"
        meta={<span className="num">{tasks.data?.total ?? 0} no total</span>}
      >
        <Select
          size="sm"
          value={status}
          onChange={(e) => setStatus(e.target.value as 'open' | 'done' | 'all')}
          aria-label="Filtrar tarefas"
        >
          <option value="open">Abertas</option>
          <option value="done">Concluídas</option>
          <option value="all">Todas</option>
        </Select>
      </PageHeader>

      <PageBody>
        {canWrite ? (
          <form
            className="mb-5 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim()) create.mutate();
            }}
          >
            <div className="w-96">
              <Input
                placeholder="Nova tarefa…"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Título da nova tarefa"
                maxLength={200}
              />
            </div>
            <Button type="submit" variant="primary" disabled={create.isPending || !title.trim()}>
              <Plus size={14} /> Adicionar
            </Button>
            {error ? (
              <p role="alert" className="text-body-sm text-negative">
                {error}
              </p>
            ) : null}
          </form>
        ) : null}

        <Panel className="max-w-3xl">
          <ul className="divide-y divide-border/60">
            {items.map((task) => (
              <li key={task.id} className="flex items-center gap-3 px-4 py-2.5">
                <input
                  type="checkbox"
                  checked={task.status === 'done'}
                  disabled={!canWrite || toggle.isPending}
                  onChange={() => toggle.mutate(task)}
                  aria-label={`Concluir ${task.title}`}
                />
                <span
                  className={clsx(
                    'flex-1 text-body-sm',
                    task.status === 'done' && 'text-muted-fg line-through',
                  )}
                >
                  {task.title}
                </span>
                {task.priority !== 'normal' ? (
                  <span
                    className={clsx(
                      'text-data-sm',
                      task.priority === 'high' ? 'text-negative' : 'text-muted-fg',
                    )}
                  >
                    {priorityLabels[task.priority]}
                  </span>
                ) : null}
                {task.assigneeName ? (
                  <span className="text-data text-muted-fg">{task.assigneeName}</span>
                ) : null}
                {task.dueAt ? (
                  <span className="num text-data-sm text-muted-fg">
                    {dateFormat.format(new Date(task.dueAt))}
                  </span>
                ) : null}
              </li>
            ))}
            {tasks.data && items.length === 0 ? (
              <li>
                <EmptyState
                  title={
                    status === 'open'
                      ? 'Nenhuma tarefa aberta.'
                      : status === 'done'
                        ? 'Nenhuma tarefa concluída ainda.'
                        : 'Nenhuma tarefa neste workspace.'
                  }
                  hint={
                    status === 'done'
                      ? 'Marque uma tarefa como concluída e ela aparece aqui.'
                      : canWrite
                        ? 'Anote o próximo passo no campo acima — tarefa com prazo aparece em Hoje.'
                        : 'Quem tem permissão de escrita cria tarefas para o time.'
                  }
                />
              </li>
            ) : null}
          </ul>
        </Panel>
      </PageBody>
    </div>
  );
}
