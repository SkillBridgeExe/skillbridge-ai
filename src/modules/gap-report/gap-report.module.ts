import { Module } from '@nestjs/common';
import { CvJdMatchModule } from '../cv-jd-match/cv-jd-match.module';
import { JobsModule } from '../jobs/jobs.module';
import { GapReportService } from './gap-report.service';

/** Gap Engine v1 — unified gap report (top-of-composition; exported for the platform route). */
@Module({
  imports: [CvJdMatchModule, JobsModule],
  providers: [GapReportService],
  exports: [GapReportService],
})
export class GapReportModule {}
