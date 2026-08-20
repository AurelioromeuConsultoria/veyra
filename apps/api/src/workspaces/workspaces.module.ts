import { Module } from '@nestjs/common';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { ProvisioningService } from './provisioning.service';

@Module({
  controllers: [MembersController],
  providers: [MembersService, ProvisioningService],
  exports: [ProvisioningService],
})
export class WorkspacesModule {}
