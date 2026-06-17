/**
 * Drift-prevalence eval — how often does the L1 extraction model (gpt-4o-mini) under-extract or
 * under-rate skills vs the prod baseline (gpt-5.4-mini) on a REAL CV corpus? Answers whether the
 * synthetic fe-react "score drop" generalises before activating the determinism toggle in prod.
 *
 * CV-ONLY (no JD pairing / no labels needed): the cv_jd_match prompt extracts cv_skills_raw with a
 * "(no JD provided)" JD, so we measure the two leading indicators of the fe-react score gap directly:
 *   (1) skill COUNT + canonical SET (under-extraction of prose skills), and
 *   (2) mean proficiency_hint (the calibration difference that drove fe-react 100→41).
 * Plus L1 self-consistency across trials (is L1 deterministic on messy real CVs?) and parse health
 * (does pdf-parse choke on e.g. the Canva CV?).
 *
 * PII / PDPL: reads PDFs from data/corpus/ (gitignored). Prints/persists ONLY metrics + taxonomy
 * canonical skill names + an anonymous CV## index — NEVER raw CV text and NEVER the filename (which
 * can be a real person's name). DB-less (NODE_ENV=test). Needs LLM keys. Usage:
 *   DRIFT_TRIALS=2 DRIFT_CANDIDATE_MODEL=gpt-4o-mini DRIFT_SEED=7 pnpm drift:cv-corpus
 */
import * as dotenv from 'dotenv';
// Surgical override (parity with the other calibration harnesses): a stale OS-level key must not
// shadow .env.
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
import * as fs from 'fs';
import * as path from 'path';
import { withRetry } from './retry';
import { pdfParseExtract } from './extractors/pdf-parse.extractor';

process.env.NODE_ENV = 'test'; // DB-less BEFORE AppModule import — we measure extraction, not persistence.

const CORPUS_DIR = path.join(process.cwd(), 'data', 'corpus', 'cv');
const TEMPLATE = process.env.DRIFT_TEMPLATE ?? 'cv_jd_match_v2'; // the live prod template.
const CANDIDATE_MODEL = process.env.DRIFT_CANDIDATE_MODEL ?? 'gpt-4o-mini';
const SEED = process.env.DRIFT_SEED !== undefined ? Number(process.env.DRIFT_SEED) : 7;
const TRIALS = Number(process.env.DRIFT_TRIALS ?? 2);
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 700);
const NO_JD = '(no JD provided)';
const MIN_CHARS = 120; // below this the PDF almost certainly failed to yield a usable text layer.

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
    .sort()
    .slice(0, LIMIT);
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

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const llm = app.get(LlmService);
  const prompts = app.get(PromptsService);
  const normalizer = app.get(SkillNormalizerService);
  const baselineModel =
    app.get(ConfigService).get<string>('llm.openai.modelDefault') ?? 'gpt-5.4-mini';

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

  const runN = async (cvText: string, model: string, temperature: number, seed?: number) => {
    const out: ExtractResult[] = [];
    for (let i = 0; i < TRIALS; i++) {
      out.push(await extractOnce(cvText, model, temperature, seed));
      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    return out;
  };

  interface Row {
    cv: string; // anonymous index, never the filename
    parseChars: number;
    parseOk: boolean;
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
  }
  const rows: Row[] = [];

  console.log(
    `\nDrift-prevalence cv_jd_match — ${pdfs.length} real CVs × ${TRIALS} trials (DB-less, real LLM) — template=${TEMPLATE}`,
  );
  console.log(
    `baseline=${baselineModel} (temp 0.1) | candidate=${CANDIDATE_MODEL} (temp 0, seed=${SEED}) | CV## = alphabetical order in data/corpus/cv/\n`,
  );

  for (let i = 0; i < pdfs.length; i++) {
    const cvId = `CV${String(i + 1).padStart(2, '0')}`;
    let text = '';
    try {
      text = await pdfParseExtract(fs.readFileSync(path.join(CORPUS_DIR, pdfs[i])));
    } catch (e) {
      text = '';
      console.log(`${cvId}  PARSE-ERROR: ${(e as Error).message}`);
    }
    const parseOk = text.trim().length >= MIN_CHARS;
    if (!parseOk) {
      rows.push({
        cv: cvId,
        parseChars: text.trim().length,
        parseOk: false,
        baselineCount: 0,
        l1Count: 0,
        countDelta: 0,
        crossJaccard: 0,
        baselineSelfJac: 0,
        l1SelfJac: 0,
        baselineProf: 0,
        l1Prof: 0,
        profDelta: 0,
        missVsBaseline: [],
        extraVsBaseline: [],
      });
      console.log(`${cvId}  parse_chars=${text.trim().length} → SKIP (no usable text layer)`);
      continue;
    }

    const base = await runN(text, baselineModel, 0.1, undefined);
    const l1 = await runN(text, CANDIDATE_MODEL, 0, SEED);
    const baseCanon = base[0].canon;
    const l1Canon = l1[0].canon;
    const row: Row = {
      cv: cvId,
      parseChars: text.trim().length,
      parseOk: true,
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
      `${cvId}  chars=${String(row.parseChars).padStart(5)} | ` +
        `skills base=${String(row.baselineCount).padStart(2)} L1=${String(row.l1Count).padStart(2)} (Δ${row.countDelta >= 0 ? '+' : ''}${row.countDelta}) | ` +
        `crossJac=${row.crossJaccard.toFixed(2)} | prof base=${row.baselineProf.toFixed(1)} L1=${row.l1Prof.toFixed(1)} (Δ${row.profDelta >= 0 ? '+' : ''}${row.profDelta.toFixed(1)}) | ` +
        `selfJac base=${row.baselineSelfJac.toFixed(2)} L1=${row.l1SelfJac.toFixed(2)}` +
        (row.missVsBaseline.length ? ` | L1-missed=[${row.missVsBaseline.join(' ')}]` : ''),
    );
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const ok = rows.filter((r) => r.parseOk);
  const parseFailed = rows.filter((r) => !r.parseOk).map((r) => r.cv);
  const underExtract = ok.filter((r) => r.countDelta < 0);
  const lowerProf = ok.filter((r) => r.profDelta < 0);
  const agg = {
    corpus_size: rows.length,
    parsed_ok: ok.length,
    parse_failed: parseFailed,
    mean_cross_jaccard: r2(mean(ok.map((r) => r.crossJaccard))),
    cvs_l1_under_extracts: underExtract.length,
    mean_count_delta: r2(mean(ok.map((r) => r.countDelta))),
    mean_prof_delta: r2(mean(ok.map((r) => r.profDelta))),
    cvs_l1_lower_prof: lowerProf.length,
    l1_mean_self_jaccard: r2(mean(ok.map((r) => r.l1SelfJac))),
    baseline_mean_self_jaccard: r2(mean(ok.map((r) => r.baselineSelfJac))),
    l1_fully_deterministic_cvs: ok.filter((r) => r.l1SelfJac === 1).length,
  };

  console.log('\n=== AGGREGATE (real-CV drift, baseline → L1) ===');
  console.log(
    `  parsed ok:            ${agg.parsed_ok}/${agg.corpus_size}` +
      (parseFailed.length ? ` (parse-failed: ${parseFailed.join(', ')})` : ''),
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
        candidateModel: CANDIDATE_MODEL,
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
