import { buildApplicationMatchExplanation } from './application-match-explanation';

describe('buildApplicationMatchExplanation', () => {
  it('normalizes a ready persisted skill-diff result for business UI consumption', () => {
    const explanation = buildApplicationMatchExplanation({
      matchStatus: 'READY',
      matchScore: '87.50',
      matchScoringVersion: 'skill-diff-v2',
      matchErrorCode: null,
      matchResult: {
        score_basis: 'skills_only',
        requirements_source: 'jd_extraction',
        required_coverage: 0.75,
        matched_skills: [
          {
            canonical_name: 'react',
            display_name: 'React',
            importance: 'REQUIRED',
            cv_level: 4,
            required_level: 3,
          },
        ],
        partial_skills: [
          {
            canonical_name: 'typescript',
            display_name: 'TypeScript',
            importance: 'REQUIRED',
            cv_level: 2,
            required_level: 4,
          },
        ],
        missing_skills: [
          {
            canonical_name: 'testing',
            display_name: 'Testing',
            importance: 'PREFERRED',
            required_level: 3,
          },
        ],
      },
    });

    expect(explanation).toEqual({
      status: 'READY',
      score: 87.5,
      scoringVersion: 'skill-diff-v2',
      scoreBasis: 'skills_only',
      requirementsSource: 'jd_extraction',
      requiredCoverage: 0.75,
      errorCode: null,
      matchedSkills: [
        {
          canonicalName: 'react',
          displayName: 'React',
          importance: 'REQUIRED',
          cvLevel: 4,
          requiredLevel: 3,
        },
      ],
      partialSkills: [
        {
          canonicalName: 'typescript',
          displayName: 'TypeScript',
          importance: 'REQUIRED',
          cvLevel: 2,
          requiredLevel: 4,
        },
      ],
      missingSkills: [
        {
          canonicalName: 'testing',
          displayName: 'Testing',
          importance: 'PREFERRED',
          cvLevel: null,
          requiredLevel: 3,
        },
      ],
    });
  });

  it('returns an honest failed state when the stored result is malformed', () => {
    const explanation = buildApplicationMatchExplanation({
      matchStatus: 'FAILED',
      matchScore: null,
      matchScoringVersion: null,
      matchErrorCode: 'MATCH_COMPUTATION_FAILED',
      matchResult: {
        matched_skills: 'invalid',
        partial_skills: [{ display_name: 12 }],
        missing_skills: null,
        required_coverage: 'unknown',
      },
    });

    expect(explanation).toEqual({
      status: 'FAILED',
      score: null,
      scoringVersion: null,
      scoreBasis: null,
      requirementsSource: null,
      requiredCoverage: null,
      errorCode: 'MATCH_COMPUTATION_FAILED',
      matchedSkills: [],
      partialSkills: [],
      missingSkills: [],
    });
  });
});
