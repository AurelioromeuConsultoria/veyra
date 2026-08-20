import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { ProvisioningService } from './provisioning.service';

@Module({
  imports: [AuthModule],
  controllers: [MembersController, InvitesController],
  providers: [MembersService, InvitesService, ProvisioningService],
  exports: [ProvisioningService],
})
export class WorkspacesModule {}
