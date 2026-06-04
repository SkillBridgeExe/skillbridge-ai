import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { ReplaceUserSkillsDto } from './dto/replace-user-skills.dto';
import { SkillListQueryDto } from './dto/skill-list-query.dto';
import { UpdateUserProfileDto } from './dto/update-user-profile.dto';
import { UsersService } from './users.service';

const MAX_AVATAR_FILE_BYTES = 2 * 1024 * 1024;

@ApiTags('Users')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me/profile')
  @ApiOperation({ summary: 'Get the current user profile and skills' })
  profile(@CurrentUser() user: JwtUser) {
    return this.users.getCurrentUserAggregate(user.userId);
  }

  @Patch('me/profile')
  @ApiOperation({ summary: 'Update the current user profile' })
  updateProfile(@CurrentUser() user: JwtUser, @Body() dto: UpdateUserProfileDto) {
    return this.users.updateProfile(user.userId, dto);
  }

  @Post('me/avatar')
  @ApiOperation({ summary: 'Upload or replace the current user avatar' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Avatar image. Supported: PNG, JPG, WEBP. Max 2MB.',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_AVATAR_FILE_BYTES },
    }),
  )
  uploadAvatar(@CurrentUser() user: JwtUser, @UploadedFile() file: Express.Multer.File) {
    return this.users.uploadAvatar(user.userId, file);
  }

  @Get('me/avatar')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Download the current uploaded avatar' })
  async downloadAvatar(@CurrentUser() user: JwtUser, @Res() res: Response) {
    const { file } = await this.users.downloadAvatar(user.userId);
    res.setHeader('Content-Type', file.contentType ?? 'application/octet-stream');
    if (file.contentLength !== null) {
      res.setHeader('Content-Length', file.contentLength.toString());
    }
    res.setHeader('Content-Disposition', 'inline; filename="avatar"');
    file.body.pipe(res);
  }

  @Delete('me/avatar')
  @ApiOperation({ summary: 'Delete the current user avatar' })
  removeAvatar(@CurrentUser() user: JwtUser) {
    return this.users.removeAvatar(user.userId);
  }

  @Get('me/skills')
  @ApiOperation({ summary: 'List skills for the current user' })
  skills(@CurrentUser() user: JwtUser) {
    return this.users.listCurrentUserSkills(user.userId);
  }

  @Put('me/skills')
  @ApiOperation({ summary: 'Replace skills for the current user' })
  replaceSkills(@CurrentUser() user: JwtUser, @Body() dto: ReplaceUserSkillsDto) {
    return this.users.replaceSkills(user.userId, dto);
  }
}

@ApiTags('Skills')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/skills')
export class SkillsController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Search canonical skills for profile editing' })
  @ApiQuery({ name: 'query', required: false, example: 'react' })
  @ApiQuery({ name: 'category', required: false, example: 'frontend_framework' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  list(@Query() query: SkillListQueryDto) {
    return this.users.listSkills(query);
  }
}
