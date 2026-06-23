import {
  buildInterviewQuestionBankSeeds,
  QUESTION_BANK_LOGICAL_COUNTS,
  QUESTION_BANK_TARGET_ROLES,
} from './interview-question-bank-seeds';

describe('interview question bank seeds', () => {
  it('builds exactly 60 logical questions per role and 600 language rows', () => {
    const seeds = buildInterviewQuestionBankSeeds();
    const keys = new Set(seeds.map((seed) => seed.questionKey));

    expect(QUESTION_BANK_TARGET_ROLES).toEqual([
      'backend_developer',
      'frontend_developer',
      'fullstack_developer',
      'devops_engineer',
      'qa_engineer',
    ]);
    expect(keys.size).toBe(QUESTION_BANK_TARGET_ROLES.length * 60);
    expect(seeds).toHaveLength(QUESTION_BANK_TARGET_ROLES.length * 60 * 2);
  });

  it('keeps each role at 10 common, 30 skill, 10 scenario, and 10 behavioral questions', () => {
    const seeds = buildInterviewQuestionBankSeeds();
    const logicalRows = Array.from(new Map(seeds.map((seed) => [seed.questionKey, seed])).values());

    for (const role of QUESTION_BANK_TARGET_ROLES) {
      const rows = logicalRows.filter((seed) => seed.targetRole === role);
      const common = rows.filter((seed) => seed.phase === 'SCREENING' || seed.phase === 'WRAP');
      const skill = rows.filter(
        (seed) => seed.phase === 'JD_REQUIREMENT' || seed.phase === 'SKILL_PROBE',
      );
      const scenario = rows.filter((seed) => seed.phase === 'SCENARIO');
      const behavioral = rows.filter((seed) => seed.phase === 'BEHAVIORAL');

      expect({
        role,
        common: common.length,
        skill: skill.length,
        scenario: scenario.length,
        behavioral: behavioral.length,
      }).toEqual({
        role,
        ...QUESTION_BANK_LOGICAL_COUNTS,
      });
    }
  });

  it('creates paired Vietnamese and English rows for every logical question', () => {
    const seeds = buildInterviewQuestionBankSeeds();
    const languagesByKey = new Map<string, Set<string>>();

    for (const seed of seeds) {
      if (!languagesByKey.has(seed.questionKey)) languagesByKey.set(seed.questionKey, new Set());
      languagesByKey.get(seed.questionKey)!.add(seed.language);
      expect(seed.questionText.trim()).toBeTruthy();
      expect(seed.expectedSignals.length).toBeGreaterThan(0);
      expect(seed.rubricDimensions).toEqual(
        expect.arrayContaining(['technical_depth', 'evidence_credibility', 'communication']),
      );
      expect(seed.sourceKind).toBe('authored_from_taxonomy');
      expect(seed.license).toBe('CC BY 4.0 + SkillBridge-authored');
      expect(seed.reviewStatus).toBe('draft');
    }

    for (const languages of languagesByKey.values()) {
      expect([...languages].sort()).toEqual(['en', 'vi']);
    }
  });
});
