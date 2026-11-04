import { DealReplayGuard } from './deal-replay.guard';
import { Module } from '@nestjs/common';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { DealsController } from './deals.controller';
import { DealsService } from './deals.service';

@Module({
  imports: [PipelinesModule],
  controllers: [DealsController],
  providers: [DealsService, DealReplayGuard],
  exports: [DealsService],
})
export class DealsModule {}
