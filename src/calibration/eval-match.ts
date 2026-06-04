/**
 * R2 eval harness #2 — CV↔role MATCH-SCORE quality. Fully OFFLINE (no LLM, no DB): the pairs
 * supply cv_skills as raw names + proficiency hints, which flow through the real
 * SkillNormalizer → SkillDiffService, so this isolates the MATCHING MATH (not extraction).
 * This is the GATE for every match-formula change (blueprint §5 / step 5).
 *
 *   pnpm eval:match                      # report + data-sanity gate
 *   EVAL_MATCH_STRICT=1 pnpm eval:match  # ALSO enforce within-band ≥80% + Spearman ≥0.6
 *
 * data/eval-match-pairs.json pairs: { id, target_role, cv_skills[{name, proficiency_hint}],
 *   expected_overall:[min,max] (EXPERT band — what the score SHOULD be),
 *   expected_required_coverage?:[min,max], current_formula_score? (author's hand-computed
 *   baseline under the current formula — drift >2 pts is reported), rationale }
 *
 * Data sanity: every cv_skills name MUST normalize (unnormalized names would silently shrink
 * the CV and corrupt the measurement) — violations fail the run regardless of mode.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';
import { RoleRubricService } from '../common/services/role-rubric.service';
import {
  SkillDiffService,
  RawCvSkill,
  DiffResult,
} from '../modules/cv-jd-match/skill-diff.service';
import { spearman } from './calibration-stats';

interface MatchPair {
  id: string;
  target_role: string;
  cv_skills: Array<{ name: string; proficiency_hint: string }>;
  expected_overall: [number, number];
  expected_required_coverage?: [number, number];
  current_formula_score?: number;
  rationale: string;
}

const STRICT = process.env.EVAL_MATCH_STRICT === '1';
const BAND_BAR = Number(process.env.EVAL_MATCH_BAND ?? 0.8);
const SPEARMAN_MIN = Number(process.env.EVAL_MATCH_SPEARMAN ?? 0.6);

const inBand = (x: number, [lo, hi]: [number, number]): boolean => x >= lo && x <= hi;
const mid = ([lo, hi]: [number, number]): number => (lo + hi) / 2;

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-match-pairs.json');
  const { pairs } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { pairs: MatchPair[] };

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const normalizer = new SkillNormalizerService(taxonomy);
  const rubrics = new RoleRubricService();
  await rubrics.onModuleInit();
  const diffSvc = new SkillDiffService(normalizer, rubrics);

  console.log(`\nMatch-score eval — ${pairs.length} CV→role pairs (offline, 0 LLM calls)\n`);

  let inBandCount = 0;
  let covTotal = 0;
  let covIn = 0;
  const covOut: string[] = [];
  const predicted: number[] = [];
  const expectedMid: number[] = [];
  const dataErrors: string[] = [];
  const drift: string[] = [];
  const outOfBand: string[] = [];

  for (const pair of pairs) {
    const res: DiffResult = diffSvc.diff({
      cv_skills_raw: pair.cv_skills as RawCvSkill[],
      target_role: pair.target_role,
    });
    const score = res.overall_score;
    const ok = inBand(score, pair.expected_overall);
    if (ok) inBandCount += 1;
    else
      outOfBand.push(
        `  ${pair.id.padEnd(26)} got ${score}, expected ${pair.expected_overall[0]}-${pair.expected_overall[1]}`,
      );
    predicted.push(score);
    expectedMid.push(mid(pair.expected_overall));

    // required_coverage check (report-only — promotes to a strict bar once stable).
    if (pair.expected_required_coverage) {
      covTotal += 1;
      const [clo, chi] = pair.expected_required_coverage;
      if (res.required_coverage >= clo && res.required_coverage <= chi) covIn += 1;
      else covOut.push(`  ${pair.id}: coverage ${res.required_coverage}, expected ${clo}-${chi}`);
    }

    if (res.unnormalized_cv_skills.length > 0) {
      dataErrors.push(
        `  ${pair.id}: unnormalized cv_skills [${res.unnormalized_cv_skills.map((u) => u.raw_input).join(', ')}]`,
      );
    }
    if (
      typeof pair.current_formula_score === 'number' &&
      Math.abs(pair.current_formula_score - score) > 2
    ) {
      drift.push(
        `  ${pair.id}: author hand-computed ${pair.current_formula_score}, formula returned ${score}`,
      );
    }

    const b = res.scoring_breakdown;
    console.log(
      `${pair.id.padEnd(26)} role=${pair.target_role.padEnd(20)} score=${String(score).padStart(3)}  band=${pair.expected_overall[0]}-${pair.expected_overall[1]} ${ok ? 'OK ' : 'OUT'}  match=${b.matched_count}/${b.total_requirements} partial=${b.partial_count} miss=${b.missing_count}`,
    );
  }

  const rate = pairs.length === 0 ? 0 : inBandCount / pairs.length;
  const rho = spearman(predicted, expectedMid);

  console.log('\n=== Summary ===');
  console.log(
    `within-band : ${inBandCount}/${pairs.length} (${Math.round(rate * 100)}%)  [strict bar ${Math.round(BAND_BAR * 100)}%]`,
  );
  console.log(`Spearman    : ${rho}  [strict min ${SPEARMAN_MIN}]`);
  if (covTotal > 0) {
    console.log(`req-coverage: ${covIn}/${covTotal} in expected band (report-only)`);
    if (covOut.length) console.log(`Coverage out-of-band:\n${covOut.join('\n')}`);
  }
  if (outOfBand.length) console.log(`Out-of-band:\n${outOfBand.join('\n')}`);
  if (drift.length)
    console.log(
      `Hand-computed vs formula drift (>2 pts — check author math or formula change):\n${drift.join('\n')}`,
    );
  if (dataErrors.length)
    console.log(`DATA ERRORS (must fix — corrupt measurement):\n${dataErrors.join('\n')}`);

  const sanityFail = dataErrors.length > 0;
  const strictFail = STRICT && (rate < BAND_BAR || rho < SPEARMAN_MIN);
  console.log(
    `\nVerdict: ${sanityFail ? 'FAIL ❌ (data sanity)' : strictFail ? 'FAIL ❌ (strict bars not met yet)' : 'PASS ✅'}${STRICT ? ' [strict]' : ''}\n`,
  );
  process.exit(sanityFail || strictFail ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval-match failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
