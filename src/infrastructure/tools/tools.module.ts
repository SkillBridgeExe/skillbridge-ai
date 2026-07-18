import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GithubEvidenceModule } from '../../modules/github-evidence/github-evidence.module';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import { ResourceValidateAdapter } from './adapters/resource-validate.adapter';
import { GithubEnrichAdapter } from './adapters/github-enrich.adapter';
import { RoadmapProgressAdapter } from './adapters/roadmap-progress.adapter';
import { InterviewHistoryAdapter } from './adapters/interview-history.adapter';
import { ToolRegistry } from './tool-registry.service';

// e2e boots AppModule with NODE_ENV=test and NO DataSource (DatabaseOrmModule is empty there) —
// an unguarded forFeature would fail the whole DI graph at Test.createTestingModule. Same guard
// as TracingModule; the adapters take their repos as @Optional and shape-empty without them.
const TOOLS_ORM_IMPORTS =
  process.env.NODE_ENV === 'test'
    ? []
    : [TypeOrmModule.forFeature([LearningSessionProgressEntity, InterviewSessionEntity])];

/** Same pattern as LlmModule/PromptsModule/TracingModule — @Global() so DiagnosisChatModule and
 *  LearningModule get ToolRegistry for free, zero changes to their own imports.
 *  The Wave 3 read-tools inject entity repos DIRECTLY (forFeature above) instead of importing
 *  LearningModule/InterviewsModule — those platform modules drag the CvMatches⇄Interviews
 *  forwardRef cycle into this @Global graph (same reasoning as TailorVerifier's direct reads). */
@Global()
@Module({
  imports: [GithubEvidenceModule, ...TOOLS_ORM_IMPORTS],
  providers: [
    ResourceValidateAdapter,
    GithubEnrichAdapter,
    RoadmapProgressAdapter,
    InterviewHistoryAdapter,
    ToolRegistry,
  ],
  exports: [ToolRegistry],
})
export class ToolsModule {}
