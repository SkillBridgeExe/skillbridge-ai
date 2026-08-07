import {
  aggregateInterviewScore,
  calibrateInterviewAnswerScore,
  calibrateInterviewAnswerScores,
  criterionKeysForDimension,
  INTERVIEW_CRITERION_KEYS,
  InterviewCriterionScore,
} from '../../../src/modules/interview/interview-scoring';

const criteria = (
  dimension: Parameters<typeof criterionKeysForDimension>[0],
  score: number,
  overrides: Partial<Record<(typeof INTERVIEW_CRITERION_KEYS)[number], number>> = {},
): InterviewCriterionScore[] =>
  criterionKeysForDimension(dimension).map((key) => ({
    key,
    score: overrides[key] ?? score,
    evidence: `Evidence for ${key}`,
  }));

describe('calibrateInterviewAnswerScore', () => {
  it('uses the dimension rubric and rewards a strong, well-evidenced answer', () => {
    const result = calibrateInterviewAnswerScore({
      dimension: 'technical_depth',
      criteria: criteria('technical_depth', 4),
      depthSignal: 'deep',
      offTopic: false,
      claimStatus: 'ok',
    });

    expect(result.source).toBe('criterion_rubric');
    expect(result.criteriaCoverage).toBe('complete');
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('is monotonic: a correct answer scores above a shallow partial answer', () => {
    const strong = calibrateInterviewAnswerScore({
      dimension: 'technical_depth',
      criteria: criteria('technical_depth', 4),
      depthSignal: 'deep',
      offTopic: false,
      claimStatus: 'ok',
    });
    const partial = calibrateInterviewAnswerScore({
      dimension: 'technical_depth',
      criteria: criteria('technical_depth', 2),
      depthSignal: 'shallow',
      offTopic: false,
      claimStatus: 'partial',
    });

    expect(strong.score).toBeGreaterThan(partial.score!);
  });

  it('caps an off-topic answer even when the model rated the criteria highly', () => {
    const result = calibrateInterviewAnswerScore({
      dimension: 'problem_solving',
      criteria: criteria('problem_solving', 4),
      depthSignal: 'deep',
      offTopic: true,
      claimStatus: 'ok',
    });

    expect(result.score).toBe(40);
    expect(result.reasons).toContain('score_capped_off_topic');
  });

  it('does not invent a default score when criterion output is incomplete', () => {
    const [first] = criteria('communication', 3);
    const result = calibrateInterviewAnswerScore({
      dimension: 'communication',
      criteria: [first],
      depthSignal: 'adequate',
      offTopic: false,
      claimStatus: 'partial',
    });

    expect(result.score).toBeNull();
    expect(result.source).toBe('unscored');
    expect(result.criteriaCoverage).toBe('partial');
    expect(result.missingCriteria.length).toBeGreaterThan(0);
  });

  it('keeps old sessions explainable with an explicit legacy fallback', () => {
    const result = calibrateInterviewAnswerScore({
      dimension: 'technical_depth',
      criteria: [],
      legacyScore: 60,
      depthSignal: 'adequate',
      offTopic: false,
      claimStatus: 'ok',
    });

    expect(result).toMatchObject({
      score: 60,
      source: 'legacy_llm',
      criteriaCoverage: 'missing',
    });
    expect(result.confidence).toBe('low');
  });

  it('never allows a wrong claim to present as a strong result', () => {
    const result = calibrateInterviewAnswerScore({
      dimension: 'evidence_credibility',
      criteria: criteria('evidence_credibility', 4),
      depthSignal: 'deep',
      offTopic: false,
      claimStatus: 'wrong',
    });

    expect(result.score).toBeLessThanOrEqual(40);
    expect(result.reasons).toContain('score_capped_wrong_claim');
  });
});

describe('multi-dimension interview scoring', () => {
  it('keeps technical depth and evidence credibility independent for one skill probe', () => {
    const scoreAssessments = calibrateInterviewAnswerScores({
      dimensions: ['technical_depth', 'evidence_credibility'],
      criteria: [...criteria('technical_depth', 4), ...criteria('evidence_credibility', 2)],
      depthSignal: 'deep',
      offTopic: false,
      claimStatus: 'ok',
    });

    expect(scoreAssessments.technical_depth?.score).toBe(100);
    expect(scoreAssessments.evidence_credibility?.score).toBe(50);

    const score = aggregateInterviewScore({
      answers: [
        {
          topic_phase: 'SKILL_PROBE',
          score: 100,
          depth_signal: 'deep',
          dimension_scores: {
            technical_depth: scoreAssessments.technical_depth?.score,
            evidence_credibility: scoreAssessments.evidence_credibility?.score,
          },
          dimension_score_sources: {
            technical_depth: scoreAssessments.technical_depth?.source,
            evidence_credibility: scoreAssessments.evidence_credibility?.source,
          },
        },
      ],
      role: 'backend_developer',
      seniority: 'senior',
    });

    expect(score.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: 'technical_depth', score: 100 }),
        expect.objectContaining({ dimension: 'evidence_credibility', score: 50 }),
      ]),
    );
    expect(score.overall).toBe(86);
  });
});
