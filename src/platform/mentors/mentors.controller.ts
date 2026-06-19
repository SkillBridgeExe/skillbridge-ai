import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { DownloadedFile } from '../../infrastructure/storage/gcs-storage.service';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  AdminListMentorsQueryDto,
  ListMentorsQueryDto,
  UpdateAdminMentorStatusDto,
  UpdateMentorProfileDto,
} from './dto/mentor-profile.dto';
import { MentorsService } from './mentors.service';

@ApiTags('Mentors')
@Public()
@Controller('api/mentors')
export class MentorsController {
  constructor(private readonly mentors: MentorsService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Get mentor marketplace summary statistics' })
  summary() {
    return this.mentors.getPublicSummary();
  }

  @Get('filters')
  @ApiOperation({ summary: 'Get available mentor marketplace filters' })
  filters() {
    return this.mentors.getPublicFilters();
  }

  @Get()
  @ApiOperation({ summary: 'List approved public mentor profiles' })
  list(@Query() query: ListMentorsQueryDto) {
    return this.mentors.listPublicMentors(query);
  }

  @Get(':slug/avatar')
  @ApiOperation({ summary: 'Download an approved mentor avatar' })
  async avatar(@Param('slug') slug: string, @Res() response: Response) {
    streamAvatar(response, await this.mentors.getPublicAvatar(slug));
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a public mentor profile by slug' })
  detail(@Param('slug') slug: string) {
    return this.mentors.getPublicProfile(slug);
  }
}

@ApiTags('Mentor Profile')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('MENTOR')
@Controller('api/mentors/me/profile')
export class MentorSelfProfileController {
  constructor(private readonly mentors: MentorsService) {}

  @Get()
  @ApiOperation({ summary: 'Get the current mentor profile draft or approved profile' })
  profile(@CurrentUser() user: JwtUser) {
    return this.mentors.getMyProfile(user.userId);
  }

  @Patch()
  @ApiOperation({ summary: 'Update the current mentor profile' })
  update(@CurrentUser() user: JwtUser, @Body() body: UpdateMentorProfileDto) {
    return this.mentors.updateMyProfile(user.userId, body);
  }

  @Post('submit')
  @ApiOperation({ summary: 'Submit the current mentor profile for admin review' })
  submit(@CurrentUser() user: JwtUser) {
    return this.mentors.submitMyProfile(user.userId);
  }
}

@ApiTags('Admin Mentors')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
@Controller('api/admin/mentors')
export class AdminMentorsController {
  constructor(private readonly mentors: MentorsService) {}

  @Get()
  @ApiOperation({ summary: 'List mentor profiles for admin review' })
  list(@Query() query: AdminListMentorsQueryDto) {
    return this.mentors.listAdminProfiles(query);
  }

  @Get(':profileId/avatar')
  @ApiOperation({ summary: 'Download a mentor avatar for admin review' })
  async avatar(@Param('profileId') profileId: string, @Res() response: Response) {
    streamAvatar(response, await this.mentors.getAdminAvatar(profileId));
  }

  @Patch(':profileId/status')
  @ApiOperation({ summary: 'Approve, reject, or suspend a mentor profile' })
  updateStatus(
    @CurrentUser() user: JwtUser,
    @Param('profileId') profileId: string,
    @Body() body: UpdateAdminMentorStatusDto,
  ) {
    return this.mentors.updateAdminStatus(user.userId, profileId, body);
  }
}

function streamAvatar(response: Response, file: DownloadedFile): void {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Content-Type', file.contentType ?? 'application/octet-stream');
  if (file.contentLength !== null) {
    response.setHeader('Content-Length', file.contentLength.toString());
  }
  response.setHeader('Content-Disposition', 'inline; filename="mentor-avatar"');
  file.body.pipe(response);
}
