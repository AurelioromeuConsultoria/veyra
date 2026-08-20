import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CalendarEventDto } from '@veyra/contracts';
import { clsx } from 'clsx';
import { CalendarPlus, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Field, Input } from '../components/ui/input';
import { api, ApiError, toQuery } from '../lib/api';
import { hasPermission, useSession } from '../lib/session';

const dayFormat = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
});
const hourFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const rangeFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });

/** Segunda-feira da semana de `date`, à meia-noite local. */
function weekStart(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const weekday = (start.getDay() + 6) % 7; // segunda = 0
  start.setDate(start.getDate() - weekday);
  return start;
}
function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
/** value de <input type="datetime-local"> a partir de um Date local. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function CalendarPage() {
  const { data: user } = useSession();
  const canWrite = hasPermission(user, 'calendar:write');
  const queryClient = useQueryClient();

  const [anchor, setAnchor] = useState(() => weekStart(new Date()));
  const [title, setTitle] = useState('');
  const [startAt, setStartAt] = useState(() => toLocalInput(new Date()));
  const [durationMin, setDurationMin] = useState(60);
  const [error, setError] = useState<string | null>(null);

  const from = anchor;
  const to = addDays(anchor, 7);
  const params = { from: from.toISOString(), to: to.toISOString(), status: 'all' as const };

  const events = useQuery({
    queryKey: ['calendar', params],
    queryFn: () => api.get<CalendarEventDto[]>(`/api/calendar/events${toQuery(params)}`),
    placeholderData: keepPreviousData,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['calendar'] });

  const create = useMutation({
    mutationFn: () => {
      const start = new Date(startAt);
      return api.post<CalendarEventDto>('/api/calendar/events', {
        title: title.trim(),
        startAt: start.toISOString(),
        endAt: new Date(start.getTime() + durationMin * 60_000).toISOString(),
      });
    },
    onSuccess: () => {
      setTitle('');
      setError(null);
      void invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao criar evento'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/calendar/events/${id}`),
    onSuccess: () => void invalidate(),
  });

  const days = Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
  const byDay = new Map<string, CalendarEventDto[]>();
  for (const event of events.data ?? []) {
    const key = new Date(event.startAt).toDateString();
    byDay.set(key, [...(byDay.get(key) ?? []), event]);
  }
  const today = new Date().toDateString();

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="mr-auto">
          <h1 className="text-sm font-semibold">Agenda</h1>
          <p className="text-xs text-muted-fg">
            {rangeFormat.format(from)} – {rangeFormat.format(addDays(to, -1))}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAnchor(addDays(anchor, -7))}
          aria-label="Semana anterior"
        >
          <ChevronLeft size={14} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAnchor(weekStart(new Date()))}>
          Hoje
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAnchor(addDays(anchor, 7))}
          aria-label="Próxima semana"
        >
          <ChevronRight size={14} />
        </Button>
      </header>

      {canWrite ? (
        <form
          className="flex flex-wrap items-end gap-2 border-b border-border px-5 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate();
          }}
        >
          <div className="min-w-56 flex-1">
            <Field label="Evento">
              <Input
                className="h-8"
                placeholder="Reunião com o cliente"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Título do evento"
              />
            </Field>
          </div>
          <Field label="Início">
            <Input
              className="h-8"
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              aria-label="Início do evento"
            />
          </Field>
          <Field label="Duração (min)">
            <Input
              className="h-8 w-24 tabular-nums"
              type="number"
              min={5}
              step={5}
              value={durationMin}
              onChange={(e) => setDurationMin(Number(e.target.value))}
              aria-label="Duração em minutos"
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!title.trim() || create.isPending}
          >
            <CalendarPlus size={14} /> Agendar
          </Button>
          {error ? (
            <p role="alert" className="w-full text-sm text-negative">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}

      <div className="grid flex-1 grid-cols-7 overflow-auto">
        {days.map((day) => {
          const dayEvents = (byDay.get(day.toDateString()) ?? []).sort(
            (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
          );
          return (
            <div key={day.toISOString()} className="min-w-0 border-r border-border last:border-r-0">
              <div
                className={clsx(
                  'sticky top-0 border-b border-border bg-background px-2 py-1.5 text-[11px] uppercase tracking-wider',
                  day.toDateString() === today ? 'text-accent' : 'text-muted-fg',
                )}
              >
                {dayFormat.format(day)}
              </div>
              <ul className="space-y-1 p-1.5">
                {dayEvents.map((event) => (
                  <li
                    key={event.id}
                    className={clsx(
                      'group rounded border px-2 py-1.5',
                      event.status === 'canceled'
                        ? 'border-border bg-surface-2 line-through opacity-60'
                        : 'border-accent/30 bg-accent/5',
                    )}
                  >
                    <div className="flex items-start gap-1">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                        {event.title}
                      </span>
                      {canWrite ? (
                        <button
                          type="button"
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                          aria-label={`Excluir ${event.title}`}
                          onClick={() => remove.mutate(event.id)}
                        >
                          <Trash2 size={12} className="text-muted-fg hover:text-negative" />
                        </button>
                      ) : null}
                    </div>
                    <div className="font-mono text-[10px] tabular-nums text-muted-fg">
                      {hourFormat.format(new Date(event.startAt))}–
                      {hourFormat.format(new Date(event.endAt))}
                    </div>
                    {event.contactName ? (
                      <div className="truncate text-[11px] text-muted-fg">{event.contactName}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
