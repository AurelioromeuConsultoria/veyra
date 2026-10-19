import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  ClinicsAiReleaseDto,
  ClinicsAiReleaseReason,
} from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../common/decorators';
import { ContactsService } from '../../contacts/contacts.service';
import { IntelligenceService } from '../../intelligence/intelligence.service';
import { PrismaService, type Db } from '../../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

type ReleaseRow = {
  id: string;
  contactId: string;
  reason: ClinicsAiReleaseReason;
  releasedByMembershipId: string;
  createdAt: Date;
};

/**
 * Liberação de contato para IA como "sem relação com o Clinics" (ADR-048 §6.4).
 * Só o consumidor `ai` existe no MVP: nada aqui libera webhooks. Client
 * protegido em tudo; cada mudança é auditada sem dado do contato.
 */
@Injectable()
export class ClinicsReleasesService {
  private readonly logger = new Logger(ClinicsReleasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly contacts: ContactsService,
    private readonly intelligence: IntelligenceService,
  ) {}

  async list(): Promise<ClinicsAiReleaseDto[]> {
    const rows = (await this.prisma.db.clinicsContactRelease.findMany({
      where: { consumer: 'ai' },
      orderBy: { createdAt: 'desc' },
      // teto SEM paginação: dívida com gatilho (tela de liberação, F2)
      take: 500,
    })) as unknown as ReleaseRow[];
    return rows.map(toDto);
  }

  /** Repetir devolve a liberação existente (o motivo original permanece). */
  async grant(
    auth: AuthContext,
    contactId: string,
    reason: ClinicsAiReleaseReason,
  ): Promise<ClinicsAiReleaseDto> {
    await this.contacts.get(contactId); // 404 para id inexistente ou de outro workspace
    const workspaceId = auth.workspaceId as string;
    const row = await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      const existing = (await tx.clinicsContactRelease.findFirst({
        where: { contactId, consumer: 'ai' },
      })) as unknown as ReleaseRow | null;
      if (existing) return existing;
      const created = (await tx.clinicsContactRelease.create({
        data: {
          workspaceId,
          contactId,
          consumer: 'ai',
          reason,
          releasedByMembershipId: auth.membershipId as string,
        },
      })) as unknown as ReleaseRow;
      await this.audit.record(tx, workspaceId, 'clinics.ai_release.granted', {
        entityType: 'clinicsContactRelease',
        entityId: created.id,
        actor: this.audit.actorFrom(auth),
        after: { contactId, consumer: 'ai', reason },
      });
      return created;
    });
    return toDto(row);
  }

  /** Revogar APAGA a linha (a prova fica na auditoria) e expira o conteúdo de IA. */
  async revoke(auth: AuthContext, contactId: string): Promise<void> {
    const workspaceId = auth.workspaceId as string;
    await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      const existing = (await tx.clinicsContactRelease.findFirst({
        where: { contactId, consumer: 'ai' },
      })) as unknown as ReleaseRow | null;
      if (!existing) throw new NotFoundException('Liberação não encontrada');
      await tx.clinicsContactRelease.deleteMany({ where: { id: existing.id } });
      await this.audit.record(tx, workspaceId, 'clinics.ai_release.revoked', {
        entityType: 'clinicsContactRelease',
        entityId: existing.id,
        actor: this.audit.actorFrom(auth),
        before: { contactId, consumer: 'ai', reason: existing.reason },
        after: null,
      });
    });
    // voltou a ser restrito: o que a IA produziu sobre ele expira. A leitura já
    // o oculta, então a limpeza é complementar: falhar aqui é relatado, e a
    // revogação, já gravada, não vira 500 (repetir daria 404)
    try {
      await this.intelligence.expireContentFor({ contactIds: [contactId] });
    } catch (error) {
      this.logger.error(
        `Limpeza de conteúdo de IA falhou após revogar liberação: ${
          error instanceof Error ? error.name : 'erro desconhecido'
        }`,
      );
    }
  }
}

function toDto(row: ReleaseRow): ClinicsAiReleaseDto {
  return {
    contactId: row.contactId,
    reason: row.reason,
    releasedByMembershipId: row.releasedByMembershipId,
    createdAt: row.createdAt.toISOString(),
  };
}
