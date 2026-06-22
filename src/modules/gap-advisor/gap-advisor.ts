/**
 * gap_next_step_advisor — deterministic core (PURE, no LLM, no IO).
 *
 * Turns a Gap Engine report into a prioritized, grounded list of "next steps" for the diagnosis page.
 * Anti-fabrication BY CONSTRUCTION: it only ever speaks about REAL gaps (cv_status !== 'matched') that
 * the engine already produced, ranked by the engine's own `severityRaw`, with a bilingual action
 * template keyed off the gap's status. It can never invent a gap, a skill, or a severity.
 *
 * Reuses [[gap-engine/gap-item]] (GapItem + severityRaw); the LLM (in gap-advisor.service) only PHRASES
 * these steps and may never add a step.
 */
import { CvStatus, GapItem, severityRaw } from '../gap-engine/gap-item';

type Lang = 'vi' | 'en';

export interface NextStep {
  /** 1-based priority (1 = most severe). */
  rank: number;
  skill: string;
  canonical: string;
  status: CvStatus;
  severity: number;
  /** deterministic, bilingual action label — the grounded baseline the LLM may rephrase but not replace. */
  action: string;
}

const NEXT_ACTION: Record<Lang, Partial<Record<CvStatus, string>>> = {
  en: {
    missing: 'Learn this skill, then add it to your CV with one concrete example.',
    partial: 'Level it up and show clearer evidence of what you did.',
    unproven: 'Add one bullet that proves it — right now it is only listed.',
    overclaimed: 'Back up the level you claimed with a concrete example.',
  },
  vi: {
    missing: 'Học kỹ năng này rồi bổ sung vào CV kèm một ví dụ cụ thể.',
    partial: 'Nâng trình độ và làm rõ bằng chứng cho phần bạn đã làm.',
    unproven: 'Thêm một bullet chứng minh — hiện mới chỉ liệt kê.',
    overclaimed: 'Bổ sung ví dụ cụ thể cho mức bạn đã khai.',
  },
};

/** Prioritized next steps from a gap report. Empty list ⇒ no actionable gaps (a strong CV). */
export function buildNextSteps(
  gaps: GapItem[],
  language: Lang,
  opts: { limit?: number } = {},
): NextStep[] {
  const limit = opts.limit ?? 5;
  return gaps
    .filter((g) => g.cv_status !== 'matched' && Boolean(NEXT_ACTION[language][g.cv_status]))
    .slice()
    .sort((a, b) => severityRaw(b) - severityRaw(a))
    .slice(0, limit)
    .map((g, i) => ({
      rank: i + 1,
      skill: g.display_name,
      canonical: g.canonical_name,
      status: g.cv_status,
      severity: g.severity,
      action: NEXT_ACTION[language][g.cv_status] as string,
    }));
}
