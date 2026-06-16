import { RoleRubric, RubricBand } from '../common/services/role-rubric.service';
import { RawCvSkill, UnnormalizedSkill } from '../modules/cv-jd-match/skill-diff.service';

export interface RubricCalibrationCase {
  id: string;
  target_role: string;
  target_band: RubricBand;
  cv_skills: RawCvSkill[];
  expected_overall: [number, number];
  expected_required_coverage?: [number, number];
  rationale: string;
}

export interface RubricCaseDiffLike {
  overall_score: number;
  required_coverage: number;
  requirements_source: 'jd_extraction' | 'role_rubric' | 'none';
  unnormalized_cv_skills: UnnormalizedSkill[];
  scoring_breakdown: {
    matched_count: number;
    partial_count: number;
    missing_count: number;
    total_requirements: number;
  };
}

export interface RubricCalibrationResult {
  id: string;
  role: string;
  band: RubricBand;
  pass: boolean;
  score: number;
  expected: [number, number];
  requiredCoverage?: number;
  expectedRequiredCoverage?: [number, number];
  matched?: number;
  partial?: number;
  missing?: number;
  totalRequirements?: number;
  errors: string[];
}

export interface RubricCalibrationSummary {
  pass: boolean;
  total: number;
  passed: number;
  failed: string[];
  structuralErrors: string[];
  byRole: Record<string, { total: number; passed: number; failed: number }>;
}

export function evaluateRubricCaseResult(
  testCase: RubricCalibrationCase,
  diff: RubricCaseDiffLike,
): RubricCalibrationResult {
  const errors: string[] = [];

  if (diff.requirements_source !== 'role_rubric') {
    errors.push(`source=${diff.requirements_source} expected role_rubric`);
  }

  if (!inBand(diff.overall_score, testCase.expected_overall)) {
    errors.push(
      `score=${diff.overall_score} expected ${testCase.expected_overall[0]}-${testCase.expected_overall[1]}`,
    );
  }

  if (
    testCase.expected_required_coverage &&
    !inBand(diff.required_coverage, testCase.expected_required_coverage)
  ) {
    errors.push(
      `required_coverage=${diff.required_coverage} expected ${testCase.expected_required_coverage[0]}-${testCase.expected_required_coverage[1]}`,
    );
  }

  if (diff.unnormalized_cv_skills.length > 0) {
    errors.push(
      `unnormalized CV skills: ${diff.unnormalized_cv_skills.map((s) => s.raw_input).join(', ')}`,
    );
  }

  return {
    id: testCase.id,
    role: testCase.target_role,
    band: testCase.target_band,
    pass: errors.length === 0,
    score: diff.overall_score,
    expected: testCase.expected_overall,
    requiredCoverage: diff.required_coverage,
    expectedRequiredCoverage: testCase.expected_required_coverage,
    matched: diff.scoring_breakdown.matched_count,
    partial: diff.scoring_breakdown.partial_count,
    missing: diff.scoring_breakdown.missing_count,
    totalRequirements: diff.scoring_breakdown.total_requirements,
    errors,
  };
}

export function validateRubricStructure(
  rubrics: RoleRubric[],
  hasCanonicalSkill: (canonical: string) => boolean,
  calibratedRoleCodes: string[],
): string[] {
  const errors: string[] = [];
  const calibrated = new Set(calibratedRoleCodes);

  for (const rubric of rubrics) {
    const weightSum = rubric.skills.reduce((sum, skill) => sum + skill.weight, 0);
    if (weightSum < 0.95 || weightSum > 1.05) {
      errors.push(
        `${rubric.role_code} weight_sum=${round3(weightSum).toFixed(3)} expected 0.95-1.05`,
      );
    }

    if (!calibrated.has(rubric.role_code)) {
      errors.push(`${rubric.role_code} has no calibration case`);
    }

    for (const skill of rubric.skills) {
      if (!hasCanonicalSkill(skill.skill_canonical_name)) {
        errors.push(`${rubric.role_code}:${skill.skill_canonical_name} is not in taxonomy`);
      }
      if (skill.required_level < 1 || skill.required_level > 5) {
        errors.push(
          `${rubric.role_code}:${skill.skill_canonical_name} required_level=${skill.required_level} outside 1-5`,
        );
      }
      for (const member of skill.any_of ?? []) {
        if (!hasCanonicalSkill(member)) {
          errors.push(
            `${rubric.role_code}:${skill.skill_canonical_name} any_of member ${member} is not in taxonomy`,
          );
        }
      }
    }
  }

  return errors;
}

export function summarizeRubricCalibration(
  results: RubricCalibrationResult[],
  structuralErrors: string[],
): RubricCalibrationSummary {
  const byRole: RubricCalibrationSummary['byRole'] = {};
  for (const result of results) {
    byRole[result.role] ??= { total: 0, passed: 0, failed: 0 };
    byRole[result.role].total += 1;
    if (result.pass) byRole[result.role].passed += 1;
    else byRole[result.role].failed += 1;
  }

  const failed = results.filter((result) => !result.pass).map((result) => result.id);
  return {
    pass: failed.length === 0 && structuralErrors.length === 0,
    total: results.length,
    passed: results.length - failed.length,
    failed,
    structuralErrors,
    byRole,
  };
}

function inBand(value: number, [low, high]: [number, number]): boolean {
  return value >= low && value <= high;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
