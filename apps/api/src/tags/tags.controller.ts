import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  CreateTagInput,
  TagDto,
  UpdateTagInput,
  createTagSchema,
  updateTagSchema,
} from '@veyra/contracts';
import { RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { TagsService } from './tags.service';

@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @RequirePermissions('contacts:read')
  @Get()
  list(): Promise<TagDto[]> {
    return this.tags.list();
  }

  @RequirePermissions('contacts:write')
  @Post()
  create(@Body(new ZodPipe(createTagSchema)) body: CreateTagInput): Promise<TagDto> {
    return this.tags.create(body);
  }

  @RequirePermissions('contacts:write')
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateTagSchema)) body: UpdateTagInput,
  ): Promise<TagDto> {
    return this.tags.update(id, body);
  }

  @RequirePermissions('contacts:write')
  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ ok: true }> {
    await this.tags.remove(id);
    return { ok: true };
  }
}
