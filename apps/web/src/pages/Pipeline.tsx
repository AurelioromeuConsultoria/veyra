import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardColumnDto, BoardDto, ContactDto, DealDto, Paginated } from '@veyra/contracts';
import { clsx } from 'clsx';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Timeline } from '../components/Timeline';
import { Button } from '../components/ui/button';
import { Drawer } from '../components/ui/drawer';
import { Field, Input, Select } from '../components/ui/input';
import { api, ApiError } from '../lib/api';
import { hasPermission, useSession } from '../lib/session';

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const formatCents = (cents: number) => money.format(cents / 100);

const dealFormSchema = z.object({
  title: z.string().trim().min(1, 'Informe o título').max(160),
  amount: z.string().trim(),
  contactId: z.string(),
});
type DealFormValues = z.infer<typeof dealFormSchema>;

export function PipelinePage() {
  const { data: user } = useSession();
  const canWrite = hasPermission(user, 'deals:write');
  const queryClient = useQueryClient();
  const [drawer, setDrawer] = useState<'closed' | 'create' | DealDto>('closed');
  const [focusedDeal, setFocusedDeal] = useState<string | null>(null);

  const board = useQuery({
    queryKey: ['board'],
    queryFn: () => api.get<BoardDto>('/api/deals/board'),
    placeholderData: keepPreviousData,
  });
  const contacts = useQuery({
    queryKey: ['contacts', 'options'],
    queryFn: () =>
      api.get<Paginated<ContactDto>>('/api/contacts?pageSize=200&sortBy=name&sortDir=asc'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['board'] });
    void queryClient.invalidateQueries({ queryKey: ['activities'] });
  };

  const move = useMutation({
    mutationFn: ({ dealId, stageId }: { dealId: string; stageId: string }) =>
      api.post<DealDto>(`/api/deals/${dealId}/move`, { stageId }),
    onSuccess: invalidate,
  });

  const columns = board.data?.columns ?? [];

  /** Move o card focado para a coluna vizinha — teclado é cidadão de 1ª classe. */
  function moveFocused(direction: -1 | 1) {
    if (!focusedDeal || !canWrite) return;
    const fromIndex = columns.findIndex((column) =>
      column.deals.some((deal) => deal.id === focusedDeal),
    );
    const target = columns[fromIndex + direction];
    if (fromIndex < 0 || !target) return;
    move.mutate({ dealId: focusedDeal, stageId: target.stageId });
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="mr-auto">
          <h1 className="text-sm font-semibold">{board.data?.pipelineName ?? 'Pipeline'}</h1>
          <p className="font-mono text-xs tabular-nums text-muted-fg">
            {formatCents(columns.reduce((sum, column) => sum + column.totalCents, 0))} em aberto
          </p>
        </div>
        <p className="hidden text-xs text-muted-fg lg:block">
          Selecione um card e use <kbd className="font-mono">[</kbd> ou{' '}
          <kbd className="font-mono">]</kbd> para mover
        </p>
        {canWrite ? (
          <Button variant="primary" size="sm" onClick={() => setDrawer('create')}>
            <Plus size={14} /> Nova oportunidade
          </Button>
        ) : null}
      </header>

      <div className="flex-1 overflow-x-auto">
        <div className="flex h-full min-w-max gap-3 p-4">
          {columns.map((column) => (
            <Column
              key={column.stageId}
              column={column}
              focusedDeal={focusedDeal}
              canWrite={canWrite}
              onFocusDeal={setFocusedDeal}
              onOpenDeal={setDrawer}
              onMoveFocused={moveFocused}
              onDropDeal={(dealId) => move.mutate({ dealId, stageId: column.stageId })}
            />
          ))}
        </div>
      </div>

      <Drawer
        open={drawer !== 'closed'}
        onOpenChange={(open) => !open && setDrawer('closed')}
        title={drawer === 'create' ? 'Nova oportunidade' : 'Oportunidade'}
      >
        {drawer !== 'closed' ? (
          <DealForm
            key={drawer === 'create' ? 'create' : drawer.id}
            deal={drawer === 'create' ? null : drawer}
            contacts={contacts.data?.items ?? []}
            canWrite={canWrite}
            onDone={() => {
              setDrawer('closed');
              invalidate();
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

function Column({
  column,
  focusedDeal,
  canWrite,
  onFocusDeal,
  onOpenDeal,
  onMoveFocused,
  onDropDeal,
}: {
  column: BoardColumnDto;
  focusedDeal: string | null;
  canWrite: boolean;
  onFocusDeal: (id: string) => void;
  onOpenDeal: (deal: DealDto) => void;
  onMoveFocused: (direction: -1 | 1) => void;
  onDropDeal: (dealId: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <section
      aria-label={column.stageName}
      className={clsx(
        'flex w-72 shrink-0 flex-col rounded-lg border bg-surface',
        dragOver ? 'border-accent' : 'border-border',
      )}
      onDragOver={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        // dado de drop é ENTRADA NÃO CONFIÁVEL (pode vir de outra origem):
        // só um uuid vira path de request
        const dropped = e.dataTransfer.getData('text/plain');
        if (
          canWrite &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dropped)
        ) {
          onDropDeal(dropped);
        }
      }}
    >
      <header className="flex items-baseline justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-fg">
          {column.stageName}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-fg">
          {column.deals.length} · {formatCents(column.totalCents)}
        </span>
      </header>
      <ul className="flex-1 space-y-2 overflow-y-auto p-2">
        {column.deals.map((deal) => (
          <li key={deal.id}>
            <article
              tabIndex={0}
              draggable={canWrite}
              aria-label={`${deal.title}, ${column.stageName}`}
              onDragStart={(e) => e.dataTransfer.setData('text/plain', deal.id)}
              onFocus={() => onFocusDeal(deal.id)}
              onClick={() => onOpenDeal(deal)}
              onKeyDown={(e) => {
                if (e.key === '[') {
                  e.preventDefault();
                  onMoveFocused(-1);
                } else if (e.key === ']') {
                  e.preventDefault();
                  onMoveFocused(1);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  onOpenDeal(deal);
                }
              }}
              className={clsx(
                'cursor-pointer rounded-md border bg-background p-2.5 transition-colors',
                focusedDeal === deal.id ? 'border-accent' : 'border-border hover:bg-surface-2',
              )}
            >
              <p className="text-[13px] font-medium">{deal.title}</p>
              {(deal.contactName ?? deal.companyName) ? (
                <p className="truncate text-xs text-muted-fg">
                  {deal.contactName ?? deal.companyName}
                </p>
              ) : null}
              <p className="mt-1.5 flex items-center justify-between font-mono text-[11px] tabular-nums">
                <span>{formatCents(deal.amountCents)}</span>
                {/* sinal de "parado": insumo do lead scoring da Entrega 7 */}
                {deal.daysInStage >= 7 ? (
                  <span className="text-warning">{deal.daysInStage}d parado</span>
                ) : (
                  <span className="text-muted-fg">{deal.daysInStage}d</span>
                )}
              </p>
            </article>
          </li>
        ))}
        {column.deals.length === 0 ? (
          <li className="px-1 py-6 text-center text-xs text-muted-fg">Vazio</li>
        ) : null}
      </ul>
    </section>
  );
}

function DealForm({
  deal,
  contacts,
  canWrite,
  onDone,
}: {
  deal: DealDto | null;
  contacts: ContactDto[];
  canWrite: boolean;
  onDone: () => void;
}) {
  const form = useForm<DealFormValues>({
    resolver: zodResolver(dealFormSchema),
    defaultValues: {
      title: deal?.title ?? '',
      amount: deal ? String(deal.amountCents / 100) : '',
      contactId: deal?.contactId ?? '',
    },
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (values: DealFormValues) => {
      const payload = {
        title: values.title,
        amountCents: Math.round(Number(values.amount.replace(',', '.') || 0) * 100),
        contactId: values.contactId || null,
      };
      return deal
        ? api.patch<DealDto>(`/api/deals/${deal.id}`, payload)
        : api.post<DealDto>('/api/deals', {
            ...payload,
            contactId: payload.contactId ?? undefined,
          });
    },
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao salvar'),
  });
  const remove = useMutation({
    mutationFn: () => api.delete<{ ok: true }>(`/api/deals/${deal!.id}`),
    onSuccess: onDone,
  });

  return (
    <div className="space-y-6">
      <form
        className="space-y-4"
        onSubmit={form.handleSubmit((values) => save.mutate(values))}
        noValidate
      >
        <Field label="Título" error={form.formState.errors.title?.message}>
          <Input autoFocus {...form.register('title')} disabled={!canWrite} />
        </Field>
        <Field label="Valor (R$)">
          <Input inputMode="decimal" {...form.register('amount')} disabled={!canWrite} />
        </Field>
        <Field label="Contato">
          <Select {...form.register('contactId')} disabled={!canWrite}>
            <option value="">— sem contato —</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </Select>
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        ) : null}
        {canWrite ? (
          <div className="flex items-center gap-2 border-t border-border pt-4">
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {save.isPending ? 'Salvando…' : 'Salvar'}
            </Button>
            {deal ? (
              <Button
                variant="danger"
                className="ml-auto"
                onClick={() => {
                  if (window.confirm('Excluir esta oportunidade?')) remove.mutate();
                }}
              >
                Excluir
              </Button>
            ) : null}
          </div>
        ) : null}
      </form>

      {deal ? (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-fg">
            Histórico
          </h3>
          <Timeline dealId={deal.id} />
        </section>
      ) : null}
    </div>
  );
}
