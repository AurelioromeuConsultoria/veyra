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
      // ajuste #6: o tipo declarado no catálogo é emitido de fato
      await this.activities.record(tx, auth.workspaceId as string, 'contact_created', {
        actorMembershipId: auth.membershipId,
        payload: { name: input.name },
        targets: { contactId: contact.id, companyId: input.companyId },
      });
      return contact.id;
    });
    return this.get(id);
  }

  async update(id: string, input: UpdateContactInput): Promise<ContactDto> {
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
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.prisma.db.contact.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Contato não encontrado');
    await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      // CustomFieldValue.entityId não tem FK (exceção documentada): limpeza aqui
      await this.customFields.deleteValues(tx, 'contact', id);
      await tx.contact.deleteMany({ where: { id } }); // junções caem por cascade
    });
  }

  /** Import simples (linhas já parseadas pelo cliente). source = 'import'. */
  async import(input: ImportContactsInput): Promise<{ imported: number }> {
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
    const { count } = await this.prisma.db.contact.createMany({
      data: input.rows.map((row) => ({
        name: row.name,
        emails: row.email ? [row.email] : [],
        phones: row.phone ? [row.phone] : [],
        source: 'import',
      })),
    } as never);
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
