/**
 * CV INPUT-QUALITY harness (end-to-end: file → text → parsed CanonicalCvDocument) on a REAL PDF corpus.
 * This is the missing link between two existing evals:
 *   - eval:extractors  — file → text only (deterministic text metrics per PDF).
 *   - eval:cv-parse    — text → parsed, but on SYNTHETIC text fixtures, not real PDFs.
 * This harness runs each real PDF through the platform's pdf-parse extractor THEN CvParserService,
 * and scores whether the FULL pipeline yields a populated, correct-language document per layout/lang.
 * That's the signal for "production-quality diagnosis": which CV shapes (2-column, Canva, scanned,
 * VN/EN) silently degrade into empty/wrong parses.
 *
 *   pnpm eval:cv-input-quality                              # report-only descriptive scorecard
 *   EVAL_CV_INPUT_QUALITY_STRICT=1 pnpm eval:cv-input-quality   # gate: healthy-rate ≥ MIN
 *
 * CORPUS (gitignored — PII/PDPL): drop CV PDFs into data/eval-cvs-pdf/ and annotate them in
 * data/eval-cvs-pdf/manifest.json — SAME file eval:extractors uses. See the committed
 * data/eval-cvs-pdf.manifest.example.json for the schema and the layout/lang values to target
 * (single_column, two_column, canva, scanned × vi, en). No code change to add coverage.
 *
 * Calls the real LLM (CvParserService) → billable, non-deterministic → NOT in CI / `pnpm test`.
 * PII-safe: writes data/eval-cvs-pdf/input-quality-report.json with COUNTS / section-names / lang
 * ONLY — never raw CV text. Does NOT touch the prod extractor/parser (read-only consumer).
 */
import * as dotenv from 'dotenv';
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
import * as fs from 'fs';
import * as path from 'path';
import { CanonicalCvDocument } from '../common/types/canonical-cv';
import { withRetry } from './retry';

process.env.NODE_ENV = 'test';

const STRICT = process.env.EVAL_CV_INPUT_QUALITY_STRICT === '1';
const HEALTHY_RATE_MIN = Number(process.env.EVAL_CV_INPUT_HEALTHY_MIN ?? 0.8);
const MIN_SECTIONS = Number(process.env.EVAL_CV_INPUT_MIN_SECTIONS ?? 3);
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 2000);

const SECTIONS = [
  'contact',
  'summary',
  'education',
  'experience',
  'projects',
  'skills',
  'certifications',
  'activities',
] as const;
type Section = (typeof SECTIONS)[number];

interface ManifestEntry {
  layout: string;
  lang: string;
  source: string;
}
const DEFAULT_ENTRY: ManifestEntry = { layout: 'unknown', lang: 'unknown', source: 'unknown' };

function loadManifest(dir: string): Map<string, ManifestEntry> {
  const file = path.join(dir, 'manifest.json');
  const map = new Map<string, ManifestEntry>();
  if (!fs.existsSync(file)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      files?: Array<{ filename: string } & Partial<ManifestEntry>>;
    };
    for (const f of raw.files ?? []) {
      if (!f.filename) continue;
      map.set(f.filename, {
        layout: f.layout ?? 'unknown',
        lang: f.lang ?? 'unknown',
        source: f.source ?? 'unknown',
      });
    }
  } catch (e) {
    console.warn(`manifest.json unreadable (${(e as Error).message}) — using defaults.`);
  }
  return map;
}

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

function skillCount(doc: CanonicalCvDocument): number {
  return (
    doc.skills.technical.length +
    doc.skills.soft.length +
    doc.skills.languages.length +
    doc.skills.tools.length
  );
}

interface RowResult {
  file: string;
  meta: ManifestEntry;
  extract_chars: number;
  sections_populated: number;
  populated: Section[];
  skills: number;
  lang_detected: string;
  lang_ok: boolean | null; // null = manifest lang unknown (not asserted)
  ocr_used: boolean; // true when the prod path fell back to OCR (thin/scanned)
  healthy: boolean;
  error?: string;
}

async function main(): Promise<void> {
  const dir = path.join(process.cwd(), 'data', 'eval-cvs-pdf');
  const disclaimer =
    'THIN CORPUS — real CV PDFs are gitignored & user-provided. These numbers are NOT production ' +
    'parse accuracy; add 2-column / Canva / scanned / English CVs (+ manifest entries) to close gaps.';

  if (!fs.existsSync(dir)) {
    console.log(`No corpus dir. Create ${dir}, drop CV PDFs + manifest.json, then re-run.`);
    console.log(
      `(copy data/eval-cvs-pdf.manifest.example.json → ${path.join(dir, 'manifest.json')})`,
    );
    console.log('\n⚠️  ' + disclaimer + '\n');
    return;
  }
  const pdfs = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort();
  if (pdfs.length === 0) {
    console.log(`No PDFs in ${dir} — drop CV PDFs (esp. 2-column/Canva/scanned/EN) and re-run.`);
    console.log('\n⚠️  ' + disclaimer + '\n');
    return;
  }

  const manifest = loadManifest(dir);

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { CvParserService } = await import('../modules/cv-review/cv-parser.service');
  const { SkillTaxonomyService } = await import('../common/services/skill-taxonomy.service');
  const { SkillTextScannerService } = await import('../common/services/skill-text-scanner.service');
  const { ScannedPdfOcrService } = await import('../common/services/scanned-pdf-ocr.service');
  const { TextExtractorService } = await import('../platform/cvs/text-extractor.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const parser = app.get(CvParserService);

  // The PROD extractor path: pdf-parse → OCR-rescue when the text layer is thin (mirrors a real
  // upload). Constructed DB-less here (same pattern as eval:extractors) — TextExtractorService is a
  // CvsModule-internal provider, not resolvable from the root context. Config stub ⇒ OCR uses its
  // Joi defaults (enabled, dpi 200) so scanned/image CVs are measured exactly as prod would.
  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const scanner = new SkillTextScannerService(taxonomy);
  scanner.buildMatchers();
  const ocr = new ScannedPdfOcrService(
    { get: () => undefined } as unknown as ConstructorParameters<typeof ScannedPdfOcrService>[0],
    scanner,
  );
  const extractor = new TextExtractorService(ocr);

  console.log(
    `\nCV input-quality (file→text→parsed) — ${pdfs.length} PDF(s)${STRICT ? ' [STRICT]' : ''}\n`,
  );

  const rows: RowResult[] = [];
  for (const file of pdfs) {
    const meta = manifest.get(file) ?? DEFAULT_ENTRY;
    const buffer = fs.readFileSync(path.join(dir, file));
    let text = '';
    let ocrUsed = false;
    try {
      const extracted = await extractor.extract({
        buffer,
        mimetype: 'application/pdf',
        originalname: file,
      } as Express.Multer.File);
      text = extracted.text;
      ocrUsed = extracted.isOcrOnly;
    } catch (e) {
      rows.push({
        file,
        meta,
        extract_chars: 0,
        sections_populated: 0,
        populated: [],
        skills: 0,
        lang_detected: 'none',
        lang_ok: null,
        ocr_used: false,
        healthy: false,
        error: `extract: ${(e as Error).message}`,
      });
      console.log(`  ${file} [${meta.layout}/${meta.lang}]  EXTRACT-ERROR`);
      continue;
    }

    let doc: CanonicalCvDocument;
    try {
      const res = await withRetry(
        () => parser.parse(text),
        2,
        (e, n) => console.warn(`  ${file}: retry ${n} — ${(e as Error).message}`),
      );
      doc = res.document;
    } catch (e) {
      rows.push({
        file,
        meta,
        extract_chars: text.length,
        sections_populated: 0,
        populated: [],
        skills: 0,
        lang_detected: 'none',
        lang_ok: null,
        ocr_used: ocrUsed,
        healthy: false,
        error: `parse: ${(e as Error).message}`,
      });
      console.log(`  ${file} [${meta.layout}/${meta.lang}]  PARSE-ERROR`);
      continue;
    }

    const populated = SECTIONS.filter((s) => hasSection(doc, s));
    const langKnown = meta.lang === 'vi' || meta.lang === 'en';
    const langOk = langKnown ? doc.language === meta.lang : null;
    const healthy =
      populated.length >= MIN_SECTIONS && hasSection(doc, 'skills') && langOk !== false;
    rows.push({
      file,
      meta,
      extract_chars: text.length,
      sections_populated: populated.length,
      populated,
      skills: skillCount(doc),
      lang_detected: doc.language,
      lang_ok: langOk,
      ocr_used: ocrUsed,
      healthy,
    });
    console.log(
      `  ${file.padEnd(28)} [${meta.layout}/${meta.lang}]  ` +
        `sections=${populated.length}/8  skills=${String(skillCount(doc)).padStart(3)}  ` +
        `lang=${doc.language}${langOk === false ? `≠${meta.lang}✗` : ''}  chars=${text.length}  ` +
        `${ocrUsed ? 'OCR ' : ''}${healthy ? 'healthy ✓' : 'DEGRADED ✗'}`,
    );
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  await app.close();

  // Aggregate by layout — surfaces "2-column parses worse than single-column".
  const byLayout = new Map<
    string,
    { n: number; healthy: number; sections: number; skills: number }
  >();
  for (const r of rows) {
    const k = r.meta.layout;
    const a = byLayout.get(k) ?? { n: 0, healthy: 0, sections: 0, skills: 0 };
    a.n += 1;
    a.healthy += r.healthy ? 1 : 0;
    a.sections += r.sections_populated;
    a.skills += r.skills;
    byLayout.set(k, a);
  }
  console.log('\n=== BY LAYOUT ===');
  for (const [layout, a] of byLayout) {
    console.log(
      `  ${layout.padEnd(14)} n=${a.n}  healthy=${a.healthy}/${a.n}  ` +
        `avg_sections=${(a.sections / a.n).toFixed(1)}/8  avg_skills=${(a.skills / a.n).toFixed(1)}`,
    );
  }

  const healthy = rows.filter((r) => r.healthy).length;
  const healthyRate = rows.length ? healthy / rows.length : 0;
  console.log('\n=== Summary ===');
  console.log(
    `healthy parses: ${healthy}/${rows.length} = ${(healthyRate * 100).toFixed(0)}%  [min ${(HEALTHY_RATE_MIN * 100).toFixed(0)}%]`,
  );
  console.log('\n⚠️  ' + disclaimer + '\n');

  const outPath = path.join(dir, 'input-quality-report.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        corpus_size: rows.length,
        disclaimer,
        healthy_rate: healthyRate,
        by_layout: Object.fromEntries(byLayout),
        rows, // COUNTS + section-names + lang only — NO raw CV text
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`wrote ${outPath} (counts + section-names + lang only — NO CV text)`);

  const measured = rows.length > 0;
  const pass = measured && healthyRate >= HEALTHY_RATE_MIN;
  if (!measured) console.log('⚠️  no PDFs evaluated — cannot certify');
  console.log(
    `\nVerdict: ${pass ? 'PASS ✅' : 'FAIL ❌'}${STRICT ? ' [strict]' : ' (report-only — set EVAL_CV_INPUT_QUALITY_STRICT=1 to gate)'}\n`,
  );
  process.exit(STRICT && !pass ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval-cv-input-quality failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
