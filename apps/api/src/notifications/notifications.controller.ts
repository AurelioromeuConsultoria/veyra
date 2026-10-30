import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ListNotificationsInput,
  NotificationPageDto,
  listNotificationsSchema,
} from '@veyra/contracts';
import { AuthContext, AuthenticatedOnly, CurrentAuth } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { NotificationsService } from './notifications.service';

/**
 * @AuthenticatedOnly (raro, revisável — ADR-016): a caixa é PESSOAL. Não existe
 * permissão que faça sentido aqui, porque não há acesso à caixa de outra pessoa
 * para conceder: o destinatário é sempre a membership da própria sessão, imposto
 * no service. Uma permissão daria a impressão de um controle que não existe.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @AuthenticatedOnly()
  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listNotificationsSchema)) query: ListNotificationsInput,
  ): Promise<NotificationPageDto> {
    // sem workspace ativo (a membership removida, por exemplo), a caixa é vazia:
    // não há destinatário, e consultar sem workspace seria recusado com 500
    // pela proteção multitenant (ADR-055 adendo 1, item 7)
    if (!auth.workspaceId) return { items: [], unreadCount: 0 };
    return this.notifications.list(auth.membershipId as string, query);
  }

  @AuthenticatedOnly()
  @Patch(':id/read')
  async markRead(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    if (!auth.workspaceId) throw new NotFoundException('Notificação não encontrada');
    const marked = await this.notifications.markRead(auth.membershipId as string, id);
    // 404 também quando a notificação é de outra pessoa: não revela existência
    if (!marked) throw new NotFoundException('Notificação não encontrada');
    return { ok: true };
  }

  @AuthenticatedOnly()
  @Post('read-all')
  async markAllRead(@CurrentAuth() auth: AuthContext): Promise<{ marked: number }> {
    if (!auth.workspaceId) return { marked: 0 };
    return { marked: await this.notifications.markAllRead(auth.membershipId as string) };
  }
}
