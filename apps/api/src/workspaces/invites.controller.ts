import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AcceptInviteInput,
  AuthUserDto,
  CreateInviteInput,
  InviteCreatedDto,
  InviteDto,
  acceptInviteSchema,
  createInviteSchema,
} from '@veyra/contracts';
import type { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { setSessionCookies } from '../auth/tokens';
import { AuthContext, CurrentAuth, Public, RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { InvitesService } from './invites.service';

@Controller('invites')
export class InvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly auth: AuthService,
  ) {}

  /** O token retorna UMA única vez aqui — depois só o hash existe. */
  @RequirePermissions('members:manage')
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createInviteSchema)) body: CreateInviteInput,
  ): Promise<InviteCreatedDto> {
    return this.invites.create(auth, body.email, body.roleId);
  }

  @RequirePermissions('members:manage')
  @Get()
  list(): Promise<InviteDto[]> {
    return this.invites.list();
  }

  @RequirePermissions('members:manage')
  @Delete(':inviteId')
  async revoke(@Param('inviteId', new ParseUUIDPipe()) inviteId: string): Promise<{ ok: true }> {
    await this.invites.revoke(inviteId);
    return { ok: true };
  }

  /**
   * @Public justificado: o aceite acontece antes de existir sessão — a
   * credencial é o token do convite (rate-limited; mensagem de erro única).
   * Sucesso emite sessão (auto-login) já no workspace do convite.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('accept')
  async accept(
    @Body(new ZodPipe(acceptInviteSchema)) body: AcceptInviteInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUserDto> {
    const { userId, membershipId } = await this.invites.accept(body);
    const session = await this.auth.createSession(userId, membershipId);
    setSessionCookies(res, session.cookies);
    return session.user;
  }
}
