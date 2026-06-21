import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreCvAssistantCase,
  type CvAssistantEvalCase,
} from '../../src/calibration/eval-cv-assistant-turns';

describe('cv-assistant golden set', () => {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'cv-assistant-golden.json'), 'utf8'),
  ) as { cases: CvAssistantEvalCase[] };

  it('covers gap-detection + rewrite-accept + rewrite-reject (anti-fabrication)', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(10);
    expect(golden.cases.some((c) => c.kind === 'gaps')).toBe(true);
    expect(golden.cases.some((c) => c.kind === 'rewrite' && c.expect_ok)).toBe(true);
    expect(golden.cases.some((c) => c.kind === 'rewrite' && !c.expect_ok)).toBe(true);
  });

  it('every golden case PASSES (self-consistent)', () => {
    for (const c of golden.cases) {
      const r = scoreCvAssistantCase(c);
      if (!r.pass) throw new Error(`case ${c.id} failed: ${r.detail}`);
      expect(r.pass).toBe(true);
    }
  });
});
