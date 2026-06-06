import { Module } from '@nestjs/common';
import { CvReviewController } from './cv-review.controller';
import { CvReviewService } from './cv-review.service';
import { CvReviewParser } from './cv-review.parser';
import { CvParserService } from './cv-parser.service';
import { AtsRuleCheckerService } from './ats-rule-checker.service';
import { BulletAnalyzerService } from './bullet-analyzer.service';
import { CvJdMatchModule } from '../cv-jd-match/cv-jd-match.module';

@Module({
  // Import for SkillDiffService — reused to compute the deterministic Dimension-2
  // matched/partial/missing breakdown (same engine as CV-JD match, no new logic).
  imports: [CvJdMatchModule],
  controllers: [CvReviewController],
  // CvParserService is also exported so the upcoming cv-builder module (no-CV
  // intake) can reuse the same structured-parse + coerce logic.
  providers: [
    CvReviewService,
    CvReviewParser,
    CvParserService,
    AtsRuleCheckerService,
    BulletAnalyzerService,
  ],
  // BulletAnalyzerService exported for the cv-builder live evaluator (R1b) — same
  // deterministic heuristics power both the one-shot diagnosis and per-section checks.
  exports: [CvReviewService, CvParserService, BulletAnalyzerService],
})
export class CvReviewModule {}
