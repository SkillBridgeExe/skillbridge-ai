import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LlmExtractionCacheEntity } from '../../database/entities/llm-extraction-cache.entity';
import { CvJdMatchController } from './cv-jd-match.controller';
import { CvJdMatchExtractionCacheService } from './cv-jd-match-extraction-cache.service';
import { CvJdMatchService } from './cv-jd-match.service';
import { SkillDiffService } from './skill-diff.service';
import { TailorChecklistService } from './tailor-checklist.service';
import { RagModule } from '../rag/rag.module';

const EXTRACTION_CACHE_IMPORTS =
  process.env.NODE_ENV === 'test' ? [] : [TypeOrmModule.forFeature([LlmExtractionCacheEntity])];

@Module({
  imports: [RagModule, ...EXTRACTION_CACHE_IMPORTS],
  controllers: [CvJdMatchController],
  providers: [
    CvJdMatchService,
    SkillDiffService,
    TailorChecklistService,
    CvJdMatchExtractionCacheService,
  ],
  // SkillDiffService is the eval-gated matching engine — JobsModule reuses it for
  // the top-N job recommendation signal (same MATCH_TUNING semantics everywhere).
  exports: [
    CvJdMatchService,
    SkillDiffService,
    TailorChecklistService,
    CvJdMatchExtractionCacheService,
  ],
})
export class CvJdMatchModule {}
