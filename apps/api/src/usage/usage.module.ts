import { Global, Module } from '@nestjs/common';
import { PermissionCheckService } from '../auth/permission-check.service';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

/** Global: quase todo service de domínio consome quota na própria transação. */
@Global()
@Module({
  controllers: [UsageController],
  providers: [UsageService, PermissionCheckService],
  exports: [UsageService],
})
export class UsageModule {}
