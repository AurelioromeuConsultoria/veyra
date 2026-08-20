/**
 * Catálogo GLOBAL de permissões (ADR-004): chaves estáveis do sistema.
 * O código autoriza por chave (@RequirePermissions), nunca por nome de role.
 * Renomear/remover uma chave exige migração dos RolePermission existentes.
 */
export const PERMISSION_CATALOG = {
  'workspace:read': 'Ver dados do workspace (nome, configurações)',
  'workspace:manage': 'Editar configurações do workspace',
  'members:read': 'Ver membros e equipes',
  'members:manage': 'Convidar, remover e alterar membros e equipes',
  'roles:manage': 'Criar e editar papéis customizados e suas permissões',
  'contacts:read': 'Ver contatos e empresas',
  'contacts:write': 'Criar e editar contatos e empresas',
  'pipelines:read': 'Ver pipelines e oportunidades',
  'pipelines:manage': 'Criar e editar pipelines e estágios',
  'deals:write': 'Criar, editar e mover oportunidades',
  'tasks:read': 'Ver tarefas e notas',
  'tasks:write': 'Criar e editar tarefas e notas',
  'conversations:read': 'Ver conversas e mensagens',
  'conversations:write': 'Enviar mensagens e gerir conversas',
  'calendar:read': 'Ver agenda',
  'calendar:write': 'Criar e editar eventos de agenda',
  'files:read': 'Baixar arquivos',
  'files:write': 'Enviar e remover arquivos',
  'automations:manage': 'Criar e editar automações',
  'webhooks:manage': 'Configurar webhooks e integrações',
  'audit:read': 'Ver trilha de auditoria',
  'billing:manage': 'Gerir plano, assinatura e limites',
  'intelligence:use': 'Usar capacidades de IA (leitura, sinais, insights)',
  'intelligence:approve': 'Aprovar ações externas propostas pela IA',
} as const;

export type PermissionKey = keyof typeof PERMISSION_CATALOG;

export const PERMISSION_KEYS: readonly PermissionKey[] = Object.freeze(
  Object.keys(PERMISSION_CATALOG) as PermissionKey[],
);

/**
 * Templates dos roles de sistema, semeados POR WORKSPACE no provisionamento
 * (Entrega 2) com isSystem=true. Não existe Role global (ADR-004).
 * Arrays novos por template (nunca a MESMA referência de PERMISSION_KEYS):
 * mutação acidental num consumidor não pode alterar as permissões do Owner.
 */
export const SYSTEM_ROLE_TEMPLATES: Record<string, readonly PermissionKey[]> = {
  Owner: [...PERMISSION_KEYS],
  Admin: PERMISSION_KEYS.filter((k) => k !== 'billing:manage'),
  Member: [
    'workspace:read',
    'members:read',
    'contacts:read',
    'contacts:write',
    'pipelines:read',
    'deals:write',
    'tasks:read',
    'tasks:write',
    'conversations:read',
    'conversations:write',
    'calendar:read',
    'calendar:write',
    'files:read',
    'files:write',
    'intelligence:use',
  ],
  Guest: [
    'workspace:read',
    'contacts:read',
    'pipelines:read',
    'tasks:read',
    'conversations:read',
    'calendar:read',
    'files:read',
  ],
};
