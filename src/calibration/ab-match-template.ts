/**
 * A/B drift probe for the cv_jd_match v1→v2 flip (pre-flip safety check; refinement #3).
 *
 * For each case in data/ab-match-cases.json, runs the REAL LLM extraction with BOTH prompts
 * (cv_jd_match_v1 + cv_jd_match_v2), feeds each into the SAME deterministic SkillDiffService, and
 * reports per case: overall_score delta, matched/missing skill-set diff, and jd_dimensions presence
 * under v2. The point: confirm that adding jd_dimensions_raw to the v2 call does NOT shift the skill
 * extraction enough to move the score.
 *
 * DB-less (tracing stub via NODE_ENV=test, like eval:jd-extract). NOT a CI gate, NOT a scoring change.
 * Needs LLM keys (OPENAI_API_KEY / GEMINI_API_KEY). Usage:  pnpm ab:match-template
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

const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 3000);

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

  const extract = async (code: string, c: AbCase) => {
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
      (e, n) => console.warn(`  ${c.id}/${code}: retry ${n} — ${(e as Error).message}`),
    );
    const obj = (
      res.parsedJson && typeof res.parsedJson === 'object' ? res.parsedJson : {}
    ) as Record<string, unknown>;
    const diff = skillDiff.diff({
      cv_skills_raw: (obj.cv_skills_raw ?? []) as never,
      jd_requirements_raw: (obj.jd_requirements_raw ?? []) as never,
      target_role: c.target_role,
    });
    const jdDimsCount = Array.isArray(obj.jd_dimensions_raw) ? obj.jd_dimensions_raw.length : 0;
    return { diff, jdDimsCount };
  };

  const names = (arr: Array<{ canonical_name: string }>): Set<string> =>
    new Set(arr.map((s) => s.canonical_name));
  const only = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => !b.has(x));

  console.log(`\nA/B cv_jd_match v1 vs v2 — ${cases.length} cases (DB-less, real LLM)\n`);
  let maxDelta = 0;
  for (const c of cases) {
    const v1 = await extract('cv_jd_match_v1', c);
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    const v2 = await extract('cv_jd_match_v2', c);
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));

    const delta = Math.abs(v1.diff.overall_score - v2.diff.overall_score);
    maxDelta = Math.max(maxDelta, delta);
    const m1 = names(v1.diff.matched_skills);
    const m2 = names(v2.diff.matched_skills);
    const mi1 = names(v1.diff.missing_skills);
    const mi2 = names(v2.diff.missing_skills);
    console.log(
      `${c.id.padEnd(18)} score v1=${v1.diff.overall_score} v2=${v2.diff.overall_score} Δ=${delta} | ` +
        `matched +[${only(m2, m1).join(',')}] -[${only(m1, m2).join(',')}] | ` +
        `missing +[${only(mi2, mi1).join(',')}] -[${only(mi1, mi2).join(',')}] | jd_dims(v2)=${v2.jdDimsCount}`,
    );
  }
  console.log(
    `\nMAX |overall_score Δ| = ${maxDelta} (target ~0 for a safe flip; investigate if large)\n`,
  );
  await app.close();
}

main().catch((e) => {
  console.error('\nab-match-template failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
