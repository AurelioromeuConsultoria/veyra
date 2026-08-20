import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreatePipelineInput,
  CreateStageInput,
  PipelineDto,
  StageDto,
  UpdatePipelineInput,
  UpdateStageInput,
} from '@veyra/contracts';
import { PrismaService, type Db } from '../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

/** Stages padrão — usados no provisionamento, no backfill (migration) e no create. */
export const DEFAULT_STAGES: ReadonlyArray<{
  name: string;
  order: number;
  probability: number;
  type: 'open' | 'won' | 'lost';
}> = [
  { name: 'Novo', order: 0, probability: 10, type: 'open' },
  { name: 'Qualificado', order: 1, probability: 30, type: 'open' },
  { name: 'Proposta', order: 2, probability: 60, type: 'open' },
  { name: 'Fechamento', order: 3, probability: 85, type: 'open' },
  { name: 'Ganhou', order: 4, probability: 100, type: 'won' },
  { name: 'Perdeu', order: 5, probability: 0, type: 'lost' },
];

type StageRow = {
  id: string;
  name: string;
  order: number;
  probability: number | null;
  type: 'open' | 'won' | 'lost';
};
type PipelineRow = { id: string; name: string; defaultMark: boolean | null; stages: StageRow[] };

@Injectable()
export class PipelinesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<PipelineDto[]> {
    const rows = (await this.prisma.db.pipeline.findMany({
      include: { stages: { orderBy: { order: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    } as never)) as unknown as PipelineRow[];
    return rows.map((row) => this.toDto(row));
  }

  /** Resolve o pipeline padrão do workspace (garantido pelo backfill/seed). */
  async resolveDefault(): Promise<string> {
    const row = await this.prisma.db.pipeline.findFirst({ where: { defaultMark: true } });
    if (!row) throw new NotFoundException('Workspace sem pipeline padrão');
    return row.id;
  }

  async create(input: CreatePipelineInput): Promise<PipelineDto> {
    const db = this.prisma.db as unknown as TxRunner;
    const id = await db.$transaction(async (tx) => {
      const pipeline = await tx.pipeline.create({ data: { name: input.name } } as never);
      await tx.stage.createMany({
        data: DEFAULT_STAGES.map((stage) => ({ ...stage, pipelineId: pipeline.id })),
      } as never);
      return pipeline.id;
    });
    return this.get(id);
  }

  async update(id: string, input: UpdatePipelineInput): Promise<PipelineDto> {
    const existing = await this.prisma.db.pipeline.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Pipeline não encontrado');
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      if (input.isDefault) {
        // troca de default: o anterior perde a marca (unique estrutural TRUE/NULL)
        await tx.pipeline.updateMany({
          where: { defaultMark: true },
          data: { defaultMark: null },
        });
        await tx.pipeline.updateMany({ where: { id }, data: { defaultMark: true } });
      }
      if (input.name) {
        await tx.pipeline.updateMany({ where: { id }, data: { name: input.name } });
      }
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const existing = (await this.prisma.db.pipeline.findFirst({
      where: { id },
    })) as { defaultMark: boolean | null } | null;
    if (!existing) throw new NotFoundException('Pipeline não encontrado');
    if (existing.defaultMark) {
      throw new ConflictException('Defina outro pipeline como padrão antes de excluir este');
    }
    // precheck amigável; corrida residual vira P2003 → 409 pelo filtro global
    const deals = await this.prisma.db.deal.count({ where: { pipelineId: id } });
    if (deals > 0) {
      throw new ConflictException(
        `Este pipeline tem ${deals} oportunidade(s) — mova ou exclua antes`,
      );
    }
    await this.prisma.db.pipeline.deleteMany({ where: { id } }); // stages caem por cascade
  }

  async createStage(pipelineId: string, input: CreateStageInput): Promise<StageDto> {
    const pipeline = await this.prisma.db.pipeline.findFirst({ where: { id: pipelineId } });
    if (!pipeline) throw new NotFoundException('Pipeline não encontrado');
    const last = await this.prisma.db.stage.findFirst({
      where: { pipelineId },
      orderBy: { order: 'desc' },
    });
    const stage = (await this.prisma.db.stage.create({
      data: {
        pipelineId,
        name: input.name,
        type: input.type,
        probability: input.probability ?? null,
        order: (last?.order ?? -1) + 1,
      },
    } as never)) as unknown as StageRow;
    return this.stageDto(stage);
  }

  async updateStage(stageId: string, input: UpdateStageInput): Promise<StageDto> {
    const { count } = await this.prisma.db.stage.updateMany({
      where: { id: stageId },
      data: { name: input.name, probability: input.probability },
    });
    if (count === 0) throw new NotFoundException('Estágio não encontrado');
    const stage = (await this.prisma.db.stage.findFirst({
      where: { id: stageId },
    })) as unknown as StageRow;
    return this.stageDto(stage);
  }

  async reorderStages(pipelineId: string, stageIds: string[]): Promise<void> {
    const stages = await this.prisma.db.stage.findMany({ where: { pipelineId } });
    const current = new Set(stages.map((stage) => stage.id));
    const incoming = new Set(stageIds);
    if (current.size !== incoming.size || [...current].some((id) => !incoming.has(id))) {
      throw new BadRequestException(
        'A reordenação precisa conter exatamente os estágios do pipeline',
      );
    }
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      for (const [index, id] of stageIds.entries()) {
        await tx.stage.updateMany({ where: { id, pipelineId }, data: { order: index } });
      }
    });
  }

  async removeStage(stageId: string): Promise<void> {
    const stage = await this.prisma.db.stage.findFirst({ where: { id: stageId } });
    if (!stage) throw new NotFoundException('Estágio não encontrado');
    // precheck amigável (ajuste #7); corrida residual → P2003 → 409 pelo filtro
    const deals = await this.prisma.db.deal.count({ where: { stageId } });
    if (deals > 0) {
      throw new ConflictException(
        `Este estágio tem ${deals} oportunidade(s) — mova antes de excluir`,
      );
    }
    await this.prisma.db.stage.deleteMany({ where: { id: stageId } });
  }

  private async get(id: string): Promise<PipelineDto> {
    const row = (await this.prisma.db.pipeline.findFirst({
      where: { id },
      include: { stages: { orderBy: { order: 'asc' } } },
    } as never)) as unknown as PipelineRow | null;
    if (!row) throw new NotFoundException('Pipeline não encontrado');
    return this.toDto(row);
  }

  private toDto(row: PipelineRow): PipelineDto {
    return {
      id: row.id,
      name: row.name,
      isDefault: row.defaultMark === true,
      stages: row.stages.map((stage) => this.stageDto(stage)),
    };
  }

  private stageDto(stage: StageRow): StageDto {
    return {
      id: stage.id,
      name: stage.name,
      order: stage.order,
      probability: stage.probability,
      type: stage.type,
    };
  }
}
