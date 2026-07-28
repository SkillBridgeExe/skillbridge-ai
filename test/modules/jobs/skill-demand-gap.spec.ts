import { SkillDemandService } from '../../../src/modules/jobs/trends/skill-demand.service';

/** getSkillGap query order: cv ownership → trends rows → active count → cv skills. */
function makeService(trendRows: unknown[], cvSkills: string[]) {
  const db = {
    query: jest
      .fn()
      .mockResolvedValueOnce([{ id: 'cv-1' }])
      .mockResolvedValueOnce(trendRows)
      .mockResolvedValueOnce([{ total: '60' }])
      .mockResolvedValueOnce(cvSkills.map((canonical_name) => ({ canonical_name }))),
  };
  return { service: new SkillDemandService(db as never), db };
}

function row(canonical: string, pct: string) {
  return {
    canonical_name: canonical,
    display_name: canonical,
    posting_count: 10,
    pct_of_postings: pct,
    salary_p50: null,
    prev_count: null,
    period: '2026-07-16',
    has_prev: false,
  };
}

describe('getSkillGap — satisfies-edge closure parity with the match engine', () => {
  it('a curated child on the CV covers its parent market skill', async () => {
    // postgresql ⇒ sql is a curated edge in data/skill-satisfies-edges.json —
    // the match audit credits it, so the market gap list must agree.
    const { service } = makeService([row('sql', '60'), row('docker', '30')], ['postgresql']);

    const result = await service.getSkillGap('user-1', 'cv-1', 'all');

    const sql = result.skills.find((s) => s.canonical_name === 'sql');
    const docker = result.skills.find((s) => s.canonical_name === 'docker');
    expect(sql?.covered).toBe(true);
    expect(docker?.covered).toBe(false);
    expect(result.gap.map((s) => s.canonical_name)).toEqual(['docker']);
  });

  it('exact canonical hits still cover, unrelated skills stay gaps', async () => {
    const { service } = makeService([row('react', '50'), row('kubernetes', '20')], ['react']);

    const result = await service.getSkillGap('user-1', 'cv-1', 'all');

    expect(result.skills.find((s) => s.canonical_name === 'react')?.covered).toBe(true);
    expect(result.gap.map((s) => s.canonical_name)).toEqual(['kubernetes']);
  });
});

describe('getTrends — row cap fits the full taxonomy', () => {
  it('passes the requested 200-row full-snapshot limit through un-clamped', async () => {
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce([row('react', '50')])
        .mockResolvedValueOnce([{ total: '60' }]),
    };
    const service = new SkillDemandService(db as never);

    await service.getTrends('all', 200);

    // The old 106 cap (pre-O*NET taxonomy) silently truncated rank-107+ rows.
    expect(db.query.mock.calls[0][1]).toEqual(['all', 200]);
  });
});
