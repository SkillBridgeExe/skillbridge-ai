import { Module } from '@nestjs/common';
import { JdIngestService } from './ingest/jd-ingest.service';

/**
 * Jobs pool (J-track): ingest pipeline now; top-5 recommendation endpoint (J4) and
 * trend analytics (J5) land here next. Crawler sources (J3) call JdIngestService —
 * one ingest code path for manual import / employer-posted / Tier-A crawlers.
 */
@Module({
  providers: [JdIngestService],
  exports: [JdIngestService],
})
export class JobsModule {}
