import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvConsentAuditEntity } from '../../database/entities/cv-consent-audit.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvSkillEntity } from '../../database/entities/cv-skill.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { CvBuilderModule } from '../../modules/cv-builder/cv-builder.module';
import { CvReviewModule } from '../../modules/cv-review/cv-review.module';
import { TracingModule } from '../../modules/tracing/tracing.module';
import { BillingModule } from '../billing/billing.module';
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
    BillingModule,
    // Self-sufficient DI for CV analysis usage counting; @Global, so idempotent.
    TracingModule,
  ],
  controllers: [CvsController, DiagnosisController],
  providers: [
    CvsService,
    TextExtractorService,
    CvPdfRendererService,
    CvsRetentionService,
    CvAnalysisQuotaService,
  ],
  exports: [CvsRetentionService],
})
export class CvsModule {}
