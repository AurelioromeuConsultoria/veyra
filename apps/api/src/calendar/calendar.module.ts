import { Module } from '@nestjs/common';
import { CalendarReplayGuard } from './calendar-replay.guard';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

@Module({
  controllers: [CalendarController],
  providers: [CalendarService, CalendarReplayGuard],
  exports: [CalendarService],
})
export class CalendarModule {}
