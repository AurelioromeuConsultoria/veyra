import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ConversationDto,
  ConversationPageDto,
  ConversationSenderCandidateDto,
  CreateConversationInput,
  CreateMessageInput,
  IdentifyConversationSenderInput,
  ListConversationsInput,
  ListMessagesInput,
  MessageDto,
  MessagePageDto,
  RejectConversationSenderInput,
  SendPolicyDto,
  UpdateConversationInput,
  createConversationSchema,
  createMessageSchema,
  identifyConversationSenderSchema,
  listConversationsSchema,
  listMessagesSchema,
  rejectConversationSenderSchema,
  updateConversationSchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { Idempotent } from '../common/idempotency.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { ConversationSenderService } from './conversation-sender.service';
import { ConversationsService } from './conversations.service';

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly sender: ConversationSenderService,
  ) {}

  @RequirePermissions('conversations:read')
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listConversationsSchema)) query: ListConversationsInput,
  ): Promise<ConversationPageDto> {
    return this.conversations.list(auth, query);
  }

  @RequirePermissions('conversations:read')
  @Get(':id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ConversationDto> {
    return this.conversations.get(auth, id);
  }

  @RequirePermissions('conversations:write')
  @Idempotent()
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createConversationSchema)) body: CreateConversationInput,
  ): Promise<ConversationDto> {
    return this.conversations.create(auth, body);
  }

  @RequirePermissions('conversations:write')
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateConversationSchema)) body: UpdateConversationInput,
  ): Promise<ConversationDto> {
    return this.conversations.update(auth, id, body);
  }

  /**
   * O que pode ser enviado AGORA. `conversations:write` e não `read`: quem não
   * pode enviar não precisa do catálogo de templates nem do estado de opt-in do
   * contato — dar a permissão mais larga ampliaria a exposição justamente para
   * quem nunca vai usar a informação (revisão da 9.1.c).
   */
  @RequirePermissions('conversations:write')
  @Get(':id/send-policy')
  sendPolicy(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SendPolicyDto> {
    return this.conversations.sendPolicy(auth, id);
  }

  @RequirePermissions('conversations:read')
  @Get(':id/messages')
  listMessages(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodPipe(listMessagesSchema)) query: ListMessagesInput,
  ): Promise<MessagePageDto> {
    return this.conversations.listMessages(auth, id, query);
  }

  /**
   * O REMETENTE (ADR-052 item 2). Ver a conversa RAI exige `contacts:write`
   * (C13, conferido no serviço, com 404); os candidatos mostram contatos, então
   * pedem também `contacts:read`.
   */
  @RequirePermissions('conversations:read', 'contacts:read', 'contacts:write')
  @Get(':id/sender/candidates')
  senderCandidates(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ConversationSenderCandidateDto[]> {
    return this.sender.candidates(auth, id);
  }

  /** Identificar: só para a conversa; o número compartilhado continua RAI. */
  @RequirePermissions('conversations:write', 'contacts:write', 'contacts:read')
  @Post(':id/sender/identify')
  async identifySender(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(identifyConversationSenderSchema)) body: IdentifyConversationSenderInput,
  ): Promise<ConversationDto> {
    await this.sender.identify(auth, id, body);
    return this.conversations.get(auth, id);
  }

  /** Desfazer a identificação feita por uma pessoa. */
  @RequirePermissions('conversations:write', 'contacts:write', 'contacts:read')
  @Post(':id/sender/unidentify')
  async unidentifySender(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ConversationDto> {
    await this.sender.unidentify(auth, id);
    return this.conversations.get(auth, id);
  }

  /** "O remetente não é este contato", com a retirada do número oferecida. */
  @RequirePermissions('conversations:write', 'contacts:write', 'contacts:read')
  @Post(':id/sender/reject')
  async rejectSender(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(rejectConversationSenderSchema)) body: RejectConversationSenderInput,
  ): Promise<ConversationDto> {
    await this.sender.reject(auth, id, body);
    return this.conversations.get(auth, id);
  }

  /**
   * @Idempotent: duplo clique ou retry não pode duplicar mensagem nem Activity —
   * a chave inclui os path params, então a mesma chave em outra conversa é
   * requisição diferente.
   */
  @RequirePermissions('conversations:write')
  @Idempotent()
  @Post(':id/messages')
  addMessage(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(createMessageSchema)) body: CreateMessageInput,
  ): Promise<MessageDto> {
    return this.conversations.addMessage(auth, id, body);
  }
}
