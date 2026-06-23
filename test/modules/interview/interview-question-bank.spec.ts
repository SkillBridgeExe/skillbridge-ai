import {
  InterviewQuestionBankCandidate,
  selectInterviewQuestion,
  selectVoiceQuestionAnchors,
} from '../../../src/modules/interview/interview-question-bank';

const item = (
  over: Partial<InterviewQuestionBankCandidate> = {},
): InterviewQuestionBankCandidate => ({
  id: 'item-1',
  questionKey: 'backend-skill-1',
  language: 'vi',
  targetRole: 'backend_developer',
  interviewType: 'TECHNICAL',
  phase: 'JD_REQUIREMENT',
  skillCanonical: 'rest_api',
  focusType: 'gap_probe',
  seniority: 'junior',
  difficulty: 2,
  questionText: 'Bạn thiết kế REST API như thế nào?',
  expectedSignals: ['specific_project', 'error_handling'],
  rubricDimensions: ['technical_depth', 'evidence_credibility', 'communication'],
  sourceKind: 'authored_from_taxonomy',
  sourceUrl: 'https://www.onetcenter.org/database.html',
  sourceBasis: 'O*NET/ESCO role-skill-task mapping plus SkillBridge role rubric.',
  license: 'CC BY 4.0 + SkillBridge-authored',
  attribution: 'O*NET Resource Center; ESCO; SkillBridge authored wording.',
  reviewStatus: 'draft',
  priority: 10,
  active: true,
  ...over,
});

describe('selectInterviewQuestion', () => {
  it('chooses an active exact role/language/phase/skill match with the highest priority', () => {
    const selected = selectInterviewQuestion(
      [
        item({ id: 'inactive', active: false, priority: 100 }),
        item({ id: 'wrong-language', language: 'en', priority: 90 }),
        item({ id: 'generic', skillCanonical: null, priority: 20 }),
        item({ id: 'best', questionKey: 'backend-rest-api-best', priority: 30 }),
      ],
      {
        language: 'vi',
        targetRole: 'backend_developer',
        interviewType: 'TECHNICAL',
        phase: 'JD_REQUIREMENT',
        skillCanonical: 'rest_api',
        focusType: 'gap_probe',
        seniority: 'junior',
      },
    );

    expect(selected).toMatchObject({
      id: 'best',
      questionKey: 'backend-rest-api-best',
      questionText: 'Bạn thiết kế REST API như thế nào?',
    });
  });

  it('falls back to a generic skill question when the specific skill is not covered', () => {
    const selected = selectInterviewQuestion(
      [
        item({ id: 'wrong-skill', skillCanonical: 'postgresql', priority: 40 }),
        item({ id: 'generic', skillCanonical: null, priority: 10 }),
      ],
      {
        language: 'vi',
        targetRole: 'backend_developer',
        interviewType: 'TECHNICAL',
        phase: 'JD_REQUIREMENT',
        skillCanonical: 'graphql',
        focusType: 'gap_probe',
        seniority: 'junior',
      },
    );

    expect(selected?.id).toBe('generic');
  });

  it('returns null when no active row matches role, language, and phase', () => {
    expect(
      selectInterviewQuestion([item({ targetRole: 'frontend_developer' })], {
        language: 'vi',
        targetRole: 'backend_developer',
        interviewType: 'TECHNICAL',
        phase: 'JD_REQUIREMENT',
        skillCanonical: 'rest_api',
        focusType: 'gap_probe',
        seniority: 'junior',
      }),
    ).toBeNull();
  });
});

describe('selectVoiceQuestionAnchors', () => {
  it('returns prioritized concise anchors for live voice mode', () => {
    const anchors = selectVoiceQuestionAnchors(
      [
        item({ id: 'screening', phase: 'SCREENING', questionText: 'Giới thiệu dự án gần nhất?' }),
        item({ id: 'skill', phase: 'JD_REQUIREMENT', questionText: 'Bạn debug API ra sao?' }),
        item({ id: 'scenario', phase: 'SCENARIO', questionText: 'Nếu production chậm thì sao?' }),
      ],
      {
        language: 'vi',
        targetRole: 'backend_developer',
        interviewType: 'TECHNICAL',
        seniority: 'junior',
        limit: 2,
      },
    );

    expect(anchors).toEqual([
      expect.objectContaining({ id: 'screening', questionText: 'Giới thiệu dự án gần nhất?' }),
      expect.objectContaining({ id: 'skill', questionText: 'Bạn debug API ra sao?' }),
    ]);
  });
});
