/**
 * Role-inference eval — the GATE for Story→CV slice 1. Fully OFFLINE (no LLM, no DB): each gold story
 * runs through the REAL SkillTaxonomy alias index → weighted role inference over the REAL role rubric
 * set (role-rubrics-pilot.json). Reports per-case detail, accuracy + abstention-accuracy + a confusion
 * matrix, AND a threshold sweep that calibrates (minConfidence / minMatched / ambiguityMargin) on the
 * gold set. Exits non-zero below baseline so a regression fails CI.
 *
 *   npm run eval:role-infer
 *
 * Gold set (data/eval-role-infer-cases.json) is the USER's lane — 30 hand-labeled stories over the
 * full-IT role set. expected_role: null = a case that SHOULD abstain (too weak / ambiguous).
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { RoleRubricService } from '../common/services/role-rubric.service';
import { confusionMatrix } from './calibration-metrics';
import {
  extractSkillMentions,
  inferRoleFromSkills,
  rubricsToProfiles,
  RoleProfile,
} from '../modules/cv-builder/role-inference';

const BASELINE_ACC = 0.9; // gate on the matured 30-case gold set (allows ~3 misses before failing).
const NONE = '__none__'; // confusion-matrix label for "abstained / no role".

// CALIBRATED defaults — these MUST match inferRoleFromSkills' defaults so the gate reflects prod.
// The sweep below re-derives the best combo on the gold set each run; if it diverges, update both.
type Thresholds = { minConfidence: number; minMatched: number; ambiguityMargin: number };
const DEFAULTS: Thresholds = { minConfidence: 0.34, minMatched: 2, ambiguityMargin: 0.1 };

interface RoleCase {
  id: string;
  story: string;
  expected_role: string | null;
}

/** Run the whole gold set under one threshold combo → accuracy + abstention scoring. */
function scoreCombo(
  cases: RoleCase[],
  skillsPerCase: string[][],
  profiles: RoleProfile[],
  opts: Thresholds,
): { acc: number; correct: number; abstainOk: number; abstainTotal: number } {
  let correct = 0;
  let abstainOk = 0;
  let abstainTotal = 0;
  for (let i = 0; i < cases.length; i++) {
    const out = inferRoleFromSkills(skillsPerCase[i], profiles, opts);
    const got = out.role_code ?? NONE;
    const exp = cases[i].expected_role ?? NONE;
    if (got === exp) correct++;
    if (exp === NONE) {
      abstainTotal++;
      if (out.needs_user_input) abstainOk++;
    }
  }
  return { acc: cases.length ? correct / cases.length : 0, correct, abstainOk, abstainTotal };
}

async function main(): Promise<void> {
  // Lightweight bootstrap (mirrors eval-gap.ts) — instantiate the services directly, no Nest context.
  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const rubrics = new RoleRubricService();
  await rubrics.onModuleInit();

  const profiles = rubricsToProfiles(rubrics.listRubrics());
  // resolve = taxonomy alias lookup, composed from the two existing public methods (no new method).
  const resolve = (raw: string): string | null =>
    taxonomy.lookupByAliasKey(SkillTaxonomyService.normalizeKey(raw)) ?? null;

  const { cases } = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'data', 'eval-role-infer-cases.json'), 'utf-8'),
  ) as { cases: RoleCase[] };

  // Extract once per case (deterministic) → reused by the detail print AND every sweep combo.
  const skillsPerCase = cases.map((c) => extractSkillMentions(c.story, resolve));

  console.log(
    `Roles in rubric set (${profiles.length}): ${profiles.map((p) => p.role_code).join(', ')}\n`,
  );

  const expected: string[] = [];
  const predicted: string[] = [];

  console.log('Per-case (default thresholds):');
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const out = inferRoleFromSkills(skillsPerCase[i], profiles, DEFAULTS);
    const got = out.role_code ?? NONE;
    const exp = c.expected_role ?? NONE;
    expected.push(exp);
    predicted.push(got);
    const top = out.candidates[0];
    const second = out.candidates[1];
    const fmt = (x?: { role_code: string; score: number }) =>
      x ? `${x.role_code}=${x.score.toFixed(2)}` : '—';
    const flag = got === exp ? 'PASS' : 'MISS';
    console.log(
      `  [${flag}] ${c.id.padEnd(14)} exp=${exp.padEnd(22)} got=${got.padEnd(22)} ` +
        `reason=${out.reason.padEnd(9)} top=[${fmt(top)}] 2nd=[${fmt(second)}] ` +
        `skills={${skillsPerCase[i].join(',')}}`,
    );
  }

  const correct = expected.filter((e, i) => e === predicted[i]).length;
  const acc = cases.length ? correct / cases.length : 0;
  const abstainTotal = cases.filter((c) => c.expected_role === null).length;
  const abstainOk = cases.filter(
    (c, i) => c.expected_role === null && predicted[i] === NONE,
  ).length;

  const labels = [...new Set([...expected, ...predicted])].sort();
  const matrix = confusionMatrix(predicted, expected, labels); // rows = actual, cols = predicted

  console.log(`\nrole-infer accuracy = ${(acc * 100).toFixed(1)}% (${correct}/${cases.length})`);
  console.log(
    `abstention correct = ${abstainOk}/${abstainTotal} (abstained when the story is weak/ambiguous)`,
  );
  console.log('labels:', labels.join(', '));
  console.log('confusion (rows=actual, cols=predicted):', JSON.stringify(matrix));

  // ---- Threshold calibration sweep on the gold set --------------------------------------------
  const grid = {
    minConfidence: [0.25, 0.3, 0.34, 0.38, 0.42, 0.46],
    minMatched: [2, 3],
    ambiguityMargin: [0.05, 0.08, 0.1, 0.12, 0.15],
  };
  const combos: Array<{ opts: Thresholds; acc: number; abstainOk: number }> = [];
  for (const minConfidence of grid.minConfidence)
    for (const minMatched of grid.minMatched)
      for (const ambiguityMargin of grid.ambiguityMargin) {
        const opts = { minConfidence, minMatched, ambiguityMargin };
        const r = scoreCombo(cases, skillsPerCase, profiles, opts);
        combos.push({ opts, acc: r.acc, abstainOk: r.abstainOk });
      }
  // Rank: accuracy, then abstention correctness, then prefer the most "central"/lenient combo
  // (lower minConfidence + minMatched + margin) so we don't over-tighten on a 30-case set.
  const dist = (o: Thresholds) =>
    Math.abs(o.minConfidence - 0.34) + (o.minMatched - 2) + Math.abs(o.ambiguityMargin - 0.1);
  combos.sort((a, b) => b.acc - a.acc || b.abstainOk - a.abstainOk || dist(a.opts) - dist(b.opts));
  console.log('\nThreshold sweep (top 8 by accuracy, then abstention, then least-tightened):');
  for (const c of combos.slice(0, 8)) {
    console.log(
      `  acc=${(c.acc * 100).toFixed(1)}%  abstain=${c.abstainOk}/${abstainTotal}  ` +
        `minConf=${c.opts.minConfidence} minMatched=${c.opts.minMatched} margin=${c.opts.ambiguityMargin}`,
    );
  }
  const best = combos[0];
  const dflt = combos.find(
    (c) =>
      c.opts.minConfidence === DEFAULTS.minConfidence &&
      c.opts.minMatched === DEFAULTS.minMatched &&
      c.opts.ambiguityMargin === DEFAULTS.ambiguityMargin,
  );
  console.log(
    `\nRECOMMENDED: minConf=${best.opts.minConfidence} minMatched=${best.opts.minMatched} ` +
      `margin=${best.opts.ambiguityMargin} → acc=${(best.acc * 100).toFixed(1)}%  ` +
      `(current defaults acc=${dflt ? (dflt.acc * 100).toFixed(1) : '?'}%)`,
  );

  if (acc < BASELINE_ACC) {
    console.error(`\nBELOW BASELINE ${BASELINE_ACC} — failing.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
