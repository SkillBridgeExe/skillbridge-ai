import { DiffResult } from '../cv-jd-match/skill-diff.service';
import { GapItem } from '../gap-engine/gap-item';

export type FocusType = 'gap_probe' | 'depth_probe' | 'evidence_probe' | 'strength_showcase';
export type FocusDifficulty = 'foundation' | 'applied';

export interface InterviewFocusArea {
  skill_canonical: string;
  display_name: string;
  focus_type: FocusType;
  /** Deterministic, templated — the "why this question" transparency. */
  reason: string;
  difficulty: FocusDifficulty;
  /** Deterministic fallback question — ALWAYS present (the plan works without the LLM). */
  template_question: string;
}

const MAX_PER_PROBE = 2;
const MAX_PROBES = 6;

type Lang = 'vi' | 'en';
const T: Record<
  Lang,
  {
    gapReason: (s: string) => string;
    gapQ: (s: string) => string;
    depthReason: (s: string, cv: number, req: number) => string;
    depthQ: (s: string) => string;
    evidenceReason: (s: string) => string;
    evidenceQ: (s: string) => string;
    strengthReason: (s: string) => string;
    strengthQ: (s: string) => string;
  }
> = {
  vi: {
    gapReason: (s) =>
      `Vị trí yêu cầu ${s} nhưng CV chưa thể hiện — kiểm tra nền tảng và kiến thức lân cận.`,
    gapQ: (s) =>
      `Vị trí này thường dùng ${s}, nhưng CV của bạn chưa thể hiện nó. Bạn đã từng tìm hiểu hoặc dùng công nghệ tương tự chưa? Nếu cần học ${s}, bạn sẽ bắt đầu thế nào?`,
    depthReason: (s, cv, req) =>
      `CV thể hiện ${s} ở mức ${cv}/5, vị trí cần mức ${req}/5 — đo độ sâu thực tế.`,
    depthQ: (s) =>
      `Hãy mô tả một vấn đề cụ thể bạn đã xử lý bằng ${s}: bối cảnh, quyết định kỹ thuật của bạn, và kết quả.`,
    evidenceReason: (s) =>
      `CV liệt kê ${s} nhưng chưa có dự án hay bullet nào chứng minh — luyện kể một ví dụ thật.`,
    evidenceQ: (s) =>
      `CV của bạn liệt kê ${s} nhưng chưa có ví dụ cụ thể. Hãy kể một lần bạn thực sự dùng ${s}: bạn đã làm gì, và kết quả ra sao?`,
    strengthReason: (s) =>
      `${s} là điểm mạnh có bằng chứng trong CV — luyện trình bày nó thật ấn tượng.`,
    strengthQ: (s) =>
      `${s} là điểm mạnh của bạn. Hãy kể thành tích bạn tự hào nhất với ${s} và tác động của nó.`,
  },
  en: {
    gapReason: (s) =>
      `The role requires ${s} but the CV doesn't show it — probe fundamentals and adjacent knowledge.`,
    gapQ: (s) =>
      `This role commonly uses ${s}, which your CV doesn't show yet. Have you explored it or used something similar? If you had to learn ${s}, how would you start?`,
    depthReason: (s, cv, req) =>
      `The CV shows ${s} at level ${cv}/5; the role needs ${req}/5 — probe real depth.`,
    depthQ: (s) =>
      `Describe a concrete problem you solved with ${s}: the context, the technical decisions you made, and the outcome.`,
    evidenceReason: (s) =>
      `The CV lists ${s} but no project or bullet demonstrates it — practice telling a real example.`,
    evidenceQ: (s) =>
      `Your CV lists ${s} but shows no concrete example. Tell me about a time you actually used ${s}: what did you do, and what was the result?`,
    strengthReason: (s) =>
      `${s} is an evidenced strength on the CV — practice presenting it impressively.`,
    strengthQ: (s) =>
      `${s} is your strength. Tell me about the achievement with ${s} you're most proud of, and its impact.`,
  },
};

/**
 * Deterministic gap-targeted interview plan. CODE decides what to probe and why;
 * the LLM (later, optional) only words the questions. Selection order:
 *   1. gap_probe      — missing REQUIRED, weight desc, max 2 (difficulty: foundation)
 *   2. depth_probe    — partial, REQUIRED first then gap_levels desc then weight desc, max 2
 *   3. evidence_probe — matched ∩ evidenceGap (claimed-at-level but never shown), weight desc, max 2
 *   4. strength_showcase — ONE matched skill, preferring demonstrated evidence (practice selling it)
 * Each skill appears at most once; total ≤ 6 probes + 1 showcase.
 */
export function buildInterviewPlan(
  diff: DiffResult,
  evidenceGap: string[] | null,
  demonstrated: Set<string> | null,
  lang: Lang,
): InterviewFocusArea[] {
  const t = T[lang];
  const taken = new Set<string>();
  const probes: InterviewFocusArea[] = [];

  const missingReq = diff.missing_skills
    .filter((m) => m.importance === 'REQUIRED')
    .sort((a, b) => b.weight - a.weight || a.canonical_name.localeCompare(b.canonical_name));
  for (const m of missingReq.slice(0, MAX_PER_PROBE)) {
    taken.add(m.canonical_name);
    probes.push({
      skill_canonical: m.canonical_name,
      display_name: m.display_name,
      focus_type: 'gap_probe',
      reason: t.gapReason(m.display_name),
      difficulty: 'foundation',
      template_question: t.gapQ(m.display_name),
    });
  }

  const partials = [...diff.partial_skills].sort(
    (a, b) =>
      Number(b.importance === 'REQUIRED') - Number(a.importance === 'REQUIRED') ||
      b.gap_levels - a.gap_levels ||
      b.weight - a.weight ||
      a.canonical_name.localeCompare(b.canonical_name),
  );
  for (const p of partials.slice(0, MAX_PER_PROBE)) {
    if (taken.has(p.canonical_name)) continue;
    taken.add(p.canonical_name);
    probes.push({
      skill_canonical: p.canonical_name,
      display_name: p.display_name,
      focus_type: 'depth_probe',
      reason: t.depthReason(p.display_name, p.cv_level, p.required_level),
      difficulty: p.gap_levels >= 2 ? 'foundation' : 'applied',
      template_question: t.depthQ(p.display_name),
    });
  }

  if (evidenceGap && evidenceGap.length > 0) {
    const gapSet = new Set(evidenceGap);
    const evCandidates = diff.matched_skills
      .filter((m) => gapSet.has(m.canonical_name) && !taken.has(m.canonical_name))
      .sort((a, b) => b.weight - a.weight || a.canonical_name.localeCompare(b.canonical_name));
    for (const m of evCandidates.slice(0, MAX_PER_PROBE)) {
      taken.add(m.canonical_name);
      probes.push({
        skill_canonical: m.canonical_name,
        display_name: m.display_name,
        focus_type: 'evidence_probe',
        reason: t.evidenceReason(m.display_name),
        difficulty: 'applied',
        template_question: t.evidenceQ(m.display_name),
      });
    }
  }

  const plan = probes.slice(0, MAX_PROBES);

  const strengthPool = diff.matched_skills
    .filter((m) => !taken.has(m.canonical_name))
    .sort(
      (a, b) =>
        Number(demonstrated?.has(b.canonical_name) ?? false) -
          Number(demonstrated?.has(a.canonical_name) ?? false) ||
        b.weight - a.weight ||
        a.canonical_name.localeCompare(b.canonical_name),
    );
  if (strengthPool.length > 0) {
    const s = strengthPool[0];
    plan.push({
      skill_canonical: s.canonical_name,
      display_name: s.display_name,
      focus_type: 'strength_showcase',
      reason: t.strengthReason(s.display_name),
      difficulty: 'applied',
      template_question: t.strengthQ(s.display_name),
    });
  }

  return plan;
}

/** Interview-probe-able gap types. Non-skill dimensions (seniority/language/education/domain/
 *  work_mode) are advisory/experience/credential/preference gaps, NOT interview skill probes in v1. */
const SKILL_TYPES: ReadonlySet<GapItem['type']> = new Set(['hard_skill', 'soft_skill']);

/**
 * Gap-driven interview plan: select probe topics from canonical GapItems (already severity-ranked by
 * buildGapItems). Only hard_skill/soft_skill gaps are interview probes (non-skill dimensions excluded
 * in v1). Each item is assigned ONE focus_type with priority evidence > gap > depth > showcase — so a
 * `partial` skill that ALSO has weak evidence becomes an evidence_probe ("you claim it but never
 * showed it"), not a depth_probe. Dedupe by canonical (the same skill can appear in multiple gap_items
 * from jd + role_rubric sources). Mirrors buildInterviewPlan's caps & output order; the output type is
 * identical, so the LLM phrasing prompt (interview_plan_v1.md) is unchanged. The upgrade over the
 * diff-based planner: `unproven`/`overclaimed` (GapEngine-v2 statuses the old DiffResult lacked) now
 * drive evidence probes.
 */
export function buildInterviewPlanFromGapItems(items: GapItem[], lang: Lang): InterviewFocusArea[] {
  const t = T[lang];
  const taken = new Set<string>();
  const gap: InterviewFocusArea[] = [];
  const depth: InterviewFocusArea[] = [];
  const evidence: InterviewFocusArea[] = [];
  const showcase: InterviewFocusArea[] = [];

  for (const g of items) {
    if (!SKILL_TYPES.has(g.type) || taken.has(g.canonical_name)) continue;
    const weakEvidence = g.evidence_risk === 'listed_only' || g.evidence_risk === 'unproven';
    if (
      g.cv_status === 'unproven' ||
      g.cv_status === 'overclaimed' ||
      (weakEvidence && g.cv_status !== 'missing')
    ) {
      taken.add(g.canonical_name);
      evidence.push({
        skill_canonical: g.canonical_name,
        display_name: g.display_name,
        focus_type: 'evidence_probe',
        reason: t.evidenceReason(g.display_name),
        difficulty: 'applied',
        template_question: t.evidenceQ(g.display_name),
      });
    } else if (g.cv_status === 'missing' && g.importance === 'REQUIRED') {
      taken.add(g.canonical_name);
      gap.push({
        skill_canonical: g.canonical_name,
        display_name: g.display_name,
        focus_type: 'gap_probe',
        reason: t.gapReason(g.display_name),
        difficulty: 'foundation',
        template_question: t.gapQ(g.display_name),
      });
    } else if (g.cv_status === 'partial') {
      taken.add(g.canonical_name);
      depth.push({
        skill_canonical: g.canonical_name,
        display_name: g.display_name,
        focus_type: 'depth_probe',
        reason: t.depthReason(g.display_name, g.cv_level ?? 0, g.required_level ?? 0),
        difficulty: g.gap_levels >= 2 ? 'foundation' : 'applied',
        template_question: t.depthQ(g.display_name),
      });
    } else if (g.cv_status === 'matched') {
      taken.add(g.canonical_name);
      showcase.push({
        skill_canonical: g.canonical_name,
        display_name: g.display_name,
        focus_type: 'strength_showcase',
        reason: t.strengthReason(g.display_name),
        difficulty: 'applied',
        template_question: t.strengthQ(g.display_name),
      });
    }
    // else: missing & not REQUIRED → skip (parity with buildInterviewPlan)
  }

  const probes = [
    ...gap.slice(0, MAX_PER_PROBE),
    ...depth.slice(0, MAX_PER_PROBE),
    ...evidence.slice(0, MAX_PER_PROBE),
  ].slice(0, MAX_PROBES);
  if (showcase.length > 0) probes.push(showcase[0]);
  return probes;
}
