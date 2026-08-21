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
]);

/**
 * Modelos APPEND-ONLY: histórico que não se reescreve (ADR-011 e SECURITY.md §5).
 * O client protegido BLOQUEIA update/updateMany/delete/deleteMany/upsert neles —
 * "append-only" deixa de ser convenção e vira invariante técnica. A exclusão
 * legítima acontece só por cascade do dono (LGPD) ou pelo job de retenção, que
 * usa `raw` com justificativa.
 */
export const APPEND_ONLY_MODELS = new Set<string>(['Activity', 'AuditLog', 'Message']);

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
  },
};
