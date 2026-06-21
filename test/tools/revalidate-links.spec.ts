import { revalidateResources, shouldDemoteLink } from '../../src/tools/revalidate-links';
import { LearningResource } from '../../src/modules/roadmap/learning-resource';

const res = (over: Partial<LearningResource>): LearningResource => ({
  id: 'r',
  source_type: 'course',
  title: 'React Hooks',
  provider: 'Udemy',
  url: 'https://example.test/react',
  is_internal: false,
  language: 'en',
  duration_minutes: 60,
  difficulty: 'INTERMEDIATE',
  is_free: true,
  skills: [{ skill_canonical_name: 'react', teaches_level: 4 }],
  outcome_type: 'practice',
  quality_score: 80,
  freshness_score: 100,
  last_verified_at: '2026-06-10',
  validation_status: 'verified',
  ...over,
});

describe('revalidate link helpers', () => {
  it('demotes only hard dead-link signals', () => {
    expect(shouldDemoteLink(404)).toBe(true);
    expect(shouldDemoteLink(410)).toBe(true);
    expect(shouldDemoteLink(null)).toBe(true);
    expect(shouldDemoteLink(500)).toBe(false);
    expect(shouldDemoteLink(200)).toBe(false);
  });

  it('marks 404/410/timeout resources as dead_link without touching missing-url resources', async () => {
    const result = await revalidateResources(
      [
        res({ id: 'ok', url: 'https://example.test/ok' }),
        res({ id: 'gone', url: 'https://example.test/gone' }),
        res({ id: 'internal', url: undefined, is_internal: true }),
      ],
      async (url) => (url.endsWith('/gone') ? 404 : 200),
    );

    expect(result.transitions).toEqual([{ resource_id: 'gone', status: 404 }]);
    expect(result.resources.find((r) => r.id === 'gone')?.validation_status).toBe('dead_link');
    expect(result.resources.find((r) => r.id === 'ok')?.validation_status).toBe('verified');
    expect(result.resources.find((r) => r.id === 'internal')?.validation_status).toBe('verified');
  });
});
