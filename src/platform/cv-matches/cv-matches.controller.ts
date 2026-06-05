import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
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
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { CreateCvMatchDto } from './dto/create-cv-match.dto';
import { CvMatchListQueryDto } from './dto/cv-match-list-query.dto';
import { CvMatchesService } from './cv-matches.service';

const MAX_JD_FILE_BYTES = 5 * 1024 * 1024;

@ApiTags('CV Matches')
@ApiBearerAuth()
@Public()
@UseGuards(AuthGuard('jwt'))
@Controller('api/cvs/:cvId')
export class CvMatchesController {
  constructor(private readonly matches: CvMatchesService) {}

  @Post('match')
  @ApiOperation({
    summary: 'Match a CV against a pasted job description',
    description:
      'Stores the user-provided JD, runs the deterministic CV/JD match flow, persists the result, and returns the match detail.',
  })
  @ApiConsumes('application/json')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['jdText'],
      properties: {
        jdText: {
          type: 'string',
          description: 'Raw JD text for paste mode.',
        },
        title: {
          type: 'string',
          example: 'Frontend Developer JD',
          description: 'Optional.',
        },
        targetRole: {
          type: 'string',
          example: 'frontend_developer',
          description: 'Optional. Falls back to the CV targetRole when omitted.',
        },
      },
    },
  })
  @ApiParam({ name: 'cvId', format: 'uuid' })
  create(@CurrentUser() user: JwtUser, @Param('cvId') cvId: string, @Body() dto: CreateCvMatchDto) {
    return this.matches.createMatch(user.userId, cvId, dto);
  }

  @Post('match/file')
  @ApiOperation({
    summary: 'Match a CV against an uploaded job description file',
    description:
      'Stores extracted text from a user-uploaded JD file, runs the CV/JD match flow, persists the result, and returns the match detail.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'JD file. Supported: TXT, PDF, DOCX. Max 5MB.',
        },
        title: {
          type: 'string',
          example: 'Frontend Developer JD',
          description: 'Optional. Defaults to the uploaded file name when omitted.',
        },
        targetRole: {
          type: 'string',
          example: 'frontend_developer',
          description: 'Optional. Falls back to the CV targetRole when omitted.',
        },
      },
    },
  })
  @ApiParam({ name: 'cvId', format: 'uuid' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_JD_FILE_BYTES },
    }),
  )
  createFromFile(
    @CurrentUser() user: JwtUser,
    @Param('cvId') cvId: string,
    @Body() dto: CreateCvMatchDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.matches.createMatch(user.userId, cvId, dto, file);
  }

  @Get('matches')
  @ApiOperation({ summary: 'List persisted CV/JD match history for a CV' })
  @ApiParam({ name: 'cvId', format: 'uuid' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  list(
    @CurrentUser() user: JwtUser,
    @Param('cvId') cvId: string,
    @Query() query: CvMatchListQueryDto,
  ) {
    return this.matches.listMatches(user.userId, cvId, query);
  }

  @Get('matches/:matchId')
  @ApiOperation({ summary: 'Get one persisted CV/JD match result' })
  @ApiParam({ name: 'cvId', format: 'uuid' })
  @ApiParam({ name: 'matchId', format: 'uuid' })
  get(
    @CurrentUser() user: JwtUser,
    @Param('cvId') cvId: string,
    @Param('matchId') matchId: string,
  ) {
    return this.matches.getMatch(user.userId, cvId, matchId);
  }
}
