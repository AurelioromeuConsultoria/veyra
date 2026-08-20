import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  BoardDto,
  CreateDealInput,
  DealDto,
  ListDealsInput,
  MoveDealInput,
  UpdateDealInput,
  createDealSchema,
  listDealsSchema,
  moveDealSchema,
  updateDealSchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DealsService } from './deals.service';

@Controller('deals')
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @RequirePermissions('pipelines:read')
  @Get('board')
  board(@Query(new ZodPipe(listDealsSchema)) query: ListDealsInput): Promise<BoardDto> {
    return this.deals.board(query.pipelineId);
  }

  @RequirePermissions('pipelines:read')
  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<DealDto> {
    return this.deals.get(id);
  }

  @RequirePermissions('deals:write')
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createDealSchema)) body: CreateDealInput,
  ): Promise<DealDto> {
    return this.deals.create(auth, body);
  }

  @RequirePermissions('deals:write')
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateDealSchema)) body: UpdateDealInput,
  ): Promise<DealDto> {
    return this.deals.update(id, body);
  }

  @RequirePermissions('deals:write')
  @Post(':id/move')
  move(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(moveDealSchema)) body: MoveDealInput,
  ): Promise<DealDto> {
    return this.deals.move(auth, id, body);
  }

  @RequirePermissions('deals:write')
  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ ok: true }> {
    await this.deals.remove(id);
    return { ok: true };
  }
}
