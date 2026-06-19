import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { CvMatchScoreEntity } from '../../database/entities/cv-match-score.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { CvJdMatchModule } from '../../modules/cv-jd-match/cv-jd-match.module';
import { GapReportModule } from '../../modules/gap-report/gap-report.module';
import { RoadmapModule } from '../../modules/roadmap/roadmap.module';
import { InterviewModule } from '../../modules/interview/interview.module';
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
    ]),
    CvJdMatchModule,
    BillingModule,
    GapReportModule,
    RoadmapModule,
    InterviewModule,
    forwardRef(() => InterviewsModule),
    CvsModule,
  ],
  controllers: [CvMatchesController, CvMatchReportsController],
  providers: [CvMatchesService, JdTextExtractorService, UnifiedPlanService],
  exports: [CvMatchesService],
})
export class CvMatchesModule {}
