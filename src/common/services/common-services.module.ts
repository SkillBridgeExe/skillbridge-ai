import { Global, Module } from '@nestjs/common';
import { SkillTaxonomyService } from './skill-taxonomy.service';
import { SkillNormalizerService } from './skill-normalizer.service';
import { RoleRubricService } from './role-rubric.service';

/**
 * Common services available globally to feature modules.
 *
 * Marked @Global so cv-review / cv-jd-match / roadmap modules don't all need to
 * `imports: [CommonServicesModule]`. These three services are stateful in-memory
 * caches that should be singletons across the app.
 *
 * Services exported:
 *   - SkillTaxonomyService  — loads & indexes skills-pilot.json
 *   - SkillNormalizerService — fuzzy match LLM-extracted skills → canonical
 *   - RoleRubricService     — loads role rubrics (required skills per role)
 */
@Global()
@Module({
  providers: [SkillTaxonomyService, SkillNormalizerService, RoleRubricService],
  exports: [SkillTaxonomyService, SkillNormalizerService, RoleRubricService],
})
export class CommonServicesModule {}
