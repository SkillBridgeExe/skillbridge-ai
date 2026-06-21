import {
  buildResourceSourceText,
  selectEmbeddableResources,
  bm25Search,
  resolveResources,
} from '../../../src/modules/roadmap/resource-embedding';
import { LearningResource } from '../../../src/modules/roadmap/learning-resource';

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

describe('buildResourceSourceText', () => {
  it('embeds curated metadata only (title, provider, description, skills, outcome) — never full content', () => {
    const t = buildResourceSourceText(res({ description: 'Deep dive into hooks and effects.' }));
    expect(t).toContain('React Hooks');
    expect(t).toContain('Udemy');
    expect(t).toContain('Deep dive into hooks and effects.');
    expect(t).toContain('react');
    expect(t).toContain('practice');
  });

  it('is stable when description is absent (no "undefined" leakage)', () => {
    const t = buildResourceSourceText(res({ description: undefined }));
    expect(t).not.toContain('undefined');
    expect(t).toContain('React Hooks');
  });
});

describe('selectEmbeddableResources', () => {
  it('embeds everything except dead_link (so pending→verified needs no re-embed)', () => {
    const cat = [
      res({ id: 'v', validation_status: 'verified' }),
      res({ id: 'p', validation_status: 'pending' }),
      res({ id: 'f', validation_status: 'flagged' }),
      res({ id: 'd', validation_status: 'dead_link' }),
    ];
    expect(
      selectEmbeddableResources(cat)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['f', 'p', 'v']);
  });
});

describe('bm25Search (sparse lane)', () => {
  const corpus = [
    { id: 'docker', text: 'Docker containers and kubernetes deployment for devops' },
    { id: 'react', text: 'React hooks and frontend state management' },
    { id: 'docker2', text: 'Intro to Docker images and registries' },
  ];

  it('ranks docs containing the query terms above unrelated docs', () => {
    const out = bm25Search('how do i learn docker containers', corpus);
    expect(out[0]).toBe('docker'); // most query-term overlap
    expect(out).toContain('docker2');
    expect(out).not.toContain('react'); // no overlap → excluded (score 0)
  });

  it('returns [] when nothing matches (honest empty for the sparse lane)', () => {
    expect(bm25Search('xyzzy nonexistent', corpus)).toEqual([]);
  });

  it('respects topK', () => {
    expect(bm25Search('docker', corpus, 1)).toHaveLength(1);
  });
});

describe('resolveResources (verified-only + metadata filter, preserves fused rank order)', () => {
  const cat = [
    res({ id: 'a', validation_status: 'verified', language: 'en', url: 'https://a' }),
    res({ id: 'b', validation_status: 'pending', language: 'en' }),
    res({ id: 'c', validation_status: 'verified', language: 'vi' }),
  ];

  it('keeps only verified, joins metadata, drops unknown ids, preserves order, stamps 1-based rank', () => {
    const out = resolveResources(['a', 'b', 'zzz', 'c'], cat);
    expect(out.map((r) => r.resource_id)).toEqual(['a', 'c']); // b=pending + zzz=unknown dropped
    expect(out[0]).toMatchObject({ resource_id: 'a', rank: 1, url: 'https://a' });
    expect(out[1].rank).toBe(2);
  });

  it('applies the optional language filter and topK', () => {
    expect(resolveResources(['a', 'c'], cat, { language: 'vi' }).map((r) => r.resource_id)).toEqual(
      ['c'],
    );
    expect(resolveResources(['a', 'c'], cat, { topK: 1 }).map((r) => r.resource_id)).toEqual(['a']);
  });
});
