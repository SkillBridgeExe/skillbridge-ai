import { readFileSync } from 'fs';
import { join } from 'path';
import { scoreIntakeCase, type CvIntakeEvalCase } from '../../src/calibration/eval-cv-intake';

describe('cv-intake golden set', () => {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'cv-intake-golden.json'), 'utf8'),
  ) as { cases: CvIntakeEvalCase[] };

  it('has enough cases incl. a fabricated-atom case the gate must drop', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(5);
    // At least one case feeds the LLM a fabricated atom (company/number/tech)
    // that the grounding gate must drop — exercised via `expectFabricationDropped`.
    expect(golden.cases.some((c) => c.expectFabricationDropped === true)).toBe(true);
  });

  it('every case: no fabrication and field recall >= 0.8', () => {
    for (const c of golden.cases) {
      const r = scoreIntakeCase(c);
      if (!r.noFabrication) {
        throw new Error(`case ${r.id} fabricated an atom not in the narrative`);
      }
      if (r.fieldRecall < 0.8) {
        throw new Error(`case ${r.id} fieldRecall ${r.fieldRecall} < 0.8`);
      }
      expect(r.noFabrication).toBe(true);
      expect(r.fieldRecall).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('the fabricated-atom case drops the bad value (precision stays perfect)', () => {
    const fab = golden.cases.find((c) => c.expectFabricationDropped === true)!;
    const r = scoreIntakeCase(fab);
    expect(r.noFabrication).toBe(true);
    expect(r.fieldPrecision).toBe(1);
  });
});
