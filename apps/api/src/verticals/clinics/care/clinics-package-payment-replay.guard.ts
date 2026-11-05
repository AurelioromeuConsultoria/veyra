import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PermissionKey } from '@veyra/contracts';
import type { ClinicsPermissionKey } from '@veyra/contracts/verticals/clinics';
import type { Request } from 'express';
import { PermissionsService } from '../../../auth/permissions.service';
import type { AuthContext } from '../../../common/decorators';
import type { IdempotentReplayGuard, ReplayVerdict } from '../../../common/idempotency.decorator';
import { ClinicsPackagePaymentsService } from './clinics-package-payments.service';

/** As chaves de cada rota: as MESMAS do decorator da rota. */
export const REGISTRAR_PAGAMENTO: readonly ClinicsPermissionKey[] = [
  'clinics:payments:write',
  'clinics:payments:read',
  'clinics:schedule:read',
];
export const ANULAR_PAGAMENTO: readonly ClinicsPermissionKey[] = [
  'clinics:payments:void',
  'clinics:payments:read',
  'clinics:schedule:read',
];

/**
 * O replay do registro e da anulação de pagamento (ADR-063, no padrão do
 * ADR-061 adendo 6 e do ADR-059). A chave já é da membership autenticada e do
 * conteúdo do pedido (o hash do interceptor): outra pessoa com a mesma chave
 * recebe 409, nunca o pagamento de outra. A guarda refaz, na repetição, o acesso
 * de AGORA:
 *
 * - as permissões da rota, lidas vivas no papel: sem elas, 403, e o corpo
 *   guardado não sai;
 * - o pagamento guardado ainda é deste workspace: senão, 404.
 *
 * Nunca descarta nem executa de novo: o registro já aconteceu, e repeti-lo
 * seria um pagamento novo. Falha ao ler: 503, sem apagar nada.
 */
abstract class ReplayDoPagamento implements IdempotentReplayGuard {
  constructor(
    private readonly chaves: readonly ClinicsPermissionKey[],
    private readonly permissions: PermissionsService,
    private readonly payments: ClinicsPackagePaymentsService,
  ) {}

  async verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict> {
    const auth = request.auth;
    if (!auth) return { refuse: new ForbiddenException('Permissão insuficiente') };
    try {
      for (const chave of this.chaves) {
        if (!(await this.permissions.has(auth, chave as PermissionKey))) {
          return { refuse: new ForbiddenException('Permissão insuficiente') };
        }
      }
      const id = (guardado.body as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !(await this.payments.existe(id))) {
        return { refuse: new NotFoundException('Pagamento não encontrado') };
      }
      return 'replay';
    } catch {
      return 'unavailable';
    }
  }
}

// os construtores explícitos: o Nest lê as dependências da classe decorada
@Injectable()
export class ClinicsPaymentRecordReplayGuard extends ReplayDoPagamento {
  constructor(permissions: PermissionsService, payments: ClinicsPackagePaymentsService) {
    super(REGISTRAR_PAGAMENTO, permissions, payments);
  }
}

@Injectable()
export class ClinicsPaymentVoidReplayGuard extends ReplayDoPagamento {
  constructor(permissions: PermissionsService, payments: ClinicsPackagePaymentsService) {
    super(ANULAR_PAGAMENTO, permissions, payments);
  }
}
