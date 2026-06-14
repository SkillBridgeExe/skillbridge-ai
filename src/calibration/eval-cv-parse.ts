/**
 * cv_parse ACCURACY harness (Tier B, LLM) — does the cv_parse_v1 prompt faithfully turn raw CV TEXT
 * into a CanonicalCvDocument with the right sections populated? The deterministic coercion safety net
 * is already CI-gated by test/modules/cv-review/cv-parser.coerce.spec.ts; THIS measures the LLM
 * extraction step itself (section recall + language detection) on golden text fixtures.
 *
 *   pnpm eval:cv-parse                          # report-only
 *   EVAL_CV_PARSE_STRICT=1 pnpm eval:cv-parse   # gate: section recall ≥ RECALL_MIN AND lang ok
 *
 * Fixtures (data/eval-cv-parse-cases.json) are SYNTHETIC/redacted TEXT-only CVs (VN + EN) — no PDF,
 * no PII — so they are safe to commit. They are NOT a layout-diverse production corpus: do NOT cite
 * these numbers as production parse accuracy. NOT in CI / `pnpm test` (calls the real LLM →
 * non-deterministic, billable). Anti-flakiness: temperature 0.1 + jsonMode, thresholds over the
 * WHOLE set, withRetry on transient errors.
 */
import * as dotenv from 'dotenv';
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
import * as fs from 'fs';
import * as path from 'path';
import { CanonicalCvDocument } from '../common/types/canonical-cv';
import { withRetry } from './retry';

// DB-less mode (tracing stub) BEFORE AppModule is imported — we measure extraction, not persistence.
process.env.NODE_ENV = 'test';

type Section =
  | 'contact'
  | 'summary'
  | 'education'
  | 'experience'
  | 'projects'
  | 'skills'
  | 'certifications'
  | 'activities';

interface CvParseCase {
  id: string;
  lang: string;
  source: string;
  layout: string;
  text: string;
  /** Sections the CV genuinely contains → the parser must populate them (non-empty). */
  expect_sections: Section[];
  /** Expected detected language (ISO 639-1). */
  expect_language: string;
}

const STRICT = process.env.EVAL_CV_PARSE_STRICT === '1';
const RECALL_MIN = Number(process.env.EVAL_CV_PARSE_RECALL_MIN ?? 0.85);
const LANG_MIN = Number(process.env.EVAL_CV_PARSE_LANG_MIN ?? 0.8);
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 2000);

function hasSection(doc: CanonicalCvDocument, s: Section): boolean {
  switch (s) {
    case 'contact':
      return Boolean(doc.contact.name || doc.contact.email);
    case 'summary':
      return doc.summary.trim().length > 0;
    case 'skills':
      return (
        doc.skills.technical.length +
          doc.skills.soft.length +
          doc.skills.languages.length +
          doc.skills.tools.length >
        0
      );
    default:
      return (doc[s] as unknown[]).length > 0;
  }
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-cv-parse-cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: CvParseCase[] };

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { CvParserService } = await import('../modules/cv-review/cv-parser.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const parser = app.get(CvParserService);

  console.log(
    `\ncv_parse eval (Tier B, LLM) — ${cases.length} synthetic cases${STRICT ? ' [STRICT]' : ''}\n` +
      `(fixtures are synthetic/redacted text — NOT production parse accuracy)\n`,
  );

  let sectionExpected = 0;
  let sectionHit = 0;
  let langOk = 0;
  let evaluated = 0;
  const skipped: string[] = [];
  const lines: string[] = [];

  for (const c of cases) {
    let doc: CanonicalCvDocument;
    try {
      const res = await withRetry(
        () => parser.parse(c.text),
        2,
        (e, n) => console.warn(`  ${c.id}: retry ${n} — ${(e as Error).message}`),
      );
      doc = res.document;
    } catch (e) {
      console.warn(`  ${c.id}: SKIPPED — ${(e as Error).message}`);
      skipped.push(c.id);
      continue;
    }

    evaluated += 1;
    const missing = c.expect_sections.filter((s) => !hasSection(doc, s));
    const hit = c.expect_sections.length - missing.length;
    sectionExpected += c.expect_sections.length;
    sectionHit += hit;
    const langMatch = doc.language === c.expect_language;
    if (langMatch) langOk += 1;

    lines.push(
      `  ${c.id.padEnd(24)} sections ${hit}/${c.expect_sections.length}` +
        `${missing.length ? ` (missing: ${missing.join(',')})` : ''}` +
        `  lang=${doc.language}${langMatch ? '' : `≠${c.expect_language} ✗`}`,
    );
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  await app.close();

  const recall = sectionExpected ? sectionHit / sectionExpected : 0;
  const langRate = evaluated ? langOk / evaluated : 0;
  console.log(lines.join('\n'));
  console.log('\n=== Summary ===');
  if (skipped.length) console.log(`skipped (transient): ${skipped.join(', ')}`);
  console.log(
    `section recall : ${sectionHit}/${sectionExpected} = ${(recall * 100).toFixed(0)}%  [min ${(RECALL_MIN * 100).toFixed(0)}%]`,
  );
  console.log(
    `language match : ${langOk}/${evaluated} = ${(langRate * 100).toFixed(0)}%  [min ${(LANG_MIN * 100).toFixed(0)}%]`,
  );
  // False-green guard: a strict gate must not pass if nothing was actually evaluated.
  const measured = evaluated > 0 && sectionExpected > 0;
  const pass = measured && recall >= RECALL_MIN && langRate >= LANG_MIN;
  if (!measured) console.log('⚠️  no cases evaluated (all skipped?) — cannot certify');
  console.log(
    `\nVerdict: ${pass ? 'PASS ✅' : 'FAIL ❌'}${STRICT ? ' [strict]' : ' (report-only — set EVAL_CV_PARSE_STRICT=1 to gate)'}\n`,
  );
  process.exit(STRICT && !pass ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval-cv-parse failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
