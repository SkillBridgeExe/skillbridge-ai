import { Global, Module } from '@nestjs/common';
import { SkillTaxonomyService } from './skill-taxonomy.service';
import { SkillNormalizerService } from './skill-normalizer.service';
import { SemanticSkillMatcherService } from './semantic-skill-matcher.service';
import { RoleRubricService } from './role-rubric.service';

/**
 * Common services available globally to feature modules.
 *
 * Marked @Global so cv-review / cv-jd-match / roadmap modules don't all need to
 * `imports: [CommonServicesModule]`. These services are stateful in-memory
 * caches that should be singletons across the app.
 *
 * Services exported:
 *   - SkillTaxonomyService       — loads & indexes skills-pilot.json
 *   - SkillNormalizerService     — deterministic LLM-extracted skill → canonical cascade
 *   - SemanticSkillMatcherService — embedding fallback tier (pgvector, OpenAI-only, 3-band gate)
 *   - RoleRubricService          — loads role rubrics (required skills per role)
 *
 * SemanticSkillMatcherService pulls LlmService/PgVectorService/DatabaseService from their
 * own @Global modules; under NODE_ENV=test it self-disables (isEnabled() === false).
 */
@Global()
@Module({
  providers: [
    SkillTaxonomyService,
    SkillNormalizerService,
    SemanticSkillMatcherService,
    RoleRubricService,
  ],
  exports: [
    SkillTaxonomyService,
    SkillNormalizerService,
    SemanticSkillMatcherService,
    RoleRubricService,
  ],
})
export class CommonServicesModule {}
