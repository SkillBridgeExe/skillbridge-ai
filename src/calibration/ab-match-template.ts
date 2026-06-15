/**
 * A/B drift probe for the cv_jd_match v1→v2 flip (pre-flip safety check; refinement #3).
 *
 * ⚠️ The extraction model (gpt-5.4-mini) is a REASONING model — the OpenAI provider does NOT send
 * `temperature` for it, so `temperature: 0.1` is a NO-OP and every call is non-deterministic. A single
 * v1-vs-v2 comparison therefore conflates the (unknown) v2 effect with run-to-run model noise. So this
 * harness runs EACH version AB_TRIALS times per case and reports the within-version NOISE FLOOR
 * (range of same-prompt scores) alongside the cross-version |Δ median|. A v2 effect is only
 * "distinguishable" if |Δ median| exceeds the noise floor.
 *
 * Faithful to prod's call: same params ({jsonMode, temperature:0.1, maxOutputTokens:3000}) AND
 * target_band:'fresher' (the cv-jd-match.service default). DB-less (NODE_ENV=test, like eval:jd-extract).
 * NOT a CI gate, NOT a scoring change. Needs LLM keys. Usage:  AB_TRIALS=3 pnpm ab:match-template
 */
import * as dotenv from 'dotenv';
// Surgical override (parity with eval-jd-extract): a stale OS-level key must not shadow .env.
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
import * as fs from 'fs';
import * as path from 'path';
import { withRetry } from './retry';

process.env.NODE_ENV = 'test'; // DB-less mode BEFORE AppModule import — we measure extraction, not persistence.

interface AbCase {
  id: string;
  cv_text: string;
  jd_text: string;
  target_role?: string;
}

interface Trial {
  score: number | null;
  cvSkills: number;
  jdReqs: number;
  jdDims: number;
  compTokens: number;
  error?: string;
}

const TRIALS = Number(process.env.AB_TRIALS ?? 3);
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 2000);

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const range = (xs: number[]): number => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'ab-match-cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: AbCase[] };

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { LlmService } = await import('../infrastructure/llm/llm.service');
  const { PromptsService } = await import('../modules/prompts/prompts.service');
  const { SkillDiffService } = await import('../modules/cv-jd-match/skill-diff.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const llm = app.get(LlmService);
  const prompts = app.get(PromptsService);
  const skillDiff = app.get(SkillDiffService);

  const runOne = async (code: string, c: AbCase): Promise<Trial> => {
    try {
      const template = prompts.get(code);
      const user = prompts.render(code, { cv_text: c.cv_text, jd_text: c.jd_text });
      const res = await withRetry(
        () =>
          llm.complete(
            [
              { role: 'system', content: template.meta.system ?? '' },
              { role: 'user', content: user },
            ],
            { jsonMode: true, temperature: 0.1, maxOutputTokens: 3000 },
          ),
        2,
        () => {},
      );
      const obj = (
        res.parsedJson && typeof res.parsedJson === 'object' ? res.parsedJson : {}
      ) as Record<string, unknown>;
      const diff = skillDiff.diff({
        cv_skills_raw: (obj.cv_skills_raw ?? []) as never,
        jd_requirements_raw: (obj.jd_requirements_raw ?? []) as never,
        target_role: c.target_role,
        target_band: 'fresher', // parity with cv-jd-match.service prod default
      });
      return {
        score: diff.overall_score,
        cvSkills: Array.isArray(obj.cv_skills_raw) ? obj.cv_skills_raw.length : 0,
        jdReqs: Array.isArray(obj.jd_requirements_raw) ? obj.jd_requirements_raw.length : 0,
        jdDims: Array.isArray(obj.jd_dimensions_raw) ? obj.jd_dimensions_raw.length : 0,
        compTokens: res.tokenUsage.completionTokens,
      };
    } catch (e) {
      return {
        score: null,
        cvSkills: 0,
        jdReqs: 0,
        jdDims: 0,
        compTokens: 0,
        error: (e as Error).message,
      };
    }
  };

  const runN = async (code: string, c: AbCase): Promise<Trial[]> => {
    const out: Trial[] = [];
    for (let i = 0; i < TRIALS; i++) {
      out.push(await runOne(code, c));
      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    return out;
  };

  const scores = (ts: Trial[]): number[] =>
    ts.map((t) => t.score).filter((s): s is number => s !== null);

  console.log(
    `\nA/B cv_jd_match v1 vs v2 — ${cases.length} cases × ${TRIALS} trials (DB-less, real LLM; temp is a NO-OP on gpt-5*)\n`,
  );

  let maxNoiseFloor = 0;
  let maxCrossDelta = 0;
  let anyTruncationOrError = false;

  for (const c of cases) {
    const v1 = await runN('cv_jd_match_v1', c);
    const v2 = await runN('cv_jd_match_v2', c);
    const s1 = scores(v1);
    const s2 = scores(v2);
    const m1 = median(s1);
    const m2 = median(s2);
    const r1 = range(s1);
    const r2 = range(s2);
    const noise = Math.max(r1, r2);
    maxNoiseFloor = Math.max(maxNoiseFloor, noise);
    const crossDelta = m1 !== null && m2 !== null ? Math.abs(m1 - m2) : NaN;
    if (!Number.isNaN(crossDelta)) maxCrossDelta = Math.max(maxCrossDelta, crossDelta);

    const errs = [...v1, ...v2].filter((t) => t.error);
    const maxComp = Math.max(...[...v1, ...v2].map((t) => t.compTokens), 0);
    if (errs.length || maxComp >= 8000) anyTruncationOrError = true;

    console.log(
      `${c.id.padEnd(12)} v1 ${JSON.stringify(s1)} med=${m1} range=${r1} | ` +
        `v2 ${JSON.stringify(s2)} med=${m2} range=${r2} | |Δmed|=${Number.isNaN(crossDelta) ? '?' : crossDelta} | ` +
        `jd_dims(v2)=${median(v2.map((t) => t.jdDims))} | comp_tok_max=${maxComp}` +
        (errs.length ? ` | ERRORS=${errs.length}: ${errs[0].error}` : ''),
    );
  }

  console.log('\n=== Summary ===');
  console.log(`Noise floor  (max within-version score range, same prompt) = ${maxNoiseFloor}`);
  console.log(`v2 effect    (max |median(v1) − median(v2)|)               = ${maxCrossDelta}`);
  if (anyTruncationOrError) {
    console.log('⚠️  truncation/errors or completion ~cap (≥8000 tok) observed — inspect (H2).');
  }
  console.log(
    maxCrossDelta <= maxNoiseFloor
      ? '\n→ v2 effect is WITHIN the run-to-run noise floor — NOT distinguishable from model non-determinism.'
      : '\n→ v2 median differs by MORE than the noise floor — a candidate real v2 effect; inspect skill/jd_dims columns.',
  );
  console.log(
    '\nNote: gpt-5.4-mini ignores temperature (reasoning model) → extraction is inherently noisy for BOTH versions; this is a PRE-EXISTING prod property, not introduced by the flip.\n',
  );
  await app.close();
}

main().catch((e) => {
  console.error('\nab-match-template failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
