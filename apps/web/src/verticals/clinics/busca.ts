import { useQuery } from '@tanstack/react-query';
import type { ClinicsLeadsPageDto, ClinicsPatientDto } from '@veyra/contracts/verticals/clinics';
import { api, toQuery } from '../../lib/api';
import type { SearchProvider } from '../../lib/experience';
import { fichaDoPaciente, pessoaDoContato } from './nav';

const MAXIMO = 6;

/**
 * A busca da clínica (ADR-055, adendos 3 e 4): pacientes e interessados, cada
 * um com o seu rótulo e o seu destino, e cada um só com TODAS as chaves da sua
 * rota — quem não consulta pacientes não vê nenhum dos dois, e o vínculo nunca
 * se revela por aqui.
 */
export const buscaDePacientes: SearchProvider = {
  label: 'Pacientes',
  singular: 'paciente',
  // o destino é a ficha, que exige também o catálogo
  permission: 'clinics:schedule:read',
  permissions: ['clinics:catalog:read'],
  useResultados(termo, ativo) {
    const pacientes = useQuery({
      queryKey: ['global-search', 'clinics-patients', termo],
      queryFn: () =>
        api.get<ClinicsPatientDto[]>(
          `/api/clinics/patients${toQuery({ search: termo, limit: MAXIMO })}`,
        ),
      enabled: ativo,
      staleTime: 30_000,
    });
    return {
      resultados: (pacientes.data ?? []).map((p) => ({
        id: `patient:${p.id}`,
        to: fichaDoPaciente(p.id),
        label: p.name,
        hint: 'Paciente',
      })),
      buscando: ativo && pacientes.isFetching,
    };
  },
};

export const buscaDeInteressados: SearchProvider = {
  label: 'Interessados',
  singular: 'interessado',
  permission: 'contacts:read',
  permissions: ['clinics:schedule:read'],
  useResultados(termo, ativo) {
    const interessados = useQuery({
      queryKey: ['global-search', 'clinics-leads', termo],
      queryFn: () =>
        api.get<ClinicsLeadsPageDto>(
          `/api/clinics/leads${toQuery({ search: termo, limit: MAXIMO })}`,
        ),
      enabled: ativo,
      staleTime: 30_000,
    });
    return {
      resultados: (interessados.data?.items ?? []).map((i) => ({
        id: `lead:${i.id}`,
        to: pessoaDoContato(i.id),
        label: i.name,
        hint: 'Interessado',
      })),
      buscando: ativo && interessados.isFetching,
    };
  },
};
