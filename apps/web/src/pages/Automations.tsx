import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AutomationDto, AutomationExecutionDto, AutomationTrigger } from '@veyra/contracts';
import { clsx } from 'clsx';
import { Plus, Trash2, Workflow } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Field, Input, Select } from '../components/ui/input';
import { api, ApiError } from '../lib/api';

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

/** Catálogo FECHADO: o que aparece aqui é o que o servidor aceita (ADR-035). */
const triggerLabels: Record<AutomationTrigger, string> = {
  'contact.created': 'Contato criado',
  'deal.created': 'Oportunidade criada',
  'deal.won': 'Oportunidade ganha',
  'deal.lost': 'Oportunidade perdida',
  'task.created': 'Tarefa criada',
  'task.completed': 'Tarefa concluída',
};

const statusLabels: Record<string, string> = {
  executed: 'Executada',
  skipped: 'Ignorada',
  failed: 'Falhou',
};

export function AutomationsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<AutomationTrigger>('contact.created');
  const [title, setTitle] = useState('Ligar para {{name}}');
  const [dueInDays, setDueInDays] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const automations = useQuery({
    queryKey: ['automations'],
    queryFn: () => api.get<AutomationDto[]>('/api/automations'),
  });
  const executions = useQuery({
    queryKey: ['automation-executions'],
    queryFn: () => api.get<AutomationExecutionDto[]>('/api/automations/executions?limit=20'),
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['automations'] });
    void queryClient.invalidateQueries({ queryKey: ['automation-executions'] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<AutomationDto>('/api/automations', {
        name: name.trim(),
        trigger,
        action: 'create_task',
        actionConfig: { title: title.trim(), dueInDays },
        conditions: [],
      }),
    onSuccess: () => {
      setName('');
      setError(null);
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao criar automação'),
  });
  const toggle = useMutation({
    mutationFn: (automation: AutomationDto) =>
      api.patch<AutomationDto>(`/api/automations/${automation.id}`, {
        enabled: !automation.enabled,
      }),
    onSuccess: () => invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/automations/${id}`),
    onSuccess: () => invalidate(),
  });

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Workflow size={15} className="text-muted-fg" />
        <div>
          <h1 className="text-sm font-semibold">Automações</h1>
          <p className="text-xs text-muted-fg">
            Quando algo acontece, crie a tarefa certa — catálogo fechado, sem código.
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-5">
        <form
          className="mb-6 flex max-w-3xl flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && title.trim()) create.mutate();
          }}
        >
          <div className="min-w-40 flex-1">
            <Field label="Nome">
              <Input
                className="h-8"
                placeholder="Follow-up de novo contato"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="Nome da automação"
              />
            </Field>
          </div>
          <Field label="Quando">
            <Select
              className="h-8 w-auto"
              value={trigger}
              onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}
              aria-label="Gatilho"
            >
              {Object.entries(triggerLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="min-w-48 flex-1">
            <Field label="Criar tarefa">
              <Input
                className="h-8"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Título da tarefa"
              />
            </Field>
          </div>
          <Field label="Prazo (dias)">
            <Input
              className="h-8 w-20 tabular-nums"
              type="number"
              min={0}
              max={30}
              value={dueInDays}
              onChange={(e) => setDueInDays(Number(e.target.value))}
              aria-label="Prazo em dias"
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!name.trim() || create.isPending}
          >
            <Plus size={14} /> Criar
          </Button>
          {error ? (
            <p role="alert" className="w-full text-sm text-negative">
              {error}
            </p>
          ) : null}
        </form>

        <ul className="mb-8 max-w-3xl space-y-2">
          {(automations.data ?? []).map((automation) => (
            <li
              key={automation.id}
              className={clsx(
                'flex items-start gap-3 rounded-md border p-3',
                automation.enabled ? 'border-border' : 'border-border/60 opacity-60',
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{automation.name}</p>
                <p className="mt-0.5 text-xs text-muted-fg">
                  {triggerLabels[automation.trigger]} → criar “{automation.actionConfig.title}”
                  {automation.actionConfig.dueInDays > 0
                    ? ` em ${automation.actionConfig.dueInDays} dia(s)`
                    : ' hoje'}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => toggle.mutate(automation)}>
                {automation.enabled ? 'Desativar' : 'Ativar'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Excluir ${automation.name}`}
                onClick={() => remove.mutate(automation.id)}
              >
                <Trash2 size={14} />
              </Button>
            </li>
          ))}
          {automations.data && automations.data.length === 0 ? (
            <li className="py-10 text-center text-sm text-muted-fg">Nenhuma automação ainda.</li>
          ) : null}
        </ul>

        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-fg">
          Execuções recentes
        </h2>
        <table className="w-full max-w-3xl border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border">
              {['Quando', 'Automação', 'Resultado'].map((header) => (
                <th
                  key={header}
                  className="py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-fg"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(executions.data ?? []).map((execution) => (
              <tr key={execution.id} className="border-b border-border/60">
                <td className="whitespace-nowrap py-1.5 font-mono text-xs tabular-nums text-muted-fg">
                  {dateTimeFormat.format(new Date(execution.createdAt))}
                </td>
                <td className="py-1.5">{execution.automationName}</td>
                <td className="py-1.5">
                  <span
                    className={clsx(
                      'text-xs',
                      execution.status === 'executed' ? 'text-positive' : 'text-muted-fg',
                    )}
                  >
                    {statusLabels[execution.status]}
                    {execution.reason ? ` · ${execution.reason}` : ''}
                  </span>
                </td>
              </tr>
            ))}
            {executions.data && executions.data.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-10 text-center text-sm text-muted-fg">
                  Nenhuma execução ainda.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
