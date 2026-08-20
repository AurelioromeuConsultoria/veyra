import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  CreateNoteInput,
  ListNotesInput,
  NoteDto,
  createNoteSchema,
  listNotesSchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { NotesService } from './notes.service';

@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @RequirePermissions('tasks:read')
  @Get()
  list(@Query(new ZodPipe(listNotesSchema)) query: ListNotesInput): Promise<NoteDto[]> {
    return this.notes.list(query);
  }

  @RequirePermissions('tasks:write')
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createNoteSchema)) body: CreateNoteInput,
  ): Promise<NoteDto> {
    return this.notes.create(auth, body);
  }

  @RequirePermissions('tasks:write')
  @Delete(':id')
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.notes.remove(auth, id);
    return { ok: true };
  }
}
