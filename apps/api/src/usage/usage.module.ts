import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

/** Global: quase todo service de domínio consome quota na própria transação. */
@Global()
@Module({
  // AuthModule exporta o `PermissionsService`, usado pelo controller para
  // decidir CAMPO (situação comercial) — não rota
  imports: [AuthModule],
  controllers: [UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
