import * as fs from 'fs';
import * as path from 'path';
import {
  CatalogCourse,
  CourseMatcherService,
  CourseMatchRequest,
} from '../../../src/modules/roadmap/course-matcher.service';
import { LearningResourceMatcherService } from '../../../src/modules/roadmap/learning-resource-matcher.service';

/**
 * SHOULD-2 regression: prove the refactored CourseMatcherService (now a wrapper over the unified
 * LearningResource matcher) produces BYTE-IDENTICAL scores + ordering to the legacy formula for the
 * capped top results from the real `data/course-catalog.json`. Re-implements the pre-refactor scoring
 * exactly as the oracle.
 */

const TOP_N_PER_SKILL = 10;

// --- Legacy oracle: the exact formula from the pre-refactor CourseMatcherService.scoreCourse ---
function legacyScore(
  course: CatalogCourse,
  teachesLevel: number,
  requiredLevel: number,
  requestedSet: Set<string>,
): number {
  const rating_pts = (course.rating / 5) * 30;
  const language_pts = course.language === 'vi' ? 20 : 0;
  const free_pts = course.is_free ? 15 : 0;
  const level_fit_pts = teachesLevel >= requiredLevel ? 20 : 10;
  const overlap = course.skills.filter((s) => requestedSet.has(s.skill_canonical_name)).length;
  const coverageRatio = course.skills.length > 0 ? overlap / Math.max(course.skills.length, 1) : 0;
  const multi_skill_pts = Math.min(15, coverageRatio * 15);
  return Math.round(rating_pts + language_pts + free_pts + level_fit_pts + multi_skill_pts);
}

function legacyMatch(
  catalog: CatalogCourse[],
  requests: CourseMatchRequest[],
): Array<{ skill: string; ids: string[]; scores: number[] }> {
  const skillIndex = new Map<string, Array<{ course: CatalogCourse; teaches_level: number }>>();
  for (const course of catalog) {
    for (const cs of course.skills ?? []) {
      if (!skillIndex.has(cs.skill_canonical_name)) skillIndex.set(cs.skill_canonical_name, []);
      skillIndex.get(cs.skill_canonical_name)!.push({ course, teaches_level: cs.teaches_level });
    }
  }
  const requestedSet = new Set(requests.map((r) => r.skill_canonical_name));
  return requests.map((req) => {
    const candidates = skillIndex.get(req.skill_canonical_name) ?? [];
    const scored = candidates
      .map(({ course, teaches_level }) => ({
        id: course.id,
        score: legacyScore(course, teaches_level, req.required_level, requestedSet),
      }))
      .sort((a, b) => b.score - a.score);
    return {
      skill: req.skill_canonical_name,
      ids: scored.map((s) => s.id),
      scores: scored.map((s) => s.score),
    };
  });
}

describe('CourseMatcherService real-catalog parity (no drift vs legacy)', () => {
  const catalog = (
    JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'data', 'course-catalog.json'), 'utf-8'),
    ) as { courses: CatalogCourse[] }
  ).courses;

  const skills = [...new Set(catalog.flatMap((c) => c.skills.map((s) => s.skill_canonical_name)))];
  const requests: CourseMatchRequest[] = skills.map((s) => ({
    skill_canonical_name: s,
    required_level: 3,
  }));

  const matcher = new LearningResourceMatcherService();
  matcher.onModuleInit();
  const wrapper = new CourseMatcherService(matcher).matchCourses(requests);
  const legacy = legacyMatch(catalog, requests);

  it('covers the whole catalog (sanity: many skills, aligned order)', () => {
    expect(skills.length).toBeGreaterThan(20);
    expect(wrapper.per_skill.map((p) => p.skill_canonical_name)).toEqual(
      legacy.map((l) => l.skill),
    );
  });

  it('max match_score diff = 0 across each returned top course in every skill', () => {
    let maxDiff = 0;
    for (let i = 0; i < requests.length; i++) {
      const legacyIds = new Set(legacy[i].ids);
      const w = wrapper.per_skill[i].courses.filter((c) => legacyIds.has(c.id));
      const l = legacy[i];
      expect(w.length).toBe(Math.min(TOP_N_PER_SKILL, l.scores.length));
      for (let j = 0; j < w.length; j++) {
        maxDiff = Math.max(maxDiff, Math.abs(w[j].match_score - l.scores[j]));
      }
    }
    expect(maxDiff).toBe(0);
  });

  it('top course ORDER is unchanged for every skill (no rank drift)', () => {
    for (let i = 0; i < requests.length; i++) {
      const legacyIds = new Set(legacy[i].ids);
      const w = wrapper.per_skill[i].courses.filter((c) => legacyIds.has(c.id));
      expect(w.map((c) => c.id)).toEqual(legacy[i].ids.slice(0, TOP_N_PER_SKILL));
    }
  });
});
