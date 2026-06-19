import { Injectable } from '@nestjs/common';
import type { ScoredResource } from './learning-resource';
import { LearningResourceMatcherService } from './learning-resource-matcher.service';

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
  language: string;
  duration_minutes: number;
  rating: number;
  is_free: boolean;
  difficulty: CourseDifficulty;
  skills: CatalogCourseSkill[];
}

export interface CourseMatchRequest {
  skill_canonical_name: string;
  required_level: number;
  weight?: number;
}

export interface ScoredCourse extends CatalogCourse {
  match_score: number;
  match_breakdown: {
    rating_pts: number;
    language_pts: number;
    free_pts: number;
    level_fit_pts: number;
    multi_skill_pts: number;
  };
}

export interface CourseMatcherResult {
  per_skill: Array<{
    skill_canonical_name: string;
    required_level: number;
    courses: ScoredCourse[];
  }>;
  uncovered_skills: string[];
}

@Injectable()
export class CourseMatcherService {
  constructor(private readonly resources: LearningResourceMatcherService) {}

  matchCourses(requests: CourseMatchRequest[]): CourseMatcherResult {
    const result = this.resources.matchResources(requests, { sourceTypes: ['course'] });
    return {
      per_skill: result.per_skill.map((perSkill) => ({
        skill_canonical_name: perSkill.skill_canonical_name,
        required_level: perSkill.required_level,
        courses: perSkill.resources.map(toScoredCourse),
      })),
      uncovered_skills: result.uncovered_skills,
    };
  }
}

function toScoredCourse(resource: ScoredResource): ScoredCourse {
  return {
    id: resource.id,
    title: resource.title,
    url: resource.url ?? '',
    provider: resource.provider,
    language: resource.language,
    duration_minutes: resource.duration_minutes,
    rating: resource.quality_score / 20,
    is_free: resource.is_free,
    difficulty: resource.difficulty,
    skills: resource.skills,
    match_score: resource.match_score,
    match_breakdown: {
      rating_pts: resource.match_breakdown.quality_pts,
      language_pts: resource.match_breakdown.language_pts,
      free_pts: resource.match_breakdown.free_pts,
      level_fit_pts: resource.match_breakdown.level_fit_pts,
      multi_skill_pts: resource.match_breakdown.multi_skill_pts,
    },
  };
}
