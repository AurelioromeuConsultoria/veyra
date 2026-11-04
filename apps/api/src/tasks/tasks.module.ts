import { TaskReplayGuard } from './task-replay.guard';
import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  controllers: [TasksController],
  providers: [TasksService, TaskReplayGuard],
  exports: [TasksService],
})
export class TasksModule {}
