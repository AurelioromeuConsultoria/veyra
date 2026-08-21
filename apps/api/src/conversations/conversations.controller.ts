import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ConversationDto,
  ConversationPageDto,
  CreateConversationInput,
  CreateMessageInput,
  ListConversationsInput,
  ListMessagesInput,
  MessageDto,
  MessagePageDto,
  SendPolicyDto,
  UpdateConversationInput,
  createConversationSchema,
  createMessageSchema,
  listConversationsSchema,
  listMessagesSchema,
  updateConversationSchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { Idempotent } from '../common/idempotency.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { ConversationsService } from './conversations.service';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @RequirePermissions('conversations:read')
  @Get()
  list(
    @Query(new ZodPipe(listConversationsSchema)) query: ListConversationsInput,
  ): Promise<ConversationPageDto> {
    return this.conversations.list(query);
  }

  @RequirePermissions('conversations:read')
  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<ConversationDto> {
    return this.conversations.get(id);
  }

  @RequirePermissions('conversations:write')
  @Idempotent()
  @Post()
  create(
    @Body(new ZodPipe(createConversationSchema)) body: CreateConversationInput,
  ): Promise<ConversationDto> {
    return this.conversations.create(body);
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
    return this.conversations.sendPolicy(auth.workspaceId as string, id);
  }

  @RequirePermissions('conversations:read')
  @Get(':id/messages')
  listMessages(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodPipe(listMessagesSchema)) query: ListMessagesInput,
  ): Promise<MessagePageDto> {
    return this.conversations.listMessages(id, query);
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
