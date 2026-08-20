/**
 * Modelos protegidos por workspace: toda query recebe `where workspaceId` e
 * todo create é carimbado automaticamente pelo client extension (SECURITY.md §2).
 *
 * FICAM FORA (com justificativa — acesso EXCLUSIVAMENTE via prisma.raw
 * comentado; o client `db` REJEITA operações neles, fail-closed):
 * - User, RefreshToken: identidade GLOBAL (ADR-003) — login exige lookup por email.
 * - Workspace: a raiz do tenant; services acessam via raw com workspaceId do CLS.
 * - Permission: catálogo global do sistema (ADR-004), não é dado de tenant.
 *
 * REGRA: toda entidade de domínio nova entra aqui no MESMO commit do model.
 * O teste de drift (workspace-models.spec.ts) compara este set com o
 * schema.prisma — modelo com workspaceId fora do set = build vermelho.
 */
export const WORKSPACE_MODELS = new Set<string>([
  // Dados de acesso por workspace (ajuste aprovado: tenant-scoped, nunca via raw)
  'Role',
  'RolePermission',
  'Membership',
  'Invite',
  // CRM: relacionamento (Entrega 3)
  'Company',
  'Contact',
  'Tag',
  'ContactTag',
  'CompanyTag',
  'CustomFieldDefinition',
  'CustomFieldValue',
]);

/**
 * Mapa campo-de-relação → modelo alvo, para os modelos protegidos. Usado pelo
 * client extension para barrar travessias (`include`/`select`/`where`/`orderBy`/
 * `data`) que saem do perímetro protegido — o hook do Prisma só intercepta a
 * operação de topo, então relações aninhadas precisam ser validadas aqui.
 *
 * Mantido à mão e verificado contra o schema.prisma pelo teste de drift:
 * relação nova sem entrada aqui = build vermelho.
 */
export const RELATION_TARGETS: Record<string, Record<string, string>> = {
  Role: {
    workspace: 'Workspace',
    permissions: 'RolePermission',
    memberships: 'Membership',
    invites: 'Invite',
  },
  RolePermission: {
    role: 'Role',
    permission: 'Permission',
  },
  Membership: {
    workspace: 'Workspace',
    user: 'User',
    role: 'Role',
    ownedCompanies: 'Company',
    ownedContacts: 'Contact',
    // alvo fora do perímetro: travessia via db é bloqueada (sessões só via raw)
    activeSessions: 'RefreshToken',
  },
  Invite: {
    workspace: 'Workspace',
    role: 'Role',
  },
  Company: {
    workspace: 'Workspace',
    owner: 'Membership',
    contacts: 'Contact',
    tags: 'CompanyTag',
  },
  Contact: {
    workspace: 'Workspace',
    company: 'Company',
    owner: 'Membership',
    tags: 'ContactTag',
  },
  Tag: {
    workspace: 'Workspace',
    contactTags: 'ContactTag',
    companyTags: 'CompanyTag',
  },
  ContactTag: {
    contact: 'Contact',
    tag: 'Tag',
  },
  CompanyTag: {
    company: 'Company',
    tag: 'Tag',
  },
  CustomFieldDefinition: {
    workspace: 'Workspace',
    values: 'CustomFieldValue',
  },
  CustomFieldValue: {
    definition: 'CustomFieldDefinition',
  },
};
