/**
 * CV Profile Signals (PR3b) accuracy + non-fabrication gate. Fully OFFLINE (no LLM, no DB).
 * Runs the pure `deriveCvProfileSignals` over `data/eval-cv-signals-cases.json` and asserts each
 * per-family expectation. `expect.<fam> = null` asserts NO signal (the anti-fabrication guarantee);
 * a subset object asserts those fields; `expect.domain.includes` asserts those domains are present.
 *
 *   pnpm eval:cv-signals                          # report + gate
 *   EVAL_CV_SIGNALS_STRICT=1 pnpm eval:cv-signals  # symmetry with the other harnesses
 */
import * as fs from 'fs';
import * as path from 'path';
import { CanonicalCvDocument } from '../common/types/canonical-cv';
import { deriveCvProfileSignals } from '../common/services/cv-profile-signals';

interface ExpectDomain {
  includes: string[];
}
interface EvalCase {
  id: string;
  lang: 'en' | 'vi';
  document: Partial<CanonicalCvDocument>;
  expect: {
    english?: Record<string, unknown> | null;
    education?: Record<string, unknown> | null;
    domain?: ExpectDomain | null;
    work_mode?: Record<string, unknown> | null;
  };
}

const STRICT = process.env.EVAL_CV_SIGNALS_STRICT === '1';

function checkSubset(
  got: Record<string, unknown> | null | undefined,
  exp: Record<string, unknown>,
  fam: string,
  id: string,
  fails: string[],
): void {
  if (!got) {
    fails.push(`${id} ${fam}: expected a signal, got null`);
    return;
  }
  for (const key of Object.keys(exp)) {
    if (got[key] !== exp[key]) {
      fails.push(
        `${id} ${fam}.${key}: got ${JSON.stringify(got[key])}, expected ${JSON.stringify(exp[key])}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-cv-signals-cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: EvalCase[] };
  const fails: string[] = [];

  for (const c of cases) {
    const out = deriveCvProfileSignals(c.document as CanonicalCvDocument);
    const e = c.expect;

    if ('english' in e) {
      if (e.english === null) {
        if (out.english !== null)
          fails.push(`${c.id} english: expected null, got ${JSON.stringify(out.english)}`);
      } else if (e.english) {
        checkSubset(
          out.english as unknown as Record<string, unknown> | null,
          e.english,
          'english',
          c.id,
          fails,
        );
      }
    }
    if ('education' in e) {
      if (e.education === null) {
        if (out.education !== null)
          fails.push(`${c.id} education: expected null, got ${JSON.stringify(out.education)}`);
      } else if (e.education) {
        checkSubset(
          out.education as unknown as Record<string, unknown> | null,
          e.education,
          'education',
          c.id,
          fails,
        );
      }
    }
    if ('domain' in e) {
      if (e.domain === null) {
        if (out.domain !== null)
          fails.push(`${c.id} domain: expected null, got ${JSON.stringify(out.domain)}`);
      } else if (e.domain) {
        for (const d of e.domain.includes) {
          if (!out.domain?.domains.includes(d)) {
            fails.push(`${c.id} domain: missing ${d}, got ${JSON.stringify(out.domain?.domains)}`);
          }
        }
      }
    }
    if ('work_mode' in e) {
      if (e.work_mode === null) {
        if (out.work_mode !== null)
          fails.push(`${c.id} work_mode: expected null, got ${JSON.stringify(out.work_mode)}`);
      } else if (e.work_mode) {
        checkSubset(
          out.work_mode as unknown as Record<string, unknown> | null,
          e.work_mode,
          'work_mode',
          c.id,
          fails,
        );
      }
    }
  }

  console.log(`\nCV profile signals eval — ${cases.length} cases (offline, 0 LLM)\n`);
  if (fails.length) console.log(`FAILURES:\n${fails.map((f) => `  ${f}`).join('\n')}`);
  else console.log('All CV-signal cases hold.');

  const fail = fails.length > 0;
  console.log(`\nVerdict: ${fail ? 'FAIL ❌' : 'PASS ✅'}${STRICT ? ' [strict]' : ''}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval-cv-signals failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
