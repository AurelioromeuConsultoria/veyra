import { Gauge, ScrollText, Settings2, Tags, UserCog, Webhook, Workflow } from 'lucide-react';
import type { ExperienceManifest, SettingsSection } from '../lib/experience';
import { NAV_GROUPS } from '../lib/nav';
import { hasPermission } from '../lib/session';
import { buscaDeContatos } from './busca-de-contatos';
import { rotasDoCore } from './core-routes';

/** As seções de configuração do Core, que os produtos escolhem. */
export const SECOES_DO_CORE = {
  equipe: {
    to: '/settings/team',
    label: 'Equipe',
    description: 'Membros, papéis, convites e o acesso de cada pessoa.',
    icon: UserCog,
    permission: 'members:read',
  },
  tags: {
    to: '/tags',
    label: 'Tags',
    description: 'As etiquetas que organizam os contatos.',
    icon: Tags,
    permission: 'contacts:read',
  },
  campos: {
    to: '/settings/fields',
    label: 'Campos',
    description: 'Os campos customizados dos contatos.',
    icon: Settings2,
    permission: 'contacts:read',
  },
  automacoes: {
    to: '/settings/automations',
    label: 'Automações',
    description: 'Regras que agem quando algo acontece.',
    icon: Workflow,
    permission: 'automations:manage',
  },
  webhooks: {
    to: '/settings/webhooks',
    label: 'Webhooks',
    description: 'Integrações que recebem os eventos do workspace.',
    icon: Webhook,
    permission: 'webhooks:manage',
  },
  uso: {
    to: '/settings/usage',
    label: 'Uso e plano',
    description: 'O plano aplicado, o consumo e os limites.',
    icon: Gauge,
    permission: 'workspace:read',
  },
  auditoria: {
    to: '/audit',
    label: 'Auditoria',
    description: 'A trilha de quem alterou o quê.',
    icon: ScrollText,
    permission: 'audit:read',
  },
} satisfies Record<string, SettingsSection>;

/**
 * A experiência `crm`, do Core (ADR-055): o produto como sempre foi — o mesmo
 * menu, as mesmas telas, o Hoje como início. A página de configurações reúne
 * as seções que o menu já mostra.
 */
export const crmExperience: ExperienceManifest = {
  key: 'crm',
  produto: 'Veyra',
  marca: 'veyra',
  inicio: '/',
  grupos: NAV_GROUPS,
  rotas: rotasDoCore(
    'hoje',
    'pipeline',
    'contatos',
    'empresas',
    'inbox',
    'agenda',
    'sinais',
    'tarefas',
    'tags',
    'campos',
    'automacoes',
    'webhooks',
    'uso',
    'auditoria',
    'equipe',
    'configuracoes',
  ),
  configuracoes: [
    SECOES_DO_CORE.equipe,
    SECOES_DO_CORE.tags,
    SECOES_DO_CORE.campos,
    SECOES_DO_CORE.automacoes,
    SECOES_DO_CORE.webhooks,
    SECOES_DO_CORE.uso,
    SECOES_DO_CORE.auditoria,
  ],
  links: {
    contato: (id, user) => (hasPermission(user, 'contacts:read') ? `/contacts?c=${id}` : null),
  },
  busca: buscaDeContatos((id) => `/contacts?c=${id}`),
};
