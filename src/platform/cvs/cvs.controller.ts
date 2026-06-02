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
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { CreateCvDto } from './dto/create-cv.dto';
import { CvListQueryDto } from './dto/cv-list-query.dto';
import { CvsService } from './cvs.service';

const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;

@ApiTags('CVs')
@ApiBearerAuth()
@Public()
@UseGuards(AuthGuard('jwt'))
@Controller('api/cvs')
export class CvsController {
  constructor(private readonly cvs: CvsService) {}

  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'consentAccepted'],
      properties: {
        file: { type: 'string', format: 'binary' },
        title: { type: 'string', example: 'Software Engineer CV' },
        targetRole: { type: 'string', example: 'frontend_developer' },
        consentAccepted: { type: 'boolean', example: true },
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
  list(@CurrentUser() user: JwtUser, @Query() query: CvListQueryDto) {
    return this.cvs.list(user.userId, query);
  }

  @Get(':id')
  get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.cvs.get(user.userId, id);
  }

  @Get(':id/file')
  @Header('Cache-Control', 'private, no-store')
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
  async remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    await this.cvs.remove(user.userId, id);
    return { deleted: true };
  }
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, '_');
}
