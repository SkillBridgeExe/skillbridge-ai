import {
  buildInterviewQuestionBankSeeds,
  QUESTION_BANK_LOGICAL_COUNTS,
  QUESTION_BANK_TARGET_ROLES,
} from './interview-question-bank-seeds';
import { selectInterviewQuestion } from '../modules/interview/interview-question-bank';

describe('interview question bank seeds', () => {
  it('builds exactly 63 logical questions per role (60 generated + 3 authored) and 1008 rows', () => {
    const seeds = buildInterviewQuestionBankSeeds();
    const keys = new Set(seeds.map((seed) => seed.questionKey));

    expect(QUESTION_BANK_TARGET_ROLES).toEqual([
      'backend_developer',
      'frontend_developer',
      'fullstack_developer',
      'mobile_developer',
      'devops_engineer',
      'data_analyst',
      'qa_engineer',
      'ai_ml_engineer',
    ]);
    expect(keys.size).toBe(QUESTION_BANK_TARGET_ROLES.length * 63);
    expect(seeds).toHaveLength(QUESTION_BANK_TARGET_ROLES.length * 63 * 2);
  });

  it('keeps each role at 10 common, 32 skill, 11 scenario, and 10 behavioral questions', () => {
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

describe('hand-authored scenario layer (P2 Interview Intelligence)', () => {
  it('ships one debug incident, one trade-off, and one mini design per role, in both languages', () => {
    const seeds = buildInterviewQuestionBankSeeds();
    for (const role of QUESTION_BANK_TARGET_ROLES) {
      const authored = seeds.filter(
        (seed) => seed.targetRole === role && seed.questionKey.includes('.authored.'),
      );
      expect(authored).toHaveLength(6); // 3 logical × vi+en
      const kinds = new Set(authored.map((seed) => seed.questionKey.split('.')[2]));
      expect([...kinds].sort()).toEqual(['debug_incident', 'mini_design', 'tradeoff']);
      for (const seed of authored) {
        // real situations, not one-line templates — must carry concrete constraints.
        expect(seed.questionText.length).toBeGreaterThan(80);
        expect(seed.priority).toBeGreaterThanOrEqual(1400);
      }
    }
  });

  it('always beats the generated template inside its phase (selection picks authored first)', () => {
    const candidates = buildInterviewQuestionBankSeeds().map((seed) => ({
      ...seed,
      id: `seed:${seed.questionKey}:${seed.language}`,
    }));
    const picked = selectInterviewQuestion(candidates, {
      language: 'en',
      targetRole: 'backend_developer',
      interviewType: 'TECHNICAL',
      phase: 'SCENARIO',
    });
    expect(picked?.questionKey).toBe('backend_developer.authored.debug_incident.01');
  });
});
