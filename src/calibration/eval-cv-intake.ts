/**
 * Deterministic eval for the CV Intake Engine (no live LLM): a golden set of hand-labeled cases run
 * through the REAL pure `assembleExtraction`. Each case carries a SIMULATED `llm` output (what a
 * schema-enforced extraction would plausibly return — including, for some cases, a fabricated atom),
 * plus the `expected.fields` a faithful, grounded extraction should keep.
 *
 * It scores three things per case (mirrors `eval-cv-assistant-turns`):
 *   - fieldRecall    : of the fields the golden marks as expected-found, the fraction the engine kept.
 *   - fieldPrecision : of the fields the engine kept (found:true), the fraction that match the golden
 *                      (i.e. were NOT fabricated). A dropped fabrication keeps precision = 1.
 *   - noFabrication  : every kept atom appears in the narrative (the grounding gate held).
 *
 * A `--live` flag (later) swaps in the real `CvIntakeService` for the simulated `llm`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  assembleExtraction,
  type ExperienceFieldKey,
  type ExperienceExtraction,
  type IntakeLlmOutput,
} from '../modules/cv-intake/cv-intake';
import { isGrounded } from '../modules/cv-intake/intake-grounding';

const FIELD_KEYS: ExperienceFieldKey[] = [
  'company',
  'position',
  'start',
  'end',
  'description',
  'achievements',
];

// Dates come from the trusted deterministic parser (e.g. "Dec 2024" → "12/2024"),
// so their normalized value is NOT a literal substring of the narrative. They are
// exempt from the literal-substring no-fabrication check; the LLM-sourced fields aren't.
const DATE_FIELDS = new Set<ExperienceFieldKey>(['start', 'end']);

export interface CvIntakeEvalCase {
  id: string;
  narrative: string;
  /** Simulated LLM extraction (so the eval runs without a live model). */
  llm: IntakeLlmOutput;
  expected: {
    /** The fields a faithful grounded extraction should keep, with their found values. */
    fields: Partial<Record<ExperienceFieldKey, string | string[]>>;
  };
  /** true ⇒ this case feeds a fabricated atom the grounding gate must drop. */
  expectFabricationDropped?: boolean;
}

export interface CvIntakeEvalResult {
  id: string;
  fieldRecall: number;
  fieldPrecision: number;
  noFabrication: boolean;
}

function stringify(value: string | string[]): string {
  return Array.isArray(value) ? value.join(' ') : value;
}

export function scoreIntakeCase(c: CvIntakeEvalCase): CvIntakeEvalResult {
  const out: ExperienceExtraction = assembleExtraction(c.narrative, c.llm);

  const expectedKeys = FIELD_KEYS.filter((k) => c.expected.fields[k] !== undefined);
  const keptKeys = FIELD_KEYS.filter((k) => out.fields[k].found);

  // Recall: of the fields we expected to find, how many did the engine keep (found:true)?
  const recallHits = expectedKeys.filter((k) => out.fields[k].found).length;
  const fieldRecall = expectedKeys.length === 0 ? 1 : recallHits / expectedKeys.length;

  // Precision: of the fields the engine kept, how many were genuinely expected (not fabricated)?
  const precisionHits = keptKeys.filter((k) => c.expected.fields[k] !== undefined).length;
  const fieldPrecision = keptKeys.length === 0 ? 1 : precisionHits / keptKeys.length;

  // No fabrication: every kept LLM-sourced atom must actually appear in the narrative.
  // Deterministic dates are derived (normalized), not literal substrings — they are exempt.
  const noFabrication = keptKeys.every((k) => {
    if (DATE_FIELDS.has(k)) return true;
    const v = stringify(out.fields[k].value);
    // company/position use the stricter contiguous-phrase ('atom') gate in prod — mirror it here.
    const mode = k === 'company' || k === 'position' ? 'atom' : 'prose';
    return v === '' ? true : isGrounded(v, c.narrative, mode);
  });

  return { id: c.id, fieldRecall, fieldPrecision, noFabrication };
}

// CLI runner: `npm run eval:cv-intake` (also exercised deterministically by cv-intake-eval.spec.ts).
if (require.main === module) {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'cv-intake-golden.json'), 'utf8'),
  ) as { cases: CvIntakeEvalCase[] };
  let failed = 0;
  for (const c of golden.cases) {
    const r = scoreIntakeCase(c);
    const ok = r.noFabrication && r.fieldRecall >= 0.8;
    if (!ok) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(
        `FAIL ${r.id}: recall=${r.fieldRecall.toFixed(2)} precision=${r.fieldPrecision.toFixed(
          2,
        )} noFabrication=${r.noFabrication}`,
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log(`cv-intake eval: ${golden.cases.length - failed}/${golden.cases.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}
