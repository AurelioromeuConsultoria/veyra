import { useQuery } from '@tanstack/react-query';
import type { ClinicsReturnAssigneeDto } from '@veyra/contracts/verticals/clinics';
import { useState } from 'react';
import { Field, Input, Select } from '../../components/ui/input';
import { PageHeader } from '../../components/ui/page';
import { api } from '../../lib/api';
import { hasPermission, useSession } from '../../lib/session';
import { PortaDaClinica, RETURNS_KEY } from './continuidade';
import { ListaDeRetornos, type FiltrosDeRetorno } from './retornos/ListaDeRetornos';

/**
 * Retornos da clínica (F3.3b; ADR-048 adendo 7). Da agenda: a recepção marca o
 * retorno. A criação à mão fica na ficha do paciente, onde ele já está
 * escolhido; daqui, o nome leva até a ficha.
 */
export function ClinicsReturnsPage() {
  return (
    <PortaDaClinica titulo="Retornos" recusa="Você não tem acesso aos retornos da clínica.">
      <RetornosReady />
    </PortaDaClinica>
  );
}

function RetornosReady() {
  const { data: user } = useSession();
  const podeAgir =
    hasPermission(user, 'clinics:schedule:write') || hasPermission(user, 'clinics:care:write');
  const [filtros, setFiltros] = useState<FiltrosDeRetorno>({ status: 'pending' });
  const mudar = (campo: keyof FiltrosDeRetorno, valor: string) =>
    setFiltros((f) => ({ ...f, [campo]: valor || undefined }));
  // o seletor de responsável é de quem age sobre retornos
  const responsaveis = useQuery({
    queryKey: [...RETURNS_KEY, 'assignees'],
    queryFn: () => api.get<ClinicsReturnAssigneeDto[]>('/api/clinics/returns/assignees'),
    enabled: podeAgir,
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader eyebrow="Clínica" title="Retornos" meta="Quem precisa voltar, e quando." />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Estado">
            <Select value={filtros.status ?? ''} onChange={(e) => mudar('status', e.target.value)}>
              <option value="">Todos</option>
              <option value="pending">Pendentes</option>
              <option value="done">Concluídos</option>
              <option value="canceled">Cancelados</option>
            </Select>
          </Field>
          <Field label="Vencimento">
            <Select
              value={filtros.overdue ?? ''}
              onChange={(e) => mudar('overdue', e.target.value)}
            >
              <option value="">Todos</option>
              <option value="true">Vencidos</option>
              <option value="false">Em dia</option>
            </Select>
          </Field>
          <Field label="Responsável">
            <Select
              value={filtros.assignee ?? ''}
              onChange={(e) => mudar('assignee', e.target.value)}
            >
              <option value="">Todos</option>
              <option value="none">Sem responsável</option>
              {(responsaveis.isError ? [] : (responsaveis.data ?? [])).map((c) => (
                <option key={c.membershipId} value={c.membershipId}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vence a partir de">
            <Input
              type="date"
              value={filtros.dueFrom ?? ''}
              onChange={(e) => mudar('dueFrom', e.target.value)}
            />
          </Field>
          <Field label="Vence até">
            <Input
              type="date"
              value={filtros.dueTo ?? ''}
              onChange={(e) => mudar('dueTo', e.target.value)}
            />
          </Field>
        </div>
        <ListaDeRetornos filtros={filtros} mostrarPaciente />
      </div>
    </div>
  );
}
