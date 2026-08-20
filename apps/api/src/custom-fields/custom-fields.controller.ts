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
  CreateCustomFieldInput,
  CustomFieldDto,
  UpdateCustomFieldInput,
  createCustomFieldSchema,
  customFieldEntitySchema,
  updateCustomFieldSchema,
} from '@veyra/contracts';
import { RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CustomFieldsService } from './custom-fields.service';

@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly customFields: CustomFieldsService) {}

  /** leitura liberada a quem lê contatos (o form precisa das definições) */
  @RequirePermissions('contacts:read')
  @Get()
  list(
    @Query('entityType', new ZodPipe(customFieldEntitySchema.optional()))
    entityType?: 'contact' | 'company',
  ): Promise<CustomFieldDto[]> {
    return this.customFields.listDefinitions(entityType);
  }

  /** definição de campo é configuração do workspace */
  @RequirePermissions('workspace:manage')
  @Post()
  create(
    @Body(new ZodPipe(createCustomFieldSchema)) body: CreateCustomFieldInput,
  ): Promise<CustomFieldDto> {
    return this.customFields.createDefinition(body);
  }

  @RequirePermissions('workspace:manage')
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateCustomFieldSchema)) body: UpdateCustomFieldInput,
  ): Promise<CustomFieldDto> {
    return this.customFields.updateDefinition(id, body);
  }

  @RequirePermissions('workspace:manage')
  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ ok: true }> {
    await this.customFields.removeDefinition(id);
    return { ok: true };
  }
}
