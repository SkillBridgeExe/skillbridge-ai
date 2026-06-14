/**
 * Extractor eval harness — compare PDF text extractors on a real CV corpus.
 *   pnpm eval:extractors
 *
 * Reads every *.pdf in data/eval-cvs-pdf/ (gitignored, user-provided), runs each through
 * pdf-parse + unpdf + liteparse(slot), and reports DETERMINISTIC quality metrics (skills the
 * gazetteer recognises, mojibake, hygiene). Writes data/eval-cvs-pdf/extractor-report.json —
 * METRICS + skill canonicals ONLY, never raw CV text (PII / PDPL).
 *
 * Each row is annotated from an OPTIONAL data/eval-cvs-pdf/manifest.json (per-machine — the whole
 * corpus dir is gitignored) with { layout, lang, source }. A THIN-CORPUS disclaimer is ALWAYS
 * printed and embedded in the report: the committed corpus is tiny and layout-homogeneous, so these
 * numbers must NEVER be cited as production extractor accuracy. To add coverage, drop CVs (esp.
 * two_column / canva / scanned / English) into the dir + add a manifest entry — no code change.
 *
 * Scanner is instantiated DB-less (no NestFactory), exactly like eval-mentions.
 * (A downstream LLM-score A/B — `--score` — is a documented follow-up, not in v1.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillTextScannerService } from '../common/services/skill-text-scanner.service';
import { ScannedPdfOcrService, OcrRescueMeta } from '../common/services/scanned-pdf-ocr.service';
import { computeMetrics, ExtractorMetrics } from './extractor-metrics';
import { pdfParseExtract } from './extractors/pdf-parse.extractor';
import { unpdfExtract } from './extractors/unpdf.extractor';
import { liteParseExtract } from './extractors/liteparse.extractor';

type ExtractorFn = (b: Buffer) => Promise<string>;
const EXTRACTORS: Record<string, ExtractorFn> = {
  'pdf-parse': pdfParseExtract, // CURRENT platform extractor (the baseline)
  unpdf: unpdfExtract,
  liteparse: liteParseExtract, // reading-order slot (throws until wired → honest error cell)
};

type Layout = 'single_column' | 'two_column' | 'canva' | 'scanned' | 'unknown';
type Lang = 'vi' | 'en' | 'mixed' | 'unknown';
type Source = 'real' | 'synthetic' | 'redacted' | 'unknown';
interface ManifestEntry {
  layout: Layout;
  lang: Lang;
  source: Source;
}
const DEFAULT_ENTRY: ManifestEntry = { layout: 'unknown', lang: 'unknown', source: 'unknown' };

/** Layout × lang coverage we WANT before trusting these numbers for production. */
const TARGET_LAYOUTS: Layout[] = ['single_column', 'two_column', 'canva', 'scanned'];
const TARGET_LANGS: Lang[] = ['vi', 'en'];

const ALL_LAYOUTS: Layout[] = [...TARGET_LAYOUTS, 'unknown'];
const ALL_LANGS: Lang[] = ['vi', 'en', 'mixed', 'unknown'];
const ALL_SOURCES: Source[] = ['real', 'synthetic', 'redacted', 'unknown'];
/** Coerce a raw manifest value to a known enum member, else 'unknown' — a typo can't silently
 *  invent a coverage key (e.g. "two-column") that never matches the target grid. */
const oneOf = <T extends string>(value: unknown, allowed: T[]): T =>
  allowed.includes(value as T) ? (value as T) : (allowed[allowed.length - 1] as T);

type Cell = ExtractorMetrics | { error: string };
const isErr = (c: Cell): c is { error: string } => 'error' in c;

// OCR-rescue report for layout:'scanned' files. PII-safe: metadata is metrics/timings/decision only
// (no raw CV text). Kept on a SEPARATE field so it never enters the extractor A/B aggregate.
type OcrRescueReport = { ocrUsed: boolean } & OcrRescueMeta;
interface ReportRow {
  file: string;
  meta: ManifestEntry;
  metrics: Record<string, Cell>;
  ocr_rescue?: OcrRescueReport;
}

/** Load the optional per-machine manifest (corpus dir is gitignored). Returns an empty map if absent. */
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
        layout: oneOf(f.layout, ALL_LAYOUTS),
        lang: oneOf(f.lang, ALL_LANGS),
        source: oneOf(f.source, ALL_SOURCES),
      });
    }
  } catch (e) {
    console.warn(
      `manifest.json present but unreadable (${(e as Error).message}) — using defaults.`,
    );
  }
  return map;
}

/** Honest, explicit disclaimer naming what the corpus covers and (critically) what it does NOT. */
function buildDisclaimer(rows: Array<{ file: string; entry: ManifestEntry }>): {
  text: string;
  coverage: Record<string, boolean>;
  missing: string[];
} {
  const present = new Set(rows.map((r) => `${r.entry.layout}/${r.entry.lang}`));
  const coverage: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const layout of TARGET_LAYOUTS) {
    for (const lang of TARGET_LANGS) {
      const key = `${layout}/${lang}`;
      const has = present.has(key);
      coverage[key] = has;
      if (!has) missing.push(key);
    }
  }
  const layoutsSeen = [...new Set(rows.map((r) => r.entry.layout))].join(', ') || 'none';
  const text =
    `THIN CORPUS — ${rows.length} CV(s), layouts present: [${layoutsSeen}]. ` +
    `These DETERMINISTIC metrics are NOT representative of production extractor accuracy. ` +
    `Coverage gaps (no sample): ${missing.join(', ') || 'none'}. ` +
    `Do NOT cite as "overall accuracy"; add two_column / canva / scanned / English CVs to close the gap.`;
  return { text, coverage, missing };
}

async function main(): Promise<void> {
  const dir = path.join(process.cwd(), 'data', 'eval-cvs-pdf');
  // ALWAYS surface the thin-corpus disclaimer — including the (gitignored, so DEFAULT-on-fresh-checkout)
  // empty paths, so a run can never look authoritative without the caveat.
  if (!fs.existsSync(dir)) {
    console.log(`No corpus dir. Create ${dir} and drop CV PDFs (esp. 2-column), then re-run.`);
    console.log('\n⚠️  ' + buildDisclaimer([]).text + '\n');
    return;
  }
  const pdfs = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort();
  if (pdfs.length === 0) {
    console.log(`No PDFs in ${dir} — drop CV PDFs (esp. 2-column) and re-run.`);
    console.log('\n⚠️  ' + buildDisclaimer([]).text + '\n');
    return;
  }

  const manifest = loadManifest(dir);
  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const scanner = new SkillTextScannerService(taxonomy);
  scanner.buildMatchers();
  const scan = (t: string): { canonical_name: string }[] => scanner.scan(t);

  // DB-less, defaults-only config (Joi defaults mirrored). Reuses the SAME scanner so OCR skill
  // counts are comparable to the extractor cells.
  const ocrService = new ScannedPdfOcrService(
    { get: () => undefined } as unknown as ConfigService,
    scanner,
  );

  const report: ReportRow[] = [];

  for (const file of pdfs) {
    const entry = manifest.get(file) ?? DEFAULT_ENTRY;
    const buffer = fs.readFileSync(path.join(dir, file));
    const cells: Record<string, Cell> = {};
    for (const [name, fn] of Object.entries(EXTRACTORS)) {
      try {
        cells[name] = computeMetrics(await fn(buffer), scan);
      } catch (e) {
        cells[name] = { error: (e as Error).message };
      }
    }
    const row: ReportRow = { file, meta: entry, metrics: cells };
    // Scanned / image-only PDFs: additionally run the OCR rescue and report PII-safe metrics so the
    // run shows whether OCR would have rescued the thin text layer.
    if (entry.layout === 'scanned') {
      let pdfText = '';
      try {
        pdfText = await pdfParseExtract(buffer);
      } catch {
        pdfText = '';
      }
      const rescued = await ocrService.rescue(buffer, pdfText);
      row.ocr_rescue = { ocrUsed: rescued.ocrUsed, ...rescued.metadata };
    }
    report.push(row);
    console.log(`\n${file}  [${entry.layout}/${entry.lang}/${entry.source}]`);
    for (const [name, c] of Object.entries(cells)) {
      console.log(
        isErr(c)
          ? `  ${name.padEnd(10)} ERROR: ${c.error}`
          : `  ${name.padEnd(10)} skills=${String(c.skillsFound).padStart(3)}  mojibake=${String(c.mojibakeCount).padStart(3)}  chars=${String(c.charCount).padStart(5)}  wordlike=${c.wordlikeRatio}  nonWs=${c.nonWsRatio}`,
      );
    }
    if (row.ocr_rescue) {
      const o = row.ocr_rescue;
      console.log(
        `  ${'ocr_rescue'.padEnd(10)} decision=${o.decision}${o.reason ? `(${o.reason})` : ''}  ` +
          `orig_chars=${o.original.charCount} ocr_chars=${o.ocr?.charCount ?? '-'}  ` +
          `orig_skills=${o.original.skillsFound} ocr_skills=${o.ocr?.skillsFound ?? '-'}`,
      );
    }
  }

  const agg: Record<string, { skills: number; mojibake: number; wins: number }> = {};
  for (const name of Object.keys(EXTRACTORS)) agg[name] = { skills: 0, mojibake: 0, wins: 0 };
  for (const row of report) {
    let best = -1;
    let bestName = '';
    for (const [name, c] of Object.entries(row.metrics)) {
      if (isErr(c)) continue;
      agg[name].skills += c.skillsFound;
      agg[name].mojibake += c.mojibakeCount;
      if (c.skillsFound > best) {
        best = c.skillsFound;
        bestName = name;
      }
    }
    if (bestName) agg[bestName].wins += 1;
  }
  console.log('\n=== AGGREGATE ===');
  for (const [name, a] of Object.entries(agg)) {
    console.log(
      `  ${name.padEnd(10)} total_skills=${a.skills}  total_mojibake=${a.mojibake}  skill_wins=${a.wins}/${report.length}`,
    );
  }

  const disclaimer = buildDisclaimer(report.map((r) => ({ file: r.file, entry: r.meta })));
  console.log('\n⚠️  ' + disclaimer.text + '\n');

  const outPath = path.join(dir, 'extractor-report.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        corpus_size: pdfs.length,
        disclaimer: disclaimer.text,
        coverage: disclaimer.coverage,
        missing_coverage: disclaimer.missing,
        report,
        aggregate: agg,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`wrote ${outPath} (metrics + skill canonicals only — NO CV text)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
