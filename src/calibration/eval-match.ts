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
  MATCH_TUNING_VERSION,
} from '../modules/cv-jd-match/skill-diff.service';
import { spearman } from './calibration-stats';

interface MatchPair {
  id: string;
  target_role: string;
  /** Seniority yardstick (rubric path). Omitted = 'mid' — every legacy pair unchanged. */
  target_band?: 'intern' | 'fresher' | 'mid';
  cv_skills: Array<{ name: string; proficiency_hint: string }>;
  jd_requirements?: Array<{ name: string; importance_hint?: string; required_level_hint?: string }>;
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
  const fixture = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    rubric_version?: string;
    match_tuning_version?: string;
    pairs: MatchPair[];
  };
  const { pairs } = fixture;
  const rubricFile = path.join(process.cwd(), 'data', 'role-rubrics-pilot.json');
  const rubricVersion = (JSON.parse(fs.readFileSync(rubricFile, 'utf-8')) as { version?: string })
    .version;

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

  if (fixture.rubric_version !== rubricVersion) {
    dataErrors.push(
      `  fixture rubric_version=${fixture.rubric_version ?? '<missing>'}, active=${rubricVersion ?? '<missing>'}`,
    );
  }
  if (fixture.match_tuning_version !== MATCH_TUNING_VERSION) {
    dataErrors.push(
      `  fixture match_tuning_version=${fixture.match_tuning_version ?? '<missing>'}, active=${MATCH_TUNING_VERSION}`,
    );
  }

  for (const pair of pairs) {
    const res: DiffResult = diffSvc.diff({
      cv_skills_raw: pair.cv_skills as RawCvSkill[],
      target_role: pair.target_role,
      ...(pair.jd_requirements ? { jd_requirements_raw: pair.jd_requirements } : {}),
      // Legacy pairs omit target_band → diff defaults to 'mid' (byte-identical history).
      ...(pair.target_band ? { target_band: pair.target_band } : {}),
    });
    if (res.overall_score === null || res.match_ratio === null) {
      throw new Error(
        `eval:match — unexpected null score for pair '${pair.id}' ` +
          `(requirements_source='${res.requirements_source}', ` +
          `degraded_reasons=[${res.degraded_reasons.join(', ')}]). A golden pair must always have a ` +
          `scorable requirement basis — check its target_role has a rubric or its jd_requirements normalize.`,
      );
    }
    const score = res.overall_score;
    const ok = inBand(score, pair.expected_overall);
    if (ok) inBandCount += 1;
    else
      outOfBand.push(
        `  ${pair.id.padEnd(26)} got ${score}, expected ${pair.expected_overall[0]}-${pair.expected_overall[1]}`,
      );
    predicted.push(score);
    expectedMid.push(mid(pair.expected_overall));

    // Required coverage is a first-class score guard: a formula can land in the broad overall
    // band while still treating mandatory requirements incorrectly.
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
    console.log(`req-coverage: ${covIn}/${covTotal} in expected band`);
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
  const strictFail =
    STRICT && (rate < BAND_BAR || rho < SPEARMAN_MIN || covOut.length > 0 || drift.length > 0);
  console.log(
    `\nVerdict: ${sanityFail ? 'FAIL ❌ (data sanity)' : strictFail ? 'FAIL ❌ (strict bars not met yet)' : 'PASS ✅'}${STRICT ? ' [strict]' : ''}\n`,
  );
  process.exit(sanityFail || strictFail ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval-match failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
