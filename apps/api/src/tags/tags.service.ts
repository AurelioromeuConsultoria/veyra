import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateTagInput, TagDto, UpdateTagInput } from '@veyra/contracts';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<TagDto[]> {
    const [tags, contactCounts, companyCounts] = await Promise.all([
      this.prisma.db.tag.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.db.contactTag.groupBy({ by: ['tagId'], _count: true } as never),
      this.prisma.db.companyTag.groupBy({ by: ['tagId'], _count: true } as never),
    ]);
    const usage = new Map<string, number>();
    for (const row of [...(contactCounts as never[]), ...(companyCounts as never[])]) {
      const { tagId, _count } = row as { tagId: string; _count: number };
      usage.set(tagId, (usage.get(tagId) ?? 0) + _count);
    }
    return tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      usageCount: usage.get(tag.id) ?? 0,
    }));
  }

  async create(input: CreateTagInput): Promise<TagDto> {
    const existing = await this.prisma.db.tag.findFirst({ where: { name: input.name } });
    if (existing) throw new BadRequestException(`Já existe uma tag "${input.name}"`);
    const tag = await this.prisma.db.tag.create({
      data: { name: input.name, color: input.color },
    } as never);
    return { id: tag.id, name: tag.name, color: tag.color, usageCount: 0 };
  }

  async update(id: string, input: UpdateTagInput): Promise<TagDto> {
    const { count } = await this.prisma.db.tag.updateMany({
      where: { id },
      data: { name: input.name, color: input.color },
    });
    if (count === 0) throw new NotFoundException('Tag não encontrada');
    const [tag, contactUses, companyUses] = await Promise.all([
      this.prisma.db.tag.findFirst({ where: { id } }),
      this.prisma.db.contactTag.count({ where: { tagId: id } }),
      this.prisma.db.companyTag.count({ where: { tagId: id } }),
    ]);
    return {
      id: tag!.id,
      name: tag!.name,
      color: tag!.color,
      usageCount: contactUses + companyUses,
    };
  }

  async remove(id: string): Promise<void> {
    // cascade das FKs compostas remove as junções contact/company
    const { count } = await this.prisma.db.tag.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException('Tag não encontrada');
  }

  /** Garante que todos os tagIds existem NESTE workspace (usado por contacts/companies). */
  async assertTagsExist(tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) return;
    const found = await this.prisma.db.tag.count({ where: { id: { in: tagIds } } });
    if (found !== new Set(tagIds).size) {
      throw new BadRequestException('Uma ou mais tags não existem');
    }
  }
}
