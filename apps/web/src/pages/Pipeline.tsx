import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardColumnDto, BoardDto, ContactDto, DealDto, Paginated } from '@veyra/contracts';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Timeline } from '../components/Timeline';
import { Button } from '../components/ui/button';
import { Drawer } from '../components/ui/drawer';
import { Field, Input, Select } from '../components/ui/input';
import { PageHeader } from '../components/ui/page';
import { api, ApiError } from '../lib/api';
import { formatCents } from '../lib/format';
import { hasPermission, useSession } from '../lib/session';

/** Coluna e folga em px — o board rola de uma etapa por vez (w-[17.5rem]). */
const COLUMN_WIDTH_PX = 280;
const COLUMN_GAP_PX = 12;

/**
 * Afordância de rolagem horizontal: o board tem mais etapas do que cabem na
 * tela e a coluna cortada na borda não dizia nada a quem olha ("Ganhou" e
 * "Perdeu" simplesmente não existiam). Devolve se há conteúdo ANTES e DEPOIS
 * das bordas para desenhar o esmaecimento — nunca uma barra decorativa fixa.
 */
function useHorizontalOverflow() {
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setEdges({ start: el.scrollLeft > 1, end: max > 1 && el.scrollLeft < max - 1 });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // o board chega depois da query: o conteúdo muda de largura sem que o
    // viewport mude de tamanho — por isso o trilho também é observado
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (track.current) observer.observe(track.current);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  /** Uma etapa por gesto — a largura da coluna mais a folga entre elas. */
  const scrollByColumn = (direction: -1 | 1) => {
    const el = viewport.current;
    if (!el) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({
      left: direction * (COLUMN_WIDTH_PX + COLUMN_GAP_PX),
      behavior: smooth ? 'smooth' : 'auto',
    });
  };

  return { viewport, track, scrollByColumn, ...edges };
}

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
  // arrasto em curso: as colunas crescem só enquanto ele dura, para que soltar
  // continue fácil sem que a coluna vire um retângulo oco o tempo todo
  const [dragging, setDragging] = useState(false);
  const overflow = useHorizontalOverflow();

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

  const abertoCents = columns.reduce((sum, column) => sum + column.totalCents, 0);
  const abertoCount = columns.reduce((sum, column) => sum + column.deals.length, 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Pipeline"
        title={board.data?.pipelineName ?? 'Pipeline'}
        meta={
          <span className="num">
            {formatCents(abertoCents)} em aberto · {abertoCount} oportunidades
          </span>
        }
      >
        <p className="hidden items-center gap-1.5 text-data text-muted-fg lg:flex">
          Selecione um card e use
          <kbd className="num rounded-sm border border-border bg-surface-2 px-1 text-data-sm">
            [
          </kbd>
          <kbd className="num rounded-sm border border-border bg-surface-2 px-1 text-data-sm">
            ]
          </kbd>
          para mover
        </p>
        {canWrite ? (
          <Button variant="primary" onClick={() => setDrawer('create')}>
            <Plus size={14} /> Nova oportunidade
          </Button>
        ) : null}
      </PageHeader>

      <div className="relative min-h-0 flex-1">
        <div ref={overflow.viewport} className="h-full overflow-auto">
          {/* sem `h-full`: a faixa tem a altura da coluna mais cheia, não a da
                viewport — e `stretch` (padrão) mantém o rodapé alinhado */}
          <div ref={overflow.track} className="flex min-w-max gap-3 p-5">
            {columns.map((column) => (
              <Column
                key={column.stageId}
                column={column}
                focusedDeal={focusedDeal}
                canWrite={canWrite}
                dragging={dragging}
                onDragStateChange={setDragging}
                onFocusDeal={setFocusedDeal}
                onOpenDeal={setDrawer}
                onMoveFocused={moveFocused}
                onDropDeal={(dealId) => move.mutate({ dealId, stageId: column.stageId })}
              />
            ))}
          </div>
        </div>
        {/* esmaecimento só quando há etapa fora de vista — some quando não há */}
        <div
          aria-hidden
          className={clsx(
            'pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-background via-background/75 to-transparent transition-opacity duration-150',
            overflow.start ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          aria-hidden
          className={clsx(
            'pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-background via-background/75 to-transparent transition-opacity duration-150',
            overflow.end ? 'opacity-100' : 'opacity-0',
          )}
        />
        {/* o esmaecimento avisa; o botão resolve — e é a única forma de chegar
            às etapas terminais sem trackpad horizontal ou foco em card */}
        {overflow.start ? (
          <Button
            size="icon"
            aria-label="Ver etapas anteriores"
            className="absolute left-2 top-[1.625rem] shadow-float"
            onClick={() => overflow.scrollByColumn(-1)}
          >
            <ChevronLeft size={16} />
          </Button>
        ) : null}
        {overflow.end ? (
          <Button
            size="icon"
            aria-label="Ver próximas etapas"
            className="absolute right-2 top-[1.625rem] shadow-float"
            onClick={() => overflow.scrollByColumn(1)}
          >
            <ChevronRight size={16} />
          </Button>
        ) : null}
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
  dragging,
  onDragStateChange,
  onFocusDeal,
  onOpenDeal,
  onMoveFocused,
  onDropDeal,
}: {
  column: BoardColumnDto;
  focusedDeal: string | null;
  canWrite: boolean;
  dragging: boolean;
  onDragStateChange: (dragging: boolean) => void;
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
        // altura pelo CONTEÚDO com piso utilizável: a coluna inteira continua
        // sendo alvo de soltura, mas sem esticar até o rodapé da viewport e
        // virar um retângulo oco de 650px quando há um card só
        'flex w-[17.5rem] shrink-0 flex-col rounded-card border bg-surface-2/40 transition-[min-height,background-color,border-color] duration-150',
        dragging ? 'min-h-[22rem]' : 'min-h-[12.5rem]',
        dragOver ? 'border-accent bg-accent/5' : 'border-border',
      )}
      onDragOver={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        onDragStateChange(false);
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
      <header className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2.5">
        <span className="eyebrow truncate text-muted-fg">{column.stageName}</span>
        <span className="num shrink-0 text-data-sm text-muted-fg">
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
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', deal.id);
                onDragStateChange(true);
              }}
              onDragEnd={() => onDragStateChange(false)}
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
                'cursor-pointer rounded-control border bg-surface p-3 shadow-raised transition-colors duration-150',
                focusedDeal === deal.id
                  ? 'border-accent ring-1 ring-accent/30'
                  : 'border-border hover:border-border-strong',
              )}
            >
              <p className="text-body-sm font-medium">{deal.title}</p>
              {(deal.contactName ?? deal.companyName) ? (
                <p className="mt-0.5 truncate text-data text-muted-fg">
                  {deal.contactName ?? deal.companyName}
                </p>
              ) : null}
              <p className="mt-2.5 flex items-baseline justify-between gap-2">
                <span className="num text-data text-foreground">
                  {formatCents(deal.amountCents)}
                </span>
                {/* sinal de "parado": insumo do lead scoring da Entrega 7 */}
                {/* "0d" sozinho era críptico: o número precisa dizer de que
                    tempo se trata — dias desde a entrada NESTA etapa */}
                {deal.daysInStage >= 7 ? (
                  <span className="num shrink-0 rounded-sm bg-warning/12 px-1 text-data-sm text-warning">
                    {deal.daysInStage}d parado
                  </span>
                ) : (
                  <span className="num shrink-0 text-data-sm text-muted-fg">
                    {deal.daysInStage}d na etapa
                  </span>
                )}
              </p>
            </article>
          </li>
        ))}
        {column.deals.length === 0 ? (
          <li className="flex flex-col items-center gap-1.5 px-1 py-8 text-center">
            <span aria-hidden className="h-px w-8 bg-border-strong" />
            <span className="text-data text-muted-fg">Nenhuma oportunidade nesta etapa</span>
          </li>
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
          <Select full {...form.register('contactId')} disabled={!canWrite}>
            <option value="">— sem contato —</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </Select>
        </Field>
        {error ? (
          <p role="alert" className="text-body-sm text-negative">
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
          <h3 className="eyebrow mb-2.5 text-muted-fg">Histórico</h3>
          <Timeline dealId={deal.id} />
        </section>
      ) : null}
    </div>
  );
}
