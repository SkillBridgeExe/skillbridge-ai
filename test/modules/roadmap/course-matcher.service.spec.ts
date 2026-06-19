import { CourseMatcherService } from '../../../src/modules/roadmap/course-matcher.service';
import { LearningResource } from '../../../src/modules/roadmap/learning-resource';
import { LearningResourceMatcherService } from '../../../src/modules/roadmap/learning-resource-matcher.service';

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
  const matcher = new LearningResourceMatcherService();
  matcher.setCatalogForTest(resources);
  return matcher;
}

describe('CourseMatcherService (wrapper parity)', () => {
  it('produces the legacy ScoredCourse shape with identical match_score', () => {
    const svc = new CourseMatcherService(makeMatcher([courseRes({ id: 'a' })]));
    const out = svc.matchCourses([{ skill_canonical_name: 'react', required_level: 3 }]);
    const course = out.per_skill[0].courses[0];

    expect(course.match_score).toBe(63);
    expect(course.rating).toBeCloseTo(4.6);
    expect(course.match_breakdown).toEqual({
      rating_pts: 28,
      language_pts: 0,
      free_pts: 0,
      level_fit_pts: 20,
      multi_skill_pts: 15,
    });
  });

  it('only returns source_type=course resources and ranks them among themselves', () => {
    const svc = new CourseMatcherService(
      makeMatcher([
        courseRes({ id: 'course-hi', quality_score: 100 }),
        courseRes({ id: 'video-hi', source_type: 'video', quality_score: 100 }),
        courseRes({ id: 'course-lo', quality_score: 40 }),
      ]),
    );

    const out = svc.matchCourses([{ skill_canonical_name: 'react', required_level: 3 }]);

    expect(out.per_skill[0].courses.map((course) => course.id)).toEqual(['course-hi', 'course-lo']);
  });
});
