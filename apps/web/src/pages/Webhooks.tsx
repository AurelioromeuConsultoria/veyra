import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { webhookEventSchema, type WebhookDto } from '@veyra/contracts';
import { clsx } from 'clsx';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Field, Input } from '../components/ui/input';
import { Panel } from '../components/ui/page';
import { api, ApiError } from '../lib/api';

const allEvents = webhookEventSchema.options;

const statusLabels: Record<string, string> = {
  active: 'Ativo',
  paused: 'Pausado',
  disabled: 'Desativado',
};

export function WebhooksPage() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Segredo aparece UMA vez: fica só no estado local, nunca é refetchado. */
  const [freshSecret, setFreshSecret] = useState<string | null>(null);

  const webhooks = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api.get<WebhookDto[]>('/api/webhooks'),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['webhooks'] });

  const create = useMutation({
    mutationFn: () => api.post<WebhookDto & { secret: string }>('/api/webhooks', { url, events }),
    onSuccess: (created) => {
      setFreshSecret(created.secret);
      setUrl('');
      setEvents([]);
      setError(null);
      void invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao criar'),
  });
  const toggle = useMutation({
    mutationFn: (webhook: WebhookDto) =>
      api.patch<WebhookDto>(`/api/webhooks/${webhook.id}`, {
        status: webhook.status === 'active' ? 'paused' : 'active',
      }),
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/webhooks/${id}`),
    onSuccess: () => void invalidate(),
  });

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-border bg-surface px-6 py-3.5">
        <h1 className="text-display-md">Webhooks</h1>
        <p className="text-data text-muted-fg">
          Entrega assinada (HMAC), com retry e pausa automática após falhas.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {freshSecret ? (
          <div className="mb-5 rounded-md border border-accent/40 bg-accent/5 p-3">
            <p className="text-xs font-medium uppercase tracking-wider text-accent">
              Segredo de assinatura — copie agora
            </p>
            <p className="mt-1 text-xs text-muted-fg">
              Ele não será exibido de novo. Use para validar o header{' '}
              <code className="font-mono">x-veyra-signature</code>.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code
                data-testid="webhook-secret"
                className="flex-1 truncate rounded bg-surface-2 px-2 py-1 num text-data"
              >
                {freshSecret}
              </code>
              <Button
                size="sm"
                onClick={() => void navigator.clipboard?.writeText(freshSecret)}
                aria-label="Copiar segredo"
              >
                <Copy size={13} />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFreshSecret(null)}>
                Fechar
              </Button>
            </div>
          </div>
        ) : null}

        <form
          className="mb-6 max-w-2xl space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim() && events.length > 0) create.mutate();
          }}
        >
          <Field label="URL de destino (https)">
            <Input
              placeholder="https://seu-sistema.com/webhooks/veyra"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="URL do webhook"
            />
          </Field>
          <fieldset>
            <legend className="mb-1.5 block eyebrow text-muted-fg">Eventos</legend>
            <div className="flex flex-wrap gap-1.5">
              {allEvents.map((event) => {
                const active = events.includes(event);
                return (
                  <button
                    key={event}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setEvents((current) =>
                        active ? current.filter((e) => e !== event) : [...current, event],
                      )
                    }
                    className={clsx(
                      'num rounded-full border px-2 py-0.5 text-data-sm',
                      active
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-border text-muted-fg hover:bg-surface-2',
                    )}
                  >
                    {event}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {error ? (
            <p role="alert" className="text-body-sm text-negative">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || !url.trim() || events.length === 0}
          >
            <Plus size={14} /> Criar webhook
          </Button>
        </form>

        <Panel className="max-w-4xl">
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2/50">
                {['URL', 'Eventos', 'Status', 'Falhas', ''].map((header, i) => (
                  <th key={`${header}-${i}`} className="py-2 text-left eyebrow text-muted-fg">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(webhooks.data ?? []).map((webhook) => (
                <tr key={webhook.id} className="border-b border-border/60 last:border-b-0">
                  <td className="max-w-xs truncate py-2 num text-data">{webhook.url}</td>
                  <td className="py-2 text-xs text-muted-fg">{webhook.events.join(', ')}</td>
                  <td className="py-2">
                    <span
                      className={clsx(
                        'text-xs',
                        webhook.status === 'active' ? 'text-positive' : 'text-warning',
                      )}
                    >
                      {statusLabels[webhook.status]}
                    </span>
                  </td>
                  <td className="py-2 num text-data text-muted-fg">{webhook.failureCount}</td>
                  <td className="py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => toggle.mutate(webhook)}>
                      {webhook.status === 'active' ? 'Pausar' : 'Reativar'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Excluir webhook ${webhook.url}`}
                      onClick={() => {
                        if (window.confirm('Excluir este webhook?')) remove.mutate(webhook.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
              {webhooks.data && webhooks.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-body-sm text-muted-fg">
                    Nenhum webhook configurado.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
