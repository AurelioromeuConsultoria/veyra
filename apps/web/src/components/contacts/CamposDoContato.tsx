import type { CustomFieldDto, TagDto } from '@veyra/contracts';
import { Field, Input, Select } from '../ui/input';
import { TagBadge } from '../ui/tag-badge';

/**
 * As etiquetas e os campos personalizados do CONTATO, compartilhados pela
 * página de Contatos (CRM) e pela pessoa da clínica (ADR-055, adendo 5): os
 * mesmos componentes, sobre as mesmas definições do Core.
 */
export function SeletorDeEtiquetas({
  titulo = 'Tags',
  tags,
  selecionadas,
  disabled,
  onChange,
}: {
  /** a legenda: "Tags" no CRM, "Etiquetas" na clínica */
  titulo?: string;
  tags: TagDto[];
  selecionadas: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  if (tags.length === 0) return null;
  return (
    <fieldset>
      <legend className="eyebrow mb-1.5 block text-muted-fg">{titulo}</legend>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => {
          const active = selecionadas.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() =>
                onChange(
                  active ? selecionadas.filter((id) => id !== tag.id) : [...selecionadas, tag.id],
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
  );
}

/** Um campo personalizado, pelo tipo da definição; o obrigatório leva "*". */
export function CustomFieldInput({
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
