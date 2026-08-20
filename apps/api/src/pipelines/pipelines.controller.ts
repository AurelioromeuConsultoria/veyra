import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  CreatePipelineInput,
  CreateStageInput,
  PipelineDto,
  ReorderStagesInput,
  StageDto,
  UpdatePipelineInput,
  UpdateStageInput,
  createPipelineSchema,
  createStageSchema,
  reorderStagesSchema,
  updatePipelineSchema,
  updateStageSchema,
} from '@veyra/contracts';
import { RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { PipelinesService } from './pipelines.service';

@Controller()
export class PipelinesController {
  constructor(private readonly pipelines: PipelinesService) {}

  @RequirePermissions('pipelines:read')
  @Get('pipelines')
  list(): Promise<PipelineDto[]> {
    return this.pipelines.list();
  }

  @RequirePermissions('pipelines:manage')
  @Post('pipelines')
  create(@Body(new ZodPipe(createPipelineSchema)) body: CreatePipelineInput): Promise<PipelineDto> {
    return this.pipelines.create(body);
  }

  @RequirePermissions('pipelines:manage')
  @Patch('pipelines/:id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updatePipelineSchema)) body: UpdatePipelineInput,
  ): Promise<PipelineDto> {
    return this.pipelines.update(id, body);
  }

  @RequirePermissions('pipelines:manage')
  @Delete('pipelines/:id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ ok: true }> {
    await this.pipelines.remove(id);
    return { ok: true };
  }

  @RequirePermissions('pipelines:manage')
  @Post('pipelines/:id/stages')
  createStage(
    @Param('id', new ParseUUIDPipe()) pipelineId: string,
    @Body(new ZodPipe(createStageSchema)) body: CreateStageInput,
  ): Promise<StageDto> {
    return this.pipelines.createStage(pipelineId, body);
  }

  @RequirePermissions('pipelines:manage')
  @Patch('stages/:id')
  updateStage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateStageSchema)) body: UpdateStageInput,
  ): Promise<StageDto> {
    return this.pipelines.updateStage(id, body);
  }

  @RequirePermissions('pipelines:manage')
  @Post('pipelines/:id/stages/reorder')
  async reorder(
    @Param('id', new ParseUUIDPipe()) pipelineId: string,
    @Body(new ZodPipe(reorderStagesSchema)) body: ReorderStagesInput,
  ): Promise<{ ok: true }> {
    await this.pipelines.reorderStages(pipelineId, body.stageIds);
    return { ok: true };
  }

  @RequirePermissions('pipelines:manage')
  @Delete('stages/:id')
  async removeStage(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ ok: true }> {
    await this.pipelines.removeStage(id);
    return { ok: true };
  }
}
