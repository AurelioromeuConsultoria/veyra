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
  CalendarEventDto,
  CreateCalendarEventInput,
  ListCalendarEventsInput,
  UpdateCalendarEventInput,
  createCalendarEventSchema,
  listCalendarEventsSchema,
  updateCalendarEventSchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { Idempotent } from '../common/idempotency.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { CalendarService } from './calendar.service';

@Controller('calendar/events')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @RequirePermissions('calendar:read')
  @Get()
  list(
    @Query(new ZodPipe(listCalendarEventsSchema)) query: ListCalendarEventsInput,
  ): Promise<CalendarEventDto[]> {
    return this.calendar.list(query);
  }

  @RequirePermissions('calendar:read')
  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<CalendarEventDto> {
    return this.calendar.get(id);
  }

  @RequirePermissions('calendar:write')
  @Idempotent()
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createCalendarEventSchema)) body: CreateCalendarEventInput,
  ): Promise<CalendarEventDto> {
    return this.calendar.create(auth, body);
  }

  @RequirePermissions('calendar:write')
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateCalendarEventSchema)) body: UpdateCalendarEventInput,
  ): Promise<CalendarEventDto> {
    return this.calendar.update(id, body);
  }

  @RequirePermissions('calendar:write')
  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ ok: true }> {
    await this.calendar.remove(id);
    return { ok: true };
  }
}
