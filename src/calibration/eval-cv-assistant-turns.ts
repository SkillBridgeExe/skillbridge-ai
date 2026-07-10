/**
 * Deterministic eval for the CV Builder Assistant (no LLM): a golden set of hand-labeled cases run
 * through the REAL pure functions. Kinds:
 *   - 'gaps'             : a bullet → the gaps `analyzeBulletGaps` must detect.
 *   - 'rewrite'          : answers + a candidate model rewrite → whether `groundCvRewrite` ACCEPTS it
 *                          (anti-fabrication: a rewrite that invents a number/entity must be rejected).
 *   - 'grounding'        : a raw (simulated LLM) smart-question payload → what `groundSmartQuestions`
 *                          must keep/strip/drop (anti-fabrication + off-taxonomy gate, Task 2).
 *   - 'grounding_role_diff': two raw payloads for the SAME bullet/gap (role-specific chip sets) →
 *                          grounding must preserve each set distinctly (proves it doesn't homogenize).
 *   - 'explanation'      : a field → the exact citedSignals the read-only explanation must emit
 *                          (P3-5 case 5: an explanation may cite ONLY deterministic signal IDs).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  analyzeBulletGaps,
  AssistantGap,
  BulletGap,
  CvAnswer,
  Language,
} from '../modules/cv-assistant/cv-assistant';
import {
  groundCvAssistantAnswers,
  groundCvRewrite,
} from '../modules/cv-assistant/cv-assistant-rewrite';
import {
  groundSmartQuestions,
  hasPlantedNumber,
} from '../modules/cv-assistant/cv-question-grounding';
import {
  buildCvAssistantExplanation,
  CitedSignal,
} from '../modules/cv-assistant/cv-assistant-explain';

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
    }
  | {
      id: string;
      kind: 'grounding';
      language: Language;
      detected_gaps: AssistantGap[];
      /** simulated LLM output fed straight into `groundSmartQuestions` (no LLM call). */
      raw: unknown;
      /** fixture sanity: strings inside `raw` that MUST already read as planted numbers — guards
       *  against the fixture itself going stale/non-adversarial and the case passing vacuously. */
      expect_raw_has_planted_number?: string[];
      /** true = grounding must reject the whole payload (every question off-taxonomy). */
      expect_null: boolean;
      /** exact ordered list of gaps expected to survive grounding. */
      expect_gaps?: AssistantGap[];
      /** exact chip-label list expected to survive per gap (planted-number chips stripped). */
      expect_chip_labels?: Partial<Record<AssistantGap, string[]>>;
      /** gaps whose surviving prompt must NOT read as a planted number (fell back to the safe prompt). */
      expect_prompt_no_planted_number?: AssistantGap[];
    }
  | {
      id: string;
      kind: 'grounding_role_diff';
      language: Language;
      detected_gaps: AssistantGap[];
      raw_a: unknown;
      raw_b: unknown;
      expect_chips_a: string[];
      expect_chips_b: string[];
    }
  | {
      id: string;
      kind: 'explanation';
      text: string;
      section: 'summary' | 'projects' | 'experience';
      language: Language;
      expected_signals: CitedSignal[];
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
  if (c.kind === 'grounding') {
    for (const text of c.expect_raw_has_planted_number ?? []) {
      if (!hasPlantedNumber(text)) {
        return {
          id: c.id,
          pass: false,
          detail: `fixture stale: "${text}" no longer reads as a planted number`,
        };
      }
    }
    const grounded = groundSmartQuestions(c.raw, c.detected_gaps, c.language);
    if (c.expect_null) {
      const pass = grounded === null;
      return {
        id: c.id,
        pass,
        detail: pass ? '' : `expected null (all off-taxonomy), got ${JSON.stringify(grounded)}`,
      };
    }
    if (!grounded) {
      return { id: c.id, pass: false, detail: 'expected a grounded result, got null' };
    }
    const gotGaps = grounded.questions.map((q) => q.gap);
    const expectedGaps = c.expect_gaps ?? [];
    if (JSON.stringify(gotGaps) !== JSON.stringify(expectedGaps)) {
      return {
        id: c.id,
        pass: false,
        detail: `gaps ${JSON.stringify(gotGaps)} != ${JSON.stringify(expectedGaps)}`,
      };
    }
    for (const [gap, labels] of Object.entries(c.expect_chip_labels ?? {})) {
      const q = grounded.questions.find((x) => x.gap === gap);
      const gotLabels = q ? q.options.map((o) => o.label) : [];
      if (JSON.stringify(gotLabels) !== JSON.stringify(labels)) {
        return {
          id: c.id,
          pass: false,
          detail: `chips[${gap}] ${JSON.stringify(gotLabels)} != ${JSON.stringify(labels)}`,
        };
      }
    }
    for (const gap of c.expect_prompt_no_planted_number ?? []) {
      const q = grounded.questions.find((x) => x.gap === gap);
      if (!q || hasPlantedNumber(q.prompt)) {
        return {
          id: c.id,
          pass: false,
          detail: `prompt[${gap}] still reads as a planted number: "${q?.prompt}"`,
        };
      }
    }
    return { id: c.id, pass: true, detail: '' };
  }
  if (c.kind === 'grounding_role_diff') {
    const a = groundSmartQuestions(c.raw_a, c.detected_gaps, c.language);
    const b = groundSmartQuestions(c.raw_b, c.detected_gaps, c.language);
    if (!a || !b) {
      return {
        id: c.id,
        pass: false,
        detail: `expected both grounded, got a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
      };
    }
    const chipsA = a.questions.flatMap((q) => q.options.map((o) => o.label));
    const chipsB = b.questions.flatMap((q) => q.options.map((o) => o.label));
    const matchesA = JSON.stringify(chipsA) === JSON.stringify(c.expect_chips_a);
    const matchesB = JSON.stringify(chipsB) === JSON.stringify(c.expect_chips_b);
    const differ = JSON.stringify(chipsA) !== JSON.stringify(chipsB);
    const pass = matchesA && matchesB && differ;
    return {
      id: c.id,
      pass,
      detail: pass
        ? ''
        : `chipsA=${JSON.stringify(chipsA)} (expected ${JSON.stringify(c.expect_chips_a)}) chipsB=${JSON.stringify(chipsB)} (expected ${JSON.stringify(c.expect_chips_b)})`,
    };
  }
  if (c.kind === 'explanation') {
    const got = buildCvAssistantExplanation({
      page: 'cv_builder',
      section: c.section,
      current_value: c.text,
      locale: c.language,
    });
    if (!got || got.type !== 'explanation' || !got.message.trim()) {
      return { id: c.id, pass: false, detail: `no explanation: ${JSON.stringify(got)}` };
    }
    const pass = JSON.stringify(got.citedSignals) === JSON.stringify(c.expected_signals);
    return {
      id: c.id,
      pass,
      detail: pass
        ? ''
        : `signals ${JSON.stringify(got.citedSignals)} != ${JSON.stringify(c.expected_signals)}`,
    };
  }
  const grounded = groundCvAssistantAnswers(c.answers, c.language);
  const verdict = groundCvRewrite(
    c.before,
    { after: c.model_after, used_facts: c.model_used_facts },
    grounded,
    { target: 't', why: 'w' },
  );
  if (verdict.ok !== c.expect_ok) {
    return {
      id: c.id,
      pass: false,
      detail:
        `expected ok=${c.expect_ok} got ok=${verdict.ok}` +
        (verdict.ok ? '' : ` (${verdict.detail})`),
    };
  }
  // P3-5 case 6 (BE side): an accepted patch must echo the exact target/before it was asked
  // for — the FE fail-closed validator relies on that fidelity to apply it to the right field.
  if (verdict.ok) {
    const fp = verdict.field_patch;
    if (fp.target !== 't' || fp.before !== c.before || fp.after !== c.model_after) {
      return { id: c.id, pass: false, detail: `patch fidelity broken: ${JSON.stringify(fp)}` };
    }
  }
  return { id: c.id, pass: true, detail: '' };
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
  // eslint-disable-next-line no-console
  console.log(`\nVerdict: ${failed === 0 ? 'PASS ✅' : 'FAIL ❌'}\n`);
  process.exit(failed === 0 ? 0 : 1);
}
