import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * A BARREIRA DE MANUTENÇÃO (ADR-053): com `MAINTENANCE_MODE=true`, toda
 * requisição recebe 503 — o login, o webhook da Meta, as rotas autenticadas, a
 * rota inexistente, o OPTIONS do CORS e a saúde vista de fora. É o PRIMEIRO
 * `app.use` do `configureHttp`: a requisição barrada não lê cookie nem corpo,
 * não autentica e não toca o banco.
 *
 * A única exceção é `GET /api/health` pelo SOCKET de loopback — o healthcheck
 * do container e a conferência por dentro. Decidido pelo endereço do socket,
 * nunca por `req.ip`, `X-Forwarded-For` ou `X-Real-IP`: o nginx do `web` repassa
 * o XFF do cliente, e o `req.ip` depende de `trust proxy`.
 *
 * O limite: o HTML estático da SPA continua no `web`. A barreira protege a API
 * e a execução de tarefas; a tela abre, mas nada responde.
 */

export const ROTA_DA_SAUDE = '/api/health';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const RESPOSTA_DA_MANUTENCAO = {
  statusCode: 503,
  code: 'maintenance',
  message: 'O Veyra está em manutenção. Tente de novo mais tarde.',
} as const;

/** A saúde pelo loopback, e só ela, passa pela barreira. */
export function passaPelaBarreira(req: Pick<Request, 'method' | 'path' | 'socket'>): boolean {
  return (
    req.method === 'GET' &&
    req.path === ROTA_DA_SAUDE &&
    LOOPBACK.has(req.socket?.remoteAddress ?? '')
  );
}

export function barreiraDeManutencao(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (passaPelaBarreira(req)) {
      next();
      return;
    }
    res
      .status(503)
      .set('Retry-After', '300')
      .set('Cache-Control', 'no-store')
      .json(RESPOSTA_DA_MANUTENCAO);
  };
}
