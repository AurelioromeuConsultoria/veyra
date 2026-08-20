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
  ContactDto,
  CreateContactInput,
  ImportContactsInput,
  ListContactsInput,
  Paginated,
  UpdateContactInput,
  createContactSchema,
  importContactsSchema,
  listContactsSchema,
  updateContactSchema,
} from '@veyra/contracts';
import { Throttle } from '@nestjs/throttler';
import { RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { ContactsService } from './contacts.service';

@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @RequirePermissions('contacts:read')
  @Get()
  list(
    @Query(new ZodPipe(listContactsSchema)) query: ListContactsInput,
  ): Promise<Paginated<ContactDto>> {
    return this.contacts.list(query);
  }

  @RequirePermissions('contacts:read')
  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<ContactDto> {
    return this.contacts.get(id);
  }

  @RequirePermissions('contacts:write')
  @Post()
  create(@Body(new ZodPipe(createContactSchema)) body: CreateContactInput): Promise<ContactDto> {
    return this.contacts.create(body);
  }

  @RequirePermissions('contacts:write')
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // até 5k contatos/min por IP
  @Post('import')
  import(
    @Body(new ZodPipe(importContactsSchema)) body: ImportContactsInput,
  ): Promise<{ imported: number }> {
    return this.contacts.import(body);
  }

  @RequirePermissions('contacts:write')
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateContactSchema)) body: UpdateContactInput,
  ): Promise<ContactDto> {
    return this.contacts.update(id, body);
  }

  @RequirePermissions('contacts:write')
  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ ok: true }> {
    await this.contacts.remove(id);
    return { ok: true };
  }
}
