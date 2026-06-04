import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
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
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { CreateCvDto } from './dto/create-cv.dto';
import { CvListQueryDto } from './dto/cv-list-query.dto';
import { CvsService } from './cvs.service';

const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;

@ApiTags('CVs')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/cvs')
export class CvsController {
  constructor(private readonly cvs: CvsService) {}

  @Post()
  @ApiOperation({
    summary: 'Upload a CV and run the first AI diagnosis',
    description:
      'Uploads a PDF/DOCX/image CV, extracts text, calls the CV diagnosis AI flow, persists the CV/skills/review trace, and returns the review in the response.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'consentAccepted'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'CV file. Supported: PDF, DOCX, PNG, JPG, WEBP. Max 5MB.',
        },
        title: {
          type: 'string',
          example: 'Software Engineer CV',
          description: 'Optional display title. Defaults to the original file name.',
        },
        targetRole: {
          type: 'string',
          example: 'frontend_developer',
          description:
            'Optional canonical role code for role-specific scoring. Examples: frontend_developer, backend_developer, fullstack_developer, data_analyst, mobile_developer, devops_engineer, qa_tester, ai_ml_engineer.',
        },
        consentAccepted: {
          type: 'boolean',
          example: true,
          description: 'Must be true. Confirms the user consents to CV personal-data processing.',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_CV_FILE_BYTES },
    }),
  )
  create(
    @CurrentUser() user: JwtUser,
    @Body() dto: CreateCvDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.cvs.create(user.userId, dto, file);
  }

  @Get()
  @ApiOperation({
    summary: 'List uploaded CVs for the current user',
    description:
      'Returns paginated CV summary records. Full review content is returned by GET /api/cvs/{id}.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    example: 1,
    description: 'Page number, starting at 1.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 20, description: 'Items per page, max 50.' })
  list(@CurrentUser() user: JwtUser, @Query() query: CvListQueryDto) {
    return this.cvs.list(user.userId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get CV detail and latest persisted diagnosis review',
    description:
      'Returns one CV owned by the current user, normalized skills, and the latest persisted cv_review result when available.',
  })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.cvs.get(user.userId, id);
  }

  @Get(':id/file')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Download the original uploaded CV file',
    description: 'Streams the original CV file from private storage for the current user.',
  })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  async download(@CurrentUser() user: JwtUser, @Param('id') id: string, @Res() res: Response) {
    const { cv, file } = await this.cvs.download(user.userId, id);
    res.setHeader('Content-Type', file.contentType ?? 'application/octet-stream');
    if (file.contentLength !== null) {
      res.setHeader('Content-Length', file.contentLength.toString());
    }
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizeFileName(cv.originalFileName ?? `${cv.id}-cv`)}`,
    );
    file.body.pipe(res);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Soft delete a CV',
    description:
      'Deletes the private CV file from storage when present and soft-deletes the CV row.',
  })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  async remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    await this.cvs.remove(user.userId, id);
    return { deleted: true };
  }
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, '_');
}
