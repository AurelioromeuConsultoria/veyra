import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClinicsUnitDto } from '@veyra/contracts/verticals/clinics';
import { useMemo, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Field, Input, Select } from '../../../components/ui/input';
import { Panel } from '../../../components/ui/page';
import { api, ApiError } from '../../../lib/api';
import { hasPermission, useSession } from '../../../lib/session';

/**
 * A unidade (no MVP, uma só): nome e fuso. A lista de fusos é a do navegador,
 * que pode divergir da do servidor — quem decide é o servidor, e o 400 dele
 * aparece aqui (ADR-048 adendo 1, item 15).
 */
export const UNITS_KEY = ['clinics', 'catalog', 'units'] as const;

export function UnitTab() {
  const units = useQuery({
    queryKey: UNITS_KEY,
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
  });
  if (units.isError) {
    return (
      <p role="alert" className="text-data text-negative">
        Não foi possível carregar a unidade.{' '}
        {units.error instanceof ApiError ? units.error.message : 'Tente de novo em instantes.'}
      </p>
    );
  }
  if (!units.data) return <p className="text-body-sm text-muted-fg">Carregando…</p>;
  const unit = units.data[0];
  if (!unit) return <p className="text-body-sm text-muted-fg">Nenhuma unidade ativa.</p>;
  return <UnitForm key={unit.id} unit={unit} />;
}

function UnitForm({ unit }: { unit: ClinicsUnitDto }) {
  const { data: user } = useSession();
  const canManage = hasPermission(user, 'clinics:catalog:manage');
  const queryClient = useQueryClient();
  const [name, setName] = useState(unit.name);
  const [timezone, setTimezone] = useState(unit.timezone);
  const fusos = useMemo(() => {
    const lista = Intl.supportedValuesOf('timeZone');
    return lista.includes(unit.timezone) ? lista : [unit.timezone, ...lista];
  }, [unit.timezone]);
  const save = useMutation({
    mutationFn: () =>
      api.patch<ClinicsUnitDto>(`/api/clinics/units/${unit.id}`, { name, timezone }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: UNITS_KEY }),
  });

  if (!canManage) {
    return (
      <Panel>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 p-4 text-body-sm">
          <dt className="text-muted-fg">Unidade</dt>
          <dd>{unit.name}</dd>
          <dt className="text-muted-fg">Fuso horário</dt>
          <dd className="text-data">{unit.timezone}</dd>
        </dl>
      </Panel>
    );
  }
  return (
    <Panel>
      <form
        className="max-w-md space-y-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Nome da unidade">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Fuso horário" hint="Os horários de atendimento usam a hora local da unidade.">
          <Select full value={timezone} onChange={(event) => setTimezone(event.target.value)}>
            {fusos.map((fuso) => (
              <option key={fuso} value={fuso}>
                {fuso}
              </option>
            ))}
          </Select>
        </Field>
        {save.error ? (
          <p role="alert" className="text-data text-negative">
            {save.error instanceof ApiError ? save.error.message : 'Não foi possível salvar.'}
          </p>
        ) : null}
        {save.isSuccess ? (
          <p role="status" className="text-data text-positive">
            Unidade salva.
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? 'Salvando…' : 'Salvar unidade'}
        </Button>
      </form>
    </Panel>
  );
}
