import { maskPii } from '../../common/services/pii-mask';

export type InterviewGapTargetType =
  | 'skill'
  | 'evidence'
  | 'communication'
  | 'behavioral'
  | 'role_fit';

export type InterviewGapWeaknessType =
  | 'knowledge_gap'
  | 'evidence_gap'
  | 'communication_gap'
  | 'behavioral_gap'
  | 'role_fit_risk';

export interface InterviewGapItem {
  requirement_id: string | null;
  target_type: InterviewGapTargetType;
  skill_canonical: string | null;
  display_name: string;
  weakness_type: InterviewGapWeaknessType;
  severity: number;
  evidence_from_answer: string;
  recommended_action: string;
  linked_question_id: string | null;
}

export interface InterviewGapReport {
  session_id: string;
  match_id: string | null;
  interviewer_summary: string;
  gap_items: InterviewGapItem[];
}

const EVIDENCE_MAX = 280;

const WEAKNESS_TO_TARGET: Record<InterviewGapWeaknessType, InterviewGapTargetType> = {
  knowledge_gap: 'skill',
  evidence_gap: 'evidence',
  communication_gap: 'communication',
  behavioral_gap: 'behavioral',
  role_fit_risk: 'role_fit',
};

const TARGET_TYPES = new Set<InterviewGapTargetType>([
  'skill',
  'evidence',
  'communication',
  'behavioral',
  'role_fit',
]);

const asStr = (value: unknown): string => (typeof value === 'string' ? value : '');

const isWeakness = (value: unknown): value is InterviewGapWeaknessType =>
  typeof value === 'string' && value in WEAKNESS_TO_TARGET;

const clamp01 = (value: unknown): number => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0, Math.min(1, number));
};

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

export function coerceInterviewGapItems(raw: unknown): InterviewGapItem[] {
  if (!Array.isArray(raw)) return [];
  const out: InterviewGapItem[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (!isWeakness(item.weakness_type)) continue;

    const displayName = asStr(item.display_name).trim();
    if (!displayName) continue;

    const target =
      typeof item.target_type === 'string' &&
      TARGET_TYPES.has(item.target_type as InterviewGapTargetType)
        ? (item.target_type as InterviewGapTargetType)
        : WEAKNESS_TO_TARGET[item.weakness_type];
    const skillAnchored = target === 'skill' || target === 'evidence';
    const skill = asStr(item.skill_canonical).trim();

    out.push({
      requirement_id: typeof item.requirement_id === 'string' ? item.requirement_id : null,
      target_type: target,
      skill_canonical: skillAnchored && skill ? skill.toLowerCase() : null,
      display_name: displayName,
      weakness_type: item.weakness_type,
      severity: clamp01(item.severity),
      evidence_from_answer: truncate(maskPii(asStr(item.evidence_from_answer)), EVIDENCE_MAX),
      recommended_action: asStr(item.recommended_action),
      linked_question_id: item.linked_question_id != null ? String(item.linked_question_id) : null,
    });
  }

  return out;
}

export function groundInterviewGaps(
  items: InterviewGapItem[],
  probedSkillCanonicals: Set<string> | null,
): InterviewGapItem[] {
  return items.filter((item) => {
    if (!item.linked_question_id || !item.evidence_from_answer.trim()) return false;
    const skillAnchored =
      (item.target_type === 'skill' || item.target_type === 'evidence') &&
      item.skill_canonical !== null;
    if (
      skillAnchored &&
      probedSkillCanonicals &&
      !probedSkillCanonicals.has(item.skill_canonical as string)
    ) {
      return false;
    }
    return true;
  });
}
