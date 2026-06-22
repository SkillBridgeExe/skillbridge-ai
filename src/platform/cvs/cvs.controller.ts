import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
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
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { EvaluateSectionRequestDto } from '../../modules/cv-builder/dto/evaluate-section.dto';
import { RewriteRequestDto } from '../../modules/cv-builder/dto/rewrite.dto';
import { CreateBuilderCvDto, UpdateBuilderCvDto } from './dto/builder-cv.dto';
import { AssistantAnalyzeRequestDto, AssistantRewriteRequestDto } from './dto/cv-assistant.dto';
import { CreateCvDto } from './dto/create-cv.dto';
import { CvListQueryDto } from './dto/cv-list-query.dto';
import { CvsService } from './cvs.service';
import {
  CREATE_BUILDER_BODY_EXAMPLES,
  EVALUATE_BUILDER_BODY_EXAMPLES,
  REWRITE_BUILDER_BODY_EXAMPLES,
  UPDATE_BUILDER_BODY_EXAMPLES,
} from './openapi/cv-builder-openapi.examples';

const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;

@ApiTags('CVs')
@Public()
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

  @Post('builder')
  @ApiOperation({
    summary: 'Create a CV Builder draft',
    description:
      'Creates a BUILT CV row seeded from an owned CV parsed_json, the latest parsed upload, or an empty canonical CV. Does not upload a file or run AI diagnosis.',
  })
  @ApiBody({
    type: CreateBuilderCvDto,
    description:
      'All fields are optional. Omit sourceCvId to seed from latest parsed upload or create a blank CV.',
    examples: CREATE_BUILDER_BODY_EXAMPLES,
  })
  createBuilder(@CurrentUser() user: JwtUser, @Body() dto: CreateBuilderCvDto) {
    return this.cvs.createBuilderDraft(user.userId, dto);
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

  @Get(':id/interview-plan')
  @ApiOperation({
    summary: 'Generate a gap-targeted interview preparation plan for a diagnosed CV',
  })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  @ApiQuery({ name: 'role', required: true, example: 'frontend_developer' })
  @ApiQuery({ name: 'lang', required: false, enum: ['vi', 'en'] })
  interviewPlan(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Query('role') role?: string,
    @Query('lang') lang?: string,
  ) {
    return this.cvs.getInterviewPlan(user.userId, id, role, normalizeLang(lang));
  }

  @Get(':id/github-evidence')
  @ApiOperation({
    summary: 'Analyze public GitHub repository evidence for a CV with explicit user consent',
  })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  @ApiQuery({ name: 'username', required: false, example: 'octocat' })
  @ApiQuery({ name: 'consent', required: false, example: true })
  @ApiQuery({ name: 'lang', required: false, enum: ['vi', 'en'] })
  githubEvidence(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Query('username') username?: string,
    @Query('consent') consent?: string,
    @Query('lang') lang?: string,
  ) {
    return this.cvs.getGithubEvidence(
      user.userId,
      id,
      username ?? '',
      consent === 'true',
      normalizeLang(lang),
    );
  }

  @Put(':id/builder')
  @ApiOperation({
    summary: 'Autosave a CV Builder draft',
    description: 'Updates parsed_json on an owned BUILT CV row. Does not parse or score.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  @ApiBody({
    type: UpdateBuilderCvDto,
    description:
      'parsedJson is required and must be the full CanonicalCvDocument. title, targetRole, and language are optional.',
    examples: UPDATE_BUILDER_BODY_EXAMPLES,
  })
  updateBuilder(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateBuilderCvDto,
  ) {
    return this.cvs.updateBuilderDraft(user.userId, id, dto);
  }

  @Post(':id/builder/evaluate')
  @ApiOperation({
    summary: 'Evaluate one CV Builder section',
    description:
      'Checks ownership, then delegates to the internal deterministic section evaluator.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  @ApiBody({
    type: EvaluateSectionRequestDto,
    description:
      'section and content are required. role_code and language are optional. content shape depends on section.',
    examples: EVALUATE_BUILDER_BODY_EXAMPLES,
  })
  evaluateBuilderSection(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: EvaluateSectionRequestDto,
  ) {
    return this.cvs.evaluateBuilderSection(user.userId, id, dto);
  }

  @Post(':id/builder/rewrite')
  @ApiOperation({
    summary: 'Rewrite one CV Builder field',
    description: 'Checks ownership, then delegates to the internal AI rewrite service.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  @ApiBody({
    type: RewriteRequestDto,
    description:
      'text and mode are required. target_lang is required only for translate. instruction is required only for custom.',
    examples: REWRITE_BUILDER_BODY_EXAMPLES,
  })
  rewriteBuilderText(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: RewriteRequestDto,
  ) {
    return this.cvs.rewriteBuilderText(user.userId, id, dto);
  }

  @Post(':id/builder/assistant/analyze')
  @ApiOperation({
    summary: 'CV Builder assistant — analyze a field and ask (Turn-1, deterministic, no quota)',
    description:
      'Checks ownership, then detects which strong-bullet ingredients are missing and asks.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  assistantAnalyze(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: AssistantAnalyzeRequestDto,
  ) {
    return this.cvs.assistantAnalyze(user.userId, id, dto);
  }

  @Post(':id/builder/assistant/rewrite')
  @ApiOperation({
    summary: 'CV Builder assistant — rewrite a bullet from grounded answers (Turn-2)',
    description:
      'Grounds the rewrite in the user answers and rejects any fabricated number/tech. Consumes CV_BUILDER_REWRITE quota only when a patch is produced.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  assistantRewrite(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: AssistantRewriteRequestDto,
  ) {
    return this.cvs.assistantRewrite(user.userId, id, dto);
  }

  @Post(':id/render-pdf')
  @Header('Cache-Control', 'private, no-store')
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary: 'Render a CV Builder draft as Harvard PDF',
    description:
      'Renders from parsed_json on demand and returns the PDF bytes without GCS storage.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  @ApiOkResponse({
    description: 'Raw PDF file bytes. This endpoint does not return the JSON response envelope.',
    content: {
      'application/pdf': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async renderPdf(@CurrentUser() user: JwtUser, @Param('id') id: string, @Res() res: Response) {
    const rendered = await this.cvs.renderPdf(user.userId, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', rendered.buffer.length.toString());
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizeFileName(rendered.fileName)}"`,
    );
    res.end(rendered.buffer);
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

function normalizeLang(value: string | undefined): 'vi' | 'en' {
  return value === 'en' ? 'en' : 'vi';
}
