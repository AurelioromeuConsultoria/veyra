import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Correlaciona request → log → AuditLog. Aceita x-request-id do cliente apenas
 * se tiver formato seguro (vai para dentro de registros e headers); caso
 * contrário gera um uuid.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(private readonly cls: ClsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    const requestId = candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
    this.cls.set('requestId', requestId);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  }
}
