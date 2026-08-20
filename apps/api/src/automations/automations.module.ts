import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';

/** Importa TasksModule: a ação cria tarefa na MESMA transação da execução. */
@Module({
  imports: [TasksModule],
  controllers: [AutomationsController],
  providers: [AutomationsService],
  exports: [AutomationsService],
})
export class AutomationsModule {}
