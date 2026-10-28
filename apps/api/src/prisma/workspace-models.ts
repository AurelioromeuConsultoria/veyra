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
 * REGRA: toda entidade de domínio nova do CORE entra aqui no MESMO commit do
 * model; entidade de vertical entra pela composição (ADR-047, E1). O teste de
 * drift compara o registro COMPOSTO com todos os arquivos de `prisma/schema/`.
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
  // CRM: vendas e trabalho (Entrega 4)
  'Pipeline',
  'Stage',
  'Deal',
  'Task',
  'Note',
  'Activity',
  'AuditLog',
  // Plataforma de confiança (Entrega 5)
  'IdempotencyKey',
  'OutboxEvent',
  'Webhook',
  'WebhookDelivery',
  // Comunicação (Entrega 6.1)
  'Channel',
  'Conversation',
  'Message',
  // Organização (Entrega 6.2)
  'CalendarEvent',
  'Notification',
  // Arquivos (Entrega 6.3)
  'FileObject',
  'MessageAttachment',
  // Inteligência (Entrega 7). PromptVersion NÃO entra: é catálogo global de
  // prompts, como Permission — exceção documentada (ADR-004/ADR-029).
  'AiRun',
  'AiProposal',
  'AiConsent',
  // Billing e uso (Entrega 8.1). Plan/PlanLimit NÃO entram: catálogo global
  // (ADR-034), como Permission e PromptVersion.
  'Subscription',
  'UsageCounter',
  'UsageReservation',
  // Usos externos de conteúdo de contato (ADR-047, adendos 6 e 7)
  'ContentUse',
  // Automações (Entrega 8.2)
  'Automation',
  'AutomationExecution',
  // Canal externo: WhatsApp (Entrega 9.1)
  'ChannelCredential',
  'ContactChannelConsent',
  'MessageDispatch',
  'MessageStatusEvent',
  'InboundMedia',
  'MessageTemplate',
  // Finalidades, consentimentos e o pedido de parar (F4.1b, ADR-052 item 5)
  'ConsentPurpose',
  'Consent',
  'StopBlock',
  'ConsentReceiptCounter',
  'PermissionBackfill',
  // Templates versionados e revisados (F4.1c-2, ADR-052 item 4)
  'MessageTemplateVersion',
  'TemplateReview',
  // O envio iniciado pelo negócio: o pedido aprovado (F4.1c-3, ADR-052 item 8)
  'OutboundApproval',
]);

/**
 * Modelos GLOBAIS do Core (fora do perímetro, acesso só por `raw` justificado).
 * Listados para que nenhuma extensão os reivindique como seus (ADR-047, E1):
 * pôr `User` dentro do perímetro liberaria a travessia `membership → user →
 * memberships` entre workspaces. O teste de drift garante que todo modelo do
 * arquivo de schema do Core está aqui ou em `WORKSPACE_MODELS`.
 */
export const CORE_GLOBAL_MODELS = new Set<string>([
  'User',
  'RefreshToken',
  'Workspace',
  'Permission',
  'PromptVersion',
  'Plan',
  'PlanLimit',
]);

/**
 * Modelos APPEND-ONLY: histórico que não se reescreve (ADR-011 e SECURITY.md §5).
 * O client protegido BLOQUEIA update/updateMany/delete/deleteMany/upsert neles —
 * "append-only" deixa de ser convenção e vira invariante técnica. A exclusão
 * legítima acontece só por cascade do dono (LGPD) ou pelo job de retenção, que
 * usa `raw` com justificativa.
 */
export const APPEND_ONLY_MODELS = new Set<string>([
  'Activity',
  'AuditLog',
  'Message',
  // F4.1b: a finalidade é imutável (versão nova é linha nova), e o livro do
  // preenchimento só é escrito pela migration
  'ConsentPurpose',
  'PermissionBackfill',
  // F4.1c-2: a revisão de template é um ato registrado, e não se reescreve
  'TemplateReview',
  // F4.1c-3: o que a pessoa aprovou não muda depois (o gatilho vale para o raw)
  'OutboundApproval',
]);

/**
 * Modelos em que o registro é imutável e só o DESFECHO se preenche (F4.1b,
 * ADR-052 item 5): a revogação do consentimento e o desbloqueio do pedido de
 * parar.
 *
 * - `desfecho`: os únicos campos que o `updateMany` aceita; na criação, são
 *   recusados — o registro nasce ativo;
 * - `doBanco`: os instantes, que o gatilho grava pelo relógio do banco depois
 *   das travas (ADR-049); recusados na criação e no desfecho.
 *
 * `update`, `delete*` e `upsert` ficam proibidos; a exclusão vem só pela
 * cascata. O gatilho e o CHECK de coerência garantem o mesmo no banco.
 */
export const OUTCOME_ONLY_MODELS: Readonly<
  Record<string, { readonly desfecho: readonly string[]; readonly doBanco: readonly string[] }>
> = {
  Consent: {
    desfecho: ['revokedByMembershipId', 'revocationReason', 'revocationOrigin', 'activeMark'],
    doBanco: ['grantedAt', 'revokedAt'],
  },
  StopBlock: {
    desfecho: ['liftedByMembershipId', 'liftOrigin', 'liftReceipt', 'activeMark'],
    doBanco: ['createdAt', 'liftedAt'],
  },
  // F4.1c-2: o conteúdo da versão é imutável; só o status vai a `divergent`
  MessageTemplateVersion: {
    desfecho: ['status'],
    doBanco: ['createdAt'],
  },
};

/**
 * Mapa campo-de-relação → modelo alvo, para os modelos protegidos. Usado pelo
 * client extension para barrar travessias (`include`/`select`/`where`/`orderBy`/
 * `data`) que saem do perímetro protegido — o hook do Prisma só intercepta a
 * operação de topo, então relações aninhadas precisam ser validadas aqui.
 *
 * Mantido à mão e verificado contra o schema pelo teste de drift:
 * relação nova sem entrada aqui = build vermelho.
 */
export const RELATION_TARGETS: Record<string, Record<string, string>> = {
  Role: {
    workspace: 'Workspace',
    permissions: 'RolePermission',
    memberships: 'Membership',
    invites: 'Invite',
    backfills: 'PermissionBackfill',
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
    ownedDeals: 'Deal',
    assignedTasks: 'Task',
    authoredNotes: 'Note',
    activities: 'Activity',
    auditLogs: 'AuditLog',
    assignedConversations: 'Conversation',
    authoredMessages: 'Message',
    organizedEvents: 'CalendarEvent',
    notifications: 'Notification',
    uploadedFiles: 'FileObject',
    aiRuns: 'AiRun',
    reviewedProposals: 'AiProposal',
    consentChanges: 'AiConsent',
    grantedConsents: 'ContactChannelConsent',
    purposeConsentsGranted: 'Consent',
    purposeConsentsRevoked: 'Consent',
    stopBlocksCreated: 'StopBlock',
    stopBlocksLifted: 'StopBlock',
    templateReviews: 'TemplateReview',
    outboundApprovals: 'OutboundApproval',
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
    deals: 'Deal',
    notes: 'Note',
    activities: 'Activity',
  },
  Contact: {
    workspace: 'Workspace',
    company: 'Company',
    owner: 'Membership',
    tags: 'ContactTag',
    deals: 'Deal',
    tasksList: 'Task',
    notes: 'Note',
    activities: 'Activity',
    conversations: 'Conversation',
    messages: 'Message',
    calendarEvents: 'CalendarEvent',
    aiProposals: 'AiProposal',
    aiRuns: 'AiRun',
    contactChannelConsents: 'ContactChannelConsent',
    consents: 'Consent',
    outboundApprovals: 'OutboundApproval',
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
  Pipeline: {
    workspace: 'Workspace',
    stages: 'Stage',
    deals: 'Deal',
  },
  Stage: {
    pipeline: 'Pipeline',
    deals: 'Deal',
  },
  Deal: {
    workspace: 'Workspace',
    aiProposals: 'AiProposal',
    calendarEvents: 'CalendarEvent',
    pipeline: 'Pipeline',
    stage: 'Stage',
    contact: 'Contact',
    company: 'Company',
    owner: 'Membership',
    tasks: 'Task',
    notes: 'Note',
    activities: 'Activity',
  },
  Task: {
    workspace: 'Workspace',
    assignee: 'Membership',
    contact: 'Contact',
    deal: 'Deal',
    activities: 'Activity',
  },
  Note: {
    workspace: 'Workspace',
    author: 'Membership',
    contact: 'Contact',
    company: 'Company',
    deal: 'Deal',
  },
  AuditLog: {
    workspace: 'Workspace',
    actor: 'Membership',
  },
  IdempotencyKey: {
    workspace: 'Workspace',
  },
  OutboxEvent: {
    workspace: 'Workspace',
    deliveries: 'WebhookDelivery',
    originAutomation: 'Automation',
    chain: 'OutboxEvent',
    chainedEvents: 'OutboxEvent',
    executions: 'AutomationExecution',
  },
  Automation: {
    workspace: 'Workspace',
    executions: 'AutomationExecution',
    originatedEvents: 'OutboxEvent',
  },
  AutomationExecution: {
    workspace: 'Workspace',
    automation: 'Automation',
    outboxEvent: 'OutboxEvent',
  },
  ChannelCredential: {
    workspace: 'Workspace',
    channel: 'Channel',
  },
  MessageTemplate: {
    workspace: 'Workspace',
    channel: 'Channel',
  },
  ContactChannelConsent: {
    workspace: 'Workspace',
    contact: 'Contact',
    grantedBy: 'Membership',
  },
  ConsentPurpose: {
    workspace: 'Workspace',
    consents: 'Consent',
    templateReviews: 'TemplateReview',
    outboundApprovals: 'OutboundApproval',
  },
  MessageTemplateVersion: {
    workspace: 'Workspace',
    channel: 'Channel',
    reviews: 'TemplateReview',
    approvals: 'OutboundApproval',
  },
  TemplateReview: {
    workspace: 'Workspace',
    templateVersion: 'MessageTemplateVersion',
    purpose: 'ConsentPurpose',
    reviewedBy: 'Membership',
    approvals: 'OutboundApproval',
  },
  Consent: {
    workspace: 'Workspace',
    contact: 'Contact',
    channel: 'Channel',
    purpose: 'ConsentPurpose',
    grantedBy: 'Membership',
    revokedBy: 'Membership',
    approvals: 'OutboundApproval',
  },
  OutboundApproval: {
    workspace: 'Workspace',
    message: 'Message',
    contact: 'Contact',
    channel: 'Channel',
    templateVersion: 'MessageTemplateVersion',
    templateReview: 'TemplateReview',
    purpose: 'ConsentPurpose',
    consent: 'Consent',
    approvedBy: 'Membership',
  },
  StopBlock: {
    workspace: 'Workspace',
    createdBy: 'Membership',
    liftedBy: 'Membership',
  },
  ConsentReceiptCounter: {
    workspace: 'Workspace',
  },
  PermissionBackfill: {
    workspace: 'Workspace',
    role: 'Role',
    // alvo fora do perímetro: o catálogo global
    permission: 'Permission',
  },
  MessageDispatch: {
    workspace: 'Workspace',
    message: 'Message',
  },
  MessageStatusEvent: {
    workspace: 'Workspace',
    message: 'Message',
  },
  InboundMedia: {
    workspace: 'Workspace',
    message: 'Message',
    fileObject: 'FileObject',
  },
  Webhook: {
    workspace: 'Workspace',
    deliveries: 'WebhookDelivery',
  },
  WebhookDelivery: {
    webhook: 'Webhook',
    outboxEvent: 'OutboxEvent',
  },
  Activity: {
    workspace: 'Workspace',
    actor: 'Membership',
    contact: 'Contact',
    company: 'Company',
    deal: 'Deal',
    task: 'Task',
    conversation: 'Conversation',
    calendarEvent: 'CalendarEvent',
  },
  Channel: {
    workspace: 'Workspace',
    conversations: 'Conversation',
    messages: 'Message',
    credential: 'ChannelCredential',
    messageTemplates: 'MessageTemplate',
    templateVersions: 'MessageTemplateVersion',
    consents: 'Consent',
    outboundApprovals: 'OutboundApproval',
  },
  Conversation: {
    workspace: 'Workspace',
    aiProposals: 'AiProposal',
    aiRuns: 'AiRun',
    channel: 'Channel',
    contact: 'Contact',
    assignee: 'Membership',
    messages: 'Message',
    activities: 'Activity',
  },
  CalendarEvent: {
    workspace: 'Workspace',
    organizer: 'Membership',
    contact: 'Contact',
    deal: 'Deal',
    activities: 'Activity',
  },
  Notification: {
    workspace: 'Workspace',
    recipient: 'Membership',
  },
  FileObject: {
    workspace: 'Workspace',
    uploadedBy: 'Membership',
    attachments: 'MessageAttachment',
    inboundMedias: 'InboundMedia',
  },
  MessageAttachment: {
    message: 'Message',
    file: 'FileObject',
  },
  AiRun: {
    workspace: 'Workspace',
    // alvo fora do perímetro: catálogo global, travessia via db é bloqueada
    promptVersion: 'PromptVersion',
    triggeredBy: 'Membership',
    conversation: 'Conversation',
    contact: 'Contact',
    proposals: 'AiProposal',
  },
  AiProposal: {
    workspace: 'Workspace',
    run: 'AiRun',
    contact: 'Contact',
    deal: 'Deal',
    conversation: 'Conversation',
    reviewedBy: 'Membership',
  },
  AiConsent: {
    workspace: 'Workspace',
    updatedBy: 'Membership',
  },
  Subscription: {
    workspace: 'Workspace',
    // alvo fora do perímetro: catálogo global, travessia via db é bloqueada
    plan: 'Plan',
  },
  UsageCounter: {
    workspace: 'Workspace',
  },
  UsageReservation: {
    workspace: 'Workspace',
  },
  ContentUse: {
    workspace: 'Workspace',
  },
  Message: {
    workspace: 'Workspace',
    conversation: 'Conversation',
    channel: 'Channel',
    authorMembership: 'Membership',
    authorContact: 'Contact',
    attachments: 'MessageAttachment',
    messageDispatches: 'MessageDispatch',
    messageStatusEvents: 'MessageStatusEvent',
    inboundMedias: 'InboundMedia',
    outboundApproval: 'OutboundApproval',
  },
};
