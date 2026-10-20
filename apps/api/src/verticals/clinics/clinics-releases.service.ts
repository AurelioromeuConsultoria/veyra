import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  ClinicsAiReleaseDto,
  ClinicsAiReleasePageDto,
  ClinicsAiReleaseReason,
  ListClinicsAiReleasesInput,
} from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../common/decorators';
import { lockContactsForRestriction } from '../../contacts/contact-restriction-lock';
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
  contact?: { name: string } | null;
};

/**
 * Liberação de contato para IA como "sem relação com o Clinics" (ADR-048 §6.4).
 * Só o consumidor `ai` existe no MVP: nada aqui libera webhooks. Client
 * protegido em tudo; cada mudança é auditada sem dado do contato.
 *
 * Conceder e revogar MUDAM a restrição do contato: travam a linha dele antes
 * de escrever (ADR-047 adendo 5), serializando com aprovações de propostas da
 * IA. Paciente não é liberável (ADR-048 adendo 2, item 2).
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

  /** Mais recentes primeiro, por cursor keyset (createdAt, id). */
  async list({
    cursor: rawCursor,
    limit,
  }: ListClinicsAiReleasesInput): Promise<ClinicsAiReleasePageDto> {
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    const rows = (await this.prisma.db.clinicsContactRelease.findMany({
      where: {
        consumer: 'ai',
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: { contact: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    } as never)) as unknown as ReleaseRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDto),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
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
      await lockContactsForRestriction(tx, workspaceId, [contactId]);
      // paciente nunca é liberável: o vínculo clínico sempre vence (§6.4)
      if (await tx.clinicsPatient.findFirst({ where: { contactId }, select: { id: true } })) {
        throw new ConflictException('Contato é paciente da clínica: não pode ser liberado para IA');
      }
      const existing = (await tx.clinicsContactRelease.findFirst({
        where: { contactId, consumer: 'ai' },
        include: { contact: { select: { name: true } } },
      } as never)) as unknown as ReleaseRow | null;
      if (existing) return existing;
      const created = (await tx.clinicsContactRelease.create({
        data: {
          workspaceId,
          contactId,
          consumer: 'ai',
          reason,
          releasedByMembershipId: auth.membershipId as string,
        },
        include: { contact: { select: { name: true } } },
      } as never)) as unknown as ReleaseRow;
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
      await lockContactsForRestriction(tx, workspaceId, [contactId]);
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
    await this.expirar([contactId]);
  }

  /**
   * Limpeza COMPLEMENTAR do conteúdo de IA, depois do commit: quem protege é a
   * leitura (que reconfere a porta) e a aprovação (que reconfere sob trava).
   */
  async expirar(contactIds: string[]): Promise<void> {
    try {
      await this.intelligence.expireContentFor({ contactIds });
    } catch (error) {
      this.logger.error(
        `Limpeza de conteúdo de IA falhou após mudar a restrição: ${
          error instanceof Error ? error.name : 'erro desconhecido'
        }`,
      );
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Cursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || !UUID.test(id ?? '')) {
    throw new BadRequestException('Cursor inválido');
  }
  return { createdAt, id };
}

function toDto(row: ReleaseRow): ClinicsAiReleaseDto {
  return {
    contactId: row.contactId,
    contactName: row.contact?.name ?? '',
    reason: row.reason,
    releasedByMembershipId: row.releasedByMembershipId,
    createdAt: row.createdAt.toISOString(),
  };
}
