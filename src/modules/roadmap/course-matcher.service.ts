import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

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
  /** Skills that had ZERO catalog hits — flagged so .NET can prioritize course curation. */
  uncovered_skills: string[];
}

/**
 * Deterministic course recommendation.
 *
 * Replaces the previous "LLM suggests resource keywords" approach which led to
 * hallucinated course names that didn't exist. This service:
 *   1. Loads the CURATED catalog (data/course-catalog.json — real, well-known courses;
 *      every URL live-fetch-verified at curation time; integrity-tested against the taxonomy).
 *   2. For each missing/partial skill, finds all courses tagged with that skill.
 *   3. Scores each course using a fixed formula (rating + VN bonus + free bonus + level fit + coverage).
 *   4. Returns top N per skill (default 3).
 *
 * Scoring formula (deterministic, total 100):
 *   - rating (0-30)        : (rating / 5) * 30
 *   - language (0-20)      : 20 if course.language == 'vi', else 0
 *   - free (0-15)          : 15 if course.is_free, else 0
 *   - level fit (0-20)     : 20 if teaches_level >= required_level, else 10
 *   - multi-skill (0-15)   : 15 * (overlap_count / requested_skills_count), capped
 *
 * NO LLM CALLS HERE. Pure SQL-style lookup + math. Same input → same ranking.
 *
 * `rating` in the catalog is an EDITORIAL reputation score (4.0-4.8), not user reviews —
 * documented in the catalog's _note. Future: move the catalog to a DB table when a course
 * CMS exists (the JSON file is the source of truth until then).
 */
@Injectable()
export class CourseMatcherService implements OnModuleInit {
  private readonly logger = new Logger(CourseMatcherService.name);

  private catalog: CatalogCourse[] = [];
  /** skill_canonical_name → list of (course, teaches_level) tuples. Pre-indexed for O(1) skill lookup. */
  private skillIndex: Map<string, Array<{ course: CatalogCourse; teaches_level: number }>> =
    new Map();

  /** Default number of courses returned per skill. */
  private readonly TOP_N_PER_SKILL = 3;

  async onModuleInit(): Promise<void> {
    const filePath = path.join(process.cwd(), 'data', 'course-catalog.json');
    if (!fs.existsSync(filePath)) {
      this.logger.warn(
        `Course catalog not found at ${filePath}. CourseMatcherService will return empty results.`,
      );
      return;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const json = JSON.parse(raw) as { courses: CatalogCourse[] };
      this.catalog = json.courses ?? [];
      this.buildIndex();
      this.logger.log(
        `Loaded ${this.catalog.length} curated courses. Skill coverage: ${this.skillIndex.size} unique skills.`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to load course-catalog.json: ${(err as Error).message}. Catalog will be empty.`,
      );
    }
  }

  private buildIndex(): void {
    this.skillIndex.clear();
    for (const course of this.catalog) {
      for (const cs of course.skills ?? []) {
        if (!this.skillIndex.has(cs.skill_canonical_name)) {
          this.skillIndex.set(cs.skill_canonical_name, []);
        }
        this.skillIndex
          .get(cs.skill_canonical_name)!
          .push({ course, teaches_level: cs.teaches_level });
      }
    }
  }

  /**
   * Main entry point used by RoadmapService.
   * For each requested skill: returns up to TOP_N_PER_SKILL ranked courses.
   * Skills with no catalog hits are returned in `uncovered_skills`.
   */
  matchCourses(requests: CourseMatchRequest[]): CourseMatcherResult {
    const requestedSkillSet = new Set(requests.map((r) => r.skill_canonical_name));
    const per_skill: CourseMatcherResult['per_skill'] = [];
    const uncovered: string[] = [];

    for (const req of requests) {
      const candidates = this.skillIndex.get(req.skill_canonical_name) ?? [];
      if (candidates.length === 0) {
        uncovered.push(req.skill_canonical_name);
        per_skill.push({
          skill_canonical_name: req.skill_canonical_name,
          required_level: req.required_level,
          courses: [],
        });
        continue;
      }

      const scored = candidates.map(({ course, teaches_level }) =>
        this.scoreCourse(course, teaches_level, req, requestedSkillSet),
      );
      scored.sort((a, b) => b.match_score - a.match_score);

      per_skill.push({
        skill_canonical_name: req.skill_canonical_name,
        required_level: req.required_level,
        courses: scored.slice(0, this.TOP_N_PER_SKILL),
      });
    }

    return { per_skill, uncovered_skills: uncovered };
  }

  private scoreCourse(
    course: CatalogCourse,
    teaches_level: number,
    req: CourseMatchRequest,
    requestedSkillSet: Set<string>,
  ): ScoredCourse {
    const rating_pts = (course.rating / 5) * 30;
    const language_pts = course.language === 'vi' ? 20 : 0;
    const free_pts = course.is_free ? 15 : 0;
    const level_fit_pts = teaches_level >= req.required_level ? 20 : 10;

    // Multi-skill bonus: how many of the *requested* skills does this course also cover?
    const overlap = course.skills.filter((cs) =>
      requestedSkillSet.has(cs.skill_canonical_name),
    ).length;
    // Normalize over total course skills (so a course tagged with 5 skills doesn't unfairly dominate)
    const coverageRatio =
      course.skills.length > 0 ? overlap / Math.max(course.skills.length, 1) : 0;
    const multi_skill_pts = Math.min(15, coverageRatio * 15);

    const total = rating_pts + language_pts + free_pts + level_fit_pts + multi_skill_pts;

    return {
      ...course,
      match_score: Math.round(total),
      match_breakdown: {
        rating_pts: Math.round(rating_pts),
        language_pts,
        free_pts,
        level_fit_pts,
        multi_skill_pts: Math.round(multi_skill_pts),
      },
    };
  }
}
