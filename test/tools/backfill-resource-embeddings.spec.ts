import {
  buildResourceEmbeddingRows,
  selectResourceEmbeddingTodo,
} from '../../src/tools/backfill-resource-embeddings';
import { LearningResource } from '../../src/modules/roadmap/learning-resource';

const res = (over: Partial<LearningResource>): LearningResource => ({
  id: 'r',
  source_type: 'course',
  title: 'React Hooks',
  provider: 'Udemy',
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

describe('resource embedding backfill helpers', () => {
  it('embeds pending/verified resources, skips dead links and existing tuple rows', () => {
    const todo = selectResourceEmbeddingTodo(
      [
        res({ id: 'verified', validation_status: 'verified' }),
        res({ id: 'pending', validation_status: 'pending' }),
        res({ id: 'dead', validation_status: 'dead_link' }),
      ],
      new Set(['verified']),
    );

    expect(todo.map((r) => r.id)).toEqual(['pending']);
  });

  it('builds metadata-only embedding rows pinned to the embedding tuple', () => {
    const rows = buildResourceEmbeddingRows(
      [res({ id: 'react-hooks', description: 'Hooks and effects.' })],
      [[0.1, 0.2]],
      'text-embedding-3-large',
      1024,
      'v1',
    );

    expect(rows).toEqual([
      expect.objectContaining({
        resource_id: 'react-hooks',
        source_text: expect.stringContaining('Hooks and effects.'),
        embedding: [0.1, 0.2],
        model: 'text-embedding-3-large',
        dimensions: 1024,
        embedding_version: 'v1',
      }),
    ]);
    expect(rows[0].source_text).not.toContain('undefined');
  });
});
