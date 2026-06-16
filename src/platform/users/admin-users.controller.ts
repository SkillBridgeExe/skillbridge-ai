import { Body, Controller, Get, Param, Patch, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminUsersService } from './admin-users.service';
import {
  AdminListUsersQueryDto,
  AdminUserSummaryQueryDto,
  ReplaceAdminUserRolesDto,
  UpdateAdminUserStatusDto,
} from './dto/admin-users.dto';

@ApiTags('Admin Users')
@ApiBearerAuth()
@Controller('api/admin/users')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get()
  listUsers(@Query() query: AdminListUsersQueryDto) {
    return this.adminUsers.listUsers(query);
  }

  @Get('summary')
  getSummary(@Query() query: AdminUserSummaryQueryDto) {
    return this.adminUsers.getSummary(query);
  }

  @Get(':id')
  getUserDetail(@Param('id') id: string) {
    return this.adminUsers.getUserDetail(id);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: UpdateAdminUserStatusDto,
  ) {
    return this.adminUsers.updateUserStatus(user.userId, id, body);
  }

  @Put(':id/roles')
  replaceRoles(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: ReplaceAdminUserRolesDto,
  ) {
    return this.adminUsers.replaceUserRoles(user.userId, id, body);
  }
}
