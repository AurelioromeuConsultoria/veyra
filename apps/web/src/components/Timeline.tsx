import { useQuery } from '@tanstack/react-query';
import type { ActivityDto, ActivityPageDto } from '@veyra/contracts';
import { api, toQuery } from '../lib/api';

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

/** Texto da timeline montado no CLIENTE a partir do payload mínimo do servidor. */
function describe(activity: ActivityDto): string {
  const p = activity.payload;
  switch (activity.type) {
    case 'contact_created':
      return `criou o contato ${p.name ?? ''}`;
    case 'deal_created':
      return `criou a oportunidade ${p.title ?? ''}`;
    case 'deal_stage_changed':
      return `moveu de ${p.fromStage} para ${p.toStage}`;
    case 'deal_won':
      return 'marcou como ganha';
    case 'deal_lost':
      return 'marcou como perdida';
    case 'task_created':
      return `criou a tarefa ${p.title ?? ''}`;
    case 'task_completed':
      return `concluiu a tarefa ${p.title ?? ''}`;
    case 'note_added':
      return 'adicionou uma nota';
    case 'note_deleted':
      return 'removeu uma nota';
    default:
      return activity.type;
  }
}

/** Timeline de UM alvo (contactId XOR dealId) — o servidor recusa outra forma. */
export function Timeline({ contactId, dealId }: { contactId?: string; dealId?: string }) {
  const params = { contactId, dealId, limit: 30 };
  const activities = useQuery({
    queryKey: ['activities', params],
    queryFn: () => api.get<ActivityPageDto>(`/api/activities${toQuery(params)}`),
    enabled: Boolean(contactId ?? dealId),
  });

  if (!activities.data) return <p className="text-xs text-muted-fg">Carregando…</p>;
  if (activities.data.items.length === 0) {
    return <p className="text-xs text-muted-fg">Nada aconteceu por aqui ainda.</p>;
  }

  return (
    <ol className="space-y-2.5">
      {activities.data.items.map((activity) => (
        <li key={activity.id} className="flex gap-2.5 text-[13px]">
          <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-border" />
          <span className="min-w-0">
            <span className="font-medium">{activity.actorName ?? 'Sistema'}</span>{' '}
            <span className="text-muted-fg">{describe(activity)}</span>
            <time className="ml-1 font-mono text-[11px] tabular-nums text-muted-fg">
              {dateTimeFormat.format(new Date(activity.occurredAt))}
            </time>
          </span>
        </li>
      ))}
    </ol>
  );
}
