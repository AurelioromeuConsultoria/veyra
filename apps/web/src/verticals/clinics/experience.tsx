import { ClipboardList, ShieldCheck } from 'lucide-react';
import { buscaDeContatos } from '../../experiences/busca-de-contatos';
import { rotasDoCore } from '../../experiences/core-routes';
import { SECOES_DO_CORE } from '../../experiences/crm';
import type { ExperienceManifest } from '../../lib/experience';
import { NAV_GROUPS, type NavItem } from '../../lib/nav';
import { hasPermission } from '../../lib/session';
import { clinicsRoutes } from './index';
import {
  CLINICS_AGENDA_PATH,
  CLINICS_AI_RELEASES_PATH,
  CLINICS_CATALOG_PATH,
  CLINICS_NAV_GROUP,
} from './nav';

/** Um item do menu do CRM, pelo caminho — a mesma tela do Core, sem cópia. */
function doCore(to: string): NavItem {
  const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.to === to);
  if (!item) throw new Error(`Seção do Core inexistente: ${to}`);
  return item;
}

/**
 * A experiência `clinics` na E-2 do ADR-055: PROVISÓRIA e NÃO selecionável pela
 * operação (adendo 2, item 9). Monta só as telas que já existem — as do Clinics
 * e as do Core de que os fluxos atuais dependem (Contatos, para o
 * consentimento; Inbox; Pipeline, para o vínculo da F4.3) —, com a Agenda da
 * clínica como início provisório e os nomes de hoje. Sem o Hoje do CRM,
 * Empresas, a Agenda genérica, Tarefas, Sinais e Automações. A E-3 traz o Hoje
 * da clínica, os Interessados, o menu aprovado e a linguagem.
 */
export const clinicsExperience: ExperienceManifest = {
  key: 'clinics',
  produto: 'Veyra Clinics',
  marca: 'veyra clinics',
  inicio: CLINICS_AGENDA_PATH,
  grupos: [
    CLINICS_NAV_GROUP,
    {
      label: 'Atendimento',
      items: [doCore('/contacts'), doCore('/inbox'), doCore('/pipeline')],
    },
    {
      label: 'Configuração',
      items: [
        doCore('/settings/team'),
        doCore('/tags'),
        doCore('/settings/fields'),
        doCore('/settings/webhooks'),
        doCore('/settings/usage'),
        doCore('/audit'),
      ],
    },
  ],
  rotas: [
    ...clinicsRoutes,
    ...rotasDoCore(
      'contatos',
      'inbox',
      'pipeline',
      'tags',
      'campos',
      'webhooks',
      'uso',
      'auditoria',
      'equipe',
      'configuracoes',
    ),
  ],
  configuracoes: [
    {
      to: CLINICS_CATALOG_PATH,
      label: 'Catálogo',
      description: 'Unidade, serviços, profissionais e horários.',
      icon: ClipboardList,
      permission: 'clinics:catalog:read',
    },
    {
      to: CLINICS_AI_RELEASES_PATH,
      label: 'Liberação para IA',
      description: 'Contatos liberados para o uso de IA, sem relação com a clínica.',
      icon: ShieldCheck,
      permission: 'clinics:restriction:manage',
    },
    SECOES_DO_CORE.equipe,
    SECOES_DO_CORE.tags,
    SECOES_DO_CORE.campos,
    SECOES_DO_CORE.webhooks,
    SECOES_DO_CORE.uso,
    SECOES_DO_CORE.auditoria,
  ],
  links: {
    contato: (id, user) => (hasPermission(user, 'contacts:read') ? `/contacts?c=${id}` : null),
  },
  busca: buscaDeContatos((id) => `/contacts?c=${id}`),
};
