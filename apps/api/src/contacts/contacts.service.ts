import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ContactDto,
  CreateContactInput,
  ImportContactsInput,
  ListContactsInput,
  Paginated,
  UpdateContactInput,
} from '@veyra/contracts';
import { ActivitiesService } from '../activities/activities.service';
import { UsageService } from '../usage/usage.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { AuthContext } from '../common/decorators';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { TagsService } from '../tags/tags.service';

type ContactRow = {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  status: 'active' | 'archived';
  companyId: string | null;
  ownerMembershipId: string | null;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
  company: { name: string } | null;
  tags: { tag: { id: string; name: string; color: string } }[];
};

const CONTACT_INCLUDE = {
  company: true, // protegido→protegido: permitido (FK composta)
  tags: { include: { tag: true } },
} as const;

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tags: TagsService,
    private readonly customFields: CustomFieldsService,
    private readonly activities: ActivitiesService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async list(input: ListContactsInput): Promise<Paginated<ContactDto>> {
    const where = {
      status: input.status,
      ...(input.companyId ? { companyId: input.companyId } : {}),
      ...(input.ownerMembershipId ? { ownerMembershipId: input.ownerMembershipId } : {}),
      ...(input.tagId ? { tags: { some: { tagId: input.tagId } } } : {}),
      ...(input.search
        ? {
            OR: [
              { name: { contains: input.search, mode: 'insensitive' as const } },
              { emails: { has: input.search.toLowerCase() } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.db.contact.count({ where } as never),
      this.prisma.db.contact.findMany({
        where,
        include: CONTACT_INCLUDE,
        orderBy: { [input.sortBy]: input.sortDir },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      } as never) as unknown as Promise<ContactRow[]>,
    ]);
    return {
      items: await this.toDtos(rows),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  async get(id: string): Promise<ContactDto> {
    const row = (await this.prisma.db.contact.findFirst({
      where: { id },
      include: CONTACT_INCLUDE,
    } as never)) as ContactRow | null;
    if (!row) throw new NotFoundException('Contato não encontrado');
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  async create(auth: AuthContext, input: CreateContactInput): Promise<ContactDto> {
    await this.validateReferences(input);
    const validated = await this.customFields.validateValues('contact', input.customFields, {
      requireAll: true,
    });
    const id = await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      const contact = await tx.contact.create({
        data: {
          name: input.name,
          emails: input.emails,
          phones: input.phones,
          companyId: input.companyId ?? null,
          ownerMembershipId: input.ownerMembershipId ?? null,
          source: input.source ?? null,
        },
      } as never);
      if (input.tagIds.length > 0) {
        await tx.contactTag.createMany({
          data: input.tagIds.map((tagId) => ({ contactId: contact.id, tagId })),
        } as never);
      }
      await this.customFields.syncValues(tx, 'contact', contact.id, validated);
      // quota DENTRO da transação (ADR-032): estourou, o 402 derruba tudo e o
      // contador volta pelo rollback — contato nasce sempre `active`
      await this.usage.consume(tx, auth.workspaceId as string, 'contacts', 1);
      // ajuste #6: o tipo declarado no catálogo é emitido de fato
      await this.activities.record(tx, auth.workspaceId as string, 'contact_created', {
        actorMembershipId: auth.membershipId,
        payload: { name: input.name },
        targets: { contactId: contact.id, companyId: input.companyId },
      });
      // outbox NA MESMA transação: se ela abortar, o evento externo some junto
      await this.outbox.enqueue(
        tx,
        auth.workspaceId as string,
        'contact.created',
        { id: contact.id, name: input.name },
        `contact.created:${contact.id}`,
      );
      return contact.id;
    });
    return this.get(id);
  }

  /**
   * Criação a partir de CANAL EXTERNO (ADR-040), dentro da transação de quem
   * chama. Existe para que a ingestão não contorne o domínio: sem isto, o
   * contato nascia sem consumir quota, sem `Activity` e sem `contact.created`
   * no outbox — ou seja, sem disparar automação, que é justamente o ponto de
   * um lead chegando por WhatsApp.
   *
   * A quota é consumida SEM barrar: recusar a mensagem de um paciente por
   * limite de plano é dano irrecuperável para ele, enquanto ultrapassar o teto
   * é problema de cobrança, visível no medidor.
   */
  async createFromExternalChannel(
    tx: Db,
    workspaceId: string,
    input: { name: string; phone: string; source: string },
  ): Promise<string> {
    const contact = await tx.contact.create({
      data: {
        workspaceId,
        name: input.name,
        phones: [input.phone],
        source: input.source,
      },
    } as never);
    const contactId = (contact as unknown as { id: string }).id;

    await this.usage.consumeOverLimit(tx, workspaceId, 'contacts', 1);
    await this.activities.record(tx, workspaceId, 'contact_created', {
      actorMembershipId: null,
      actorType: 'system',
      payload: { name: input.name },
      targets: { contactId },
    });
    await this.outbox.enqueue(
      tx,
      workspaceId,
      'contact.created',
      { id: contactId, name: input.name },
      `contact.created:${contactId}`,
    );
    return contactId;
  }

  async update(auth: AuthContext, id: string, input: UpdateContactInput): Promise<ContactDto> {
    const existing = await this.prisma.db.contact.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Contato não encontrado');
    await this.validateReferences(input);
    const validated = input.customFields
      ? await this.customFields.validateValues('contact', input.customFields, {
          requireAll: false,
        })
      : null;
    await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      await tx.contact.updateMany({
        where: { id },
        data: {
          name: input.name,
          emails: input.emails,
          phones: input.phones,
          status: input.status,
          companyId: input.companyId,
          ownerMembershipId: input.ownerMembershipId,
          source: input.source,
        },
      });
      if (input.tagIds) {
        await tx.contactTag.deleteMany({ where: { contactId: id } });
        if (input.tagIds.length > 0) {
          await tx.contactTag.createMany({
            data: input.tagIds.map((tagId) => ({ contactId: id, tagId })),
          } as never);
        }
      }
      if (validated) await this.customFields.syncValues(tx, 'contact', id, validated);

      // gauge segue o ciclo de vida (ADR-032): arquivar libera vaga, reativar
      // consome de novo — e reativar PODE esbarrar no teto, como criar
      if (input.status && input.status !== existing.status) {
        await this.usage.consume(
          tx,
          auth.workspaceId as string,
          'contacts',
          input.status === 'active' ? 1 : -1,
        );
      }
    });
    return this.get(id);
  }

  /**
   * Exclusão de contato — POLÍTICA EXPLÍCITA (ajuste #9, LGPD/SECURITY.md §9):
   *  - Deals e Tasks são PRESERVADOS, apenas desvinculados (contactId = null):
   *    são registro comercial/operacional do workspace, não dado do titular;
   *  - Notes e CustomFieldValues do contato são REMOVIDOS (conteúdo sobre ele);
   *  - Activities caem por cascade (histórico morre com o titular);
   *  - a exclusão em si é registrada em AuditLog (fica após o expurgo).
   * Nada de 409 genérico: o contato sempre pode ser excluído.
   */
  async remove(auth: AuthContext, id: string): Promise<void> {
    const existing = (await this.prisma.db.contact.findFirst({
      where: { id },
    })) as unknown as ContactRow | null;
    if (!existing) throw new NotFoundException('Contato não encontrado');
    await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      await this.audit.record(tx, auth.workspaceId as string, 'contact.deleted', {
        entityType: 'contact',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { name: existing.name, status: existing.status },
        after: null,
      });
      // preserva o registro comercial, desvinculando o titular
      await tx.deal.updateMany({ where: { contactId: id }, data: { contactId: null } });
      await tx.task.updateMany({ where: { contactId: id }, data: { contactId: null } });
      // remove o que é conteúdo SOBRE o titular
      await tx.note.deleteMany({ where: { contactId: id } });
      // CustomFieldValue.entityId não tem FK (exceção documentada): limpeza aqui
      await this.customFields.deleteValues(tx, 'contact', id);
      await this.outbox.enqueue(
        tx,
        auth.workspaceId as string,
        'contact.deleted',
        { id },
        `contact.deleted:${id}`,
      );
      await tx.contact.deleteMany({ where: { id } }); // junções/activities: cascade
      // só quem contava é descontado: arquivado já tinha liberado a vaga
      if (existing.status === 'active') {
        await this.usage.consume(tx, auth.workspaceId as string, 'contacts', -1);
      }
    });
  }

  /** Import simples (linhas já parseadas pelo cliente). source = 'import'. */
  async import(auth: AuthContext, input: ImportContactsInput): Promise<{ imported: number }> {
    // import não carrega custom fields — com campo obrigatório definido, criar
    // sem ele furaria a invariante que o POST /contacts recusa com 400
    const required = await this.prisma.db.customFieldDefinition.count({
      where: { entityType: 'contact', required: true },
    });
    if (required > 0) {
      throw new BadRequestException(
        'Importação indisponível: há campos personalizados obrigatórios — importe pelo formulário ou torne-os opcionais',
      );
    }
    // o LOTE inteiro entra na mesma transação e consome a quota de uma vez: ou
    // importa tudo, ou nada. Importação parcial por quota deixaria o usuário
    // sem saber quais linhas entraram (ajuste da revisão da 8).
    const count = await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      const created = await tx.contact.createMany({
        data: input.rows.map((row) => ({
          name: row.name,
          emails: row.email ? [row.email] : [],
          phones: row.phone ? [row.phone] : [],
          source: 'import',
        })),
      } as never);
      const imported = (created as unknown as { count: number }).count;
      await this.usage.consume(tx, auth.workspaceId as string, 'contacts', imported);
      return imported;
    });
    return { imported: count };
  }

  private async validateReferences(input: {
    companyId?: string | null;
    ownerMembershipId?: string | null;
    tagIds?: string[];
  }): Promise<void> {
    if (input.companyId) {
      const company = await this.prisma.db.company.findFirst({ where: { id: input.companyId } });
      if (!company) throw new BadRequestException('Empresa inválida');
    }
    if (input.ownerMembershipId) {
      const owner = await this.prisma.db.membership.findFirst({
        where: { id: input.ownerMembershipId, status: 'active' },
      });
      if (!owner) throw new BadRequestException('Responsável inválido');
    }
    if (input.tagIds) await this.tags.assertTagsExist(input.tagIds);
  }

  private async toDtos(rows: ContactRow[]): Promise<ContactDto[]> {
    const [customFields, ownerNames] = await Promise.all([
      this.customFields.valuesByEntity(
        'contact',
        rows.map((r) => r.id),
      ),
      this.resolveOwnerNames(rows.map((r) => r.ownerMembershipId)),
    ]);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      emails: row.emails,
      phones: row.phones,
      status: row.status,
      companyId: row.companyId,
      companyName: row.company?.name ?? null,
      ownerMembershipId: row.ownerMembershipId,
      ownerName: row.ownerMembershipId ? (ownerNames.get(row.ownerMembershipId) ?? null) : null,
      source: row.source,
      tags: row.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color })),
      customFields: customFields.get(row.id) ?? {},
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private async resolveOwnerNames(membershipIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(membershipIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const memberships = await this.prisma.db.membership.findMany({
      where: { id: { in: ids }, status: { not: 'removed' } }, // ex-membro: ownerName null
      select: { id: true, userId: true },
    });
    // raw justificado: nome (User é global) para exibição, restrito aos userIds
    // das memberships DESTE workspace (já filtradas pelo db)
    const users = await this.prisma.raw.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, name: true },
    });
    const nameByUser = new Map(users.map((u) => [u.id, u.name]));
    return new Map(memberships.map((m) => [m.id, nameByUser.get(m.userId) ?? '']));
  }
}
