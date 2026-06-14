/**
 * Real-OCR gate on the committed synthetic image-only fixture.
 *   pnpm eval:ocr-fixture
 *
 * Proves the full scanned-PDF rescue (mupdf render → Tesseract eng+vie → deterministic decision)
 * recovers skills from data/eval-fixtures/scanned-cv-synthetic.pdf — a PDF with NO text layer, so
 * pdf-parse alone is thin. Runs under ts-node because mupdf is an ESM module loaded via dynamic
 * import(), which jest's CommonJS VM cannot execute (--experimental-vm-modules). The always-on
 * regression guard is the fast unit suite (scanned-pdf-ocr.service.spec.ts, OCR injected); this is
 * the OFF-by-default real-pipeline check. Exits non-zero on failure so it can gate when run.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillTextScannerService } from '../common/services/skill-text-scanner.service';
import { ScannedPdfOcrService } from '../common/services/scanned-pdf-ocr.service';
import { pdfParseExtract } from './extractors/pdf-parse.extractor';

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-fixtures', 'scanned-cv-synthetic.pdf');
  if (!fs.existsSync(file)) {
    console.error(`Fixture missing: ${file}`);
    process.exit(1);
  }
  const buffer = fs.readFileSync(file);

  // 1. pdf-parse alone must be thin (the fixture has no text layer).
  let thin = '';
  try {
    thin = await pdfParseExtract(buffer);
  } catch {
    thin = '';
  }
  const thinChars = thin.replace(/\s/g, '').length;

  // 2. Real, DB-less scanner + defaults-only config (mirrors eval:extractors).
  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const scanner = new SkillTextScannerService(taxonomy);
  scanner.buildMatchers();
  const svc = new ScannedPdfOcrService(
    { get: () => undefined } as unknown as ConfigService,
    scanner,
  );

  const r = await svc.rescue(buffer, thin);

  const checks = {
    pdfParseThin: thinChars < 50,
    ocrUsed: r.ocrUsed === true,
    decisionUsedOcr: r.metadata.decision === 'used_ocr',
    ocrCharsGrew: (r.metadata.ocr?.charCount ?? 0) > 200,
    keywordsPresent: /react|typescript|node|postgre/i.test(r.text),
  };

  console.log(
    `ocr_fixture: pdfParse_chars=${thinChars} ocrUsed=${r.ocrUsed} decision=${r.metadata.decision} ` +
      `ocr_chars=${r.metadata.ocr?.charCount ?? 0} ocr_skills=${r.metadata.ocr?.skillsFound ?? 0}`,
  );

  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  if (failed.length > 0) {
    console.error(`FAIL: synthetic scanned fixture not rescued as expected → ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log('PASS: synthetic scanned fixture rescued by OCR (all checks green).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
