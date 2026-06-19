import { CourseMatcherService } from '../../../src/modules/roadmap/course-matcher.service';
import { LearningResourceMatcherService } from '../../../src/modules/roadmap/learning-resource-matcher.service';
import { LearningResource } from '../../../src/modules/roadmap/learning-resource';

const courseRes = (over: Partial<LearningResource>): LearningResource => ({
  id: 'c',
  source_type: 'course',
  title: 't',
  provider: 'p',
  url: 'https://u',
  is_internal: false,
  language: 'en',
  duration_minutes: 60,
  difficulty: 'BEGINNER',
  is_free: false,
  skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
  outcome_type: 'understand',
  quality_score: 92,
  freshness_score: 100,
  last_verified_at: '2026-06-10',
  validation_status: 'verified',
  ...over,
});

function makeMatcher(resources: LearningResource[]): LearningResourceMatcherService {
  const m = new LearningResourceMatcherService();
  m.setCatalogForTest(resources);
  return m;
}

describe('CourseMatcherService (wrapper parity)', () => {
  it('produces the legacy ScoredCourse shape with identical match_score', () => {
    // quality 92 (=rating 4.6) en, paid, teaches 3>=3, multi 1/1
    // legacy: 27.6 + 0(en) + 0(paid) + 20 + 15 = 62.6 → 63
    const svc = new CourseMatcherService(makeMatcher([courseRes({ id: 'a' })]));
    const out = svc.matchCourses([{ skill_canonical_name: 'react', required_level: 3 }]);
    const c = out.per_skill[0].courses[0];
    expect(c.match_score).toBe(63);
    expect(c.rating).toBeCloseTo(4.6); // reconstructed from quality_score/20
    expect(c.match_breakdown).toEqual({
      rating_pts: 28,
      language_pts: 0,
      free_pts: 0,
      level_fit_pts: 20,
      multi_skill_pts: 15,
    });
  });

  it('only returns source_type=course resources and ranks them among themselves (parity)', () => {
    const svc = new CourseMatcherService(
      makeMatcher([
        courseRes({ id: 'course-hi', quality_score: 100 }),
        courseRes({ id: 'video-hi', source_type: 'video', quality_score: 100 }),
        courseRes({ id: 'course-lo', quality_score: 40 }),
      ]),
    );
    const out = svc.matchCourses([{ skill_canonical_name: 'react', required_level: 3 }]);
    expect(out.per_skill[0].courses.map((c) => c.id)).toEqual(['course-hi', 'course-lo']);
  });
});
