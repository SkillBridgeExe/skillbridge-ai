import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScannedPdfOcrService } from '../../common/services/scanned-pdf-ocr.service';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvConsentAuditEntity } from '../../database/entities/cv-consent-audit.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvSkillEntity } from '../../database/entities/cv-skill.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { CvBuilderModule } from '../../modules/cv-builder/cv-builder.module';
import { CvReviewModule } from '../../modules/cv-review/cv-review.module';
import { GithubEvidenceModule } from '../../modules/github-evidence/github-evidence.module';
import { InterviewModule } from '../../modules/interview/interview.module';
import { TracingModule } from '../../modules/tracing/tracing.module';
import { BillingModule } from '../billing/billing.module';
import { TailorVerifierModule } from '../tailor-verifier/tailor-verifier.module';
import { CvPdfRendererService } from './cv-pdf-renderer.service';
import { CvsRetentionService } from './cv-retention.service';
import { CvsController } from './cvs.controller';
import { DiagnosisController } from './diagnosis.controller';
import { CvsService } from './cvs.service';
import { CvAnalysisQuotaService } from './cv-analysis-quota.service';
import { TextExtractorService } from './text-extractor.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CvEntity,
      CvSkillEntity,
      SkillEntity,
      CvConsentAuditEntity,
      AiResultEntity,
    ]),
    StorageModule,
    CvReviewModule,
    CvBuilderModule,
    InterviewModule,
    GithubEvidenceModule,
    BillingModule,
    // Self-sufficient DI for CV analysis usage counting; @Global, so idempotent.
    TracingModule,
    // PR4.5 — server-verified tailor rewrite. Standalone (no Cvs/CvMatches dep) → no module cycle.
    TailorVerifierModule,
  ],
  controllers: [CvsController, DiagnosisController],
  providers: [
    CvsService,
    TextExtractorService,
    // Optional OCR rescue for scanned/thin PDFs (input-quality lane). SkillTextScannerService +
    // ConfigService come from the global CommonServicesModule / ConfigModule.
    ScannedPdfOcrService,
    CvPdfRendererService,
    CvsRetentionService,
    CvAnalysisQuotaService,
  ],
  exports: [CvsRetentionService, CvsService, CvPdfRendererService],
})
export class CvsModule {}
