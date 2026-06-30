import { Injectable, OnModuleInit } from '@nestjs/common';
import { RoleRubricService } from '../../common/services/role-rubric.service';
import { SkillTaxonomyService } from '../../common/services/skill-taxonomy.service';
import {
  RoleProfile,
  RoleInferenceResult,
  inferRoleFromStory,
  rubricsToProfiles,
} from './role-inference';

/** Engine result enriched with human display names (the rubric label in the requested language). */
export interface StoryInferenceResult extends RoleInferenceResult {
  display_name: string | null;
  candidates: Array<{ role_code: string; display_name: string; score: number; matched: string[] }>;
}

/**
 * NestJS wrapper around the pure `inferRoleFromStory` engine (Story→CV slice 1). Owns the two
 * dependencies the pure function needs — a taxonomy resolver and the role profiles — and caches the
 * profiles once (rubrics are static). Deterministic: no LLM, no quota, no tracing.
 */
@Injectable()
export class RoleInferenceService implements OnModuleInit {
  private profiles: RoleProfile[] = [];
  private displayNames = new Map<string, { vi: string; en: string }>();

  constructor(
    private readonly rubrics: RoleRubricService,
    private readonly taxonomy: SkillTaxonomyService,
  ) {}

  onModuleInit(): void {
    this.loadProfiles();
  }

  private loadProfiles(): void {
    const all = this.rubrics.listRubrics();
    this.profiles = rubricsToProfiles(all);
    this.displayNames = new Map(
      all.map((r) => [r.role_code, { vi: r.display_name_vi, en: r.display_name_en }]),
    );
  }

  /** Taxonomy alias lookup mirroring eval-role-infer: normalizeKey → alias index → canonical|null. */
  private resolve = (raw: string): string | null =>
    this.taxonomy.lookupByAliasKey(SkillTaxonomyService.normalizeKey(raw)) ?? null;

  private label(roleCode: string, language: 'vi' | 'en'): string {
    const n = this.displayNames.get(roleCode);
    return (language === 'en' ? n?.en : n?.vi) ?? roleCode;
  }

  inferFromStory(story: string, language: 'vi' | 'en' = 'vi'): StoryInferenceResult {
    // Lazy guard: tests may call without onModuleInit; load once on first use.
    if (this.profiles.length === 0) this.loadProfiles();
    const base = inferRoleFromStory(story, this.resolve, this.profiles);
    return {
      ...base,
      display_name: base.role_code ? this.label(base.role_code, language) : null,
      candidates: base.candidates.map((c) => ({
        ...c,
        display_name: this.label(c.role_code, language),
      })),
    };
  }
}
