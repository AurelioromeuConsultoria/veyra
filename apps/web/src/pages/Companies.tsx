import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CompanyDto, Paginated } from '@veyra/contracts';
import { Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '../components/ui/button';
import { Drawer } from '../components/ui/drawer';
import { Field, Input, Select } from '../components/ui/input';
import { TagBadge } from '../components/ui/tag-badge';
import { Panel } from '../components/ui/page';
import { api, ApiError, toQuery } from '../lib/api';
import { hasPermission, useSession } from '../lib/session';

const companyFormSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(160),
  domain: z.string().trim().max(253),
  size: z.string(),
});
type CompanyFormValues = z.infer<typeof companyFormSchema>;

const sizeLabels: Record<string, string> = {
  solo: 'Autônomo',
  small: 'Pequena',
  medium: 'Média',
  large: 'Grande',
  enterprise: 'Enterprise',
};
const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });

export function CompaniesPage() {
  const { data: user } = useSession();
  const canWrite = hasPermission(user, 'contacts:write');
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState<'closed' | 'create' | CompanyDto>('closed');

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const params = { page, pageSize: 50, search, sortBy: 'name', sortDir: 'asc' };
  const companies = useQuery({
    queryKey: ['companies', params],
    queryFn: () => api.get<Paginated<CompanyDto>>(`/api/companies${toQuery(params)}`),
    placeholderData: keepPreviousData,
  });
  const total = companies.data?.total ?? 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-6 py-3.5">
        <div className="mr-auto">
          <h1 className="text-display-md">Empresas</h1>
          <p className="num text-data text-muted-fg">{total} no total</p>
        </div>
        <div className="relative">
          <Search
            size={14}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-fg"
          />
          <Input
            className="w-80 pl-9"
            placeholder="Buscar nome ou domínio…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Buscar empresas"
          />
        </div>
        {canWrite ? (
          <Button variant="primary" onClick={() => setDrawer('create')}>
            <Plus size={14} /> Nova empresa
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <Panel>
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2/50">
                {['Nome', 'Domínio', 'Porte', 'Tags', 'Contatos', 'Criada'].map((header) => (
                  <th key={header} className="eyebrow px-4 py-2 text-left text-muted-fg">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(companies.data?.items ?? []).map((company) => (
                <tr
                  key={company.id}
                  className="cursor-pointer border-b border-border/60 transition-colors last:border-b-0 hover:bg-surface-2/70"
                  onClick={() => setDrawer(company)}
                >
                  <td className="px-4 py-2 font-medium">{company.name}</td>
                  <td className="px-4 py-2 text-muted-fg">{company.domain ?? '—'}</td>
                  <td className="px-4 py-2">{company.size ? sizeLabels[company.size] : '—'}</td>
                  <td className="px-4 py-2">
                    <span className="flex flex-wrap gap-1">
                      {company.tags.map((tag) => (
                        <TagBadge key={tag.id} name={tag.name} color={tag.color} />
                      ))}
                    </span>
                  </td>
                  <td className="px-4 py-2 num text-data">{company.contactCount}</td>
                  <td className="px-4 py-2 num text-data text-muted-fg">
                    {dateFormat.format(new Date(company.createdAt))}
                  </td>
                </tr>
              ))}
              {companies.data && companies.data.items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-16 text-center text-body-sm text-muted-fg">
                    Nenhuma empresa ainda — crie a primeira.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Panel>
      </div>

      <Drawer
        open={drawer !== 'closed'}
        onOpenChange={(open) => !open && setDrawer('closed')}
        title={drawer === 'create' ? 'Nova empresa' : 'Editar empresa'}
      >
        {drawer !== 'closed' ? (
          <CompanyForm
            key={drawer === 'create' ? 'create' : drawer.id}
            company={drawer === 'create' ? null : drawer}
            canWrite={canWrite}
            onDone={() => {
              setDrawer('closed');
              void queryClient.invalidateQueries({ queryKey: ['companies'] });
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

function CompanyForm({
  company,
  canWrite,
  onDone,
}: {
  company: CompanyDto | null;
  canWrite: boolean;
  onDone: () => void;
}) {
  const form = useForm<CompanyFormValues>({
    resolver: zodResolver(companyFormSchema),
    defaultValues: {
      name: company?.name ?? '',
      domain: company?.domain ?? '',
      size: company?.size ?? '',
    },
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (values: CompanyFormValues) => {
      const payload = {
        name: values.name,
        domain: values.domain || null,
        size: values.size || null,
      };
      return company
        ? api.patch<CompanyDto>(`/api/companies/${company.id}`, payload)
        : api.post<CompanyDto>('/api/companies', {
            name: payload.name,
            domain: payload.domain ?? undefined,
            size: payload.size ?? undefined,
          });
    },
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao salvar'),
  });
  const remove = useMutation({
    mutationFn: () => api.delete<{ ok: true }>(`/api/companies/${company!.id}`),
    onSuccess: onDone,
  });

  return (
    <form
      className="space-y-4"
      onSubmit={form.handleSubmit((values) => save.mutate(values))}
      noValidate
    >
      <Field label="Nome" error={form.formState.errors.name?.message}>
        <Input autoFocus {...form.register('name')} disabled={!canWrite} />
      </Field>
      <Field label="Domínio" error={form.formState.errors.domain?.message}>
        <Input placeholder="empresa.com.br" {...form.register('domain')} disabled={!canWrite} />
      </Field>
      <Field label="Porte">
        <Select {...form.register('size')} disabled={!canWrite}>
          <option value="">—</option>
          {Object.entries(sizeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
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
          {company ? (
            <Button
              variant="danger"
              className="ml-auto"
              onClick={() => {
                if (window.confirm('Excluir esta empresa? Os contatos serão desvinculados.'))
                  remove.mutate();
              }}
              disabled={remove.isPending}
            >
              Excluir
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
