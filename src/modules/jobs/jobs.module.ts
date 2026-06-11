import { Module } from '@nestjs/common';
import { BillingModule } from '../../platform/billing/billing.module';
import { CvJdMatchModule } from '../cv-jd-match/cv-jd-match.module';
import { JdIngestService } from './ingest/jd-ingest.service';
import { ItviecCrawlerService } from './crawl/itviec-crawler.service';
import { JobRecommendationService } from './reco/job-recommendation.service';
import { SkillDemandService } from './trends/skill-demand.service';
import { TrendsInsightService } from './trends/trends-insight.service';
import { JdMarketPositionService } from './trends/jd-market-position.service';
import { JobsController } from './jobs.controller';
import { TrendsController } from './trends/trends.controller';

/**
 * Jobs pool (J-track): ingest pipeline (J2), hybrid top-N recommendations (J4),
 * skill-demand trends + CV gap (J5). Crawler sources (J3) call JdIngestService —
 * one ingest code path for manual import / employer-posted / Tier-A crawlers.
 * Snapshots refresh via `pnpm trends:refresh` from an EXTERNAL daily trigger.
 */
// BillingModule (quota) needs the DB → skip in the DB-less env (NODE_ENV=test:
// e2e + calibration harnesses boot AppModule without Postgres), mirroring
// AppModule's PLATFORM_MODULES skip. JobsController injects EntitlementsService
// @Optional for exactly this case; every real runtime loads it and enforces quota.
const QUOTA_IMPORTS = process.env.NODE_ENV === 'test' ? [] : [BillingModule];

@Module({
  imports: [CvJdMatchModule, ...QUOTA_IMPORTS],
  controllers: [JobsController, TrendsController],
  providers: [
    JdIngestService,
    ItviecCrawlerService,
    JobRecommendationService,
    SkillDemandService,
    TrendsInsightService,
    JdMarketPositionService,
  ],
  exports: [
    JdIngestService,
    ItviecCrawlerService,
    JobRecommendationService,
    SkillDemandService,
    JdMarketPositionService,
  ],
})
export class JobsModule {}
