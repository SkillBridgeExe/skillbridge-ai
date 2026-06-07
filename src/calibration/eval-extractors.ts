/**
 * Extractor eval harness — compare PDF text extractors on a real CV corpus.
 *   pnpm eval:extractors
 *
 * Reads every *.pdf in data/eval-cvs-pdf/ (gitignored, user-provided — prioritise 2-column CVs),
 * runs each through pdf-parse + unpdf, and reports DETERMINISTIC quality metrics (skills the
 * gazetteer recognises, mojibake, hygiene). Writes data/eval-cvs-pdf/extractor-report.json —
 * METRICS + skill canonicals ONLY, never raw CV text (PII / PDPL).
 *
 * Scanner is instantiated DB-less (no NestFactory), exactly like eval-mentions.
 * (A downstream LLM-score A/B — `--score` — is a documented follow-up, not in v1.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillTextScannerService } from '../common/services/skill-text-scanner.service';
import { computeMetrics, ExtractorMetrics } from './extractor-metrics';
import { pdfParseExtract } from './extractors/pdf-parse.extractor';
import { unpdfExtract } from './extractors/unpdf.extractor';

type ExtractorFn = (b: Buffer) => Promise<string>;
const EXTRACTORS: Record<string, ExtractorFn> = {
  'pdf-parse': pdfParseExtract,
  unpdf: unpdfExtract,
};

type Cell = ExtractorMetrics | { error: string };
const isErr = (c: Cell): c is { error: string } => 'error' in c;

async function main(): Promise<void> {
  const dir = path.join(process.cwd(), 'data', 'eval-cvs-pdf');
  if (!fs.existsSync(dir)) {
    console.log(`No corpus dir. Create ${dir} and drop CV PDFs (esp. 2-column), then re-run.`);
    return;
  }
  const pdfs = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort();
  if (pdfs.length === 0) {
    console.log(`No PDFs in ${dir} — drop CV PDFs (esp. 2-column) and re-run.`);
    return;
  }

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const scanner = new SkillTextScannerService(taxonomy);
  scanner.buildMatchers();
  const scan = (t: string): { canonical_name: string }[] => scanner.scan(t);

  const report: Array<{ file: string; metrics: Record<string, Cell> }> = [];

  for (const file of pdfs) {
    const buffer = fs.readFileSync(path.join(dir, file));
    const cells: Record<string, Cell> = {};
    for (const [name, fn] of Object.entries(EXTRACTORS)) {
      try {
        cells[name] = computeMetrics(await fn(buffer), scan);
      } catch (e) {
        cells[name] = { error: (e as Error).message };
      }
    }
    report.push({ file, metrics: cells });
    console.log(`\n${file}`);
    for (const [name, c] of Object.entries(cells)) {
      console.log(
        isErr(c)
          ? `  ${name.padEnd(10)} ERROR: ${c.error}`
          : `  ${name.padEnd(10)} skills=${String(c.skillsFound).padStart(3)}  mojibake=${String(c.mojibakeCount).padStart(3)}  chars=${String(c.charCount).padStart(5)}  wordlike=${c.wordlikeRatio}  nonWs=${c.nonWsRatio}`,
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

  const outPath = path.join(dir, 'extractor-report.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify({ corpus_size: pdfs.length, report, aggregate: agg }, null, 2) + '\n',
  );
  console.log(`\nwrote ${outPath} (metrics + skill canonicals only — NO CV text)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
