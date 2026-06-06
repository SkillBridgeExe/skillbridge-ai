import { Module } from '@nestjs/common';
import { CvReviewModule } from '../cv-review/cv-review.module';
import { CvBuilderController } from './cv-builder.controller';
import { SectionEvaluatorService } from './section-evaluator.service';
import { CvRewriteService } from './cv-rewrite.service';

/**
 * R1b — CV Builder AI brain (spec §7A). Reuses BulletAnalyzerService (deterministic
 * bullet quality) from CvReviewModule; SkillTaxonomy/RoleRubric come from the @Global
 * CommonServicesModule; LlmService/PromptsService from their own @Global modules.
 */
@Module({
  imports: [CvReviewModule],
  controllers: [CvBuilderController],
  providers: [SectionEvaluatorService, CvRewriteService],
  exports: [SectionEvaluatorService, CvRewriteService],
})
export class CvBuilderModule {}
