import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiRequestEntity } from '../../database/entities/ai-request.entity';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { CvMatchScoreEntity } from '../../database/entities/cv-match-score.entity';
import { ImpactCalibrationEntity } from '../../database/entities/impact-calibration.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { UserLearningPreferenceEntity } from '../../database/entities/user-learning-preference.entity';
import { CvJdMatchModule } from '../../modules/cv-jd-match/cv-jd-match.module';
import { GapReportModule } from '../../modules/gap-report/gap-report.module';
import { RoadmapModule } from '../../modules/roadmap/roadmap.module';
import { InterviewModule } from '../../modules/interview/interview.module';
import { GithubEvidenceModule } from '../../modules/github-evidence/github-evidence.module';
import { BillingModule } from '../billing/billing.module';
import { CvsModule } from '../cvs/cvs.module';
import { InterviewsModule } from '../interviews/interviews.module';
import { CvMatchReportsController, CvMatchesController } from './cv-matches.controller';
import { CvMatchesService } from './cv-matches.service';
import { JdTextExtractorService } from './jd-text-extractor.service';
import { UnifiedPlanService } from './unified-plan.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CvEntity,
      JobDescriptionEntity,
      CvMatchEntity,
      CvMatchScoreEntity,
      AiResultEntity,
      UserLearningPreferenceEntity,
      // ME2 (Wave MEASURE): calibration piggyback in getProgress (write) + the ME1 attempted-flag
      // join over ai_requests (read).
      ImpactCalibrationEntity,
      AiRequestEntity,
    ]),
    CvJdMatchModule,
    BillingModule,
    GapReportModule,
    RoadmapModule,
    InterviewModule,
    forwardRef(() => InterviewsModule),
    CvsModule,
    // I3 (Wave IMPACT): GithubEvidenceModule is a leaf module (no imports of its own — CvsModule
    // already depends on it directly), so importing it here too is cycle-free.
    GithubEvidenceModule,
  ],
  controllers: [CvMatchesController, CvMatchReportsController],
  providers: [CvMatchesService, JdTextExtractorService, UnifiedPlanService],
  exports: [CvMatchesService],
})
export class CvMatchesModule {}
