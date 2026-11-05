import { HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { IdempotentReplayGuard, ReplayVerdict } from '../common/idempotency.decorator';
import type { AuthContext } from '../common/decorators';
import { EnvioDoNegocioService } from './business-outbound.service';

/**
 * A repetição da aprovação pela rota do Core dá a MESMA resposta que um pedido
 * novo daria agora (ADR-061, adendo 9, item 8; o padrão do adendo 6): no
 * `uniforme`, o 403 "Conteúdo restrito", e não os ids e estados guardados.
 * Fora dele, o corpo guardado, como antes (ele só traz ids, estados e
 * motivos). Nada é executado de novo. A falha ao decidir dá 503, sem apagar
 * o guardado.
 */
@Injectable()
export class EnvioDoNegocioReplayGuard implements IdempotentReplayGuard {
  constructor(private readonly envio: EnvioDoNegocioService) {}

  async verdict(request: Request & { auth?: AuthContext }): Promise<ReplayVerdict> {
    const auth = request.auth;
    if (!auth) return 'unavailable';
    try {
      await this.envio.exigirTextoDoCore(auth);
      return 'replay';
    } catch (erro) {
      if (erro instanceof HttpException) return { refuse: erro };
      return 'unavailable';
    }
  }
}
