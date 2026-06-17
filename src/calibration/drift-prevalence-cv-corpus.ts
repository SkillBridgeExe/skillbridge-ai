/**
 * Drift-prevalence eval — how often does the L1 extraction model (gpt-4o-mini) under-extract or
 * under-rate skills vs the prod baseline (gpt-5.4-mini) on a REAL CV corpus? Answers whether the
 * synthetic fe-react "score drop" generalises before activating the determinism toggle in prod.
 *
 * Uses the PROD text-extraction path — TextExtractorService: pdf-parse → OCR-rescue (Tesseract) when
 * the text layer is thin → picks the better text — so a "parse fail" here is a TRUE prod fail (empty
 * even after OCR), not just a missing text layer. Mirrors eval:cv-input-quality's wiring.
 *
 * CV-ONLY (no JD pairing / no labels needed): the cv_jd_match prompt extracts cv_skills_raw with a
 * "(no JD provided)" JD, so we measure the two leading indicators of the fe-react score gap directly:
 *   (1) skill COUNT + canonical SET (under-extraction of prose skills), and
 *   (2) mean proficiency_hint (the calibration difference that drove fe-react 100→41).
 * Plus L1 self-consistency across trials (is L1 deterministic on messy real CVs?), OCR-rescue rate,
 * and true parse-fail rate.
 *
 * PII / PDPL: reads PDFs from data/corpus/ (gitignored). Prints/persists ONLY metrics + taxonomy
 * canonical skill names + an anonymous CV## index — NEVER raw CV text and NEVER the filename (which
 * can be a real person's name). DB-less (NODE_ENV=test). Needs LLM keys (+ Tesseract for OCR). Usage:
 *   DRIFT_TRIALS=2 DRIFT_CANDIDATE_MODEL=gpt-4o-mini DRIFT_CANDIDATE_PROVIDER=openai DRIFT_SEED=7 pnpm drift:cv-corpus
 */
import * as dotenv from 'dotenv';
// Surgical override (parity with the other calibration harnesses): a stale OS-level key must not
// shadow .env.
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
import * as fs from 'fs';
import * as path from 'path';
import { withRetry } from './retry';

process.env.NODE_ENV = 'test'; // DB-less BEFORE AppModule import — we measure extraction, not persistence.

type Provider = 'openai' | 'gemini';

const CORPUS_DIR = path.join(process.cwd(), 'data', 'corpus', 'cv');
const TEMPLATE = process.env.DRIFT_TEMPLATE ?? 'cv_jd_match_v2'; // the live prod template.
const CANDIDATE_MODEL = process.env.DRIFT_CANDIDATE_MODEL ?? 'gpt-4o-mini';
// Force providers explicitly — LlmService resolves an unset provider from config default (fallback
// gemini), which would mis-route an OpenAI model name. Both default to openai (both models are OpenAI).
const CANDIDATE_PROVIDER = (process.env.DRIFT_CANDIDATE_PROVIDER ?? 'openai') as Provider;
const BASELINE_PROVIDER = (process.env.DRIFT_BASELINE_PROVIDER ?? 'openai') as Provider;
const SEED = process.env.DRIFT_SEED !== undefined ? Number(process.env.DRIFT_SEED) : 7;
const TRIALS = Number(process.env.DRIFT_TRIALS ?? 2);
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 700);
const NO_JD = '(no JD provided)';
// OCR-quality knobs (prod ScannedPdfOcrService config; unset = Joi defaults dpi 200 / maxPages 3).
// Used to probe whether a cheap config bump rescues the degraded OCR tail.
const OCR_DPI = process.env.DRIFT_OCR_DPI ? Number(process.env.DRIFT_OCR_DPI) : undefined;
const OCR_MAXPAGES = process.env.DRIFT_OCR_MAXPAGES
  ? Number(process.env.DRIFT_OCR_MAXPAGES)
  : undefined;
// Optional 1-based CV-index filter (e.g. "9,12,13"), preserving CV## numbering. Takes precedence over LIMIT.
const ONLY = new Set(
  (process.env.DRIFT_ONLY ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0),
);

const PROF_RANK: Record<string, number> = {
  BEGINNER: 1,
  NOVICE: 2,
  INTERMEDIATE: 3,
  ADVANCED: 4,
  EXPERT: 5,
};

const jaccard = (a: string[], b: string[]): number => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 1 : inter / union;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const r2 = (n: number): number => Math.round(n * 100) / 100;

interface ExtractResult {
  canon: string[];
  rawCount: number;
  meanProf: number; // 1..5, INTERMEDIATE default for missing hints
  error?: string;
}

async function main(): Promise<void> {
  if (!fs.existsSync(CORPUS_DIR)) {
    console.log(`No corpus dir at ${CORPUS_DIR} — drop CV PDFs there and re-run.`);
    return;
  }
  const LIMIT = process.env.DRIFT_LIMIT ? Number(process.env.DRIFT_LIMIT) : Infinity;
  const pdfs = fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort();
  if (pdfs.length === 0) {
    console.log(`No PDFs in ${CORPUS_DIR}.`);
    return;
  }

  const { NestFactory } = await import('@nestjs/core');
  const { ConfigService } = await import('@nestjs/config');
  const { AppModule } = await import('../app.module');
  const { LlmService } = await import('../infrastructure/llm/llm.service');
  const { PromptsService } = await import('../modules/prompts/prompts.service');
  const { SkillNormalizerService } = await import('../common/services/skill-normalizer.service');
  const { SkillTaxonomyService } = await import('../common/services/skill-taxonomy.service');
  const { SkillTextScannerService } = await import('../common/services/skill-text-scanner.service');
  const { ScannedPdfOcrService } = await import('../common/services/scanned-pdf-ocr.service');
  const { TextExtractorService } = await import('../platform/cvs/text-extractor.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const llm = app.get(LlmService);
  const prompts = app.get(PromptsService);
  const normalizer = app.get(SkillNormalizerService);
  const baselineModel =
    app.get(ConfigService).get<string>('llm.openai.modelDefault') ?? 'gpt-5.4-mini';

  // PROD extractor path (pdf-parse → OCR-rescue when thin). TextExtractorService is a CvsModule-internal
  // provider not resolvable from the root context, so build it manually exactly like eval:cv-input-quality;
  // the config stub makes OCR use its Joi defaults (enabled) so scanned/image CVs are measured as prod would.
  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const scanner = new SkillTextScannerService(taxonomy);
  scanner.buildMatchers();
  const ocrOverrides: Record<string, unknown> = {};
  if (OCR_DPI !== undefined) ocrOverrides['ocrFallback.dpi'] = OCR_DPI;
  if (OCR_MAXPAGES !== undefined) ocrOverrides['ocrFallback.maxPages'] = OCR_MAXPAGES;
  const ocr = new ScannedPdfOcrService(
    { get: (k: string) => ocrOverrides[k] } as unknown as ConstructorParameters<
      typeof ScannedPdfOcrService
    >[0],
    scanner,
  );
  const extractor = new TextExtractorService(ocr);

  const toCanon = (raw: Array<{ name?: string }>): string[] => {
    const out = new Set<string>();
    for (const r of raw ?? []) {
      if (!r?.name) continue;
      for (const n of normalizer.normalizeMention(r.name)) {
        if (n.canonical_name) out.add(n.canonical_name);
      }
    }
    return [...out];
  };

  const extractOnce = async (
    cvText: string,
    model: string,
    provider: Provider,
    temperature: number,
    seed?: number,
  ): Promise<ExtractResult> => {
    try {
      const template = prompts.get(TEMPLATE);
      const user = prompts.render(TEMPLATE, { cv_text: cvText, jd_text: NO_JD });
      const res = await withRetry(
        () =>
          llm.complete(
            [
              { role: 'system', content: template.meta.system ?? '' },
              { role: 'user', content: user },
            ],
            {
              provider,
              model,
              jsonMode: true,
              temperature,
              maxOutputTokens: 3000,
              ...(seed !== undefined ? { seed } : {}),
            },
          ),
        2,
        () => {},
      );
      const obj = (
        res.parsedJson && typeof res.parsedJson === 'object' ? res.parsedJson : {}
      ) as Record<string, unknown>;
      const raw = (obj.cv_skills_raw ?? []) as Array<{ name?: string; proficiency_hint?: string }>;
      const profs = raw.map((s) => PROF_RANK[(s?.proficiency_hint ?? '').toUpperCase()] ?? 3);
      return { canon: toCanon(raw), rawCount: raw.length, meanProf: mean(profs) };
    } catch (e) {
      return { canon: [], rawCount: 0, meanProf: 0, error: (e as Error).message };
    }
  };

  const runN = async (
    cvText: string,
    model: string,
    provider: Provider,
    temperature: number,
    seed?: number,
  ) => {
    const out: ExtractResult[] = [];
    for (let i = 0; i < TRIALS; i++) {
      out.push(await extractOnce(cvText, model, provider, temperature, seed));
      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    return out;
  };

  interface Row {
    cv: string; // anonymous index, never the filename
    parseChars: number;
    parseOk: boolean; // false ONLY when the prod extractor throws (empty even after OCR)
    ocrUsed: boolean; // prod path fell back to OCR (thin text layer)
    baselineCount: number;
    l1Count: number;
    countDelta: number; // l1 - baseline (negative = L1 extracts fewer)
    crossJaccard: number; // baseline vs L1 canonical agreement
    baselineSelfJac: number;
    l1SelfJac: number; // L1 determinism on this real CV
    baselineProf: number;
    l1Prof: number;
    profDelta: number; // l1 - baseline (negative = L1 rates lower)
    missVsBaseline: string[]; // canonical skills baseline found but L1 did not
    extraVsBaseline: string[]; // canonical skills L1 found but baseline did not
    parseError?: string;
  }
  const rows: Row[] = [];

  const emptyMetrics = {
    baselineCount: 0,
    l1Count: 0,
    countDelta: 0,
    crossJaccard: 0,
    baselineSelfJac: 0,
    l1SelfJac: 0,
    baselineProf: 0,
    l1Prof: 0,
    profDelta: 0,
    missVsBaseline: [] as string[],
    extraVsBaseline: [] as string[],
  };

  console.log(
    `\nDrift-prevalence cv_jd_match — ${pdfs.length} real CVs × ${TRIALS} trials (DB-less, real LLM + prod extractor/OCR) — template=${TEMPLATE}`,
  );
  console.log(
    `baseline=${baselineModel}@${BASELINE_PROVIDER} (temp 0.1) | candidate=${CANDIDATE_MODEL}@${CANDIDATE_PROVIDER} (temp 0, seed=${SEED})` +
      `${OCR_DPI || OCR_MAXPAGES ? ` | OCR dpi=${OCR_DPI ?? 200} maxPages=${OCR_MAXPAGES ?? 3}` : ''}` +
      `${ONLY.size ? ` | ONLY=[${[...ONLY].join(',')}]` : ''} | CV## = alphabetical order in data/corpus/cv/\n`,
  );

  for (let i = 0; i < pdfs.length; i++) {
    const cvId = `CV${String(i + 1).padStart(2, '0')}`;
    // Index filter (ONLY takes precedence over LIMIT), preserving CV## numbering across the full corpus.
    if (ONLY.size ? !ONLY.has(i + 1) : i >= LIMIT) continue;
    // Prod extraction: pdf-parse → OCR-rescue when thin; throws only on empty-after-OCR.
    let text = '';
    let ocrUsed = false;
    try {
      const extracted = await extractor.extract({
        buffer: fs.readFileSync(path.join(CORPUS_DIR, pdfs[i])),
        mimetype: 'application/pdf',
        originalname: pdfs[i],
      } as Express.Multer.File);
      text = extracted.text;
      ocrUsed = extracted.isOcrOnly;
    } catch (e) {
      rows.push({
        cv: cvId,
        parseChars: 0,
        parseOk: false,
        ocrUsed: false,
        ...emptyMetrics,
        parseError: (e as Error).message,
      });
      console.log(`${cvId}  PARSE-FAIL (empty even after OCR): ${(e as Error).message}`);
      continue;
    }

    const base = await runN(text, baselineModel, BASELINE_PROVIDER, 0.1, undefined);
    const l1 = await runN(text, CANDIDATE_MODEL, CANDIDATE_PROVIDER, 0, SEED);
    const baseCanon = base[0].canon;
    const l1Canon = l1[0].canon;
    const row: Row = {
      cv: cvId,
      parseChars: text.trim().length,
      parseOk: true,
      ocrUsed,
      baselineCount: baseCanon.length,
      l1Count: l1Canon.length,
      countDelta: l1Canon.length - baseCanon.length,
      crossJaccard: r2(jaccard(baseCanon, l1Canon)),
      baselineSelfJac: r2(jaccard(base[0].canon, base[base.length - 1].canon)),
      l1SelfJac: r2(jaccard(l1[0].canon, l1[l1.length - 1].canon)),
      baselineProf: r2(mean(base.map((b) => b.meanProf))),
      l1Prof: r2(mean(l1.map((b) => b.meanProf))),
      profDelta: r2(mean(l1.map((b) => b.meanProf)) - mean(base.map((b) => b.meanProf))),
      missVsBaseline: baseCanon.filter((s) => !l1Canon.includes(s)).sort(),
      extraVsBaseline: l1Canon.filter((s) => !baseCanon.includes(s)).sort(),
    };
    rows.push(row);
    console.log(
      `${cvId}  chars=${String(row.parseChars).padStart(5)}${ocrUsed ? ' OCR' : '   '} | ` +
        `skills base=${String(row.baselineCount).padStart(2)} L1=${String(row.l1Count).padStart(2)} (Δ${row.countDelta >= 0 ? '+' : ''}${row.countDelta}) | ` +
        `crossJac=${row.crossJaccard.toFixed(2)} | prof base=${row.baselineProf.toFixed(1)} L1=${row.l1Prof.toFixed(1)} (Δ${row.profDelta >= 0 ? '+' : ''}${row.profDelta.toFixed(1)}) | ` +
        `selfJac base=${row.baselineSelfJac.toFixed(2)} L1=${row.l1SelfJac.toFixed(2)}` +
        (row.missVsBaseline.length ? ` | L1-missed=[${row.missVsBaseline.join(' ')}]` : ''),
    );
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const ok = rows.filter((r) => r.parseOk);
  const parseFailed = rows.filter((r) => !r.parseOk).map((r) => r.cv);
  const ocrRescued = ok.filter((r) => r.ocrUsed).map((r) => r.cv);
  const underExtract = ok.filter((r) => r.countDelta < 0);
  const lowerProf = ok.filter((r) => r.profDelta < 0);
  const agg = {
    corpus_size: rows.length,
    parsed_ok: ok.length,
    parse_failed: parseFailed, // TRUE prod fail (empty even after OCR)
    ocr_rescued: ocrRescued, // thin text layer, recovered by OCR
    mean_cross_jaccard: r2(mean(ok.map((r) => r.crossJaccard))),
    cvs_l1_under_extracts: underExtract.length,
    mean_count_delta: r2(mean(ok.map((r) => r.countDelta))),
    mean_prof_delta: r2(mean(ok.map((r) => r.profDelta))),
    cvs_l1_lower_prof: lowerProf.length,
    l1_mean_self_jaccard: r2(mean(ok.map((r) => r.l1SelfJac))),
    baseline_mean_self_jaccard: r2(mean(ok.map((r) => r.baselineSelfJac))),
    l1_fully_deterministic_cvs: ok.filter((r) => r.l1SelfJac === 1).length,
  };

  console.log('\n=== AGGREGATE (real-CV drift, baseline → L1; prod extractor + OCR) ===');
  console.log(
    `  parsed ok:            ${agg.parsed_ok}/${agg.corpus_size}` +
      (parseFailed.length ? ` (TRUE parse-fail after OCR: ${parseFailed.join(', ')})` : ''),
  );
  console.log(
    `  OCR-rescued:          ${ocrRescued.length}/${agg.parsed_ok}` +
      (ocrRescued.length ? ` (${ocrRescued.join(', ')})` : ''),
  );
  console.log(
    `  mean cross-Jaccard:   ${agg.mean_cross_jaccard}  (1.0 = L1 extracts the same canonical skills as baseline)`,
  );
  console.log(
    `  L1 under-extracts in: ${agg.cvs_l1_under_extracts}/${agg.parsed_ok} CVs  (mean count Δ ${agg.mean_count_delta})`,
  );
  console.log(
    `  L1 lower proficiency: ${agg.cvs_l1_lower_prof}/${agg.parsed_ok} CVs  (mean prof Δ ${agg.mean_prof_delta} on 1-5 scale) ← fe-react calibration signal`,
  );
  console.log(
    `  L1 determinism:       self-Jaccard ${agg.l1_mean_self_jaccard} (baseline ${agg.baseline_mean_self_jaccard}); fully stable on ${agg.l1_fully_deterministic_cvs}/${agg.parsed_ok} CVs`,
  );
  console.log(
    `\n⚠️  ${rows.length} real CVs (PII, gitignored). CV-only extraction proxy: measures the extraction inputs to the score,` +
      ` not the score itself. baseline is single-template noisy; treat magnitudes as directional, not exact.\n`,
  );

  // PII-safe report: metrics + taxonomy canonicals + anonymous index only. No filename, no CV text.
  const outPath = path.join(process.cwd(), 'data', 'corpus', 'drift-report.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        template: TEMPLATE,
        baselineModel,
        baselineProvider: BASELINE_PROVIDER,
        candidateModel: CANDIDATE_MODEL,
        candidateProvider: CANDIDATE_PROVIDER,
        trials: TRIALS,
        aggregate: agg,
        rows,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `wrote ${outPath} (metrics + canonical skill names + CV## index only — NO CV text, NO filenames)`,
  );
  await app.close();
}

main().catch((e) => {
  console.error('\ndrift-prevalence-cv-corpus failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
