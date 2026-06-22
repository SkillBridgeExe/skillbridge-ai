/**
 * Deterministic eval for the CV Builder Assistant (no LLM): a golden set of hand-labeled cases run
 * through the REAL pure functions. Two kinds:
 *   - 'gaps'    : a bullet → the gaps `analyzeBulletGaps` must detect.
 *   - 'rewrite' : answers + a candidate model rewrite → whether `groundCvRewrite` ACCEPTS it
 *                 (anti-fabrication: a rewrite that invents a number/entity must be rejected).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  analyzeBulletGaps,
  BulletGap,
  CvAnswer,
  Language,
} from '../modules/cv-assistant/cv-assistant';
import {
  groundCvAssistantAnswers,
  groundCvRewrite,
} from '../modules/cv-assistant/cv-assistant-rewrite';

export type CvAssistantEvalCase =
  | { id: string; kind: 'gaps'; bullet: string; language: Language; expected_gaps: BulletGap[] }
  | {
      id: string;
      kind: 'rewrite';
      before: string;
      answers: CvAnswer[];
      language: Language;
      model_after: string;
      model_used_facts: string[];
      /** true = the rewrite is fully grounded and should be ACCEPTED; false = it must be REJECTED. */
      expect_ok: boolean;
    };

export interface CvAssistantEvalResult {
  id: string;
  pass: boolean;
  detail: string;
}

export function scoreCvAssistantCase(c: CvAssistantEvalCase): CvAssistantEvalResult {
  if (c.kind === 'gaps') {
    const got = analyzeBulletGaps(c.bullet, c.language);
    const pass = JSON.stringify(got) === JSON.stringify(c.expected_gaps);
    return {
      id: c.id,
      pass,
      detail: pass ? '' : `gaps ${JSON.stringify(got)} != ${JSON.stringify(c.expected_gaps)}`,
    };
  }
  const grounded = groundCvAssistantAnswers(c.answers, c.language);
  const verdict = groundCvRewrite(
    c.before,
    { after: c.model_after, used_facts: c.model_used_facts },
    grounded,
    { target: 't', why: 'w' },
  );
  const pass = verdict.ok === c.expect_ok;
  return {
    id: c.id,
    pass,
    detail: pass
      ? ''
      : `expected ok=${c.expect_ok} got ok=${verdict.ok}` +
        (verdict.ok ? '' : ` (${verdict.detail})`),
  };
}

// CLI runner: `pnpm eval:cv-assistant` (also exercised deterministically by cv-assistant-eval.spec.ts).
if (require.main === module) {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'cv-assistant-golden.json'), 'utf8'),
  ) as { cases: CvAssistantEvalCase[] };
  let failed = 0;
  for (const c of golden.cases) {
    const r = scoreCvAssistantCase(c);
    if (!r.pass) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`FAIL ${r.id}: ${r.detail}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`cv-assistant eval: ${golden.cases.length - failed}/${golden.cases.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}
