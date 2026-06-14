import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { GapReportModule } from '../../modules/gap-report/gap-report.module';
import { TailorVerifierService } from './tailor-verifier.service';

/**
 * PR4.5 — standalone provider for server-verified tailor rewrites. Depends ONLY on repos +
 * GapReportModule (no CvsModule / CvMatchesModule), so CvsModule can import it without recreating
 * the CvsModule ↔ CvMatchesModule cycle. Exports TailorVerifierService for CvsService.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CvMatchEntity, AiResultEntity, CvEntity]), GapReportModule],
  providers: [TailorVerifierService],
  exports: [TailorVerifierService],
})
export class TailorVerifierModule {}
