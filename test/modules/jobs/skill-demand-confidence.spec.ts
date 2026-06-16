import { SkillDemandService } from '../../../src/modules/jobs/trends/skill-demand.service';

function makeService(rows: unknown[], total: number) {
  const db = {
    query: jest
      .fn()
      .mockResolvedValueOnce(rows) // trends rows
      .mockResolvedValueOnce([{ total: String(total) }]), // role-scoped active count
  };
  return new SkillDemandService(db as never);
}

const ROW = {
  canonical_name: 'react',
  display_name: 'React',
  posting_count: 10,
  pct_of_postings: '50',
  salary_p50: null,
  prev_count: null,
  period: '2026-06-16',
  has_prev: false,
};

describe('getTrends — data_confidence + sample_size', () => {
  it('sample_size >= 50 → high', async () => {
    const r = await makeService([ROW], 60).getTrends('backend_developer');
    expect(r.sample_size).toBe(60);
    expect(r.data_confidence).toBe('high');
    expect(r.total_active_jobs).toBe(60); // back-compat field kept, equals sample_size
  });

  it('sample_size < 20 → low', async () => {
    const r = await makeService([ROW], 8).getTrends('ai_app_engineer');
    expect(r.sample_size).toBe(8);
    expect(r.data_confidence).toBe('low');
  });

  it('sample_size 20-49 → medium', async () => {
    const r = await makeService([ROW], 35).getTrends('data_analyst');
    expect(r.data_confidence).toBe('medium');
  });
});
