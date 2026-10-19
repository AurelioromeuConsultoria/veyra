/**
 * ALLOWLIST de campos auditáveis por entidade (SECURITY.md §5, ajuste do plano):
 * padrão-NEGAR — campo novo só é auditado quando entra aqui. Fora da lista, o
 * before/after registra apenas que mudou (`[changed]`), nunca o valor. Nada de
 * hash, token, corpo de nota, anexo ou dado clínico de vertical.
 *
 * Esta é a allowlist do CORE. Extensões contribuem a sua pela composição
 * (ADR-047, E4); o `AuditService` usa a lista composta em `extensions/registry.ts`.
 */
export const AUDIT_FIELDS: Record<string, readonly string[]> = {
  contact: ['name', 'status', 'companyId', 'ownerMembershipId', 'source'],
  company: ['name', 'domain', 'size', 'ownerMembershipId'],
  deal: [
    'title',
    'amountCents',
    'currency',
    'stageId',
    'status',
    'ownerMembershipId',
    'expectedCloseDate',
  ],
  task: ['title', 'status', 'assigneeMembershipId', 'dueAt', 'priority'],
  note: [], // nada do corpo — só o fato de ter existido
  membership: ['roleId', 'status'],
  invite: ['email', 'roleId'],
  role: ['name', 'description'],
  customField: ['label', 'required', 'options'],
  pipeline: ['name', 'defaultMark'],
  stage: ['name', 'order', 'probability', 'type'],
  webhook: ['url', 'events', 'status'], // secretCipher JAMAIS
  // nome e tipo bastam para a trilha; a CHAVE de storage nunca é auditada
  file: ['fileName', 'mimeType', 'scanStatus'],
  aiConsent: ['conversationContent'],
  automation: ['name', 'trigger', 'enabled', 'depth', 'chainId'],
  /**
   * `externalId` é o wamid — identificador DO PROVEDOR, não conteúdo nem
   * segredo — e é o único ponto de retomada quando perdemos a posse depois de
   * um envio bem-sucedido. Corpo da mensagem JAMAIS entra aqui.
   *
   * `authorType` responde "quanto do que saiu daqui foi escrito por modelo":
   * `ai` = o rascunho da IA foi aprovado como estava; `user` = o aprovador
   * reescreveu antes de enviar (ADR-044.8).
   */
  message: ['externalId', 'direction', 'authorType'],
  // payload NUNCA — pode conter texto de terceiro. `supersededByProposalId` é
  // um id, não conteúdo: é o que liga o rascunho substituído ao que o
  // substituiu (ADR-044, adendo 3)
  aiProposal: ['type', 'status', 'supersededByProposalId'],
  // limpeza de conteúdo derivado por restrição (ADR-047 E6): só a CONTAGEM e o
  // alcance, nunca ids de contato nem conteúdo
  aiContent: ['results', 'scope'],
};
