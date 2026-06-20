import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreCurationCase,
  skeletonCurate,
  CurationEvalCase,
} from '../../../src/modules/resource-curation/curation-eval';
import { CuratedResource } from '../../../src/modules/resource-curation/curation-scoring';

const baseCase: CurationEvalCase = {
  id: 'c',
  category: 'clear_verify',
  input: { title: 'T', provider: 'react.dev', description: 'd', skills: ['docker'] },
  expected_levels: { relevance: 3, authority: 3, currency: 3, accuracy: 3, purpose: 3 },
  expected_flags: [],
  expected_status: 'verified',
  expected_quality_band: [95, 100],
};
const out = (over: Partial<CuratedResource>): CuratedResource => ({
  quality_score: 100,
  validation_status: 'verified',
  description: 'clean',
  flags: [],
  craap: { relevance: 1, authority: 1, currency: 1, accuracy: 1, purpose: 1 },
  ...over,
});

describe('scoreCurationCase', () => {
  it('passes when decision matches, no URL, flags in-vocab, quality in band', () => {
    expect(scoreCurationCase(baseCase, out({})).pass).toBe(true);
  });

  it('fails decision_match when the status differs from expected', () => {
    const r = scoreCurationCase(baseCase, out({ validation_status: 'pending' }));
    expect(r.decision_match).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('fails no_raw_url when the output description still carries a URL', () => {
    const r = scoreCurationCase(baseCase, out({ description: 'see https://x.example' }));
    expect(r.no_raw_url).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('fails quality_in_band when the score is outside the expected band', () => {
    const r = scoreCurationCase(baseCase, out({ quality_score: 40 }));
    expect(r.quality_in_band).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('flags_subset is false when an off-vocabulary flag leaks into the output', () => {
    const r = scoreCurationCase(baseCase, out({ flags: ['BOGUS'] as never }));
    expect(r.flags_subset).toBe(false);
  });
});

describe('curation golden set (skeleton self-consistency)', () => {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'curation-golden.json'), 'utf8'),
  ) as { cases: CurationEvalCase[] };

  it('has a boundary-covering set of well-formed cases', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(10);
    const cats = new Set(golden.cases.map((c) => c.category));
    for (const need of [
      'clear_verify',
      'sub_threshold',
      'flag_promotional',
      'no_skills',
      'url_in_description',
    ]) {
      expect(cats.has(need)).toBe(true);
    }
  });

  it('every golden label is self-consistent with the deterministic core (skeletonCurate → pass)', () => {
    for (const c of golden.cases) {
      const result = scoreCurationCase(c, skeletonCurate(c));
      expect(result).toMatchObject({ id: c.id, pass: true });
    }
  });
});
