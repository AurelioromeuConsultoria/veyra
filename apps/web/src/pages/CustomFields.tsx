import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CustomFieldDto } from '@veyra/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '../components/ui/button';
import { Drawer } from '../components/ui/drawer';
import { Field, Input, Select } from '../components/ui/input';
import { api, ApiError } from '../lib/api';
import { hasPermission, useSession } from '../lib/session';

// Schema do FORM (standalone: o contrato tem superRefine, que impede .omit em
// runtime). A validação de negócio (options × type) é do backend; aqui só shape.
const fieldFormSchema = z.object({
  entityType: z.enum(['contact', 'company']),
  key: z
    .string()
    .trim()
    .min(1, 'Informe a chave')
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use snake_case: comece com letra, só a-z, 0-9 e _'),
  label: z.string().trim().min(1, 'Informe o rótulo').max(80),
  type: z.enum(['text', 'number', 'date', 'boolean', 'select', 'multiselect']),
  optionsText: z.string().trim().max(2000),
  required: z.boolean(),
});
type FieldFormValues = z.infer<typeof fieldFormSchema>;

const typeLabels: Record<string, string> = {
  text: 'Texto',
  number: 'Número',
  date: 'Data',
  boolean: 'Sim/Não',
  select: 'Seleção',
  multiselect: 'Seleção múltipla',
};

export function CustomFieldsPage() {
  const { data: user } = useSession();
  const canManage = hasPermission(user, 'workspace:manage');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const fields = useQuery({
    queryKey: ['custom-fields', 'all'],
    queryFn: () => api.get<CustomFieldDto[]>('/api/custom-fields'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/custom-fields/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['custom-fields'] }),
  });

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="mr-auto">
          <h1 className="text-sm font-semibold">Campos personalizados</h1>
          <p className="text-xs text-muted-fg">
            Estenda contatos e empresas sem tocar no modelo — a base dos verticais.
          </p>
        </div>
        {canManage ? (
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            <Plus size={14} /> Novo campo
          </Button>
        ) : null}
      </header>

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="border-b border-border">
              {['Entidade', 'Chave', 'Rótulo', 'Tipo', 'Obrigatório', 'Opções', ''].map(
                (header, index) => (
                  <th
                    key={`${header}-${index}`}
                    className="px-5 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-fg"
                  >
                    {header}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {(fields.data ?? []).map((field) => (
              <tr key={field.id} className="border-b border-border/60">
                <td className="px-5 py-1.5">
                  {field.entityType === 'contact' ? 'Contato' : 'Empresa'}
                </td>
                <td className="px-5 py-1.5 font-mono text-xs">{field.key}</td>
                <td className="px-5 py-1.5">{field.label}</td>
                <td className="px-5 py-1.5">{typeLabels[field.type]}</td>
                <td className="px-5 py-1.5">{field.required ? 'Sim' : '—'}</td>
                <td className="max-w-xs truncate px-5 py-1.5 text-muted-fg">
                  {field.options.join(', ') || '—'}
                </td>
                <td className="px-5 py-1.5 text-right">
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Excluir campo ${field.label}`}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Excluir "${field.label}"? Os valores gravados serão apagados.`,
                          )
                        )
                          remove.mutate(field.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
            {fields.data && fields.data.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-16 text-center text-sm text-muted-fg">
                  Nenhum campo personalizado ainda.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Drawer open={open} onOpenChange={setOpen} title="Novo campo personalizado">
        <FieldForm
          onDone={() => {
            setOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['custom-fields'] });
          }}
        />
      </Drawer>
    </div>
  );
}

function FieldForm({ onDone }: { onDone: () => void }) {
  const form = useForm<FieldFormValues>({
    resolver: zodResolver(fieldFormSchema),
    defaultValues: {
      entityType: 'contact',
      key: '',
      label: '',
      type: 'text',
      required: false,
      optionsText: '',
    },
  });
  const [error, setError] = useState<string | null>(null);
  const type = form.watch('type');
  const needsOptions = type === 'select' || type === 'multiselect';

  const save = useMutation({
    mutationFn: (values: FieldFormValues) =>
      api.post<CustomFieldDto>('/api/custom-fields', {
        entityType: values.entityType,
        key: values.key,
        label: values.label,
        type: values.type,
        required: values.required,
        options: needsOptions
          ? values.optionsText
              .split(',')
              .map((option: string) => option.trim())
              .filter(Boolean)
          : undefined,
      }),
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao criar'),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={form.handleSubmit((values) => save.mutate(values))}
      noValidate
    >
      <Field label="Entidade">
        <Select {...form.register('entityType')}>
          <option value="contact">Contato</option>
          <option value="company">Empresa</option>
        </Select>
      </Field>
      <Field label="Chave (snake_case, imutável)" error={form.formState.errors.key?.message}>
        <Input placeholder="convenio_medico" {...form.register('key')} />
      </Field>
      <Field label="Rótulo" error={form.formState.errors.label?.message}>
        <Input {...form.register('label')} />
      </Field>
      <Field label="Tipo">
        <Select {...form.register('type')}>
          {Object.entries(typeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      {needsOptions ? (
        <Field label="Opções (separadas por vírgula)">
          <Input placeholder="indicação, evento, site" {...form.register('optionsText')} />
        </Field>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" {...form.register('required')} /> Obrigatório
      </label>
      {error ? (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      ) : null}
      <div className="border-t border-border pt-4">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? 'Criando…' : 'Criar campo'}
        </Button>
      </div>
    </form>
  );
}
