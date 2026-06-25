import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminBusinessJobsService } from './admin-business-jobs.service';
import { BusinessApplicationService } from './business-application.service';
import {
  AdminBusinessJobsController,
  BusinessApplicationsController,
  BusinessCompanyController,
  BusinessWorkEmailVerificationController,
  BusinessJobsController,
  CandidateApplicationsController,
  CandidateJobActionsController,
  CandidateSavedJobsController,
  PublicCompaniesController,
  PublicJobsController,
} from './business-jobs.controller';
import { BusinessJobService } from './business-job.service';
import { CandidateJobService } from './candidate-job.service';
import { CompanyProfileService } from './company-profile.service';
import { PublicJobsService } from './public-jobs.service';

describe('business jobs OpenAPI contract', () => {
  let app: INestApplication;
  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeAll(async () => {
    const service = { provide: Symbol('unused'), useValue: {} };
    const moduleRef = await Test.createTestingModule({
      controllers: [
        PublicJobsController,
        PublicCompaniesController,
        CandidateJobActionsController,
        CandidateSavedJobsController,
        CandidateApplicationsController,
        BusinessCompanyController,
        BusinessWorkEmailVerificationController,
        BusinessJobsController,
        BusinessApplicationsController,
        AdminBusinessJobsController,
      ],
      providers: [
        { provide: PublicJobsService, useValue: {} },
        { provide: CandidateJobService, useValue: {} },
        { provide: CompanyProfileService, useValue: {} },
        { provide: BusinessJobService, useValue: {} },
        { provide: BusinessApplicationService, useValue: {} },
        { provide: AdminBusinessJobsService, useValue: {} },
        RolesGuard,
        service,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('test').addBearerAuth().build(),
    );
  });

  afterAll(async () => app.close());

  it.each([
    ['GET', '/api/jobs'],
    ['GET', '/api/jobs/filters'],
    ['GET', '/api/jobs/{slug}'],
    ['GET', '/api/companies/{slug}'],
    ['GET', '/api/companies/{slug}/jobs'],
    ['GET', '/api/jobs/{jobId}/match'],
    ['POST', '/api/jobs/{jobId}/applications'],
    ['POST', '/api/jobs/{jobId}/reports'],
    ['GET', '/api/users/me/saved-jobs'],
    ['PUT', '/api/users/me/saved-jobs/{jobId}'],
    ['DELETE', '/api/users/me/saved-jobs/{jobId}'],
    ['GET', '/api/users/me/job-applications'],
    ['POST', '/api/users/me/job-applications/{applicationId}/withdraw'],
    ['GET', '/api/users/me/job-applications/{applicationId}'],
    ['GET', '/api/business/company'],
    ['PATCH', '/api/business/company'],
    ['POST', '/api/business/company/logo'],
    ['GET', '/api/business/company/logo'],
    ['POST', '/api/business/company/cover'],
    ['GET', '/api/business/company/cover'],
    ['POST', '/api/business/company/work-email/send-verification'],
    ['POST', '/api/business/company/work-email/verify'],
    ['POST', '/api/business/company/submit'],
    ['GET', '/api/business/jobs'],
    ['POST', '/api/business/jobs'],
    ['GET', '/api/business/jobs/{jobId}'],
    ['PATCH', '/api/business/jobs/{jobId}/draft'],
    ['POST', '/api/business/jobs/{jobId}/draft/extract-skills'],
    ['PUT', '/api/business/jobs/{jobId}/draft/skills'],
    ['POST', '/api/business/jobs/{jobId}/publish'],
    ['POST', '/api/business/jobs/{jobId}/close'],
    ['POST', '/api/business/jobs/{jobId}/duplicate'],
    ['DELETE', '/api/business/jobs/{jobId}'],
    ['GET', '/api/business/jobs/{jobId}/applications'],
    ['GET', '/api/business/applications/{applicationId}'],
    ['GET', '/api/business/applications/{applicationId}/cv'],
    ['PATCH', '/api/business/applications/{applicationId}/status'],
    ['GET', '/api/admin/business-profiles'],
    ['GET', '/api/admin/business-profiles/{profileId}'],
    ['GET', '/api/admin/business-profiles/{profileId}/logo'],
    ['GET', '/api/admin/business-profiles/{profileId}/cover'],
    ['PATCH', '/api/admin/business-profiles/{profileId}/status'],
    ['GET', '/api/admin/job-reports'],
    ['PATCH', '/api/admin/job-reports/{reportId}'],
    ['GET', '/api/admin/jobs/{jobId}'],
    ['PATCH', '/api/admin/jobs/{jobId}/status'],
  ])('documents %s %s', (method, path) => {
    expect(document.paths[path]?.[method.toLowerCase() as 'get']).toBeDefined();
  });
});
