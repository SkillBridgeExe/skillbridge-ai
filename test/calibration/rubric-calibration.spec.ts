import {
  evaluateRubricCaseResult,
  summarizeRubricCalibration,
  validateRubricStructure,
  RubricCalibrationCase,
} from '../../src/calibration/rubric-calibration';
import { RoleRubric } from '../../src/common/services/role-rubric.service';

describe('rubric calibration helpers', () => {
  const baseCase: RubricCalibrationCase = {
    id: 'case-1',
    target_role: 'frontend_developer',
    target_band: 'fresher',
    cv_skills: [{ name: 'React', proficiency_hint: 'INTERMEDIATE' }],
    expected_overall: [60, 80],
    expected_required_coverage: [0.5, 1],
    rationale: 'Synthetic test case',
  };

  it('marks a calibration case as passing when score and coverage are in band', () => {
    const result = evaluateRubricCaseResult(baseCase, {
      overall_score: 72,
      required_coverage: 0.75,
      requirements_source: 'role_rubric',
      unnormalized_cv_skills: [],
      scoring_breakdown: {
        matched_count: 4,
        partial_count: 1,
        missing_count: 2,
        total_requirements: 7,
      },
    });

    expect(result.pass).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails a case when source is not role_rubric or score is out of band', () => {
    const result = evaluateRubricCaseResult(baseCase, {
      overall_score: 91,
      required_coverage: 0.75,
      requirements_source: 'jd_extraction',
      unnormalized_cv_skills: [],
      scoring_breakdown: {
        matched_count: 4,
        partial_count: 1,
        missing_count: 2,
        total_requirements: 7,
      },
    });

    expect(result.pass).toBe(false);
    expect(result.errors).toContain('source=jd_extraction expected role_rubric');
    expect(result.errors).toContain('score=91 expected 60-80');
  });

  it('fails a case when CV skills do not normalize', () => {
    const result = evaluateRubricCaseResult(baseCase, {
      overall_score: 72,
      required_coverage: 0.75,
      requirements_source: 'role_rubric',
      unnormalized_cv_skills: [{ raw_input: 'mystery skill', reason: 'not_in_taxonomy' }],
      scoring_breakdown: {
        matched_count: 4,
        partial_count: 1,
        missing_count: 2,
        total_requirements: 7,
      },
    });

    expect(result.pass).toBe(false);
    expect(result.errors).toContain('unnormalized CV skills: mystery skill');
  });

  it('validates rubric structural invariants', () => {
    const rubric: RoleRubric = {
      role_code: 'frontend_developer',
      display_name_en: 'Frontend Developer',
      display_name_vi: 'Lập trình viên Frontend',
      description: 'Test rubric',
      skills: [
        { skill_canonical_name: 'react', required_level: 3, importance: 'REQUIRED', weight: 0.6 },
        {
          skill_canonical_name: 'typescript',
          required_level: 3,
          importance: 'REQUIRED',
          weight: 0.4,
        },
      ],
    };

    const errors = validateRubricStructure(
      [rubric],
      (canonical) => canonical === 'react' || canonical === 'typescript',
      ['frontend_developer'],
    );

    expect(errors).toEqual([]);
  });

  it('reports missing role coverage and invalid weights', () => {
    const rubric: RoleRubric = {
      role_code: 'backend_developer',
      display_name_en: 'Backend Developer',
      display_name_vi: 'Lập trình viên Backend',
      description: 'Test rubric',
      skills: [
        {
          skill_canonical_name: 'not_real',
          required_level: 6,
          importance: 'REQUIRED',
          weight: 0.2,
        },
      ],
    };

    const errors = validateRubricStructure([rubric], () => false, []);

    expect(errors).toEqual(
      expect.arrayContaining([
        'backend_developer weight_sum=0.200 expected 0.95-1.05',
        'backend_developer:not_real is not in taxonomy',
        'backend_developer:not_real required_level=6 outside 1-5',
        'backend_developer has no calibration case',
      ]),
    );
  });

  it('summarizes failed cases and role coverage', () => {
    const summary = summarizeRubricCalibration(
      [
        {
          id: 'a',
          role: 'frontend_developer',
          band: 'fresher',
          pass: true,
          score: 70,
          expected: [60, 80],
          errors: [],
        },
        {
          id: 'b',
          role: 'backend_developer',
          band: 'intern',
          pass: false,
          score: 20,
          expected: [40, 60],
          errors: ['score=20 expected 40-60'],
        },
      ],
      [],
    );

    expect(summary.pass).toBe(false);
    expect(summary.total).toBe(2);
    expect(summary.failed).toEqual(['b']);
    expect(summary.byRole.backend_developer.failed).toBe(1);
  });
});
