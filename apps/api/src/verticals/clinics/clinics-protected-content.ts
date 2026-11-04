import { Injectable } from '@nestjs/common';
import type { ProtectedContentProvider } from '../../extensions/protected-content';
import { PrismaService } from '../../prisma/prisma.service';
import { clinicsPresente } from './clinics-presence';

/**
 * O conteúdo protegido do Clinics (ADR-061, adendos 2 e 3, F5.3b): as notas e
 * as tarefas de quem TEM perfil de paciente. A leitura se libera com
 * `clinics:patient-content:read`, que se soma à permissão do recurso. Não
 * depende da liberação para IA (E6): "é paciente" é o critério, a cada pedido.
 *
 * Quem pode saber QUEM é paciente é quem lê a agenda (`clinics:schedule:read`,
 * a chave da lista de pacientes). Quem não pode recebe a regra uniforme do
 * Core, num workspace com a PRESENÇA do vertical (a mesma da E6).
 */
@Injectable()
export class ClinicsProtectedContent implements ProtectedContentProvider {
  readonly unlockKey = 'clinics:patient-content:read';
  readonly revealKey = 'clinics:schedule:read';

  constructor(private readonly prisma: PrismaService) {}

  contactFilter(): Record<string, unknown> {
    return { clinicsPatient: { isNot: null } };
  }

  appliesToWorkspace(): Promise<boolean> {
    return clinicsPresente(this.prisma);
  }
}
