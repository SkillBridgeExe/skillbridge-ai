/**
 * LLM-judge PANEL agreement study for the CV-scoring system.
 *
 *   pnpm calibrate:panel
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  HONESTY NOTICE                                                             ║
 * ║  This is an OpenAI-only AI-panel PROXY — NOT human calibration.             ║
 * ║  All judges run on the SAME provider as the scoring system, so shared-      ║
 * ║  model bias is NOT mitigated (personas + temperatures + optional judge-     ║
 * ║  model override give consistency diversity, not independent validity).     ║
 * ║  The 94% within-band accuracy claim remains a PROXY until Grounding-B      ║
 * ║  (3 human raters × 30-50 CVs) runs.                                        ║
 * ║  Use this report for consistency checks and outlier triage only.           ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * Corpus: eval-cvs.json (13 CVs) + calibration-cvs.json (4 CVs, if shape-compatible).
 * System scores: the SAME scoring path as eval-accuracy (CvReviewService, DB-less).
 * Judges (BLIND — never see the system score or expected bands):
 *   J1 hiring-manager  — OpenAI, temp 0.0  (IT recruiter / hiring manager)
 *   J2 career-advisor  — OpenAI, temp 0.2  (university career advisor)
 *   J3 senior-engineer — OpenAI, temp 0.4  (senior engineer interviewer)
 *   Optional: PANEL_JUDGE_MODEL=<openai-model> judges on a different OpenAI model
 *   than production (less same-model echo; same-provider bias remains).
 *
 * Cross-provider EXTERNAL reference (optional): when
 * data/calibration-external-judge-claude.json exists (blind offline grades by the
 * Claude coding agent — NO Anthropic API in this codebase), the report adds
 * system-vs-external and panel-vs-external agreement. Reference-only, gates nothing.
 *
 * Output: console table + data/calibration-llm-panel-report.json
 * Exit: 0 when the harness itself succeeds; 1 only on harness errors.
 */

import * as dotenv from 'dotenv';
// SURGICAL override: a stale OS-level OPENAI_API_KEY can shadow .env — for a billing-relevant
// harness the .env key is the contract. Force only those two vars.
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
if (dotenvParsed.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = dotenvParsed.GOOGLE_API_KEY;

import * as fs from 'fs';
import * as path from 'path';
import { withRetry } from './retry';
import { spearman, mean, scoreAgreement } from './calibration-stats';
import type { LlmProvider } from '../infrastructure/llm/types/llm.types';

// Force DB-less mode BEFORE AppModule is imported (same pattern as eval-accuracy).
process.env.NODE_ENV = 'test';

// ─── HONESTY constant — reused in console + JSON output ──────────────────────
const HONESTY_LINE =
  'LLM-judge panel agreement study — NOT human calibration. All three judges run on the ' +
  'SAME provider (OpenAI) as the scoring system (Gemini free tier: 20 req/day — unusable for ' +
  'a 51-call panel), so shared-model bias is NOT mitigated; diversity comes from personas + ' +
  'temperatures only. The 94% within-band accuracy claim remains a PROXY until Grounding-B ' +
  '(3 human raters × 30-50 CVs) runs. Use this report for consistency checks and outlier ' +
  'triage only.';

// ─── Rubric text — kept in a const so the human protocol reuses the SAME wording ──────────────
export const RUBRIC =
  'Chấm 0-100 chất lượng CV này cho vị trí {role}: 80-100 xuất sắc (sẵn sàng phỏng vấn ngay, ' +
  'bằng chứng định lượng rõ), 60-79 tốt (đạt yêu cầu, vài điểm cần sửa), 40-59 trung bình ' +
  '(thiếu bằng chứng/cấu trúc), <40 yếu (thiếu nhiều phần cơ bản). Chấm theo: động từ hành ' +
  'động + số liệu, kỹ năng đúng role, kinh nghiệm/dự án, học vấn & trình bày.';

// ─── Judge configs ────────────────────────────────────────────────────────────
interface JudgeConfig {
  id: string;
  persona: string;
  provider: LlmProvider;
  temperature: number;
}

// All-OpenAI: Gemini free tier (20 req/day) cannot serve a 51-call panel — see HONESTY_LINE.
// Diversity = persona framing + temperature; this measures CONSISTENCY, not independent validity.
const JUDGES: JudgeConfig[] = [
  {
    id: 'hiring-manager',
    persona: 'trưởng nhóm tuyển dụng IT khó tính tại VN',
    provider: 'openai',
    temperature: 0.0,
  },
  {
    id: 'career-advisor',
    persona: 'cố vấn nghề nghiệp đại học, thiên coaching',
    provider: 'openai',
    temperature: 0.2,
  },
  {
    id: 'senior-engineer',
    persona: 'kỹ sư senior phỏng vấn ứng viên',
    provider: 'openai',
    temperature: 0.4,
  },
];

const DELAY_MS = Number(process.env.PANEL_DELAY_MS ?? 3000);
const PROMPT_CODE = 'cv_review_v1';
/**
 * Optional OpenAI model override for the JUDGES only (still OpenAI — provider is pinned).
 * Lets the panel judge on a different model than the production scorer to reduce
 * same-model echo; same-PROVIDER bias remains and stays declared in HONESTY_LINE.
 *   PANEL_JUDGE_MODEL=gpt-4o pnpm calibrate:panel
 */
const JUDGE_MODEL = process.env.PANEL_JUDGE_MODEL?.trim() || undefined;

// ─── Types ────────────────────────────────────────────────────────────────────
type Band = 'excellent' | 'good' | 'fair' | 'weak';

interface JudgeOutput {
  score: number;
  band: Band;
  justification: string;
}

interface CorpusCv {
  id: string;
  target_role: string;
  parsed_text: string;
}

interface PerCvResult {
  cv_id: string;
  target_role: string;
  system_score: number;
  judge_scores: {
    judge_id: string;
    score: number | null;
    band: Band | null;
    justification: string | null;
  }[];
  median_judge_score: number | null;
  delta_system_minus_median: number | null;
  judge_range: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Attempt to parse judge JSON from a raw string or already-parsed object.
 * Tolerant: strips markdown code fences if present.
 */
function parseJudgeOutput(raw: unknown): JudgeOutput | null {
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.score === 'number' && typeof obj.band === 'string') {
      return {
        score: Math.min(100, Math.max(0, Math.round(obj.score as number))),
        band: obj.band as Band,
        justification: typeof obj.justification === 'string' ? obj.justification : '',
      };
    }
  }
  if (typeof raw === 'string') {
    let text = raw.trim();
    // Strip markdown code fences
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
      return parseJudgeOutput(JSON.parse(text));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Call a single judge for a single CV.
 * Returns null if the judge fails after 1 retry — caller records null and continues.
 */
async function callJudge(
  judge: JudgeConfig,
  cv: CorpusCv,
  llmService: {
    complete: (
      msgs: { role: 'system' | 'user' | 'assistant'; content: string }[],
      opts: {
        provider?: LlmProvider;
        temperature?: number;
        jsonMode?: boolean;
        maxOutputTokens?: number;
      },
    ) => Promise<{ parsedJson?: unknown; text: string }>;
  },
): Promise<JudgeOutput | null> {
  const rubricForRole = RUBRIC.replace('{role}', cv.target_role);
  const systemPrompt =
    `Bạn là ${judge.persona}. Bạn chấm CV ứng tuyển vị trí IT một cách khách quan và nhất quán. ` +
    `Trả về JSON đúng schema sau, KHÔNG có text ngoài JSON:\n` +
    `{ "score": <0-100>, "band": "excellent"|"good"|"fair"|"weak", "justification": "<≤2 câu>" }`;
  const userPrompt =
    `RUBRIC:\n${rubricForRole}\n\n` +
    `VỊ TRÍ ỨNG TUYỂN: ${cv.target_role}\n\n` +
    `CV:\n${cv.parsed_text}`;

  const attempt = async (): Promise<JudgeOutput | null> => {
    try {
      const result = await llmService.complete(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          provider: judge.provider,
          temperature: judge.temperature,
          jsonMode: true,
          maxOutputTokens: 512,
          ...(JUDGE_MODEL ? { model: JUDGE_MODEL } : {}),
        },
      );
      const parsed = parseJudgeOutput(result.parsedJson ?? result.text);
      if (!parsed) throw new Error('Malformed judge JSON');
      return parsed;
    } catch (err) {
      throw err;
    }
  };

  try {
    return await withRetry(attempt, 1, (err, n) => {
      console.warn(
        `    [${judge.id}/${cv.id}] malformed response, retry ${n}/1 — ${(err as Error).message}`,
      );
    });
  } catch (err) {
    console.warn(
      `    [${judge.id}/${cv.id}] FAILED after 1 retry — recording null. (${(err as Error).message})`,
    );
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(80));
  console.log('  LLM-JUDGE PANEL CALIBRATION STUDY');
  console.log('');
  console.log('  ⚠  ' + HONESTY_LINE);
  console.log('═'.repeat(80) + '\n');

  // ─── Load corpus ──────────────────────────────────────────────────────────
  const dataDir = path.join(process.cwd(), 'data');
  const evalFile = path.join(dataDir, 'eval-cvs.json');
  const calFile = path.join(dataDir, 'calibration-cvs.json');

  const { cvs: evalCvs } = JSON.parse(fs.readFileSync(evalFile, 'utf-8')) as {
    cvs: Array<{ id: string; target_role: string; parsed_text: string }>;
  };

  // Include calibration-cvs.json only if every entry has parsed_text + target_role
  let calCvs: CorpusCv[] = [];
  try {
    const calRaw = JSON.parse(fs.readFileSync(calFile, 'utf-8')) as {
      cvs: Array<{ id: string; target_role?: string; parsed_text?: string }>;
    };
    const valid = calRaw.cvs.filter((c) => c.parsed_text && c.target_role);
    const skippedCount = calRaw.cvs.length - valid.length;
    if (skippedCount > 0) {
      console.log(
        `[corpus] calibration-cvs.json: ${valid.length}/${calRaw.cvs.length} entries included ` +
          `(${skippedCount} skipped — missing parsed_text or target_role).`,
      );
    }
    calCvs = valid as CorpusCv[];
    if (calCvs.length > 0) {
      console.log(`[corpus] calibration-cvs.json: ${calCvs.length} CVs included.\n`);
    }
  } catch {
    console.log('[corpus] calibration-cvs.json not found or unreadable — skipping.\n');
  }

  const corpus: CorpusCv[] = [
    ...evalCvs.map((c) => ({ id: c.id, target_role: c.target_role, parsed_text: c.parsed_text })),
    ...calCvs,
  ];

  console.log(`Corpus: ${corpus.length} CVs (${evalCvs.length} eval + ${calCvs.length} cal)\n`);

  // ─── Bootstrap NestJS (DB-less) ───────────────────────────────────────────
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { CvReviewService } = await import('../modules/cv-review/cv-review.service');
  const { LlmService } = await import('../infrastructure/llm/llm.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const cvReview = app.get(CvReviewService);
  const llmService = app.get(LlmService);

  // ─── System scores (same path as eval-accuracy) ────────────────────────────
  console.log('── Phase 1: System scoring ──────────────────────────────────────────────────\n');
  const systemScores: Map<string, number> = new Map();
  const systemSkipped: string[] = [];

  for (const cv of corpus) {
    try {
      const res = await withRetry(
        () =>
          cvReview.review('panel-eval', {
            cv_id: cv.id,
            parsed_text: cv.parsed_text,
            prompt_template_code: PROMPT_CODE,
            target_role: cv.target_role,
          }),
        2,
        (e, n) =>
          console.warn(`  [system/${cv.id}] transient, retry ${n}/2 — ${(e as Error).message}`),
      );
      systemScores.set(cv.id, res.total_score);
      console.log(`  system ${cv.id.padEnd(28)} overall=${res.total_score}`);
    } catch (e) {
      console.warn(`  [system/${cv.id}] SKIPPED after retries — ${(e as Error).message}`);
      systemSkipped.push(cv.id);
    }
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  if (systemSkipped.length > 0) {
    console.log(`\n  System skipped: ${systemSkipped.join(', ')}\n`);
  }

  // ─── Judge scoring (BLIND) ─────────────────────────────────────────────────
  console.log('\n── Phase 2: Judge scoring (BLIND) ────────────────────────────────────────────\n');

  // Track per-judge coverage
  const judgeCoverage: Record<string, { scored: number; failed: number }> = {};
  for (const j of JUDGES) judgeCoverage[j.id] = { scored: 0, failed: 0 };

  // Collect per-CV results for the scorable CVs only
  const perCvResults: PerCvResult[] = [];

  for (const cv of corpus) {
    if (!systemScores.has(cv.id)) {
      // System score failed → skip judge scoring for this CV
      continue;
    }
    const sysScore = systemScores.get(cv.id)!;

    const judgeScores: PerCvResult['judge_scores'] = [];
    const validScores: number[] = [];

    for (const judge of JUDGES) {
      console.log(`  [${judge.id}] judging ${cv.id}…`);
      const output = await callJudge(judge, cv, llmService);
      if (output !== null) {
        judgeCoverage[judge.id].scored++;
        judgeScores.push({
          judge_id: judge.id,
          score: output.score,
          band: output.band,
          justification: output.justification,
        });
        validScores.push(output.score);
      } else {
        judgeCoverage[judge.id].failed++;
        judgeScores.push({
          judge_id: judge.id,
          score: null,
          band: null,
          justification: null,
        });
      }
      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    const medianScore = validScores.length > 0 ? median(validScores) : null;
    const delta = medianScore !== null ? round2(sysScore - medianScore) : null;
    const judgeRange =
      validScores.length >= 2 ? round2(Math.max(...validScores) - Math.min(...validScores)) : null;

    perCvResults.push({
      cv_id: cv.id,
      target_role: cv.target_role,
      system_score: sysScore,
      judge_scores: judgeScores,
      median_judge_score: medianScore !== null ? round2(medianScore) : null,
      delta_system_minus_median: delta,
      judge_range: judgeRange,
    });
  }

  await app.close();

  // ─── Metrics ───────────────────────────────────────────────────────────────
  const scoredResults = perCvResults.filter((r) => r.median_judge_score !== null);
  const N = scoredResults.length;

  // System vs panel
  const systemArr = scoredResults.map((r) => r.system_score);
  const medianArr = scoredResults.map((r) => r.median_judge_score as number);
  const deltas = scoredResults.map((r) => r.delta_system_minus_median as number);

  const rho = N >= 2 ? spearman(systemArr, medianArr) : null;
  const meanAbsDelta = N > 0 ? round2(mean(deltas.map((d) => Math.abs(d)))) : null;
  const within15Count = deltas.filter((d) => Math.abs(d) <= 15).length;
  const within15Pct = N > 0 ? round2((within15Count / N) * 100) : null;

  // Inter-judge pairwise Spearman + per-CV range
  // Build per-judge score arrays (only for CVs where all 3 judges scored)
  const fullyScored = perCvResults.filter((r) => r.judge_scores.every((j) => j.score !== null));
  const judgeArrays: Record<string, number[]> = {};
  for (const j of JUDGES) {
    judgeArrays[j.id] = fullyScored.map(
      (r) => r.judge_scores.find((x) => x.judge_id === j.id)!.score as number,
    );
  }

  const pairwiseRhos: { pair: string; rho: number }[] = [];
  for (let i = 0; i < JUDGES.length; i++) {
    for (let k = i + 1; k < JUDGES.length; k++) {
      const a = judgeArrays[JUDGES[i].id];
      const b = judgeArrays[JUDGES[k].id];
      if (a.length >= 2) {
        pairwiseRhos.push({
          pair: `${JUDGES[i].id}×${JUDGES[k].id}`,
          rho: spearman(a, b),
        });
      }
    }
  }
  const meanInterJudgeRho =
    pairwiseRhos.length > 0 ? round2(mean(pairwiseRhos.map((p) => p.rho))) : null;

  // Mean per-CV judge range (max−min across judges with valid score)
  const rangesValid = scoredResults
    .filter((r) => r.judge_range !== null)
    .map((r) => r.judge_range as number);
  const meanJudgeRange = rangesValid.length > 0 ? round2(mean(rangesValid)) : null;

  // ─── Cross-provider EXTERNAL reference (optional, offline) ────────────────
  // data/calibration-external-judge-claude.json = blind grades by a DIFFERENT-provider
  // grader (Claude agent, offline — no Anthropic API in this codebase). When present we
  // report agreement vs the system and vs the panel median. Reference-only — it gates
  // nothing; same proxy caveats as the panel, minus the same-provider echo.
  interface ExternalJudgeFile {
    _honesty: string;
    grader: string;
    grades: Array<{ cv_id: string; score: number; band: string; justification: string }>;
  }
  let external: ExternalJudgeFile | null = null;
  try {
    external = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'calibration-external-judge-claude.json'), 'utf-8'),
    ) as ExternalJudgeFile;
  } catch {
    external = null;
  }
  const externalStats = external
    ? {
        grader: external.grader,
        honesty: external._honesty,
        n_grades: external.grades.length,
        system_vs_external: scoreAgreement(
          scoredResults.map((r) => ({ id: r.cv_id, score: r.system_score })),
          external.grades.map((g) => ({ id: g.cv_id, score: g.score })),
        ),
        panel_median_vs_external: scoreAgreement(
          scoredResults.map((r) => ({ id: r.cv_id, score: r.median_judge_score as number })),
          external.grades.map((g) => ({ id: g.cv_id, score: g.score })),
        ),
      }
    : null;

  // Outliers: |delta| > 15 → include all 3 justifications
  const outliers = scoredResults
    .filter(
      (r) => r.delta_system_minus_median !== null && Math.abs(r.delta_system_minus_median) > 15,
    )
    .map((r) => ({
      cv_id: r.cv_id,
      target_role: r.target_role,
      system_score: r.system_score,
      median_judge_score: r.median_judge_score,
      delta: r.delta_system_minus_median,
      justifications: r.judge_scores.map((j) => ({
        judge_id: j.judge_id,
        score: j.score,
        band: j.band,
        justification: j.justification,
      })),
    }));

  // ─── Console report ────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(80));
  console.log('  RESULTS — ' + HONESTY_LINE);
  console.log('═'.repeat(80) + '\n');

  // Per-CV table
  console.log(
    'CV ID'.padEnd(30) +
      'Sys'.padStart(5) +
      '  J1'.padStart(6) +
      '  J2'.padStart(6) +
      '  J3'.padStart(6) +
      '  Med'.padStart(6) +
      ' Delta'.padStart(7) +
      ' Range'.padStart(7),
  );
  console.log('─'.repeat(80));
  for (const r of perCvResults) {
    const jScores = JUDGES.map((j) => {
      const js = r.judge_scores.find((x) => x.judge_id === j.id);
      return js?.score != null ? String(js.score).padStart(4) : ' n/a';
    });
    console.log(
      r.cv_id.padEnd(30) +
        String(r.system_score).padStart(5) +
        jScores.map((s) => '  ' + s).join('') +
        (r.median_judge_score != null
          ? String(round2(r.median_judge_score)).padStart(6)
          : '   n/a') +
        (r.delta_system_minus_median != null
          ? (r.delta_system_minus_median >= 0 ? '+' : '') +
            String(r.delta_system_minus_median).padStart(6)
          : '   n/a') +
        (r.judge_range != null ? String(r.judge_range).padStart(7) : '    n/a'),
    );
  }

  console.log('\n─── Corpus metrics ─────────────────────────────────────────────────────────\n');
  console.log(`Corpus size         : ${corpus.length} CVs (${N} scored by system + panel)`);
  console.log(`Spearman(sys,panel) : ${rho ?? 'n/a'}`);
  console.log(`Mean |delta|        : ${meanAbsDelta ?? 'n/a'}`);
  console.log(`Within-15 pts       : ${within15Count}/${N} (${within15Pct ?? 'n/a'}%)`);
  console.log(
    `Inter-judge Spearman: ${meanInterJudgeRho ?? 'n/a'} (mean pairwise, ${fullyScored.length} CVs all-3 scored)`,
  );
  console.log(`Mean judge range    : ${meanJudgeRange ?? 'n/a'} pts (max−min per CV)`);

  console.log('\n─── Judge coverage ─────────────────────────────────────────────────────────\n');
  for (const j of JUDGES) {
    const c = judgeCoverage[j.id];
    console.log(
      `  ${j.id.padEnd(20)} scored=${c.scored}  failed=${c.failed}  provider=${j.provider}` +
        (JUDGE_MODEL ? `  model=${JUDGE_MODEL} (override)` : '  model=default'),
    );
  }

  if (externalStats) {
    console.log('\n─── Cross-provider EXTERNAL reference (offline, gates nothing) ─────────────\n');
    console.log(`  grader: ${externalStats.grader}`);
    const se = externalStats.system_vs_external;
    const pe = externalStats.panel_median_vs_external;
    console.log(
      `  system vs external : n=${se.n}  spearman=${se.spearman}  mae=${se.mae}  within-15=${se.within_15_count}/${se.n} (${se.within_15_pct}%)`,
    );
    console.log(
      `  panel  vs external : n=${pe.n}  spearman=${pe.spearman}  mae=${pe.mae}  within-15=${pe.within_15_count}/${pe.n} (${pe.within_15_pct}%)`,
    );
  }

  if (pairwiseRhos.length > 0) {
    console.log('\n─── Pairwise inter-judge Spearman ──────────────────────────────────────────\n');
    for (const p of pairwiseRhos) {
      console.log(`  ${p.pair.padEnd(45)} rho=${p.rho}`);
    }
  }

  if (outliers.length > 0) {
    console.log(
      '\n─── Outliers (|delta| > 15) ─────────────────────────────────────────────────\n',
    );
    for (const o of outliers) {
      console.log(
        `  ${o.cv_id} (${o.target_role}): sys=${o.system_score} median=${o.median_judge_score} delta=${o.delta}`,
      );
      for (const j of o.justifications) {
        if (j.justification) {
          console.log(
            `    [${j.judge_id}] score=${j.score ?? 'n/a'} band=${j.band ?? 'n/a'}: ${j.justification}`,
          );
        }
      }
    }
  } else {
    console.log('\n  No outliers (|delta| > 15).');
  }

  console.log('\n' + '═'.repeat(80));
  console.log('  ⚠  ' + HONESTY_LINE);
  console.log('═'.repeat(80) + '\n');

  // ─── Write JSON report ─────────────────────────────────────────────────────
  const report = {
    _honesty: HONESTY_LINE,
    generated_at: new Date().toISOString(),
    corpus_size: corpus.length,
    judges: JUDGES.map((j) => ({
      id: j.id,
      persona: j.persona,
      provider: j.provider,
      coverage: judgeCoverage[j.id],
    })),
    system_vs_panel: {
      n_scored: N,
      spearman_sys_vs_panel_median: rho,
      // mae and mean_abs_delta are the SAME number — mae is the explicit-name alias
      // (report consumers asked for "MAE"); mean_abs_delta kept for continuity.
      mae: meanAbsDelta,
      mean_abs_delta: meanAbsDelta,
      within_15_pts_count: within15Count,
      within_15_pts_pct: within15Pct,
    },
    judge_model_override: JUDGE_MODEL ?? null,
    external_reference: externalStats,
    inter_judge: {
      mean_pairwise_spearman: meanInterJudgeRho,
      pairwise: pairwiseRhos,
      mean_per_cv_range: meanJudgeRange,
      n_cvs_all_three_scored: fullyScored.length,
    },
    per_cv: perCvResults,
    outliers,
  };

  const reportPath = path.join(dataDir, 'calibration-llm-panel-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Report written → ${reportPath}\n`);
}

main().catch((err) => {
  console.error('\nPanel calibration harness FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
