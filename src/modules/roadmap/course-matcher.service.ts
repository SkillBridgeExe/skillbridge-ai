import { Injectable } from '@nestjs/common';
import { LearningResourceMatcherService } from './learning-resource-matcher.service';
import { LanguagePref, ScoredResource } from './learning-resource';

export type CourseDifficulty = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';

export interface CatalogCourseSkill {
  skill_canonical_name: string;
  teaches_level: number;
}

export interface CatalogCourse {
  id: string;
  title: string;
  url: string;
  provider: string;
  language: string; // ISO 639-1: "vi", "en"
  duration_minutes: number;
  rating: number; // 0-5
  is_free: boolean;
  difficulty: CourseDifficulty;
  skills: CatalogCourseSkill[];
}

export interface CourseMatchRequest {
  skill_canonical_name: string;
  required_level: number;
  /** Pass-through from rubric for prioritization. Higher weight = more important to fill. */
  weight?: number;
}

export interface ScoredCourse extends CatalogCourse {
  /** Composite score 0-100 used for ranking within a skill. */
  match_score: number;
  /** Breakdown for explainability — shown in roadmap UI tooltip. */
  match_breakdown: {
    rating_pts: number;
    language_pts: number;
    free_pts: number;
    level_fit_pts: number;
    multi_skill_pts: number;
  };
}

export interface CourseMatcherResult {
  /** For each requested skill: top N courses. */
  per_skill: Array<{
    skill_canonical_name: string;
    required_level: number;
    courses: ScoredCourse[];
  }>;
  /** Skills that had ZERO catalog hits — flagged so curation can prioritize. */
  uncovered_skills: string[];
}

/**
 * Backward-compatible wrapper: the course catalog is now part of the unified LearningResource catalog.
 * This service preserves the exact public contract used by RoadmapService — it delegates matching to
 * LearningResourceMatcherService (filtered to source_type='course') and maps the result back to the
 * legacy ScoredCourse shape. Parity holds because quality_score = round(rating*20) ⇒ quality/100*30 = rating/5*30.
 *
 * (Previously this service owned its own course-catalog.json load + scoring; that logic moved to the pure
 * matcher in learning-resource.ts. NO LLM here — deterministic lookup + math, same input → same ranking.)
 */
@Injectable()
export class CourseMatcherService {
  constructor(private readonly resources: LearningResourceMatcherService) {}

  // langPref defaults to 'vi' to preserve the EXACT legacy course contract (the pre-refactor formula boosted
  // Vietnamese unconditionally). The platform passes the resolved user preference once wired; callers that
  // omit it (e.g. the real-catalog parity oracle) keep byte-identical legacy scoring.
  matchCourses(requests: CourseMatchRequest[], langPref: LanguagePref = 'vi'): CourseMatcherResult {
    const result = this.resources.matchResources(requests, { sourceTypes: ['course'], langPref });
    return {
      per_skill: result.per_skill.map((ps) => ({
        skill_canonical_name: ps.skill_canonical_name,
        required_level: ps.required_level,
        courses: ps.resources.map(toScoredCourse),
      })),
      uncovered_skills: result.uncovered_skills,
    };
  }
}

function toScoredCourse(r: ScoredResource): ScoredCourse {
  return {
    id: r.id,
    title: r.title,
    url: r.url ?? '',
    provider: r.provider,
    language: r.language,
    duration_minutes: r.duration_minutes,
    rating: r.quality_score / 20, // reconstruct the legacy 0-5 rating
    is_free: r.is_free,
    difficulty: r.difficulty,
    skills: r.skills,
    match_score: r.match_score,
    match_breakdown: {
      rating_pts: r.match_breakdown.quality_pts,
      language_pts: r.match_breakdown.language_pts,
      free_pts: r.match_breakdown.free_pts,
      level_fit_pts: r.match_breakdown.level_fit_pts,
      multi_skill_pts: r.match_breakdown.multi_skill_pts,
    },
  };
}
