import { createHash } from 'node:crypto';
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, from, of, switchMap, tap, catchError, throwError } from 'rxjs';
import { AuthContext } from './decorators';
import { IDEMPOTENT_KEY } from './idempotency.decorator';
import { PrismaService } from '../prisma/prisma.service';

const HEADER = 'idempotency-key';
const TTL_HOURS = 24;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** reserva 'processing' mais velha que isto é considerada abandonada */
const PROCESSING_LEASE_MS = 60_000;

/**
 * Idempotência HTTP com RESERVA ATÔMICA (ajuste #3 da revisão do plano):
 *
 *  1. hash = sha256(método + rota CANÔNICA + query ordenada + body normalizado);
 *  2. RESERVA a chave (`processing`) com um INSERT único — se o insert falhar
 *     (P2002), já existe registro: mesmo hash `completed` → replay da resposta;
 *     mesmo hash `processing` → 409 + Retry-After (execução em curso); hash
 *     diferente → 409 (mesma chave para request diferente);
 *  3. sucesso (2xx) → grava status+body e marca `completed`;
 *  4. erro/5xx/rollback → APAGA a reserva, liberando nova tentativa.
 *
 * prisma.raw justificado: a reserva precisa acontecer FORA da transação de
 * domínio (que pode abortar) e o escopo é explícito por workspaceId.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { auth?: AuthContext }>();
    const response = http.getResponse<Response>();

    // OPT-IN: só rotas marcadas com @Idempotent() participam — resposta com
    // segredo (ex.: criação de webhook) nunca vai para o cache
    const enabled = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const rawKey = request.headers[HEADER];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!enabled || !key || SAFE_METHODS.has(request.method) || !request.auth?.workspaceId) {
      return next.handle();
    }
    if (key.length > 200) {
      // erro do cliente é 400, não 409
      return throwError(() => new BadRequestException('Idempotency-Key inválida'));
    }

    const workspaceId = request.auth.workspaceId;
    const endpoint = `${request.method} ${this.canonicalRoute(request)}`;
    const requestHash = this.hash(request, endpoint);

    return from(this.reserve(workspaceId, key, endpoint, requestHash)).pipe(
      switchMap((reserved) => {
        if (reserved.replay) {
          response.status(reserved.status);
          response.setHeader('idempotent-replay', 'true');
          return of(reserved.body);
        }
        return next.handle().pipe(
          tap((body) => {
            // promise sem catch derrubaria o processo (unhandled rejection)
            this.complete(workspaceId, key, endpoint, response.statusCode, body).catch((error) =>
              this.logger.error(`Falha ao concluir idempotência ${key}: ${String(error)}`),
            );
          }),
          catchError((error: unknown) => {
            // libera a reserva: a operação não aconteceu, nova tentativa é válida
            this.release(workspaceId, key, endpoint).catch((e) =>
              this.logger.error(`Falha ao liberar idempotência ${key}: ${String(e)}`),
            );
            return throwError(() => error);
          }),
        );
      }),
    );
  }

  /** Rota registrada (com :params), não a URL concreta — canônica por design. */
  private canonicalRoute(request: Request & { route?: { path?: string } }): string {
    return request.route?.path ?? request.path;
  }

  private hash(request: Request, endpoint: string): string {
    const query = Object.entries(request.query as Record<string, unknown>)
      .map(([k, v]) => [k, JSON.stringify(v)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    // params SÃO parte da identidade: sem eles, a mesma chave em
    // PATCH /deals/A e /deals/B daria replay silencioso no lugar de 409
    const params = Object.entries(request.params as Record<string, string>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const body = this.normalize(request.body);
    return createHash('sha256')
      .update(JSON.stringify({ endpoint, params, query, body }))
      .digest('hex');
  }

  /** Normaliza o body: ordem de chaves não muda a identidade do request. */
  private normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.normalize(item));
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, this.normalize(v)]);
    }
    return value;
  }

  private async reserve(
    workspaceId: string,
    key: string,
    endpoint: string,
    requestHash: string,
  ): Promise<{ replay: false } | { replay: true; status: number; body: unknown }> {
    const expiresAt = new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);
    try {
      await this.prisma.raw.idempotencyKey.create({
        data: { workspaceId, key, endpoint, requestHash, expiresAt },
      });
      return { replay: false };
    } catch {
      // já existe (P2002) ou expirou — resolve pelo estado atual
      const existing = await this.prisma.raw.idempotencyKey.findFirst({
        where: { workspaceId, key, endpoint },
      });
      if (!existing) throw new ConflictException('Conflito de idempotência, tente novamente');
      if (existing.expiresAt < new Date()) {
        await this.prisma.raw.idempotencyKey.deleteMany({ where: { id: existing.id } });
        throw new ConflictException('Chave de idempotência expirada, refaça a requisição');
      }
      if (existing.requestHash !== requestHash) {
        throw new ConflictException('Idempotency-Key já usada para uma requisição diferente');
      }
      if (existing.state === 'processing') {
        // LEASE: reserva presa (crash entre reserve e complete) é reciclada —
        // sem isso a chave ficaria bloqueada pelas 24h do TTL
        if (Date.now() - existing.createdAt.getTime() > PROCESSING_LEASE_MS) {
          await this.prisma.raw.idempotencyKey.deleteMany({ where: { id: existing.id } });
          throw new ConflictException('Tentativa anterior expirou, refaça a requisição');
        }
        throw new ConflictException('Requisição idêntica em processamento, tente novamente');
      }
      return {
        replay: true,
        status: existing.responseStatus ?? 200,
        body: existing.responseBody,
      };
    }
  }

  private async complete(
    workspaceId: string,
    key: string,
    endpoint: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    if (status >= 400) {
      await this.release(workspaceId, key, endpoint);
      return;
    }
    await this.prisma.raw.idempotencyKey.updateMany({
      where: { workspaceId, key, endpoint, state: 'processing' },
      data: { state: 'completed', responseStatus: status, responseBody: body as object },
    });
  }

  private async release(workspaceId: string, key: string, endpoint: string): Promise<void> {
    await this.prisma.raw.idempotencyKey.deleteMany({
      where: { workspaceId, key, endpoint, state: 'processing' },
    });
  }
}
