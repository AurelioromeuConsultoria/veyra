import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import {
  ChangeMemberRoleInput,
  MemberDto,
  RoleDto,
  changeMemberRoleSchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { MembersService } from './members.service';

@Controller()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @RequirePermissions('members:read')
  @Get('members')
  list(): Promise<MemberDto[]> {
    return this.members.listMembers();
  }

  @RequirePermissions('members:read')
  @Get('roles')
  roles(): Promise<RoleDto[]> {
    return this.members.listRoles();
  }

  @RequirePermissions('members:manage')
  @Patch('members/:membershipId/role')
  async changeRole(
    @CurrentAuth() auth: AuthContext,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Body(new ZodPipe(changeMemberRoleSchema)) body: ChangeMemberRoleInput,
  ): Promise<{ ok: true }> {
    await this.members.changeRole(auth, membershipId, body.roleId);
    return { ok: true };
  }

  @RequirePermissions('members:manage')
  @Delete('members/:membershipId')
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
  ): Promise<{ ok: true }> {
    await this.members.removeMember(auth, membershipId);
    return { ok: true };
  }
}
