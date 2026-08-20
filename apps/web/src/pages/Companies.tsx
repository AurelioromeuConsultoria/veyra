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
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="mr-auto">
          <h1 className="text-sm font-semibold">Empresas</h1>
          <p className="font-mono text-xs tabular-nums text-muted-fg">{total} no total</p>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-fg" />
          <Input
            className="h-8 w-64 pl-8"
            placeholder="Buscar por nome ou domínio…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Buscar empresas"
          />
        </div>
        {canWrite ? (
          <Button variant="primary" size="sm" onClick={() => setDrawer('create')}>
            <Plus size={14} /> Nova empresa
          </Button>
        ) : null}
      </header>

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="border-b border-border">
              {['Nome', 'Domínio', 'Porte', 'Tags', 'Contatos', 'Criada'].map((header) => (
                <th
                  key={header}
                  className="px-5 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-fg"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(companies.data?.items ?? []).map((company) => (
              <tr
                key={company.id}
                className="cursor-pointer border-b border-border/60 hover:bg-surface-2"
                onClick={() => setDrawer(company)}
              >
                <td className="px-5 py-1.5 font-medium">{company.name}</td>
                <td className="px-5 py-1.5 text-muted-fg">{company.domain ?? '—'}</td>
                <td className="px-5 py-1.5">{company.size ? sizeLabels[company.size] : '—'}</td>
                <td className="px-5 py-1.5">
                  <span className="flex flex-wrap gap-1">
                    {company.tags.map((tag) => (
                      <TagBadge key={tag.id} name={tag.name} color={tag.color} />
                    ))}
                  </span>
                </td>
                <td className="px-5 py-1.5 font-mono text-xs tabular-nums">
                  {company.contactCount}
                </td>
                <td className="px-5 py-1.5 font-mono text-xs tabular-nums text-muted-fg">
                  {dateFormat.format(new Date(company.createdAt))}
                </td>
              </tr>
            ))}
            {companies.data && companies.data.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-16 text-center text-sm text-muted-fg">
                  Nenhuma empresa ainda — crie a primeira.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
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
        <p role="alert" className="text-sm text-negative">
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
