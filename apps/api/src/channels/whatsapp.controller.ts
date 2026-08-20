import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ProviderWebhook, Public } from '../common/decorators';
import { verifyChallengeToken } from './whatsapp.signature';
import { WhatsappService } from './whatsapp.service';

/**
 * Endpoint PÚBLICO de ingestão (ADR-037): a Meta não tem sessão nossa. A defesa
 * é a assinatura sobre o corpo bruto, não o payload — payload é justamente o que
 * um atacante controla.
 *
 * `@Public()` aqui é excepcional e revisável: é o ÚNICO caminho de escrita não
 * autenticado do produto. Qualquer mudança neste arquivo pede revisão de
 * segurança.
 */
@Controller('channels/whatsapp')
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly config: ConfigService,
  ) {}

  /** Desafio de verificação da Meta: devolve o challenge se o token conferir. */
  @Public()
  @ProviderWebhook()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() response: Response,
  ): void {
    const expected = this.config.get<string>('META_WEBHOOK_VERIFY_TOKEN');
    if (mode === 'subscribe' && expected && token && verifyChallengeToken(token, expected)) {
      response.status(200).send(challenge ?? '');
      return;
    }
    // 403 sem detalhe: não dizemos se o token existe ou está errado
    response.status(403).send();
  }

  /**
   * Recebimento de eventos. Responde 200 mesmo para o que ignora: a Meta
   * reentrega o que não recebe 2xx, e reentrega de evento desconhecido viraria
   * fila infinita de erro.
   *
   * O throttle é próprio e generoso o suficiente para rajadas legítimas de
   * conversa, mas limitado — é superfície pública.
   */
  @Public()
  @ProviderWebhook()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @HttpCode(200)
  @Post('webhook')
  async receive(
    @Req() request: Request & { rawBody?: Buffer },
    @Body() body: unknown,
  ): Promise<{ received: true }> {
    const signature = request.header('x-hub-signature-256');
    if (!this.whatsapp.verifySignature(request.rawBody, signature)) {
      // 200 com corpo neutro: responder 401/403 diria a um sondador que o
      // endpoint existe e valida assinatura. Nada é processado.
      return { received: true };
    }
    await this.whatsapp.ingest(body);
    return { received: true };
  }
}
