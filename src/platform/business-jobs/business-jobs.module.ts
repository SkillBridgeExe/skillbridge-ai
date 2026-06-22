import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BusinessProfileEntity } from '../../database/entities/business-profile.entity';
import { CompanyEntity } from '../../database/entities/company.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvSkillEntity } from '../../database/entities/cv-skill.entity';
import { JobApplicationStatusEventEntity } from '../../database/entities/job-application-status-event.entity';
import { JobApplicationEntity } from '../../database/entities/job-application.entity';
import { JobPostVersionEntity } from '../../database/entities/job-post-version.entity';
import { JobReportEntity } from '../../database/entities/job-report.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { SavedJobEntity } from '../../database/entities/saved-job.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { VerificationEntity } from '../../database/entities/verification.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { EmailModule } from '../../infrastructure/email/email.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { CvJdMatchModule } from '../../modules/cv-jd-match/cv-jd-match.module';
import { JobsModule } from '../../modules/jobs/jobs.module';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CvsModule } from '../cvs/cvs.module';
import { AdminBusinessJobsService } from './admin-business-jobs.service';
import { BusinessApplicationService } from './business-application.service';
import {
  AdminBusinessJobsController,
  BusinessApplicationsController,
  BusinessCompanyController,
  BusinessJobsController,
  CandidateApplicationsController,
  CandidateJobActionsController,
  CandidateSavedJobsController,
  PublicCompaniesController,
  PublicJobsController,
} from './business-jobs.controller';
import { BusinessJobService } from './business-job.service';
import { BusinessJobsMaintenanceService } from './business-jobs-maintenance.service';
import { CandidateJobService } from './candidate-job.service';
import { CompanyProfileService } from './company-profile.service';
import { PublicJobsService } from './public-jobs.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BusinessProfileEntity,
      CompanyEntity,
      JobEntity,
      JobPostVersionEntity,
      SavedJobEntity,
      JobApplicationEntity,
      JobApplicationStatusEventEntity,
      JobReportEntity,
      VerificationEntity,
      CvEntity,
      CvSkillEntity,
      SkillEntity,
      UserEntity,
    ]),
    StorageModule,
    EmailModule,
    CvsModule,
    CvJdMatchModule,
    JobsModule,
  ],
  controllers: [
    PublicJobsController,
    PublicCompaniesController,
    CandidateJobActionsController,
    CandidateSavedJobsController,
    CandidateApplicationsController,
    BusinessCompanyController,
    BusinessJobsController,
    BusinessApplicationsController,
    AdminBusinessJobsController,
  ],
  providers: [
    CompanyProfileService,
    BusinessJobService,
    PublicJobsService,
    CandidateJobService,
    BusinessApplicationService,
    AdminBusinessJobsService,
    BusinessJobsMaintenanceService,
    RolesGuard,
  ],
  exports: [BusinessJobsMaintenanceService],
})
export class BusinessJobsModule {}
