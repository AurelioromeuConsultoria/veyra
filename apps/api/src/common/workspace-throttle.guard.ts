import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthContext } from './decorators';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 600; // por workspace, por instância

/**
 * Rate limit POR WORKSPACE (o throttler global é por IP): um tenant abusivo não
 * derruba os outros. Janela deslizante em memória — suficiente para instância
 * única; multi-instância vira dívida com gatilho (Redis).
 */
@Injectable()
export class WorkspaceThrottleGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { auth?: AuthContext }>();
    const workspaceId = request.auth?.workspaceId;
    if (!workspaceId || process.env.NODE_ENV === 'test') return true;

    const now = Date.now();
    const window = (this.hits.get(workspaceId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (window.length >= MAX_PER_WINDOW) {
      const retryAfter = Math.ceil((WINDOW_MS - (now - window[0])) / 1000);
      http.getResponse<Response>().setHeader('Retry-After', String(retryAfter));
      throw new HttpException('Limite de requisições do workspace atingido', 429);
    }
    window.push(now);
    this.hits.set(workspaceId, window);
    // limpeza preguiçosa: evita crescer indefinidamente com workspaces ociosos
    if (this.hits.size > 5000) {
      for (const [id, times] of this.hits) {
        if (times.every((t) => now - t >= WINDOW_MS)) this.hits.delete(id);
      }
    }
    return true;
  }
}
