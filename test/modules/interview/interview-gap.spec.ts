import {
  coerceInterviewGapItems,
  groundInterviewGaps,
  InterviewGapItem,
} from '../../../src/modules/interview/interview-gap';

describe('coerceInterviewGapItems', () => {
  it('returns [] for non-array and garbage input', () => {
    expect(coerceInterviewGapItems(undefined)).toEqual([]);
    expect(coerceInterviewGapItems(null)).toEqual([]);
    expect(coerceInterviewGapItems('nope')).toEqual([]);
    expect(coerceInterviewGapItems([1, 'x', null])).toEqual([]);
  });

  it('parses a valid skill-anchored item', () => {
    const out = coerceInterviewGapItems([
      {
        target_type: 'skill',
        skill_canonical: 'React',
        display_name: 'React',
        weakness_type: 'knowledge_gap',
        severity: 0.7,
        evidence_from_answer: 'Could not explain reconciliation.',
        recommended_action: 'Review React rendering.',
        linked_question_id: '3',
      },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      target_type: 'skill',
      skill_canonical: 'react',
      display_name: 'React',
      weakness_type: 'knowledge_gap',
      severity: 0.7,
      requirement_id: null,
      linked_question_id: '3',
    });
  });

  it('drops invalid weakness types and empty labels', () => {
    expect(
      coerceInterviewGapItems([
        { weakness_type: 'bogus', display_name: 'X' },
        { weakness_type: 'knowledge_gap', display_name: '   ' },
      ]),
    ).toEqual([]);
  });

  it('forces skill_canonical to null for non-skill targets', () => {
    const out = coerceInterviewGapItems([
      {
        target_type: 'communication',
        skill_canonical: 'should_be_dropped',
        display_name: 'STAR structure',
        weakness_type: 'communication_gap',
        severity: 0.5,
      },
    ]);

    expect(out[0].skill_canonical).toBeNull();
  });

  it('infers target_type from weakness_type when target_type is missing or invalid', () => {
    const out = coerceInterviewGapItems([
      { weakness_type: 'role_fit_risk', display_name: 'Seniority below JD' },
    ]);

    expect(out[0].target_type).toBe('role_fit');
  });

  it('clamps severity to [0,1] and defaults to 0.5 when non-numeric', () => {
    const out = coerceInterviewGapItems([
      { weakness_type: 'behavioral_gap', display_name: 'A', severity: 9 },
      { weakness_type: 'behavioral_gap', display_name: 'B', severity: -2 },
      { weakness_type: 'behavioral_gap', display_name: 'C', severity: 'x' },
    ]);

    expect(out.map((item) => item.severity)).toEqual([1, 0, 0.5]);
  });

  it('truncates evidence to 280 chars and masks email/phone PII', () => {
    const long = 'a'.repeat(400);
    const out = coerceInterviewGapItems([
      {
        weakness_type: 'evidence_gap',
        target_type: 'evidence',
        display_name: 'Proof',
        evidence_from_answer: `mail me at john@acme.com or 0912345678 ${long}`,
      },
    ]);

    expect(out[0].evidence_from_answer.length).toBeLessThanOrEqual(280);
    expect(out[0].evidence_from_answer).toContain('[redacted-email]');
    expect(out[0].evidence_from_answer).toContain('[redacted-phone]');
  });
});

describe('groundInterviewGaps', () => {
  const item = (over: Partial<InterviewGapItem>): InterviewGapItem => ({
    requirement_id: null,
    target_type: 'skill',
    skill_canonical: 'react',
    display_name: 'React',
    weakness_type: 'knowledge_gap',
    severity: 0.6,
    evidence_from_answer: 'thin on hooks',
    recommended_action: '',
    linked_question_id: '2',
    ...over,
  });

  it('drops a gap with no linked turn or empty evidence', () => {
    expect(groundInterviewGaps([item({ linked_question_id: null })], new Set(['react']))).toEqual(
      [],
    );
    expect(groundInterviewGaps([item({ evidence_from_answer: '   ' })], new Set(['react']))).toEqual(
      [],
    );
  });

  it('drops a skill-anchored gap whose skill was not probed', () => {
    expect(groundInterviewGaps([item({ skill_canonical: 'graphql' })], new Set(['react']))).toEqual(
      [],
    );
  });

  it('keeps a cited skill gap that was probed', () => {
    expect(groundInterviewGaps([item({})], new Set(['react']))).toHaveLength(1);
  });

  it('keeps cited non-skill gaps regardless of the skill set', () => {
    const out = groundInterviewGaps(
      [
        item({
          target_type: 'communication',
          skill_canonical: null,
          weakness_type: 'communication_gap',
        }),
      ],
      new Set(['react']),
    );

    expect(out).toHaveLength(1);
  });

  it('skips the skill-set check when no probed-skill set is available', () => {
    expect(groundInterviewGaps([item({ skill_canonical: 'anything' })], null)).toHaveLength(1);
    expect(groundInterviewGaps([item({ linked_question_id: null })], null)).toEqual([]);
  });
});
