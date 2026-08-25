import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated, TaskDto } from '@veyra/contracts';
import { clsx } from 'clsx';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Input, Select } from '../components/ui/input';
import { Panel } from '../components/ui/page';
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
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-6 py-3.5">
        <div className="mr-auto">
          <h1 className="text-display-md">Tarefas</h1>
          <p className="num text-data text-muted-fg">{tasks.data?.total ?? 0} no total</p>
        </div>
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
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
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
            {items.length === 0 ? (
              <li className="px-4 py-14 text-center text-body-sm text-muted-fg">
                Nenhuma tarefa {status === 'open' ? 'aberta' : ''} — bom sinal.
              </li>
            ) : null}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
