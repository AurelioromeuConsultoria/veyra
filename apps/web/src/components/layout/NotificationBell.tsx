import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationDto, NotificationPageDto } from '@veyra/contracts';
import { clsx } from 'clsx';
import { Bell } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';

const timeFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** Sem WebSocket no MVP (ADR-023 §consequências): polling de 60s basta. */
const POLL_MS = 60_000;

function describe(notification: NotificationDto): string {
  switch (notification.type) {
    case 'calendar_event_scheduled':
      return `Você organiza "${notification.payload.title}"`;
    case 'conversation_assigned':
      return `Conversa atribuída a você: ${notification.payload.subject}`;
    default:
      return 'Nova notificação';
  }
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationPageDto>('/api/notifications?limit=20'),
    refetchInterval: POLL_MS,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  const markRead = useMutation({
    mutationFn: (id: string) => api.patch<{ ok: true }>(`/api/notifications/${id}/read`),
    onSuccess: () => void invalidate(),
  });
  const markAll = useMutation({
    mutationFn: () => api.post<{ marked: number }>('/api/notifications/read-all'),
    onSuccess: () => void invalidate(),
  });

  const unread = notifications.data?.unreadCount ?? 0;
  const items = notifications.data?.items ?? [];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notificações (${unread} não lidas)` : 'Notificações'}
        aria-expanded={open}
        className="relative flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-fg hover:bg-surface-2"
      >
        <Bell size={15} />
        Notificações
        {unread > 0 ? (
          <span className="ml-auto rounded-full bg-accent px-1.5 font-mono text-[10px] tabular-nums text-background">
            {unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-72 rounded-md border border-border bg-surface shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-fg">
              Notificações
            </span>
            {unread > 0 ? (
              <button
                type="button"
                className="ml-auto text-xs text-accent hover:underline"
                onClick={() => markAll.mutate()}
              >
                Marcar todas
              </button>
            ) : null}
          </div>
          <ul className="max-h-80 overflow-auto">
            {items.map((notification) => (
              <li key={notification.id}>
                <button
                  type="button"
                  onClick={() => markRead.mutate(notification.id)}
                  disabled={notification.readAt !== null}
                  className={clsx(
                    'w-full border-b border-border/60 px-3 py-2 text-left last:border-b-0',
                    notification.readAt === null ? 'hover:bg-surface-2' : 'opacity-60',
                  )}
                >
                  <p className="text-[13px]">{describe(notification)}</p>
                  <p className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-fg">
                    {timeFormat.format(new Date(notification.createdAt))}
                  </p>
                </button>
              </li>
            ))}
            {items.length === 0 ? (
              <li className="px-3 py-8 text-center text-xs text-muted-fg">Nada por aqui.</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
