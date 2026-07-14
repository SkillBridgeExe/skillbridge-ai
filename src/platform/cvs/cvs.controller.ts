import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
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
import { Throttle } from '@nestjs/throttler';
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
import { ComposedRoadmap } from '../../modules/roadmap/roadmap-composer';
import { RoadmapFromMatchDto } from '../cv-matches/dto/roadmap-from-match.dto';
import { CreateBuilderCvDto, UpdateBuilderCvDto } from './dto/builder-cv.dto';
import {
  AssistantAnalyzeRequestDto,
  AssistantExplainRequestDto,
  AssistantRewriteRequestDto,
  AssistantSmartQuestionsRequestDto,
  ExtractRequestDto,
} from './dto/cv-assistant.dto';
import {
  CareerTargetStoryRequestDto,
  CareerTargetStoryResponseDto,
} from './dto/career-target-story.dto';
import { StoryReadinessRequestDto, StoryReadinessResponseDto } from './dto/story-readiness.dto';
import { StoryApplyRequestDto, StoryApplyResponseDto } from './dto/story-apply.dto';
import { StoryExtractRequestDto, StoryExtractResponseDto } from './dto/story-extract.dto';
import { ProjectIntakeRequestDto, ProjectIntakeResponseDto } from './dto/project-intake.dto';
import { CreateCvDto } from './dto/create-cv.dto';
import { CvListQueryDto } from './dto/cv-list-query.dto';
import { RenameCvDto } from './dto/rename-cv.dto';
import { CreateCvVersionDto, CvVersionListQueryDto } from './dto/cv-version.dto';
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
    summary: 'List CVs for the current user',
    description:
      'Returns paginated CV summary records, optionally filtered by upload or builder origin. Full review content is returned by GET /api/cvs/{id}.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    example: 1,
    description: 'Page number, starting at 1.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 20, description: 'Items per page, max 50.' })
  @ApiQuery({
    name: 'cvKind',
    required: false,
    enum: ['UPLOADED', 'BUILT'],
    description: 'Filter CVs by uploaded diagnosis history or builder edit history.',
  })
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

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename a CV',
    description:
      'Updates only the display title of an owned CV (UPLOADED or BUILT). Does not touch the document, so unlike the builder autosave it works for uploaded CVs and never ships the canonical doc.',
  })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  @ApiBody({ type: RenameCvDto })
  rename(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: RenameCvDto) {
    return this.cvs.rename(user.userId, id, dto.title);
  }

  @Post(':id/versions')
  @ApiOperation({
    summary: 'Snapshot the current CV document as a version',
    description:
      'Saves a point-in-time snapshot of the CV canonical document for version history / restore.',
  })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  @ApiBody({ type: CreateCvVersionDto })
  createVersion(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CreateCvVersionDto,
  ) {
    return this.cvs.createVersion(user.userId, id, dto.label, dto.origin);
  }

  @Get(':id/versions')
  @ApiOperation({
    summary: 'List a CV version history',
    description:
      'Newest-first, paginated. Snapshot bodies are omitted; fetch one by id for the doc.',
  })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({
    name: 'limit',
    required: false,
    example: 20,
    description: 'Items per page, max 100 (covers the full 70-version retention cap).',
  })
  listVersions(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Query() query: CvVersionListQueryDto,
  ) {
    return this.cvs.listVersions(user.userId, id, query.page, query.limit);
  }

  @Get(':id/versions/:versionId')
  @ApiOperation({ summary: 'Get one CV version including its document snapshot' })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  @ApiParam({ name: 'versionId', description: 'Version ID.', format: 'uuid' })
  getVersion(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.cvs.getVersion(user.userId, id, versionId);
  }

  @Post(':id/versions/:versionId/restore')
  @ApiOperation({
    summary: 'Restore a CV version',
    description: 'Auto-snapshots the current document first (undoable), then overwrites it.',
  })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  @ApiParam({ name: 'versionId', description: 'Version ID.', format: 'uuid' })
  restoreVersion(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.cvs.restoreVersion(user.userId, id, versionId);
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

  // S4 abuse bound: OFF-TOPIC rejects refund the rewrite quota, so this LLM-burning endpoint
  // gets a tight per-user rate — no human rewrites 10+ fields a minute; junk spam hits 429
  // before the model is called.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
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

  @Post(':id/builder/assistant/explain')
  @ApiOperation({
    summary: 'CV Builder assistant — read-only "why is this weak?" (deterministic, no quota)',
    description:
      'Checks ownership, then explains the field from the SAME deterministic gap analysis that drives Turn-1 questions. Returns message + citedSignals; never a patch, never an LLM call.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  assistantExplain(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: AssistantExplainRequestDto,
  ) {
    return this.cvs.assistantExplain(user.userId, id, dto);
  }

  // Same abuse bound as /rewrite: this endpoint calls an LLM, so a tight per-user rate keeps
  // scripted spam from burning tokens before it hits 429.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/builder/assistant/smart-questions')
  @ApiOperation({
    summary: 'CV Builder assistant — role-aware smart questions (Turn-1.5, LLM, rate-limited)',
    description:
      'Checks ownership, reads target_role from the CV record server-side (never trusts the client), then delegates to the LLM smart-question generator. Falls back to the deterministic Turn-1 rule questions on any LLM/parse miss — never goes silent.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  smartQuestions(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: AssistantSmartQuestionsRequestDto,
  ) {
    return this.cvs.assistantSmartQuestions(user.userId, id, dto);
  }

  @Post(':id/builder/story')
  @ApiOperation({
    summary: 'Story→CV — infer a career target from a free narrative (deterministic, no quota)',
    description:
      'Checks ownership, then runs deterministic weighted role inference over the story. Abstains honestly (needs_user_input) when too weak/ambiguous — never fabricates a role.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  inferCareerTargetFromStory(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CareerTargetStoryRequestDto,
  ): Promise<CareerTargetStoryResponseDto> {
    return this.cvs.inferCareerTargetFromStory(user.userId, id, dto);
  }

  @Post(':id/builder/story/readiness')
  @ApiOperation({
    summary: 'Story→CV — gap + readiness vs a target role (deterministic, rubric-only, no quota)',
    description:
      "Checks ownership, reads the CV doc's structured skills, diffs them against the role rubric, and returns a readiness score (0-100 + band) + the missing/partial gap + a pointer to the roadmap flow. No LLM, no fabrication.",
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  computeStoryReadiness(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: StoryReadinessRequestDto,
  ): Promise<StoryReadinessResponseDto> {
    return this.cvs.computeStoryReadiness(user.userId, id, dto);
  }

  @Get(':id/role-roadmap/options')
  @ApiOperation({ summary: 'Preview learnable roadmap skill options from CV and selected role' })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  @ApiQuery({ name: 'role', required: true })
  @ApiQuery({ name: 'band', required: false, enum: ['intern', 'fresher', 'mid'] })
  roleRoadmapOptions(
    @CurrentUser() user: JwtUser,
    @Param('id') cvId: string,
    @Query('role') roleCode: string,
    @Query('band') band?: 'intern' | 'fresher' | 'mid',
  ) {
    return this.cvs.getRoleRoadmapOptions(user.userId, cvId, roleCode, band ?? 'fresher');
  }

  @Post(':id/role-roadmap')
  @ApiOperation({ summary: 'Generate a learning roadmap from CV and selected role baseline' })
  @ApiParam({ name: 'id', description: 'CV ID.', format: 'uuid' })
  @ApiQuery({ name: 'role', required: true })
  @ApiQuery({ name: 'band', required: false, enum: ['intern', 'fresher', 'mid'] })
  roleRoadmap(
    @CurrentUser() user: JwtUser,
    @Param('id') cvId: string,
    @Query('role') roleCode: string,
    @Query('band') band: 'intern' | 'fresher' | 'mid' | undefined,
    @Body() dto: RoadmapFromMatchDto,
  ): Promise<ComposedRoadmap> {
    return this.cvs.generateRoleRoadmap(user.userId, cvId, roleCode, band ?? 'fresher', dto);
  }

  @Post(':id/builder/story/apply-preview')
  @ApiOperation({
    summary: 'Story→CV — merge chosen projects/certs into the doc (stateless preview, no persist)',
    description:
      'Checks ownership, then deterministically merges the chosen story items into the supplied document (dedup by name, anti-empty) and returns the merged doc + a dedup report. Does NOT persist — the FE saves via PUT :id/builder.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  applyStoryPreview(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: StoryApplyRequestDto,
  ): Promise<StoryApplyResponseDto> {
    return this.cvs.applyStoryPreview(user.userId, id, dto);
  }

  @Post(':id/builder/story/extract')
  @ApiOperation({
    summary:
      'Story→CV — extract projects + certifications from a free narrative (deterministic + anti-fab)',
    description:
      'Checks ownership, then extracts grounded projects (LLM-proposed prose, code-gated) and certifications (pure pattern match). Never fabricates; degrades safely. Charges CV_BUILDER_REWRITE only on a non-degraded LLM result.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  extractProjectsCertsFromStory(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: StoryExtractRequestDto,
  ): Promise<StoryExtractResponseDto> {
    return this.cvs.extractProjectsCertsFromStory(user.userId, id, dto);
  }

  @Post(':id/builder/project/intake')
  @ApiOperation({
    summary: 'Story→CV — fill ONE project card from a short narrative (deterministic + anti-fab)',
    description:
      'Checks ownership, then extracts a single grounded project (LLM-proposed prose, code-gated: name must be grounded, tech from taxonomy, role/link from regex). Never fabricates; degrades safely. Charges CV_BUILDER_REWRITE only when a project was grounded.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  intakeProjectFromStory(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ProjectIntakeRequestDto,
  ): Promise<ProjectIntakeResponseDto> {
    return this.cvs.intakeProjectFromStory(user.userId, id, dto);
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

  @Post(':id/builder/assistant/extract')
  @ApiOperation({
    summary:
      'CV Builder assistant — extract structured fields from a free-text work-experience story',
    description:
      'Checks ownership, then turns the narrative into structured experience fields (company/position/dates/description/achievements). Anti-fabrication is enforced server-side. Consumes CV_BUILDER_REWRITE quota only when the extraction is not degraded.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  assistantExtract(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ExtractRequestDto,
  ) {
    return this.cvs.assistantExtract(user.userId, id, dto);
  }

  @Get(':id/builder/assistant/skills-nudge')
  @ApiOperation({
    summary:
      'CV Builder assistant — completeness nudges for the skills section (deterministic, no quota)',
    description:
      'Checks ownership, then flags thin/missing parts of the draft skills. Never invents skills.',
  })
  @ApiParam({ name: 'id', description: 'CV Builder draft ID.', format: 'uuid' })
  @ApiQuery({ name: 'lang', required: false, enum: ['vi', 'en'] })
  assistantSkillsNudge(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Query('lang') lang?: string,
  ) {
    return this.cvs.assistantSkillsNudge(user.userId, id, normalizeLang(lang));
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
