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
  AutomationDto,
  AutomationExecutionDto,
  CreateAutomationInput,
  UpdateAutomationInput,
  createAutomationSchema,
  updateAutomationSchema,
} from '@veyra/contracts';
import { z } from 'zod';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { Idempotent } from '../common/idempotency.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { AutomationsService } from './automations.service';

const listExecutionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

@Controller('automations')
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @RequirePermissions('automations:manage')
  @Get()
  list(): Promise<AutomationDto[]> {
    return this.automations.list();
  }

  /** O histórico mostra o que a automação FEZ: mesma permissão de configurá-la. */
  @RequirePermissions('automations:manage')
  @Get('executions')
  listExecutions(
    @Query(new ZodPipe(listExecutionsSchema)) query: { limit: number },
  ): Promise<AutomationExecutionDto[]> {
    return this.automations.listExecutions(query.limit);
  }

  @RequirePermissions('automations:manage')
  @Idempotent()
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createAutomationSchema)) body: CreateAutomationInput,
  ): Promise<AutomationDto> {
    return this.automations.create(auth, body);
  }

  @RequirePermissions('automations:manage')
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateAutomationSchema)) body: UpdateAutomationInput,
  ): Promise<AutomationDto> {
    return this.automations.update(auth, id, body);
  }

  @RequirePermissions('automations:manage')
  @Delete(':id')
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.automations.remove(auth, id);
    return { ok: true };
  }
}
