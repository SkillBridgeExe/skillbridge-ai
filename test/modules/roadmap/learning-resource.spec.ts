import { CatalogCourse } from '../../../src/modules/roadmap/course-matcher.service';
import {
  LearningResource,
  mapCourseToLearningResource,
  matchResources,
  mergeResourceCatalogs,
} from '../../../src/modules/roadmap/learning-resource';

const COURSE: CatalogCourse = {
  id: 'c1',
  title: 'React Basics',
  url: 'https://x/react',
  provider: 'X',
  language: 'en',
  duration_minutes: 120,
  rating: 4.6,
  is_free: true,
  difficulty: 'BEGINNER',
  skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
};

const res = (over: Partial<LearningResource>): LearningResource => ({
  id: 'r',
  source_type: 'course',
  title: 't',
  provider: 'p',
  is_internal: false,
  language: 'en',
  duration_minutes: 10,
  difficulty: 'BEGINNER',
  is_free: true,
  skills: [],
  outcome_type: 'understand',
  quality_score: 50,
  freshness_score: 100,
  last_verified_at: '2026-06-10',
  validation_status: 'verified',
  ...over,
});

describe('mapCourseToLearningResource', () => {
  it('maps a CatalogCourse to a verified course LearningResource (quality = rating*20)', () => {
    const r = mapCourseToLearningResource(COURSE, '2026-06-10');
    expect(r).toMatchObject({
      id: 'c1',
      source_type: 'course',
      is_internal: false,
      url: 'https://x/react',
      quality_score: 92,
      freshness_score: 100,
      validation_status: 'verified',
      last_verified_at: '2026-06-10',
      outcome_type: 'understand',
      skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
    });
  });
});

describe('mergeResourceCatalogs', () => {
  it('explicit catalog OVERRIDES the mapped seed on duplicate id and warns', () => {
    const seed = [res({ id: 'dup', title: 'seed' }), res({ id: 'only-seed' })];
    const explicit = [res({ id: 'dup', title: 'explicit' }), res({ id: 'only-explicit' })];
    const warned: string[] = [];
    const merged = mergeResourceCatalogs(seed, explicit, (id) => warned.push(id));
    expect(warned).toEqual(['dup']);
    expect(merged.find((r) => r.id === 'dup')?.title).toBe('explicit');
    expect(merged.map((r) => r.id).sort()).toEqual(['dup', 'only-explicit', 'only-seed']);
  });
});

describe('matchResources', () => {
  const reqs = [{ skill_canonical_name: 'react', required_level: 3 }];

  it('scores a verified course: quality/100*30 + vi + free + level_fit + multi', () => {
    const catalog = [
      res({
        id: 'a',
        quality_score: 92,
        language: 'vi',
        is_free: true,
        skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
      }),
    ];
    const out = matchResources(catalog, reqs);
    expect(out.per_skill[0].resources[0].match_score).toBe(98);
    expect(out.per_skill[0].resources[0].low_confidence).toBe(false);
  });

  it('excludes flagged + dead_link resources entirely', () => {
    const catalog = [
      res({
        id: 'flag',
        validation_status: 'flagged',
        skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
      }),
      res({
        id: 'dead',
        validation_status: 'dead_link',
        skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
      }),
    ];
    const out = matchResources(catalog, reqs);
    expect(out.per_skill[0].resources).toEqual([]);
    expect(out.uncovered_skills).toEqual(['react']);
  });

  it('uses pending ONLY as fallback when no verified exists, marking low_confidence', () => {
    const pending = res({
      id: 'p',
      validation_status: 'pending',
      skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
    });
    const verified = res({
      id: 'v',
      validation_status: 'verified',
      skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
    });

    const withVerified = matchResources([pending, verified], reqs);
    expect(withVerified.per_skill[0].resources.map((r) => r.id)).toEqual(['v']);

    const onlyPending = matchResources([pending], reqs);
    expect(onlyPending.per_skill[0].resources.map((r) => r.id)).toEqual(['p']);
    expect(onlyPending.per_skill[0].resources[0].low_confidence).toBe(true);
  });

  it('opts.sourceTypes filters the catalog before matching (course wrapper uses this)', () => {
    const catalog = [
      res({
        id: 'course',
        source_type: 'course',
        skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
      }),
      res({
        id: 'video',
        source_type: 'video',
        skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
      }),
    ];
    const out = matchResources(catalog, reqs, { sourceTypes: ['course'] });
    expect(out.per_skill[0].resources.map((r) => r.id)).toEqual(['course']);
  });
});
