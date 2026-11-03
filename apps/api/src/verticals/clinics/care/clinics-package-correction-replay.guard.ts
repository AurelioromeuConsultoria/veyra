import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PermissionKey } from '@veyra/contracts';
import type { ClinicsPermissionKey } from '@veyra/contracts/verticals/clinics';
import type { Request } from 'express';
import { PermissionsService } from '../../../auth/permissions.service';
import type { AuthContext } from '../../../common/decorators';
import type { IdempotentReplayGuard, ReplayVerdict } from '../../../common/idempotency.decorator';
import { ClinicsPackageCorrectionsService } from './clinics-package-corrections.service';

const CORRIGIR: readonly ClinicsPermissionKey[] = ['clinics:care:write', 'clinics:care:read'];

/**
 * O replay da correção de consumo (ADR-059, ajuste 2 da aprovação). A chave já
 * é da membership autenticada e do conteúdo do pedido (o hash do interceptor):
 * outra pessoa com a mesma chave recebe 409, nunca a correção de outra. Esta
 * guarda refaz, na repetição, o acesso de AGORA:
 *
 * - as permissões da correção, lidas vivas no papel: sem elas, 403, e o corpo
 *   guardado não sai;
 * - a correção guardada ainda é deste workspace: senão, 404.
 *
 * Nunca descarta nem executa de novo: a correção já aconteceu, e repeti-la
 * seria uma operação nova. Falha ao ler: 503, sem apagar nada.
 */
@Injectable()
export class ClinicsPackageCorrectionReplayGuard implements IdempotentReplayGuard {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly corrections: ClinicsPackageCorrectionsService,
  ) {}

  async verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict> {
    const auth = request.auth;
    if (!auth) return { refuse: new ForbiddenException('Permissão insuficiente') };
    try {
      for (const chave of CORRIGIR) {
        if (!(await this.permissions.has(auth, chave as PermissionKey))) {
          return { refuse: new ForbiddenException('Permissão insuficiente') };
        }
      }
      const id = (guardado.body as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !(await this.corrections.exists(id))) {
        return { refuse: new NotFoundException('Correção não encontrada') };
      }
      return 'replay';
    } catch {
      return 'unavailable';
    }
  }
}
