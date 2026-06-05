import { Module } from '@nestjs/common';
import { CvJdMatchModule } from '../cv-jd-match/cv-jd-match.module';
import { JdIngestService } from './ingest/jd-ingest.service';
import { JobRecommendationService } from './reco/job-recommendation.service';
import { SkillDemandService } from './trends/skill-demand.service';
import { JobsController } from './jobs.controller';
import { TrendsController } from './trends/trends.controller';

/**
 * Jobs pool (J-track): ingest pipeline (J2), hybrid top-N recommendations (J4),
 * skill-demand trends + CV gap (J5). Crawler sources (J3) call JdIngestService —
 * one ingest code path for manual import / employer-posted / Tier-A crawlers.
 * Snapshots refresh via `pnpm trends:refresh` from an EXTERNAL daily trigger.
 */
@Module({
  imports: [CvJdMatchModule],
  controllers: [JobsController, TrendsController],
  providers: [JdIngestService, JobRecommendationService, SkillDemandService],
  exports: [JdIngestService, JobRecommendationService, SkillDemandService],
})
export class JobsModule {}
