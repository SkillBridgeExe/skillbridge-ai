import { Module } from '@nestjs/common';
import { CvJdMatchModule } from '../cv-jd-match/cv-jd-match.module';
import { JdIngestService } from './ingest/jd-ingest.service';
import { JobRecommendationService } from './reco/job-recommendation.service';
import { JobsController } from './jobs.controller';

/**
 * Jobs pool (J-track): ingest pipeline (J2) + hybrid top-N recommendations (J4).
 * Trend analytics (J5) lands here next. Crawler sources (J3) call JdIngestService —
 * one ingest code path for manual import / employer-posted / Tier-A crawlers.
 */
@Module({
  imports: [CvJdMatchModule],
  controllers: [JobsController],
  providers: [JdIngestService, JobRecommendationService],
  exports: [JdIngestService, JobRecommendationService],
})
export class JobsModule {}
