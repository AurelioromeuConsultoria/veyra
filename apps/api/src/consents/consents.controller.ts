import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ConsentChannelDto,
  ConsentDto,
  ConsentPurposeDto,
  ContactConsentsDto,
  ContactStopInput,
  ConversationConsentsDto,
  ConversationStopInput,
  GrantConsentInput,
  RevokeConsentInput,
  StopBlockDto,
  contactStopSchema,
  conversationStopSchema,
  grantConsentSchema,
  revokeConsentSchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { Idempotent } from '../common/idempotency.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { ConversationConsentReplayGuard } from './consent-replay.guard';
import { ConsentsService } from './consents.service';

/**
 * As rotas do consentimento e do pedido de parar (ADR-052 item 5, F4.1b), ato
 * por ato: a chave nova SEMPRE se soma à visibilidade da rota, e todo registro
 * exige também `consents:read`, porque devolve o registro — inclusive o
 * existente de outra pessoa (decisão 19). A visibilidade é `contacts:read`
 * pelo contato, `conversations:read` pela conversa (e, na RAI, `contacts:write`,
 * conferido pela leitura da conversa, C13). Os registros exigem
 * `Idempotency-Key`. Pela conversa, o replay passa pela guarda que refaz a
 * visibilidade e a projeção do número com o acesso de agora; pelo contato, o
 * guard de permissões já exige `contacts:read` em toda repetição.
 */
@Controller()
export class ConsentsController {
  constructor(private readonly consents: ConsentsService) {}

  @RequirePermissions('consents:read')
  @Get('consent-purposes')
  purposes(): Promise<ConsentPurposeDto[]> {
    return this.consents.purposes();
  }

  /** Os canais de WhatsApp, para a tela da concessão (F4.4b): só id e nome. */
  @RequirePermissions('consents:read')
  @Get('consent-channels')
  channels(): Promise<ConsentChannelDto[]> {
    return this.consents.channels();
  }

  @RequirePermissions('consents:read', 'contacts:read')
  @Get('contacts/:contactId/consents')
  forContact(
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
  ): Promise<ContactConsentsDto> {
    return this.consents.forContact(contactId);
  }

  @RequirePermissions('consents:read', 'conversations:read')
  @Get('conversations/:conversationId/consents')
  forConversation(
    @CurrentAuth() auth: AuthContext,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
  ): Promise<ConversationConsentsDto> {
    return this.consents.forConversation(auth, conversationId);
  }

  @RequirePermissions('consents:manage', 'contacts:read', 'consents:read')
  @Idempotent({ required: true })
  @Post('contacts/:contactId/consents')
  grant(
    @CurrentAuth() auth: AuthContext,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body(new ZodPipe(grantConsentSchema)) body: GrantConsentInput,
  ): Promise<ConsentDto> {
    return this.consents.grant(auth, contactId, body);
  }

  @RequirePermissions('consents:manage', 'contacts:read', 'consents:read')
  @Idempotent({ required: true })
  @Post('contacts/:contactId/consents/:consentId/revoke')
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Param('consentId', new ParseUUIDPipe()) consentId: string,
    @Body(new ZodPipe(revokeConsentSchema)) body: RevokeConsentInput,
  ): Promise<ConsentDto> {
    return this.consents.revoke(auth, contactId, consentId, body.origin);
  }

  @RequirePermissions('consents:manage', 'contacts:read', 'consents:read')
  @Idempotent({ required: true })
  @Post('contacts/:contactId/stop')
  stopByContact(
    @CurrentAuth() auth: AuthContext,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body(new ZodPipe(contactStopSchema)) body: ContactStopInput,
  ): Promise<StopBlockDto> {
    return this.consents.stopByContact(auth, contactId, body.number, body.origin);
  }

  @RequirePermissions('consents:manage', 'conversations:read', 'consents:read')
  @Idempotent({ required: true, replayGuard: ConversationConsentReplayGuard })
  @Post('conversations/:conversationId/stop')
  stopByConversation(
    @CurrentAuth() auth: AuthContext,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body(new ZodPipe(conversationStopSchema)) body: ConversationStopInput,
  ): Promise<StopBlockDto> {
    return this.consents.stopByConversation(auth, conversationId, body.origin);
  }

  @RequirePermissions('consents:unblock', 'contacts:read', 'consents:read')
  @Idempotent({ required: true })
  @Post('contacts/:contactId/stop/lift')
  liftByContact(
    @CurrentAuth() auth: AuthContext,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body(new ZodPipe(contactStopSchema)) body: ContactStopInput,
  ): Promise<StopBlockDto> {
    return this.consents.liftByContact(auth, contactId, body.number, body.origin);
  }

  @RequirePermissions('consents:unblock', 'conversations:read', 'consents:read')
  @Idempotent({ required: true, replayGuard: ConversationConsentReplayGuard })
  @Post('conversations/:conversationId/stop/lift')
  liftByConversation(
    @CurrentAuth() auth: AuthContext,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body(new ZodPipe(conversationStopSchema)) body: ConversationStopInput,
  ): Promise<StopBlockDto> {
    return this.consents.liftByConversation(auth, conversationId, body.origin);
  }
}
