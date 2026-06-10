import { Module } from '@nestjs/common';
import { CvJdMatchController } from './cv-jd-match.controller';
import { CvJdMatchService } from './cv-jd-match.service';
import { SkillDiffService } from './skill-diff.service';
import { TailorChecklistService } from './tailor-checklist.service';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [RagModule],
  controllers: [CvJdMatchController],
  providers: [CvJdMatchService, SkillDiffService, TailorChecklistService],
  // SkillDiffService is the eval-gated matching engine — JobsModule reuses it for
  // the top-N job recommendation signal (same MATCH_TUNING semantics everywhere).
  exports: [CvJdMatchService, SkillDiffService, TailorChecklistService],
})
export class CvJdMatchModule {}
