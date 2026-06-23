import { InterviewType } from '../../database/entities/interview-session.entity';
import { InterviewFocusArea } from './interview-planner';
import { InterviewPhase } from './interview-agenda';
import { Dimension } from './interview-scoring';

export interface InterviewQuestionBankCandidate {
  id: string;
  questionKey: string;
  language: 'vi' | 'en';
  targetRole: string;
  interviewType: InterviewType;
  phase: InterviewPhase;
  skillCanonical: string | null;
  focusType: InterviewFocusArea['focus_type'] | null;
  seniority: string | null;
  difficulty: number;
  questionText: string;
  expectedSignals: string[];
  rubricDimensions: Dimension[];
  sourceKind: string;
  sourceUrl: string | null;
  sourceBasis: string;
  license: string;
  attribution: string | null;
  reviewStatus: string;
  priority: number;
  active: boolean;
}

export interface InterviewQuestionSelectionCriteria {
  language: 'vi' | 'en';
  targetRole: string;
  interviewType: InterviewType;
  phase: InterviewPhase;
  skillCanonical?: string | null;
  focusType?: InterviewFocusArea['focus_type'] | null;
  seniority?: string | null;
}

export interface VoiceQuestionAnchorCriteria {
  language: 'vi' | 'en';
  targetRole: string;
  interviewType: InterviewType;
  seniority?: string | null;
  limit?: number;
}

const PHASE_ORDER: Record<InterviewPhase, number> = {
  SCREENING: 1,
  JD_REQUIREMENT: 2,
  SKILL_PROBE: 3,
  SCENARIO: 4,
  BEHAVIORAL: 5,
  WRAP: 6,
};

export function selectInterviewQuestion(
  candidates: InterviewQuestionBankCandidate[],
  criteria: InterviewQuestionSelectionCriteria,
): InterviewQuestionBankCandidate | null {
  const targetRole = normalizeQuestionBankTargetRole(criteria.targetRole);
  const skill = criteria.skillCanonical?.trim() || null;
  const focusType = criteria.focusType ?? null;
  const seniority = criteria.seniority?.trim().toLowerCase() || null;

  const matches = candidates
    .filter((candidate) =>
      baseMatches(candidate, criteria.language, targetRole, criteria.interviewType),
    )
    .filter((candidate) => candidate.phase === criteria.phase)
    .filter(
      (candidate) =>
        !skill || candidate.skillCanonical === skill || candidate.skillCanonical === null,
    )
    .filter(
      (candidate) =>
        !focusType || candidate.focusType === focusType || candidate.focusType === null,
    )
    .filter(
      (candidate) =>
        !seniority ||
        candidate.seniority === null ||
        candidate.seniority.trim().toLowerCase() === seniority,
    )
    .sort((a, b) => {
      const scoreDiff =
        scoreCandidate(b, skill, focusType, seniority) -
        scoreCandidate(a, skill, focusType, seniority);
      if (scoreDiff !== 0) return scoreDiff;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.questionKey.localeCompare(b.questionKey);
    });

  return matches[0] ?? null;
}

export function selectVoiceQuestionAnchors(
  candidates: InterviewQuestionBankCandidate[],
  criteria: VoiceQuestionAnchorCriteria,
): InterviewQuestionBankCandidate[] {
  const targetRole = normalizeQuestionBankTargetRole(criteria.targetRole);
  const seniority = criteria.seniority?.trim().toLowerCase() || null;
  const limit = Math.max(1, Math.floor(criteria.limit ?? 5));

  return candidates
    .filter((candidate) =>
      baseMatches(candidate, criteria.language, targetRole, criteria.interviewType),
    )
    .filter(
      (candidate) =>
        !seniority ||
        candidate.seniority === null ||
        candidate.seniority.trim().toLowerCase() === seniority,
    )
    .sort((a, b) => {
      const phaseDiff = PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase];
      if (phaseDiff !== 0) return phaseDiff;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.questionKey.localeCompare(b.questionKey);
    })
    .slice(0, limit);
}

export function normalizeQuestionBankTargetRole(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (
    normalized === 'backend_developer' ||
    normalized === 'frontend_developer' ||
    normalized === 'fullstack_developer' ||
    normalized === 'devops_engineer' ||
    normalized === 'qa_engineer'
  ) {
    return normalized;
  }

  const loose = normalized.replace(/_/g, ' ');
  if (/\b(fullstack|full stack|full-stack)\b/.test(loose)) return 'fullstack_developer';
  if (/\b(frontend|front end|front-end)\b/.test(loose)) return 'frontend_developer';
  if (/\b(devops|sre|platform|infra|infrastructure)\b/.test(loose)) return 'devops_engineer';
  if (/\b(qa|quality|tester|testing|sdet)\b/.test(loose)) return 'qa_engineer';
  if (/\b(backend|back end|back-end|api|server)\b/.test(loose)) return 'backend_developer';
  return normalized;
}

function baseMatches(
  candidate: InterviewQuestionBankCandidate,
  language: 'vi' | 'en',
  targetRole: string,
  interviewType: InterviewType,
): boolean {
  return (
    candidate.active &&
    candidate.language === language &&
    normalizeQuestionBankTargetRole(candidate.targetRole) === targetRole &&
    interviewTypeMatches(candidate.interviewType, interviewType)
  );
}

function interviewTypeMatches(candidate: InterviewType, requested: InterviewType): boolean {
  return candidate === requested || candidate === 'MIXED' || requested === 'MIXED';
}

function scoreCandidate(
  candidate: InterviewQuestionBankCandidate,
  skill: string | null,
  focusType: InterviewFocusArea['focus_type'] | null,
  seniority: string | null,
): number {
  let score = 0;
  if (skill && candidate.skillCanonical === skill) score += 60;
  if (!skill && candidate.skillCanonical === null) score += 20;
  if (focusType && candidate.focusType === focusType) score += 20;
  if (!focusType && candidate.focusType === null) score += 10;
  if (seniority && candidate.seniority?.trim().toLowerCase() === seniority) score += 10;
  if (candidate.seniority === null) score += 2;
  return score;
}
