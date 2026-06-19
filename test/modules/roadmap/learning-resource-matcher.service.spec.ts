import { LearningResourceMatcherService } from '../../../src/modules/roadmap/learning-resource-matcher.service';

describe('LearningResourceMatcherService', () => {
  it('loads the real merged catalog on init and matches a known seeded skill', async () => {
    const svc = new LearningResourceMatcherService();
    await svc.onModuleInit();

    const out = svc.matchResources([
      { skill_canonical_name: 'prompt_engineering', required_level: 3 },
    ]);

    expect(out.per_skill[0].resources.length).toBeGreaterThan(0);
    expect(out.per_skill[0].resources[0].source_type).toBe('course');
  });

  it('delegates to the pure matcher over an injected catalog (test seam)', () => {
    const svc = new LearningResourceMatcherService();
    svc.setCatalogForTest([
      {
        id: 'x',
        source_type: 'video',
        title: 't',
        provider: 'p',
        is_internal: false,
        language: 'en',
        duration_minutes: 10,
        difficulty: 'BEGINNER',
        is_free: true,
        skills: [{ skill_canonical_name: 'go', teaches_level: 4 }],
        outcome_type: 'understand',
        quality_score: 80,
        freshness_score: 100,
        last_verified_at: '2026-06-10',
        validation_status: 'verified',
      },
    ]);

    const out = svc.matchResources([{ skill_canonical_name: 'go', required_level: 3 }]);

    expect(out.per_skill[0].resources.map((r) => r.id)).toEqual(['x']);
  });
});
