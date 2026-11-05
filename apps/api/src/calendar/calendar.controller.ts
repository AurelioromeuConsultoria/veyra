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
import { CalendarReplayGuard } from './calendar-replay.guard';
import { CalendarService } from './calendar.service';

/**
 * O texto dos eventos ligados a pessoas segue a regra do conteúdo protegido
 * (E8; ADR-061, adendo 8), aplicada no service a cada pedido.
 */
@Controller('calendar/events')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @RequirePermissions('calendar:read')
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listCalendarEventsSchema)) query: ListCalendarEventsInput,
  ): Promise<CalendarEventDto[]> {
    return this.calendar.list(auth, query);
  }

  @RequirePermissions('calendar:read')
  @Get(':id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CalendarEventDto> {
    return this.calendar.get(auth, id);
  }

  @RequirePermissions('calendar:write')
  // a repetição devolve o corpo com a regra de leitura de AGORA (ADR-061, adendo 8)
  @Idempotent({ replayGuard: CalendarReplayGuard })
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
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateCalendarEventSchema)) body: UpdateCalendarEventInput,
  ): Promise<CalendarEventDto> {
    return this.calendar.update(auth, id, body);
  }

  @RequirePermissions('calendar:write')
  @Delete(':id')
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.calendar.remove(auth, id);
    return { ok: true };
  }
}
