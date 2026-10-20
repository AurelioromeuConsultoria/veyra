import { ClipboardList, ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import type { NavGroup } from '../../lib/nav';
import { useClinicsStatus } from './access';

export const CLINICS_CATALOG_PATH = '/clinics/catalog';
export const CLINICS_AI_RELEASES_PATH = '/clinics/ai-releases';

const NONE: readonly NavGroup[] = [];

/**
 * Contribuição do Clinics ao mapa de navegação (ADR-047 E5, adendo 4): o grupo
 * "Clínica" só existe com o vertical confirmado como ATIVO. Carregando ou com
 * erro — inclusive uma RECARGA que falha depois de uma confirmação, quando o
 * TanStack Query mantém o dado anterior —, nada aparece. Cada item leva a
 * permissão da sua rota; o shell e a busca escondem o que a pessoa não pode
 * abrir (e o grupo, se nada sobrar).
 */
export function useClinicsNavGroups(): readonly NavGroup[] {
  const status = useClinicsStatus();
  const active = !status.isError && status.data?.active === true;
  return useMemo(
    () =>
      !active
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
                {
                  to: CLINICS_AI_RELEASES_PATH,
                  label: 'Liberação para IA',
                  icon: ShieldCheck,
                  permission: 'clinics:restriction:manage',
                  aliases: ['restrição', 'inteligência', 'fornecedor', 'parceiro'],
                },
              ],
            },
          ],
    [active],
  );
}
