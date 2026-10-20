import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type {
  CompanyDto,
  ContactDto,
  CustomFieldDto,
  MemberDto,
  Paginated,
  TagDto,
} from '@veyra/contracts';
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Search, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { Timeline } from '../components/Timeline';
import { Button } from '../components/ui/button';
import { Drawer } from '../components/ui/drawer';
import { Field, Input, Select } from '../components/ui/input';
import { EmptyState, PageBody, PageHeader, Panel } from '../components/ui/page';
import { TagBadge } from '../components/ui/tag-badge';
import { api, ApiError, toQuery } from '../lib/api';
import { hasPermission, useSession } from '../lib/session';

// ── form (UI simplifica: 1 e-mail / 1 telefone; o contrato aceita listas) ────
const contactFormSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(160),
  email: z.string().trim().email('E-mail inválido').max(254).or(z.literal('')),
  phone: z.string().trim().max(25),
  companyId: z.string(),
  ownerMembershipId: z.string(),
  source: z.string().trim().max(60),
});
type ContactFormValues = z.infer<typeof contactFormSchema>;

const columnHelper = createColumnHelper<ContactDto>();
const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
/**
 * Referência ESTÁVEL enquanto a lista não chegou: o TanStack Table exige que
 * `data` seja estável. Um `[]` novo a cada render faz a tabela ver "dados
 * novos" e voltar à página 0, que muda o estado e re-renderiza com outro `[]` —
 * para sempre. A aba congelava ao digitar na busca antes da primeira resposta.
 */
const SEM_CONTATOS: ContactDto[] = [];

type SortBy = 'name' | 'createdAt' | 'updatedAt';

export function ContactsPage() {
  const { data: user } = useSession();
  const canWrite = hasPermission(user, 'contacts:write');
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [drawer, setDrawer] = useState<'closed' | 'create' | ContactDto>('closed');

  /**
   * `?c=<id>` é como a busca global entrega um contato: ela abre a FICHA, não
   * uma lista pré-filtrada que ainda exigiria achar a linha. O contato é lido
   * pelo endpoint de item porque ele pode não estar na página corrente da
   * tabela — e o parâmetro sai da URL assim que vira estado de tela.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLink = searchParams.get('c');
  const linked = useQuery({
    queryKey: ['contact', deepLink],
    queryFn: () => api.get<ContactDto>(`/api/contacts/${deepLink}`),
    enabled: deepLink !== null,
  });

  useEffect(() => {
    if (!linked.data) return;
    setDrawer(linked.data);
    setSearchParams(
      (params) => {
        params.delete('c');
        return params;
      },
      { replace: true },
    );
  }, [linked.data, setSearchParams]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const params = { page, pageSize: 50, search, status, sortBy, sortDir };
  const contacts = useQuery({
    queryKey: ['contacts', params],
    queryFn: () => api.get<Paginated<ContactDto>>(`/api/contacts${toQuery(params)}`),
    placeholderData: keepPreviousData,
  });
  const tags = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.get<TagDto[]>('/api/tags'),
  });
  const companies = useQuery({
    queryKey: ['companies', 'options'],
    queryFn: () =>
      api.get<Paginated<CompanyDto>>('/api/companies?pageSize=200&sortBy=name&sortDir=asc'),
  });
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<MemberDto[]>('/api/members'),
    enabled: hasPermission(user, 'members:read'),
  });
  const fieldDefs = useQuery({
    queryKey: ['custom-fields', 'contact'],
    queryFn: () => api.get<CustomFieldDto[]>('/api/custom-fields?entityType=contact'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['contacts'] });

  function toggleSort(column: SortBy) {
    if (sortBy === column) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(column);
      setSortDir('asc');
    }
    setPage(1);
  }

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: 'Nome',
        cell: (info) => (
          <span className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-data-xs text-muted-fg"
            >
              {info
                .getValue()
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0])
                .join('')
                .toUpperCase()}
            </span>
            <span className="font-medium">{info.getValue()}</span>
          </span>
        ),
      }),
      columnHelper.accessor((row) => row.emails[0] ?? '', {
        id: 'email',
        header: 'E-mail',
        cell: (info) => <span className="text-muted-fg">{info.getValue()}</span>,
      }),
      columnHelper.accessor('companyName', { header: 'Empresa' }),
      columnHelper.accessor('tags', {
        header: 'Tags',
        cell: (info) => (
          <span className="flex flex-wrap gap-1">
            {info.getValue().map((tag) => (
              <TagBadge key={tag.id} name={tag.name} color={tag.color} />
            ))}
          </span>
        ),
      }),
      columnHelper.accessor('ownerName', {
        header: 'Dono',
        cell: (info) => <span className="text-muted-fg">{info.getValue() ?? '—'}</span>,
      }),
      columnHelper.accessor('createdAt', {
        header: 'Criado',
        cell: (info) => (
          <span className="num text-data text-muted-fg">
            {dateFormat.format(new Date(info.getValue()))}
          </span>
        ),
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: contacts.data?.items ?? SEM_CONTATOS,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const total = contacts.data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * 50 + 1;
  const to = Math.min(page * 50, total);
  const sortable: Record<string, SortBy> = { name: 'name', createdAt: 'createdAt' };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Contatos"
        meta={
          <span className="num">
            {total} {status === 'active' ? 'ativos' : 'arquivados'}
          </span>
        }
      >
        {/* larguras INTENCIONAIS: a busca tem tamanho fixo, o filtro tem o
            tamanho do seu conteúdo e os botões não quebram em duas linhas */}
        <div className="relative">
          <Search
            size={14}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-fg"
          />
          <Input
            className="w-80 pl-9"
            placeholder="Buscar nome ou e-mail…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Buscar contatos"
          />
        </div>
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as 'active' | 'archived');
            setPage(1);
          }}
          aria-label="Filtrar por status"
        >
          <option value="active">Ativos</option>
          <option value="archived">Arquivados</option>
        </Select>
        {canWrite ? (
          <>
            <ImportButton onDone={invalidate} />
            <Button variant="primary" onClick={() => setDrawer('create')}>
              <Plus size={14} /> Novo contato
            </Button>
          </>
        ) : null}
      </PageHeader>

      <PageBody>
        {/* o painel ABRAÇA os dados: cinco linhas não esticam por 600px de nada */}
        <Panel className="rise">
          <table className="w-full border-collapse text-body-sm">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b border-border bg-surface-2/50">
                  {headerGroup.headers.map((header) => {
                    const sortKey = sortable[header.column.id];
                    return (
                      <th key={header.id} className="eyebrow px-4 py-2 text-left text-muted-fg">
                        {sortKey ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                            onClick={() => toggleSort(sortKey)}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sortBy === sortKey ? (
                              sortDir === 'asc' ? (
                                <ArrowUp size={11} />
                              ) : (
                                <ArrowDown size={11} />
                              )
                            ) : (
                              <ArrowUpDown size={11} className="opacity-30" />
                            )}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  className="cursor-pointer border-b border-border/60 transition-colors last:border-b-0 hover:bg-surface-2/70 focus-visible:bg-surface-2"
                  onClick={() => setDrawer(row.original)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setDrawer(row.original);
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-2 align-middle">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
              {contacts.data && contacts.data.items.length === 0 ? (
                <tr>
                  <td colSpan={columns.length}>
                    <EmptyState
                      title={
                        search
                          ? 'Nenhum contato para esta busca.'
                          : 'Nenhum contato ainda — crie o primeiro ou importe uma lista.'
                      }
                      hint={
                        search
                          ? 'Tente outro trecho do nome ou do e-mail.'
                          : 'A importação aceita CSV com nome, e-mail e telefone.'
                      }
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          {/* rodapé do PAINEL: o intervalo e a paginação vivem com a tabela */}
          <footer className="flex items-center gap-3 border-t border-border bg-surface-2/40 px-4 py-2">
            <span className="num text-data-sm text-muted-fg">
              {from}–{to} de {total}
            </span>
            <span className="ml-auto flex gap-1.5">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Anterior
              </Button>
              <Button size="sm" disabled={to >= total} onClick={() => setPage((p) => p + 1)}>
                Próxima
              </Button>
            </span>
          </footer>
        </Panel>
      </PageBody>

      <Drawer
        open={drawer !== 'closed'}
        onOpenChange={(open) => !open && setDrawer('closed')}
        title={drawer === 'create' ? 'Novo contato' : 'Editar contato'}
      >
        {drawer !== 'closed' ? (
          <ContactForm
            key={drawer === 'create' ? 'create' : drawer.id}
            contact={drawer === 'create' ? null : drawer}
            tags={tags.data ?? []}
            companies={companies.data?.items ?? []}
            members={members.data ?? []}
            fieldDefs={fieldDefs.data ?? []}
            canWrite={canWrite}
            onDone={() => {
              setDrawer('closed');
              void invalidate();
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

/** Import básico por CSV: colunas nome,email,telefone (cabeçalho opcional). */
function ImportButton({ onDone }: { onDone: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const importCsv = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      const rows = text
        .split(/\r?\n/)
        .map((line) => line.split(/[;,]/).map((cell) => cell.trim().replace(/^"|"$/g, '')))
        .filter((cells) => cells[0] && !/^nome$/i.test(cells[0]))
        .map(([name, email, phone]) => ({
          name,
          ...(email ? { email: email.toLowerCase() } : {}),
          ...(phone ? { phone } : {}),
        }));
      if (rows.length === 0) throw new ApiError(400, 'Arquivo vazio ou sem coluna de nome');
      return api.post<{ imported: number }>('/api/contacts/import', { rows });
    },
    onSuccess: (result) => {
      setFeedback(`${result.imported} contatos importados`);
      onDone();
    },
    onError: (e) => setFeedback(e instanceof ApiError ? e.message : 'Falha na importação'),
  });

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        aria-label="Arquivo CSV"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) importCsv.mutate(file);
          e.target.value = '';
        }}
      />
      <Button onClick={() => fileInput.current?.click()} disabled={importCsv.isPending}>
        <Upload size={14} /> {importCsv.isPending ? 'Importando…' : 'Importar CSV'}
      </Button>
      {feedback ? (
        <span className="whitespace-nowrap text-data text-muted-fg">{feedback}</span>
      ) : null}
    </>
  );
}

function ContactForm({
  contact,
  tags,
  companies,
  members,
  fieldDefs,
  canWrite,
  onDone,
}: {
  contact: ContactDto | null;
  tags: TagDto[];
  companies: CompanyDto[];
  members: MemberDto[];
  fieldDefs: CustomFieldDto[];
  canWrite: boolean;
  onDone: () => void;
}) {
  const form = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: {
      name: contact?.name ?? '',
      email: contact?.emails[0] ?? '',
      phone: contact?.phones[0] ?? '',
      companyId: contact?.companyId ?? '',
      ownerMembershipId: contact?.ownerMembershipId ?? '',
      source: contact?.source ?? '',
    },
  });
  const [tagIds, setTagIds] = useState<string[]>(contact?.tags.map((t) => t.id) ?? []);
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(
    contact?.customFields ?? {},
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (values: ContactFormValues) => {
      const payload = {
        name: values.name,
        emails: values.email ? [values.email] : [],
        phones: values.phone ? [values.phone] : [],
        companyId: values.companyId || null,
        ownerMembershipId: values.ownerMembershipId || null,
        source: values.source || null,
        tagIds,
        customFields: customValues,
      };
      return contact
        ? api.patch<ContactDto>(`/api/contacts/${contact.id}`, payload)
        : api.post<ContactDto>('/api/contacts', {
            ...payload,
            companyId: payload.companyId ?? undefined,
            ownerMembershipId: payload.ownerMembershipId ?? undefined,
            source: payload.source ?? undefined,
          });
    },
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao salvar'),
  });
  const archive = useMutation({
    mutationFn: () =>
      api.patch<ContactDto>(`/api/contacts/${contact!.id}`, {
        status: contact!.status === 'active' ? 'archived' : 'active',
      }),
    onSuccess: onDone,
  });
  const remove = useMutation({
    mutationFn: () => api.delete<{ ok: true }>(`/api/contacts/${contact!.id}`),
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
      <Field label="E-mail" error={form.formState.errors.email?.message}>
        <Input type="email" {...form.register('email')} disabled={!canWrite} />
      </Field>
      <Field label="Telefone" error={form.formState.errors.phone?.message}>
        <Input {...form.register('phone')} disabled={!canWrite} />
      </Field>
      <Field label="Empresa">
        <Select full {...form.register('companyId')} disabled={!canWrite}>
          <option value="">— sem empresa —</option>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </Select>
      </Field>
      {members.length > 0 ? (
        <Field label="Dono">
          <Select full {...form.register('ownerMembershipId')} disabled={!canWrite}>
            <option value="">— sem dono —</option>
            {members.map((member) => (
              <option key={member.membershipId} value={member.membershipId}>
                {member.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Origem">
        <Input {...form.register('source')} disabled={!canWrite} />
      </Field>

      {tags.length > 0 ? (
        <fieldset>
          <legend className="eyebrow mb-1.5 block text-muted-fg">Tags</legend>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
              const active = tagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  disabled={!canWrite}
                  aria-pressed={active}
                  onClick={() =>
                    setTagIds((ids) =>
                      active ? ids.filter((id) => id !== tag.id) : [...ids, tag.id],
                    )
                  }
                  className={active ? '' : 'opacity-40 hover:opacity-80'}
                >
                  <TagBadge name={tag.name} color={tag.color} />
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {fieldDefs.map((def) => (
        <CustomFieldInput
          key={def.id}
          def={def}
          value={customValues[def.key]}
          disabled={!canWrite}
          onChange={(value) => setCustomValues((v) => ({ ...v, [def.key]: value }))}
        />
      ))}

      {error ? (
        <p role="alert" className="text-body-sm text-negative">
          {error}
        </p>
      ) : null}

      {contact ? (
        <section className="border-t border-border pt-4">
          <h3 className="eyebrow mb-2.5 text-muted-fg">Histórico</h3>
          <Timeline contactId={contact.id} />
        </section>
      ) : null}

      {canWrite ? (
        <div className="flex items-center gap-2 border-t border-border pt-4">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? 'Salvando…' : 'Salvar'}
          </Button>
          {contact ? (
            <>
              <Button onClick={() => archive.mutate()} disabled={archive.isPending}>
                {contact.status === 'active' ? 'Arquivar' : 'Reativar'}
              </Button>
              <Button
                variant="danger"
                className="ml-auto"
                onClick={() => {
                  if (window.confirm('Excluir este contato definitivamente?')) remove.mutate();
                }}
                disabled={remove.isPending}
              >
                Excluir
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function CustomFieldInput({
  def,
  value,
  disabled,
  onChange,
}: {
  def: CustomFieldDto;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = def.required ? `${def.label} *` : def.label;
  switch (def.type) {
    case 'boolean':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </label>
      );
    case 'select':
      return (
        <Field label={label}>
          <Select
            full
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">—</option>
            {def.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      );
    case 'multiselect': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset>
          <legend className="eyebrow mb-1.5 block text-muted-fg">{label}</legend>
          <div className="flex flex-wrap gap-1.5">
            {def.options.map((option) => {
              const active = selected.includes(option);
              return (
                <button
                  key={option}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  onClick={() =>
                    onChange(active ? selected.filter((o) => o !== option) : [...selected, option])
                  }
                  className={active ? '' : 'opacity-40 hover:opacity-80'}
                >
                  <TagBadge name={option} color="info" />
                </button>
              );
            })}
          </div>
        </fieldset>
      );
    }
    case 'number':
      return (
        <Field label={label}>
          <Input
            type="number"
            value={typeof value === 'number' ? value : ''}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
      );
    case 'date':
      return (
        <Field label={label}>
          <Input
            type="date"
            value={typeof value === 'string' ? value.slice(0, 10) : ''}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value || null)}
          />
        </Field>
      );
    default:
      return (
        <Field label={label}>
          <Input
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value || null)}
          />
        </Field>
      );
  }
}
