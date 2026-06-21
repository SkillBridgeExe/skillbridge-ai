import { LearningResourceRetriever } from '../../../src/modules/roadmap/learning-resource-retriever.service';
import { LearningResourceMatcherService } from '../../../src/modules/roadmap/learning-resource-matcher.service';
import { LearningResource } from '../../../src/modules/roadmap/learning-resource';

const res = (over: Partial<LearningResource>): LearningResource => ({
  id: 'r',
  source_type: 'course',
  title: 'T',
  provider: 'P',
  is_internal: false,
  language: 'en',
  duration_minutes: 60,
  difficulty: 'BEGINNER',
  is_free: true,
  skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
  outcome_type: 'understand',
  quality_score: 80,
  freshness_score: 100,
  last_verified_at: '2026-06-10',
  validation_status: 'verified',
  ...over,
});

const config = {
  get: (k: string): unknown =>
    ({
      'llm.openai.modelEmbedding': 'text-embedding-3-large',
      'vector.dimension': 1024,
      'vector.embeddingVersion': 'v1',
    })[k],
};

function matcherWith(cat: LearningResource[]): LearningResourceMatcherService {
  const m = new LearningResourceMatcherService();
  m.setCatalogForTest(cat);
  return m;
}

describe('LearningResourceRetriever.nearest (hybrid dense + sparse + RRF)', () => {
  it('fuses dense (vector) and sparse (BM25) rankings — finds what each lane alone would, verified-only', async () => {
    const cat = [
      res({ id: 'dense-win', title: 'Advanced Patterns', description: 'unrelated material' }),
      res({
        id: 'sparse-win',
        title: 'Docker Deep Dive',
        description: 'docker containers kubernetes',
        skills: [{ skill_canonical_name: 'docker', teaches_level: 4 }],
      }),
    ];
    const llm = { embed: jest.fn().mockResolvedValue({ embedding: new Array(1024).fill(0.1) }) };
    const db = {
      query: jest.fn().mockResolvedValue([{ resource_id: 'dense-win', similarity: 0.9 }]),
    };
    const svc = new LearningResourceRetriever(
      llm as never,
      db as never,
      matcherWith(cat),
      config as never,
    );

    const out = await svc.nearest({ query: 'docker containers' });

    expect(llm.embed).toHaveBeenCalledWith('docker containers', { dimensions: 1024 });
    expect(db.query.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['text-embedding-3-large', 1024, 'v1']),
    );
    const ids = out.map((r) => r.resource_id);
    expect(ids).toContain('dense-win'); // surfaced only by the dense lane
    expect(ids).toContain('sparse-win'); // surfaced only by the sparse lane → hybrid caught both
  });

  it('degrades to sparse-only when the dense vector query fails (e.g. backfill not run / table missing)', async () => {
    const cat = [res({ id: 'docker', title: 'Docker', description: 'docker containers' })];
    const llm = { embed: jest.fn().mockResolvedValue({ embedding: new Array(1024).fill(0) }) };
    const db = {
      query: jest.fn().mockRejectedValue(new Error('relation resource_embeddings does not exist')),
    };
    const svc = new LearningResourceRetriever(
      llm as never,
      db as never,
      matcherWith(cat),
      config as never,
    );

    const out = await svc.nearest({ query: 'docker' });
    expect(out.map((r) => r.resource_id)).toEqual(['docker']); // sparse lane still answers
  });

  it('returns [] honestly when both lanes find nothing', async () => {
    const llm = { embed: jest.fn().mockResolvedValue({ embedding: new Array(1024).fill(0) }) };
    const db = { query: jest.fn().mockResolvedValue([]) };
    const svc = new LearningResourceRetriever(
      llm as never,
      db as never,
      matcherWith([]),
      config as never,
    );
    expect(await svc.nearest({ query: 'docker' })).toEqual([]);
  });

  it('searches VERIFIED-only — a flagged/pending resource never takes a slot (even if it would rank #1)', async () => {
    const cat = [
      res({
        id: 'flagged-top',
        title: 'Docker Masterclass',
        description: 'docker docker docker containers kubernetes',
        validation_status: 'flagged',
      }),
      res({ id: 'verified-real', title: 'Docker Basics', description: 'docker containers' }),
    ];
    const llm = { embed: jest.fn().mockResolvedValue({ embedding: new Array(1024).fill(0) }) };
    const db = { query: jest.fn().mockResolvedValue([]) }; // dense empty → sparse decides
    const svc = new LearningResourceRetriever(
      llm as never,
      db as never,
      matcherWith(cat),
      config as never,
    );
    const out = await svc.nearest({ query: 'docker containers' });
    // flagged-top would dominate BM25, but it is excluded from the SEARCH corpus, not just the resolve step.
    expect(out.map((r) => r.resource_id)).toEqual(['verified-real']);
  });
});
