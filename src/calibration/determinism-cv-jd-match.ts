/**
 * Determinism harness for cv_jd_match extraction (Phase 0). LOCAL/offline, NOT a CI gate, needs LLM keys.
 * Runs each gold-set case N times for BASELINE (current prod params) and CANDIDATE (env model + temp0 + seed),
 * reports score variance, cv/jd skill Jaccard across trials, precision/recall vs gold, token/latency/cost.
 * Usage:  DETERMINISM_TRIALS=5 DETERMINISM_CANDIDATE_MODEL=gpt-4o-mini DETERMINISM_SEED=7 pnpm determinism:cv-jd-match
 */
import * as dotenv from 'dotenv';
// Surgical override (parity with eval-jd-extract): a stale OS-level key must not shadow .env.
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
import * as fs from 'fs';
import * as path from 'path';
import { withRetry } from './retry';
import { scoreStats, jaccardAcrossTrials, precisionRecall } from './determinism-metrics';

process.env.NODE_ENV = 'test'; // DB-less BEFORE AppModule import — we measure extraction, not persistence.

const TRIALS = Number(process.env.DETERMINISM_TRIALS ?? 5);
const CANDIDATE_MODEL = process.env.DETERMINISM_CANDIDATE_MODEL ?? 'gpt-4o-mini';
// Candidate may live on a different provider (e.g. gemini for stronger VN recall). Provider is
// resolved from config default unless set here — the model name alone does NOT pick the provider.
const CANDIDATE_PROVIDER =
  (process.env.DETERMINISM_CANDIDATE_PROVIDER as 'openai' | 'gemini' | undefined) || undefined;
const SEED =
  process.env.DETERMINISM_SEED !== undefined ? Number(process.env.DETERMINISM_SEED) : undefined;
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 2000);
// prod default template; override to cv_jd_match_v2 (the live prod template) for prod-parity runs.
const TEMPLATE = process.env.DETERMINISM_TEMPLATE ?? 'cv_jd_match_v1';
// Optional comma-separated case-id filter (e.g. det-bilingual-vi) to probe one case cheaply.
const ONLY = (process.env.DETERMINISM_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEBUG = process.env.DETERMINISM_DEBUG === '1';

interface DetCase {
  id: string;
  lang: string;
  target_role: string;
  category: string;
  cv_text: string;
  jd_text: string;
  expected_cv_skills: string[];
  expected_jd_requirements: string[];
}
interface Trial {
  score: number | null;
  cvSkills: string[];
  jdReqs: string[];
  rawCvNames: string[]; // pre-normalization model output — distinguishes recall miss vs normalize gap
  compTokens: number;
  latencyMs: number;
  cost?: number;
  error?: string;
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-determinism-cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: DetCase[] };

  const { NestFactory } = await import('@nestjs/core');
  const { ConfigService } = await import('@nestjs/config');
  const { AppModule } = await import('../app.module');
  const { LlmService } = await import('../infrastructure/llm/llm.service');
  const { PromptsService } = await import('../modules/prompts/prompts.service');
  const { SkillDiffService } = await import('../modules/cv-jd-match/skill-diff.service');
  const { SkillNormalizerService } = await import('../common/services/skill-normalizer.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const llm = app.get(LlmService);
  const prompts = app.get(PromptsService);
  const skillDiff = app.get(SkillDiffService);
  const normalizer = app.get(SkillNormalizerService);
  const baselineModel =
    app.get(ConfigService).get<string>('llm.openai.modelDefault') ?? 'gpt-5.4-mini';

  // raw extracted skill names → set of resolved canonical names (drops unresolved)
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

  const runOne = async (
    c: DetCase,
    model: string,
    temperature: number,
    seed?: number,
    provider?: 'openai' | 'gemini',
  ): Promise<Trial> => {
    const startedAt = Date.now();
    try {
      const template = prompts.get(TEMPLATE);
      const user = prompts.render(TEMPLATE, { cv_text: c.cv_text, jd_text: c.jd_text });
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
              ...(provider ? { provider } : {}),
            },
          ),
        2,
        () => {},
      );
      const obj = (
        res.parsedJson && typeof res.parsedJson === 'object' ? res.parsedJson : {}
      ) as Record<string, unknown>;
      const rawCv = (obj.cv_skills_raw ?? []) as Array<{ name?: string }>;
      const diff = skillDiff.diff({
        cv_skills_raw: (obj.cv_skills_raw ?? []) as never,
        jd_requirements_raw: (obj.jd_requirements_raw ?? []) as never,
        target_role: c.target_role,
        target_band: 'fresher', // parity with cv-jd-match.service prod default
      });
      return {
        score: diff.overall_score,
        cvSkills: toCanon(rawCv),
        jdReqs: toCanon((obj.jd_requirements_raw ?? []) as Array<{ name?: string }>),
        rawCvNames: rawCv.map((r) => r?.name ?? '').filter(Boolean),
        compTokens: res.tokenUsage.completionTokens,
        latencyMs: res.latencyMs,
        cost: res.estimatedCostUsd,
      };
    } catch (e) {
      return {
        score: null,
        cvSkills: [],
        jdReqs: [],
        rawCvNames: [],
        compTokens: 0,
        latencyMs: Date.now() - startedAt,
        error: (e as Error).message,
      };
    }
  };

  const runN = async (
    c: DetCase,
    model: string,
    temperature: number,
    seed?: number,
    provider?: 'openai' | 'gemini',
  ): Promise<Trial[]> => {
    const out: Trial[] = [];
    for (let i = 0; i < TRIALS; i++) {
      out.push(await runOne(c, model, temperature, seed, provider));
      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    return out;
  };

  const report = (label: string, c: DetCase, trials: Trial[]): void => {
    const stats = scoreStats(trials.map((t) => t.score));
    const cvJac = jaccardAcrossTrials(trials.map((t) => t.cvSkills));
    const jdJac = jaccardAcrossTrials(trials.map((t) => t.jdReqs));
    const prs = trials
      .filter((t) => !t.error)
      .map((t) => precisionRecall(t.cvSkills, c.expected_cv_skills));
    const meanP = prs.length ? prs.reduce((s, p) => s + p.precision, 0) / prs.length : 0;
    const meanR = prs.length ? prs.reduce((s, p) => s + p.recall, 0) / prs.length : 0;
    // Union of gold skills missed across trials — names the recall gap (e.g. which VN skill drops).
    const missing = [...new Set(prs.flatMap((p) => p.missing))].sort();
    const verdict = stats.maxAbsDelta <= 3 ? 'GOOD' : stats.maxAbsDelta <= 5 ? 'OK' : 'FAIL';
    const tok = Math.max(...trials.map((t) => t.compTokens), 0);
    const lat = Math.round(
      trials.reduce((s, t) => s + t.latencyMs, 0) / Math.max(trials.length, 1),
    );
    const errs = trials.filter((t) => t.error).length;
    console.log(
      `  ${label.padEnd(16)} scores=${JSON.stringify(trials.map((t) => t.score))} maxΔ=${stats.maxAbsDelta} [${verdict}] ` +
        `stddev=${stats.stddev.toFixed(1)} | cvJac=${cvJac.toFixed(2)} jdJac=${jdJac.toFixed(2)} | ` +
        `P=${meanP.toFixed(2)} R=${meanR.toFixed(2)} | comp_tok=${tok} lat=${lat}ms` +
        (missing.length ? ` | miss=[${missing.join(' ')}]` : '') +
        (errs ? ` | ERRORS=${errs}` : ''),
    );
    if (DEBUG) {
      // First clean trial: show canonical-extracted vs raw model output to separate a true recall
      // miss (skill absent from raw) from a normalize gap (raw has it, canonical drops it).
      const t0 = trials.find((t) => !t.error);
      if (t0) {
        console.log(`      canon=[${[...t0.cvSkills].sort().join(' ')}]`);
        console.log(`      raw=[${t0.rawCvNames.join(' | ')}]`);
      }
    }
  };

  const selected = ONLY.length ? cases.filter((c) => ONLY.includes(c.id)) : cases;

  console.log(
    `\nDeterminism cv_jd_match — ${selected.length}/${cases.length} cases × ${TRIALS} trials (DB-less, real LLM) — template=${TEMPLATE}`,
  );
  console.log(
    `baseline=${baselineModel} (prod params, temp 0.1 no-op) | candidate=${CANDIDATE_MODEL}` +
      `${CANDIDATE_PROVIDER ? `@${CANDIDATE_PROVIDER}` : ''} (temp 0, seed=${SEED ?? 'none'})\n`,
  );

  for (const c of selected) {
    console.log(`${c.id} [${c.category}/${c.lang}] role=${c.target_role}`);
    report('baseline', c, await runN(c, baselineModel, 0.1, undefined));
    report('candidate', c, await runN(c, CANDIDATE_MODEL, 0, SEED, CANDIDATE_PROVIDER));
  }

  console.log(
    '\nGate: primary maxΔscore ≤3 good / ≤5 ok / >5 fail · secondary Jaccard ≥0.90 · quality floor P/R not below baseline.',
  );
  console.log(
    'Phase 0 = baseline noise floor; Phase 1 compares candidate levers. Not a CI gate.\n',
  );
  await app.close();
}

main().catch((e) => {
  console.error('\ndeterminism-cv-jd-match failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
