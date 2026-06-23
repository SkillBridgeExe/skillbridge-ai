import { GapItem } from '../gap-engine/gap-item';
import { InterviewGapItem } from '../interview/interview-gap';

export type UnifiedTrack = 'learn' | 'cv_fix' | 'interview_practice';
export type UnifiedSource = 'gap' | 'interview' | 'both';

export interface UnifiedDevelopmentPlanItem {
  source: UnifiedSource;
  track: UnifiedTrack;
  skill_canonical: string | null;
  display_name: string;
  priority: number;
  severity: number;
  rationale: string;
  requirement_id?: string;
  weakness_type?: InterviewGapItem['weakness_type'];
  target_type?: InterviewGapItem['target_type'];
}

export interface UnifiedDevelopmentPlan {
  match_id: string;
  session_id: string | null;
  learn_items: UnifiedDevelopmentPlanItem[];
  cv_fix_items: UnifiedDevelopmentPlanItem[];
  interview_practice_items: UnifiedDevelopmentPlanItem[];
}

const IMPORTANCE_WEIGHT: Record<string, number> = {
  REQUIRED: 1,
  PREFERRED: 0.6,
  NICE_TO_HAVE: 0.3,
};
const BOTH_BOOST = 1.3;
const COURSE_ADDRESSABLE_TYPES: ReadonlySet<GapItem['type']> = new Set([
  'hard_skill',
  'soft_skill',
  'language',
]);

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const gapTrack = (item: GapItem): UnifiedTrack | null => {
  if (item.fixability === 'learn') {
    return COURSE_ADDRESSABLE_TYPES.has(item.type) ? 'learn' : null;
  }
  if (item.fixability === 'rewrite' || item.fixability === 'add_evidence') return 'cv_fix';
  return null;
};

const interviewTrack = (weakness: InterviewGapItem['weakness_type']): UnifiedTrack => {
  if (weakness === 'knowledge_gap') return 'learn';
  if (weakness === 'evidence_gap') return 'cv_fix';
  return 'interview_practice';
};

const keyOf = (
  skill: string | null,
  requirementId: string | null | undefined,
  name: string,
): string => (skill ?? requirementId ?? name).toLowerCase();

const learningSkillCanonical = (gap: GapItem): string | null =>
  gap.type === 'language' ? 'english_proficiency' : (gap.canonical_name ?? null);

export function buildUnifiedPlan(input: {
  matchId: string;
  sessionId: string | null;
  gapItems: GapItem[];
  interviewItems: InterviewGapItem[];
}): UnifiedDevelopmentPlan {
  const buckets: Record<UnifiedTrack, Map<string, UnifiedDevelopmentPlanItem>> = {
    learn: new Map(),
    cv_fix: new Map(),
    interview_practice: new Map(),
  };

  for (const gap of input.gapItems) {
    const track = gapTrack(gap);
    if (!track) continue;
    const skillCanonical =
      track === 'learn' ? learningSkillCanonical(gap) : (gap.canonical_name ?? null);
    const key = keyOf(skillCanonical, gap.requirement_id, gap.display_name);
    buckets[track].set(key, {
      source: 'gap',
      track,
      skill_canonical: skillCanonical,
      display_name: gap.display_name,
      priority: round3(gap.severity * (IMPORTANCE_WEIGHT[gap.importance] ?? 0.6)),
      severity: gap.severity,
      rationale: gap.recommended_next_action || `${gap.cv_status}: ${gap.display_name}`,
      requirement_id: gap.requirement_id,
    });
  }

  for (const interviewItem of input.interviewItems) {
    const track = interviewTrack(interviewItem.weakness_type);
    const key = keyOf(
      interviewItem.skill_canonical,
      interviewItem.requirement_id,
      interviewItem.display_name,
    );
    const existing = buckets[track].get(key);
    if (existing) {
      existing.source = 'both';
      existing.priority = round3(existing.priority * BOTH_BOOST);
      existing.weakness_type = interviewItem.weakness_type;
      existing.target_type = interviewItem.target_type;
      existing.rationale = `${existing.rationale}; interview: ${interviewItem.weakness_type}`;
      continue;
    }

    buckets[track].set(key, {
      source: 'interview',
      track,
      skill_canonical: interviewItem.skill_canonical ?? null,
      display_name: interviewItem.display_name,
      priority: round3(interviewItem.severity),
      severity: interviewItem.severity,
      rationale: interviewItem.recommended_action || `interview: ${interviewItem.weakness_type}`,
      requirement_id: interviewItem.requirement_id ?? undefined,
      weakness_type: interviewItem.weakness_type,
      target_type: interviewItem.target_type,
    });
  }

  const sorted = (items: Map<string, UnifiedDevelopmentPlanItem>): UnifiedDevelopmentPlanItem[] =>
    [...items.values()].sort((a, b) => b.priority - a.priority);

  return {
    match_id: input.matchId,
    session_id: input.sessionId,
    learn_items: sorted(buckets.learn),
    cv_fix_items: sorted(buckets.cv_fix),
    interview_practice_items: sorted(buckets.interview_practice),
  };
}
