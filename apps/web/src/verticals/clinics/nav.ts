import { ClipboardList } from 'lucide-react';
import { useMemo } from 'react';
import type { NavGroup } from '../../lib/nav';
import { useClinicsAccess } from './access';

export const CLINICS_CATALOG_PATH = '/clinics/catalog';

const NONE: readonly NavGroup[] = [];

/**
 * Contribuição do Clinics ao mapa de navegação (ADR-047 E5, adendo 4): o grupo
 * "Clínica" só existe com o vertical confirmado como ATIVO e a permissão da
 * seção. Carregando ou com erro, nada aparece.
 */
export function useClinicsNavGroups(): readonly NavGroup[] {
  const access = useClinicsAccess('clinics:catalog:read');
  return useMemo(
    () =>
      access !== 'ready'
        ? NONE
        : [
            {
              label: 'Clínica',
              items: [
                {
                  to: CLINICS_CATALOG_PATH,
                  label: 'Catálogo',
                  icon: ClipboardList,
                  permission: 'clinics:catalog:read',
                  aliases: ['clínica', 'serviços', 'profissionais', 'horários', 'unidade'],
                },
              ],
            },
          ],
    [access],
  );
}
