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
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { BusinessProfileStatus } from '../../database/entities/business-profile.entity';
import { JobReportStatus } from '../../database/entities/job-report.entity';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminBusinessJobsService } from './admin-business-jobs.service';
import { BusinessApplicationService } from './business-application.service';
import { BusinessJobService } from './business-job.service';
import { CandidateJobService } from './candidate-job.service';
import { CompanyProfileService } from './company-profile.service';
import {
  AdminBusinessStatusDto,
  AdminJobStatusDto,
  ApplyToJobDto,
  CreateJobDraftDto,
  ListApplicationsQueryDto,
  PaginationDto,
  PublicJobsQueryDto,
  PublishJobDto,
  ReplaceDraftSkillsDto,
  ReportJobDto,
  ResolveJobReportDto,
  UpdateApplicationStatusDto,
  UpdateCompanyDto,
  UpdateJobDraftDto,
  VerifyWorkEmailDto,
} from './dto/business-jobs.dto';
import { PublicJobsService } from './public-jobs.service';

const MAX_COMPANY_MEDIA_BYTES = 5 * 1024 * 1024;

@ApiTags('Jobs')
@Public()
@Controller('api/jobs')
export class PublicJobsController {
  constructor(private readonly jobs: PublicJobsService) {}
  @Get()
  @ApiOperation({ summary: 'Browse active native and external jobs' })
  list(@Query() query: PublicJobsQueryDto) {
    return this.jobs.list(query);
  }
  @Get('filters')
  @ApiOperation({ summary: 'Get job discovery filter values and counts' })
  filters() {
    return this.jobs.filters();
  }
  @Get(':slug')
  @ApiOperation({ summary: 'Get a public job detail by slug' })
  detail(@Param('slug') slug: string) {
    return this.jobs.detail(slug);
  }
}

@ApiTags('Companies')
@Public()
@Controller('api/companies')
export class PublicCompaniesController {
  constructor(
    private readonly companies: CompanyProfileService,
    private readonly jobs: PublicJobsService,
  ) {}
  @Get(':slug/jobs')
  @ApiOperation({ summary: 'List active jobs for a verified company' })
  jobsForCompany(@Param('slug') slug: string, @Query() query: PublicJobsQueryDto) {
    return this.jobs.listCompany(slug, query);
  }
  @Get(':slug/logo')
  @Header('Cache-Control', 'public, max-age=3600')
  logo(@Param('slug') slug: string, @Res() res: Response) {
    return stream(res, this.companies.downloadPublicMedia(slug, 'logo'));
  }
  @Get(':slug/cover')
  @Header('Cache-Control', 'public, max-age=3600')
  cover(@Param('slug') slug: string, @Res() res: Response) {
    return stream(res, this.companies.downloadPublicMedia(slug, 'cover'));
  }
  @Get(':slug')
  @ApiOperation({ summary: 'Get a verified public company profile' })
  detail(@Param('slug') slug: string) {
    return this.companies.getPublicCompany(slug);
  }
}

@ApiTags('Candidate Jobs')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('USER')
@Controller('api/jobs')
export class CandidateJobActionsController {
  constructor(private readonly candidate: CandidateJobService) {}
  @Get(':jobId/match')
  @ApiOperation({ summary: 'Match an owned CV against a job' })
  match(@CurrentUser() user: JwtUser, @Param('jobId') jobId: string, @Query('cvId') cvId: string) {
    return this.candidate.matchJob(user.userId, jobId, cvId);
  }
  @Post(':jobId/applications')
  @ApiOperation({ summary: 'Apply to the current native job version' })
  apply(@CurrentUser() user: JwtUser, @Param('jobId') jobId: string, @Body() body: ApplyToJobDto) {
    return this.candidate.apply(user.userId, jobId, body);
  }
  @Post(':jobId/reports')
  @ApiOperation({ summary: 'Report an active or stale job' })
  report(@CurrentUser() user: JwtUser, @Param('jobId') jobId: string, @Body() body: ReportJobDto) {
    return this.candidate.reportJob(user.userId, jobId, body.reasonCode as never, body.details);
  }
}

@ApiTags('Saved Jobs')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('USER')
@Controller('api/users/me/saved-jobs')
export class CandidateSavedJobsController {
  constructor(private readonly candidate: CandidateJobService) {}
  @Get() list(@CurrentUser() user: JwtUser, @Query() query: PaginationDto) {
    return this.candidate.listSaved(user.userId, query.page, query.limit);
  }
  @Put(':jobId') save(@CurrentUser() user: JwtUser, @Param('jobId') jobId: string) {
    return this.candidate.saveJob(user.userId, jobId);
  }
  @Delete(':jobId') remove(@CurrentUser() user: JwtUser, @Param('jobId') jobId: string) {
    return this.candidate.removeSavedJob(user.userId, jobId);
  }
}

@ApiTags('My Job Applications')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('USER')
@Controller('api/users/me/job-applications')
export class CandidateApplicationsController {
  constructor(private readonly candidate: CandidateJobService) {}
  @Get() list(@CurrentUser() user: JwtUser, @Query() query: PaginationDto) {
    return this.candidate.listMyApplications(user.userId, query.page, query.limit);
  }
  @Get(':applicationId') detail(@CurrentUser() user: JwtUser, @Param('applicationId') id: string) {
    return this.candidate.getMyApplication(user.userId, id);
  }
  @Post(':applicationId/withdraw') withdraw(
    @CurrentUser() user: JwtUser,
    @Param('applicationId') id: string,
  ) {
    return this.candidate.withdraw(user.userId, id);
  }
}

@ApiTags('Business Company')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('BUSINESS')
@Controller('api/business/company')
export class BusinessCompanyController {
  constructor(private readonly companies: CompanyProfileService) {}
  @Get() get(@CurrentUser() user: JwtUser) {
    return this.companies.getMyCompany(user.userId);
  }
  @Patch() update(@CurrentUser() user: JwtUser, @Body() body: UpdateCompanyDto) {
    return this.companies.updateMyCompany(user.userId, body);
  }
  @Post('work-email/send-verification') sendVerification(@CurrentUser() user: JwtUser) {
    return this.companies.sendWorkEmailVerification(user.userId);
  }
  @Post('work-email/verify') verify(
    @CurrentUser() user: JwtUser,
    @Body() body: VerifyWorkEmailDto,
  ) {
    return this.companies.verifyWorkEmail(user.userId, body.token);
  }
  @Post('submit') submit(@CurrentUser() user: JwtUser) {
    return this.companies.submitMyCompany(user.userId);
  }
  @Post('logo')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: companyMediaSchema() })
  @UseInterceptors(companyMediaInterceptor())
  logo(@CurrentUser() user: JwtUser, @UploadedFile() file: Express.Multer.File) {
    return this.companies.uploadMedia(user.userId, 'logo', file);
  }
  @Post('cover')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: companyMediaSchema() })
  @UseInterceptors(companyMediaInterceptor())
  cover(@CurrentUser() user: JwtUser, @UploadedFile() file: Express.Multer.File) {
    return this.companies.uploadMedia(user.userId, 'cover', file);
  }
}

@ApiTags('Business Jobs')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('BUSINESS')
@Controller('api/business/jobs')
export class BusinessJobsController {
  constructor(private readonly jobs: BusinessJobService) {}
  @Get() list(
    @CurrentUser() user: JwtUser,
    @Query() query: PaginationDto,
    @Query('status') status?: string,
  ) {
    return this.jobs.listMine(user.userId, query.page, query.limit, status as never);
  }
  @Post() create(@CurrentUser() user: JwtUser, @Body() body: CreateJobDraftDto) {
    return this.jobs.createDraft(user.userId, body);
  }
  @Get(':jobId') detail(@CurrentUser() user: JwtUser, @Param('jobId') id: string) {
    return this.jobs.getMine(user.userId, id);
  }
  @Patch(':jobId/draft') update(
    @CurrentUser() user: JwtUser,
    @Param('jobId') id: string,
    @Body() body: UpdateJobDraftDto,
  ) {
    return this.jobs.updateDraft(user.userId, id, body);
  }
  @Post(':jobId/draft/extract-skills') extract(
    @CurrentUser() user: JwtUser,
    @Param('jobId') id: string,
    @Body() body: PublishJobDto,
  ) {
    return this.jobs.extractDraftSkills(user.userId, id, body.expectedRevision);
  }
  @Put(':jobId/draft/skills') replaceSkills(
    @CurrentUser() user: JwtUser,
    @Param('jobId') id: string,
    @Body() body: ReplaceDraftSkillsDto,
  ) {
    return this.jobs.replaceDraftSkills(user.userId, id, body.expectedRevision, body.skills);
  }
  @Post(':jobId/publish') publish(
    @CurrentUser() user: JwtUser,
    @Param('jobId') id: string,
    @Body() body: PublishJobDto,
  ) {
    return this.jobs.publish(user.userId, id, body.expectedRevision);
  }
  @Post(':jobId/close') close(@CurrentUser() user: JwtUser, @Param('jobId') id: string) {
    return this.jobs.close(user.userId, id);
  }
  @Post(':jobId/duplicate') duplicate(@CurrentUser() user: JwtUser, @Param('jobId') id: string) {
    return this.jobs.duplicate(user.userId, id);
  }
  @Delete(':jobId') remove(@CurrentUser() user: JwtUser, @Param('jobId') id: string) {
    return this.jobs.deleteDraft(user.userId, id);
  }
}

@ApiTags('Business Applications')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('BUSINESS')
@Controller('api/business')
export class BusinessApplicationsController {
  constructor(private readonly applications: BusinessApplicationService) {}
  @Get('jobs/:jobId/applications') list(
    @CurrentUser() user: JwtUser,
    @Param('jobId') jobId: string,
    @Query() query: ListApplicationsQueryDto,
  ) {
    return this.applications.listForJob(user.userId, jobId, query);
  }
  @Get('applications/:applicationId') detail(
    @CurrentUser() user: JwtUser,
    @Param('applicationId') id: string,
  ) {
    return this.applications.getApplication(user.userId, id);
  }
  @Get('applications/:applicationId/cv') async cv(
    @CurrentUser() user: JwtUser,
    @Param('applicationId') id: string,
    @Res() res: Response,
  ) {
    const { application, file } = await this.applications.downloadCv(user.userId, id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader(
      'Content-Type',
      file.contentType ?? application.cvContentType ?? 'application/octet-stream',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizeFileName(application.cvOriginalFileName ?? 'candidate-cv')}"`,
    );
    file.body.pipe(res);
  }
  @Patch('applications/:applicationId/status') update(
    @CurrentUser() user: JwtUser,
    @Param('applicationId') id: string,
    @Body() body: UpdateApplicationStatusDto,
  ) {
    return this.applications.updateStatus(user.userId, id, body);
  }
}

@ApiTags('Admin Business Jobs')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
@Controller('api/admin')
export class AdminBusinessJobsController {
  constructor(
    private readonly companies: CompanyProfileService,
    private readonly admin: AdminBusinessJobsService,
  ) {}
  @Get('business-profiles') listProfiles(
    @Query() query: PaginationDto,
    @Query('status') status?: BusinessProfileStatus,
  ) {
    return this.companies.listAdmin(status, query.page, query.limit);
  }
  @Get('business-profiles/:profileId') profile(@Param('profileId') id: string) {
    return this.companies.getAdmin(id);
  }
  @Patch('business-profiles/:profileId/status') updateProfile(
    @CurrentUser() user: JwtUser,
    @Param('profileId') id: string,
    @Body() body: AdminBusinessStatusDto,
  ) {
    return this.admin.updateBusinessStatus(user.userId, id, body.status, body.reason);
  }
  @Get('job-reports') reports(
    @Query() query: PaginationDto,
    @Query('status') status?: JobReportStatus,
  ) {
    return this.admin.listReports(status, query.page, query.limit);
  }
  @Patch('job-reports/:reportId') resolve(
    @CurrentUser() user: JwtUser,
    @Param('reportId') id: string,
    @Body() body: ResolveJobReportDto,
  ) {
    return this.admin.resolveReport(user.userId, id, body.status, body.resolutionNote);
  }
  @Get('jobs/:jobId') job(@Param('jobId') id: string) {
    return this.admin.getJob(id);
  }
  @Patch('jobs/:jobId/status') status(
    @CurrentUser() user: JwtUser,
    @Param('jobId') id: string,
    @Body() body: AdminJobStatusDto,
  ) {
    return this.admin.removeJob(user.userId, id, body.reason);
  }
}

function companyMediaInterceptor() {
  return FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: MAX_COMPANY_MEDIA_BYTES },
  });
}

function companyMediaSchema() {
  return {
    type: 'object' as const,
    required: ['file'],
    properties: {
      file: { type: 'string' as const, format: 'binary' },
    },
  };
}

async function stream(
  response: Response,
  filePromise: Promise<{
    body: NodeJS.ReadableStream;
    contentType: string | null;
    contentLength: number | null;
  }>,
) {
  const file = await filePromise;
  response.setHeader('Content-Type', file.contentType ?? 'application/octet-stream');
  if (file.contentLength !== null)
    response.setHeader('Content-Length', file.contentLength.toString());
  file.body.pipe(response);
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, '_');
}
