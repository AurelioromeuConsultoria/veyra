import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationDto, NotificationPageDto } from '@veyra/contracts';
import { clsx } from 'clsx';
import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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

/**
 * O sino mora no CABEÇALHO (não mais no rodapé da lateral, onde ninguém
 * procurava por ele). Botão de ícone com o contador em cima: a caixa pessoal
 * precisa se anunciar sem ocupar uma linha de navegação.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  /** Popover aberto se fecha por Esc e por clique fora — sem isso ele fica
   *  pendurado sobre a tela enquanto a pessoa tenta trabalhar embaixo. */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

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
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notificações (${unread} não lidas)` : 'Notificações'}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={clsx(
          'relative rounded-control p-2 transition-colors duration-150 hover:bg-surface-2 hover:text-foreground',
          open ? 'bg-surface-2 text-foreground' : 'text-muted-fg',
        )}
      >
        <Bell size={15} aria-hidden />
        {unread > 0 ? (
          <span
            aria-hidden
            className="num absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-data-xs leading-4 text-accent-fg"
          >
            {unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notificações"
          className="absolute right-0 top-full z-30 mt-1.5 w-80 overflow-hidden rounded-card border border-border bg-surface shadow-float"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="eyebrow text-muted-fg">Notificações</span>
            {unread > 0 ? (
              <button
                type="button"
                className="ml-auto text-data text-accent hover:underline"
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
                  <p className="text-body-sm">{describe(notification)}</p>
                  <p className="mt-0.5 num text-data-xs text-muted-fg">
                    {timeFormat.format(new Date(notification.createdAt))}
                  </p>
                </button>
              </li>
            ))}
            {items.length === 0 ? (
              <li className="px-3 py-8 text-center">
                <p className="text-body-sm">Nada por aqui.</p>
                <p className="mt-1 text-data text-muted-fg">
                  Avisamos quando alguém atribuir uma conversa ou marcar você num evento.
                </p>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
