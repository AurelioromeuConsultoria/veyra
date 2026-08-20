import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AuditEntryDto, AuditPageDto } from '@veyra/contracts';
import { useState } from 'react';
import { Select } from '../components/ui/input';
import { api, toQuery } from '../lib/api';

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'medium',
});

const entityLabels: Record<string, string> = {
  contact: 'Contato',
  company: 'Empresa',
  deal: 'Oportunidade',
  membership: 'Membro',
  webhook: 'Webhook',
};

/** Mostra só os campos que mudaram; "[changed]" indica campo fora da allowlist. */
function diff(entry: AuditEntryDto): string {
  const keys = new Set([...Object.keys(entry.before ?? {}), ...Object.keys(entry.after ?? {})]);
  const parts: string[] = [];
  for (const key of keys) {
    const before = entry.before?.[key];
    const after = entry.after?.[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    parts.push(`${key}: ${format(before)} → ${format(after)}`);
  }
  return parts.join(' · ') || '—';
}
function format(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function AuditPage() {
  const [entityType, setEntityType] = useState('');
  const params = { entityType: entityType || undefined, limit: 100 };

  const audit = useQuery({
    queryKey: ['audit', params],
    queryFn: () => api.get<AuditPageDto>(`/api/audit${toQuery(params)}`),
    placeholderData: keepPreviousData,
  });
  const items = audit.data?.items ?? [];

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="mr-auto">
          <h1 className="text-sm font-semibold">Auditoria</h1>
          <p className="text-xs text-muted-fg">
            Registro append-only de quem alterou o quê — só campos auditáveis.
          </p>
        </div>
        <Select
          className="h-8 w-auto"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          aria-label="Filtrar por entidade"
        >
          <option value="">Todas as entidades</option>
          {Object.entries(entityLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </header>

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="border-b border-border">
              {['Quando', 'Quem', 'Ação', 'Entidade', 'Mudança'].map((header) => (
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
            {items.map((entry) => (
              <tr key={entry.id} className="border-b border-border/60">
                <td className="whitespace-nowrap px-5 py-1.5 font-mono text-xs tabular-nums text-muted-fg">
                  {dateTimeFormat.format(new Date(entry.createdAt))}
                </td>
                <td className="px-5 py-1.5">
                  {entry.actorLabel ?? '—'}
                  {entry.actorType !== 'user' ? (
                    <span className="ml-1 text-[11px] text-muted-fg">({entry.actorType})</span>
                  ) : null}
                </td>
                <td className="px-5 py-1.5 font-mono text-xs">{entry.action}</td>
                <td className="px-5 py-1.5">
                  {entityLabels[entry.entityType] ?? entry.entityType}
                </td>
                <td className="max-w-md truncate px-5 py-1.5 text-muted-fg" title={diff(entry)}>
                  {diff(entry)}
                </td>
              </tr>
            ))}
            {audit.data && items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-16 text-center text-sm text-muted-fg">
                  Nenhum registro no período.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
