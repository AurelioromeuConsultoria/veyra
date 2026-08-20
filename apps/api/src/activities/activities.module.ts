import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';

/** Global: todo service de domínio emite Activity dentro da própria transação. */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [ActivitiesController],
  providers: [ActivitiesService],
  exports: [ActivitiesService],
})
export class ActivitiesModule {}
