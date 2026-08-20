import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CompanyDto,
  CreateCompanyInput,
  ListCompaniesInput,
  Paginated,
  UpdateCompanyInput,
} from '@veyra/contracts';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { TagsService } from '../tags/tags.service';

type CompanyRow = {
  id: string;
  name: string;
  domain: string | null;
  size: string | null;
  ownerMembershipId: string | null;
  createdAt: Date;
  updatedAt: Date;
  tags: { tag: { id: string; name: string; color: string } }[];
  _count: { contacts: number };
};

const COMPANY_INCLUDE = {
  tags: { include: { tag: true } }, // protegido→protegido: permitido
  _count: { select: { contacts: true } },
} as const;

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tags: TagsService,
    private readonly customFields: CustomFieldsService,
  ) {}

  async list(input: ListCompaniesInput): Promise<Paginated<CompanyDto>> {
    const where = {
      ...(input.search
        ? {
            OR: [
              { name: { contains: input.search, mode: 'insensitive' as const } },
              { domain: { contains: input.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(input.tagId ? { tags: { some: { tagId: input.tagId } } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.db.company.count({ where } as never),
      this.prisma.db.company.findMany({
        where,
        include: COMPANY_INCLUDE,
        orderBy: { [input.sortBy]: input.sortDir },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      } as never) as unknown as Promise<CompanyRow[]>,
    ]);
    return {
      items: await this.toDtos(rows),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  async get(id: string): Promise<CompanyDto> {
    const row = (await this.prisma.db.company.findFirst({
      where: { id },
      include: COMPANY_INCLUDE,
    } as never)) as CompanyRow | null;
    if (!row) throw new NotFoundException('Empresa não encontrada');
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  async create(input: CreateCompanyInput): Promise<CompanyDto> {
    await this.validateReferences(input);
    const validated = await this.customFields.validateValues('company', input.customFields, {
      requireAll: true,
    });
    const db = this.prisma.db as unknown as {
      $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
    };
    const id = await db.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: input.name,
          domain: input.domain ?? null,
          size: input.size ?? null,
          ownerMembershipId: input.ownerMembershipId ?? null,
        },
      } as never);
      if (input.tagIds.length > 0) {
        await tx.companyTag.createMany({
          data: input.tagIds.map((tagId) => ({ companyId: company.id, tagId })),
        } as never);
      }
      await this.customFields.syncValues(tx, 'company', company.id, validated);
      return company.id;
    });
    return this.get(id);
  }

  async update(id: string, input: UpdateCompanyInput): Promise<CompanyDto> {
    const existing = await this.prisma.db.company.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Empresa não encontrada');
    await this.validateReferences(input, id);
    const validated = input.customFields
      ? await this.customFields.validateValues('company', input.customFields, {
          requireAll: false,
        })
      : null;
    const db = this.prisma.db as unknown as {
      $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
    };
    await db.$transaction(async (tx) => {
      await tx.company.updateMany({
        where: { id },
        data: {
          name: input.name,
          domain: input.domain,
          size: input.size,
          ownerMembershipId: input.ownerMembershipId,
        },
      });
      if (input.tagIds) {
        await tx.companyTag.deleteMany({ where: { companyId: id } });
        if (input.tagIds.length > 0) {
          await tx.companyTag.createMany({
            data: input.tagIds.map((tagId) => ({ companyId: id, tagId })),
          } as never);
        }
      }
      if (validated) await this.customFields.syncValues(tx, 'company', id, validated);
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.prisma.db.company.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Empresa não encontrada');
    const db = this.prisma.db as unknown as {
      $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
    };
    await db.$transaction(async (tx) => {
      // FK Contact→Company é Restrict (SET NULL em FK composta anularia o
      // workspaceId): desvincula os contatos explicitamente antes de excluir
      await tx.contact.updateMany({ where: { companyId: id }, data: { companyId: null } });
      await this.customFields.deleteValues(tx, 'company', id);
      await tx.company.deleteMany({ where: { id } });
    });
  }

  private async validateReferences(
    input: {
      ownerMembershipId?: string | null;
      tagIds?: string[];
      domain?: string | null;
    },
    selfId?: string,
  ): Promise<void> {
    if (input.ownerMembershipId) {
      const owner = await this.prisma.db.membership.findFirst({
        where: { id: input.ownerMembershipId, status: 'active' },
      });
      if (!owner) throw new BadRequestException('Responsável inválido');
    }
    if (input.tagIds) await this.tags.assertTagsExist(input.tagIds);
    if (input.domain) {
      // no update, a própria linha não conta como conflito (reenvio do form)
      const clash = await this.prisma.db.company.findFirst({
        where: { domain: input.domain, ...(selfId ? { NOT: { id: selfId } } : {}) },
      });
      // conflito de domínio reporta claro (dado do próprio workspace)
      if (clash) throw new BadRequestException(`Já existe empresa com o domínio ${input.domain}`);
    }
  }

  private async toDtos(rows: CompanyRow[]): Promise<CompanyDto[]> {
    const [customFields, ownerNames] = await Promise.all([
      this.customFields.valuesByEntity(
        'company',
        rows.map((r) => r.id),
      ),
      this.resolveOwnerNames(rows.map((r) => r.ownerMembershipId)),
    ]);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      domain: row.domain,
      size: row.size as CompanyDto['size'],
      ownerMembershipId: row.ownerMembershipId,
      ownerName: row.ownerMembershipId ? (ownerNames.get(row.ownerMembershipId) ?? null) : null,
      tags: row.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color })),
      customFields: customFields.get(row.id) ?? {},
      contactCount: row._count.contacts,
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
