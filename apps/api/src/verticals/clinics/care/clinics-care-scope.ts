import { ForbiddenException, Injectable } from '@nestjs/common';
import type { PermissionKey } from '@veyra/contracts';
import type { ClinicsPermissionKey } from '@veyra/contracts/verticals/clinics';
import { PermissionsService } from '../../../auth/permissions.service';
import type { AuthContext } from '../../../common/decorators';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * O ALCANCE CLÍNICO de quem pede (ADR-061, D8 e adendo 1). Regra única para
 * todos os caminhos do atendimento: a agenda, a leitura, o registro, a correção
 * e o replay dela, as sessões do pacote, os pacotes e os ids nos retornos.
 *
 * - `todos`: a chave `clinics:care:all`, que se SOMA às de leitura e escrita do
 *   atendimento e nunca concede nada sozinha (cada rota continua exigindo as
 *   dela);
 * - `proprios`: sem a chave, o profissional NÃO arquivado vinculado à conta
 *   (`ClinicsProfessional.membershipId`, único por conta);
 * - `nenhum`: sem a chave e sem vínculo válido: nenhum acesso clínico.
 *
 * O dono de um atendimento é o `professionalId` do REGISTRO, fixado nele e
 * imutável — nunca o do agendamento visto depois.
 */
export type AlcanceClinico =
  { tipo: 'todos' } | { tipo: 'proprios'; professionalId: string } | { tipo: 'nenhum' };

export const CARE_ALL = 'clinics:care:all' satisfies ClinicsPermissionKey;

export const SEM_VINCULO =
  'Sua conta não está vinculada a um profissional ativo: sem acesso aos atendimentos.';
export const DE_OUTRO_PROFISSIONAL = 'Este atendimento é de outro profissional.';

/** O atendimento (ou o horário) do profissional `professionalId` está no alcance? */
export function alcanca(alcance: AlcanceClinico, professionalId: string): boolean {
  return (
    alcance.tipo === 'todos' ||
    (alcance.tipo === 'proprios' && alcance.professionalId === professionalId)
  );
}

/** Sem vínculo válido, nenhum dado clínico: 403, antes de qualquer leitura. */
export function exigirAlcance(alcance: AlcanceClinico): void {
  if (alcance.tipo === 'nenhum') throw new ForbiddenException(SEM_VINCULO);
}

@Injectable()
export class AlcanceClinicoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  async de(auth: AuthContext): Promise<AlcanceClinico> {
    if (await this.permissions.has(auth, CARE_ALL as PermissionKey)) return { tipo: 'todos' };
    const membershipId = auth.membershipId;
    if (!membershipId) return { tipo: 'nenhum' };
    const vinculo = (await this.prisma.db.clinicsProfessional.findFirst({
      where: { membershipId, archivedAt: null },
      select: { id: true },
    })) as { id: string } | null;
    return vinculo ? { tipo: 'proprios', professionalId: vinculo.id } : { tipo: 'nenhum' };
  }
}
