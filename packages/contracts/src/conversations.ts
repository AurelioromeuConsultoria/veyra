import { z } from 'zod';

export const conversationStatusSchema = z.enum(['open', 'pending', 'closed']);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const messageDirectionSchema = z.enum(['inbound', 'outbound']);
export type MessageDirection = z.infer<typeof messageDirectionSchema>;

export const messageAuthorSchema = z.enum(['contact', 'user', 'ai', 'system']);
export type MessageAuthorType = z.infer<typeof messageAuthorSchema>;

/**
 * O remetente da conversa (ADR-052 item 2). `unidentified` é o "remetente a
 * identificar" (RAI): o número que escreveu pertence a mais de um contato, ou só
 * coincide por aproximação, e nada o atribui sozinho. Só quem tem
 * `conversations:read` E `contacts:write` vê essas conversas (C13).
 */
export const conversationSenderSchema = z.enum(['identified', 'unidentified']);
export type ConversationSender = z.infer<typeof conversationSenderSchema>;

/**
 * Identificar o remetente de uma conversa RAI: um dos candidatos (os contatos
 * cujo número coincide), ou um contato NOVO, que recebe o número. A
 * identificação vale só para ESTA conversa: enquanto o número estiver em mais
 * de um contato, cada mensagem nova volta a ser RAI.
 */
export const identifyConversationSenderSchema = z.union([
  z.object({ contactId: z.string().uuid() }).strict(),
  z.object({ newContact: z.object({ name: z.string().trim().min(1).max(160) }).strict() }).strict(),
]);
export type IdentifyConversationSenderInput = z.infer<typeof identifyConversationSenderSchema>;

/**
 * "O remetente não é este contato": leva a conversa a RAI. Pode tirar, no mesmo
 * ato, o número do contato — senão a próxima mensagem do número volta a cair
 * nele.
 */
export const rejectConversationSenderSchema = z.object({ removeNumber: z.boolean() }).strict();
export type RejectConversationSenderInput = z.infer<typeof rejectConversationSenderSchema>;

/** Um candidato a remetente de uma conversa RAI. */
export interface ConversationSenderCandidateDto {
  contactId: string;
  name: string;
  /** `exact`: o número é o do cadastro; `possible`: só coincide por aproximação */
  match: 'exact' | 'possible';
}

/**
 * O canal NÃO é entrada do cliente (ADR-023): o service usa o canal interno de
 * sistema do workspace. Quando houver canal externo, a escolha vira explícita.
 */
export const createConversationSchema = z.object({
  contactId: z.string().uuid().optional(),
  subject: z.string().trim().max(200).optional(),
  assigneeMembershipId: z.string().uuid().optional(),
});
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const updateConversationSchema = z.object({
  subject: z.string().trim().max(200).nullable().optional(),
  status: conversationStatusSchema.optional(),
  assigneeMembershipId: z.string().uuid().nullable().optional(),
});
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

/** Inbox: cursor keyset (lastMessageAt, id) desc — estável sob mensagem nova. */
export const listConversationsSchema = z.object({
  status: z.enum(['open', 'pending', 'closed', 'all']).default('open'),
  assigneeMembershipId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListConversationsInput = z.infer<typeof listConversationsSchema>;

/**
 * Registro manual nos dois sentidos: `outbound` é o que o time enviou,
 * `inbound` o que o contato disse. O autor é derivado no servidor a partir da
 * direção — nunca informado pelo cliente.
 */
export const createMessageSchema = z.object({
  direction: messageDirectionSchema,
  body: z.string().trim().min(1).max(10000),
  /** ids de FileObject já enviados; anexar é parte da criação (append-only) */
  attachmentIds: z.array(z.string().uuid()).max(5).optional(),
  /**
   * Template aprovado, obrigatório para enviar FORA da janela de atendimento de
   * 24h em canal externo (ADR-038). Ignorado no canal interno.
   */
  template: z
    .object({
      name: z.string().trim().min(1).max(120),
      language: z.string().trim().min(2).max(10),
      params: z.array(z.string().max(200)).max(10).default([]),
    })
    .optional(),
});
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const listMessagesSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListMessagesInput = z.infer<typeof listMessagesSchema>;

export type ConsentStatus = 'granted' | 'revoked' | 'none';

export interface ConversationDto {
  id: string;
  channelType: 'internal' | 'email' | 'whatsapp';
  contactId: string | null;
  contactName: string | null;
  /** `unidentified` = remetente a identificar (RAI), sempre sem contato */
  senderStatus: ConversationSender;
  /**
   * O número do canal externo: completo só para quem tem `contacts:read`; para
   * os outros, só os quatro últimos dígitos. `null` no canal interno.
   */
  senderAddress: string | null;
  /** a pessoa identificou o remetente desta conversa, que nasceu RAI: dá para desfazer */
  senderIdentifiedByPerson: boolean;
  /**
   * A conversa tem mensagens ou atividades anteriores à F4.1a, ligadas ao
   * contato (o legado, ADR-052): identificar, desfazer e rejeitar dão 409, e a
   * tela não os oferece.
   */
  senderRelinkBlocked: boolean;
  subject: string | null;
  status: ConversationStatus;
  assigneeMembershipId: string | null;
  assigneeName: string | null;
  lastMessageAt: string;
  /**
   * Fim da janela de atendimento de 24h — INSTANTE, não duração restante:
   * duração viaja no JSON e já chega velha, enquanto o instante permite a tela
   * contar sozinha. `null` = canal sem janela (interno) ou nenhuma mensagem do
   * contato ainda. Não é permissão de envio: quem decide é o servidor
   * (`SendPolicyDto`), porque a janela é só um dos fatores (ADR-038).
   */
  windowExpiresAt: string | null;
  /**
   * O estado do consentimento NÃO viaja aqui, de propósito: é evidência com peso
   * de LGPD e a listagem é lida por qualquer portador de `conversations:read`,
   * sem finalidade — a triagem usa a janela. Quem precisa dele é o compositor,
   * e ele o obtém do `SendPolicyDto`, que exige `conversations:write`.
   */
  createdAt: string;
}

/** Template aprovado, como o compositor precisa vê-lo. */
export interface MessageTemplateDto {
  name: string;
  language: string;
  /** o envio precisa casar EXATAMENTE esta quantidade de parâmetros */
  paramCount: number;
}

/**
 * Veredito do SERVIDOR sobre o que pode ser enviado agora. A UI mostra, não
 * recalcula: reimplementar a política no front criaria duas versões que
 * divergem, e a do front seria a errada — ela não vê consentimento revogado nem
 * recibo atrasado (ADR-038, ADR-039).
 */
export interface SendPolicyDto {
  channelType: 'internal' | 'email' | 'whatsapp';
  /** `free_form` = texto livre; `template` = fora da janela, exige aprovado */
  mode: 'free_form' | 'template' | 'blocked';
  /** motivo curto quando `blocked` ou `template` — texto já em pt-BR */
  reason: string | null;
  windowExpiresAt: string | null;
  consentStatus: ConsentStatus | null;
  /** vazio quando o canal não usa template (interno) */
  templates: MessageTemplateDto[];
}

export interface MessageAttachmentDto {
  fileObjectId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: 'pending' | 'clean' | 'quarantined';
}

/**
 * Estado do despacho em canal externo. `unknown_after_dispatch` e
 * `failed_permanent` precisam ser VISÍVEIS: são mensagens que o atendente
 * enviou e que não chegaram — ou talvez tenham chegado. Fila invisível acumula
 * em silêncio (ADR-039).
 */
export type MessageDispatchState =
  | 'reserved'
  | 'sending'
  | 'sent'
  | 'failed_before_send'
  | 'failed_permanent'
  | 'unknown_after_dispatch';

export interface MessageDto {
  id: string;
  direction: MessageDirection;
  authorType: MessageAuthorType;
  authorName: string | null;
  body: string;
  attachments: MessageAttachmentDto[];
  /** null em canal interno (não há despacho externo) */
  dispatchState: MessageDispatchState | null;
  /** código curto do provedor quando o despacho falhou */
  dispatchError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ConversationPageDto {
  items: ConversationDto[];
  nextCursor: string | null;
}

export interface MessagePageDto {
  /** mais recentes primeiro; o cursor caminha para o passado */
  items: MessageDto[];
  nextCursor: string | null;
}
