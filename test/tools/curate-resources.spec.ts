import { applyCuration, parseArgs, selectPendingResources } from '../../src/tools/curate-resources';
import { LearningResource } from '../../src/modules/roadmap/learning-resource';

const res = (over: Partial<LearningResource>): LearningResource => ({
  id: 'r',
  source_type: 'official_doc',
  title: 'Docker Docs',
  provider: 'Docker',
  url: 'https://docs.docker.com',
  is_internal: false,
  language: 'en',
  duration_minutes: 30,
  difficulty: 'BEGINNER',
  is_free: true,
  skills: [{ skill_canonical_name: 'docker', teaches_level: 3 }],
  outcome_type: 'understand',
  quality_score: 50,
  freshness_score: 80,
  last_verified_at: '2026-06-10',
  validation_status: 'pending',
  ...over,
});

describe('curate-resources helpers', () => {
  it('parses dry-run/apply controls', () => {
    expect(parseArgs(['--apply', '--only=docker-docs', '--limit=2'])).toEqual({
      apply: true,
      only: 'docker-docs',
      limit: 2,
    });
    expect(parseArgs([])).toEqual({ apply: false });
  });

  it('selects only pending resources, with optional id and limit filters', () => {
    const resources = [
      res({ id: 'a', validation_status: 'pending' }),
      res({ id: 'b', validation_status: 'verified' }),
      res({ id: 'c', validation_status: 'pending' }),
    ];

    expect(selectPendingResources(resources, { apply: false }).map((r) => r.id)).toEqual([
      'a',
      'c',
    ]);
    expect(
      selectPendingResources(resources, { apply: false, only: 'c', limit: 1 }).map((r) => r.id),
    ).toEqual(['c']);
  });

  it('applies curated fields while preserving catalog identity and skill metadata', () => {
    const original = res({ id: 'docker-docs', quality_score: 10 });
    const updated = applyCuration(
      original,
      {
        quality_score: 91,
        validation_status: 'verified',
        description: 'Official Docker learning path.',
        flags: [],
        craap: { relevance: 1, authority: 1, currency: 1, accuracy: 1, purpose: 1 },
      },
      '2026-06-21',
    );

    expect(updated).toEqual(
      expect.objectContaining({
        id: 'docker-docs',
        provider: 'Docker',
        validation_status: 'verified',
        quality_score: 91,
        freshness_score: 100,
        last_verified_at: '2026-06-21',
        description: 'Official Docker learning path.',
        skills: original.skills,
      }),
    );
    expect((updated as unknown as Record<string, unknown>).craap).toBeUndefined();
  });
});
