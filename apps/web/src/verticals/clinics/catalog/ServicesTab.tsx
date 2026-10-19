import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClinicsServiceDto } from '@veyra/contracts/verticals/clinics';
import { Archive, ArchiveRestore, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '../../../components/ui/button';
import { Drawer } from '../../../components/ui/drawer';
import { Field, Input } from '../../../components/ui/input';
import { EmptyState, Panel } from '../../../components/ui/page';
import { api, ApiError } from '../../../lib/api';
import { formatCents } from '../../../lib/format';
import { hasPermission, useSession } from '../../../lib/session';
import { centsToReaisInput, reaisToCents } from '../format';

export const SERVICES_KEY = ['clinics', 'catalog', 'services'] as const;

// Schema do FORM: o preço chega como texto em reais e vira centavos inteiros.
const serviceFormSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(80),
  durationMin: z.coerce
    .number()
    .int('Use minutos inteiros')
    .min(5, 'Mínimo de 5 minutos')
    .max(480, 'Máximo de 480 minutos')
    .refine((value) => value % 5 === 0, 'Use múltiplos de 5 minutos'),
  price: z.string().refine((value) => reaisToCents(value) !== undefined, 'Use reais, como 150,00'),
});
type ServiceFormInput = z.input<typeof serviceFormSchema>;
type ServiceFormValues = z.output<typeof serviceFormSchema>;

export function ServicesTab() {
  const { data: user } = useSession();
  const canManage = hasPermission(user, 'clinics:catalog:manage');
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<ClinicsServiceDto | 'new' | null>(null);

  const services = useQuery({
    queryKey: [...SERVICES_KEY, showArchived],
    queryFn: () =>
      api.get<ClinicsServiceDto[]>(
        `/api/clinics/services${showArchived ? '?includeArchived=true' : ''}`,
      ),
  });
  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.post<ClinicsServiceDto>(
        `/api/clinics/services/${id}/${archived ? 'archive' : 'unarchive'}`,
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['clinics', 'catalog'] }),
  });

  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <label className="flex items-center gap-2 text-body-sm text-muted-fg">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Mostrar arquivados
        </label>
        {canManage ? (
          <Button variant="primary" size="sm" className="ml-auto" onClick={() => setEditing('new')}>
            <Plus size={14} /> Novo serviço
          </Button>
        ) : null}
      </div>
      {services.isError ? (
        <p role="alert" className="mb-3 text-data text-negative">
          Não foi possível carregar os serviços.{' '}
          {services.error instanceof ApiError ? services.error.message : 'Tente de novo.'}
        </p>
      ) : null}
      {archive.isError ? (
        <p role="alert" className="mb-3 text-data text-negative">
          Não foi possível arquivar ou desarquivar.{' '}
          {archive.error instanceof ApiError ? archive.error.message : 'Tente de novo.'}
        </p>
      ) : null}
      <Panel>
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2/50">
              {['Serviço', 'Duração', 'Preço', 'Situação', ''].map((header, index) => (
                <th
                  key={`${header}-${index}`}
                  className="eyebrow px-4 py-2 text-left text-muted-fg"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(services.data ?? []).map((service) => (
              <tr key={service.id} className="border-b border-border/60 last:border-b-0">
                <td className="px-4 py-2">{service.name}</td>
                <td className="px-4 py-2 num text-data">{service.durationMin} min</td>
                <td className="px-4 py-2 num text-data">
                  {service.priceCents === null ? '—' : formatCents(service.priceCents)}
                </td>
                <td className="px-4 py-2 text-muted-fg">
                  {service.archivedAt ? 'Arquivado' : 'Ativo'}
                </td>
                <td className="px-4 py-2 text-right">
                  {canManage ? (
                    <span className="inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Editar ${service.name}`}
                        onClick={() => setEditing(service)}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`${service.archivedAt ? 'Desarquivar' : 'Arquivar'} ${service.name}`}
                        onClick={() =>
                          archive.mutate({ id: service.id, archived: !service.archivedAt })
                        }
                      >
                        {service.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                      </Button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
            {services.data && services.data.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <EmptyState
                    title="Nenhum serviço no catálogo."
                    hint={
                      canManage
                        ? 'Cadastre os procedimentos que a clínica oferece, com duração e preço.'
                        : 'Quem administra o catálogo ainda não cadastrou serviços.'
                    }
                  />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>

      <Drawer
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing === 'new' ? 'Novo serviço' : 'Editar serviço'}
      >
        {editing !== null ? (
          <ServiceForm
            service={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
              void queryClient.invalidateQueries({ queryKey: ['clinics', 'catalog'] });
            }}
          />
        ) : null}
      </Drawer>
    </>
  );
}

function ServiceForm({
  service,
  onDone,
}: {
  service: ClinicsServiceDto | null;
  onDone: () => void;
}) {
  const form = useForm<ServiceFormInput, unknown, ServiceFormValues>({
    resolver: zodResolver(serviceFormSchema),
    defaultValues: {
      name: service?.name ?? '',
      durationMin: service?.durationMin ?? 60,
      price: centsToReaisInput(service?.priceCents ?? null),
    },
  });
  const save = useMutation({
    mutationFn: (values: ServiceFormValues) => {
      const body = {
        name: values.name,
        durationMin: values.durationMin,
        priceCents: reaisToCents(values.price) ?? null,
      };
      return service
        ? api.patch<ClinicsServiceDto>(`/api/clinics/services/${service.id}`, body)
        : api.post<ClinicsServiceDto>('/api/clinics/services', body);
    },
    onSuccess: onDone,
  });
  const { errors } = form.formState;

  return (
    <form className="space-y-4" onSubmit={form.handleSubmit((values) => save.mutate(values))}>
      <Field label="Nome" error={errors.name?.message}>
        <Input autoFocus {...form.register('name')} />
      </Field>
      <Field
        label="Duração (minutos)"
        hint="De 5 a 480, em passos de 5."
        error={errors.durationMin?.message}
      >
        <Input type="number" min={5} max={480} step={5} {...form.register('durationMin')} />
      </Field>
      <Field
        label="Preço (R$)"
        hint="Opcional. Só referência: o Clinics não cobra nada."
        error={errors.price?.message}
      >
        <Input inputMode="decimal" placeholder="150,00" {...form.register('price')} />
      </Field>
      {save.error ? (
        <p role="alert" className="text-data text-negative">
          {save.error instanceof ApiError ? save.error.message : 'Não foi possível salvar.'}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={save.isPending}>
        {save.isPending ? 'Salvando…' : 'Salvar serviço'}
      </Button>
    </form>
  );
}
