import { CvJdMatchParsedResponse } from './dto/cv-jd-match-response.dto';
import { MatchedSkill, PartialSkill } from './skill-diff.service';
import { EvidenceLedger } from '../../common/services/evidence-ledger';
import type { GapItem } from '../gap-engine/gap-item';

export type TailorActionType =
  | 'missing_required'
  | 'add_evidence'
  | 'emphasize'
  | 'deepen_wording'
  | 'advice';

/** A2 (ACTION'): the non-skill GapItem slice the advice bucket reads — pass gap_items entries of
 *  type seniority/language/education/domain straight through (type-only import, no runtime cycle). */
export type NonSkillGap = Pick<
  GapItem,
  | 'type'
  | 'canonical_name'
  | 'display_name'
  | 'importance'
  | 'cv_status'
  | 'cv_level'
  | 'required_level'
>;

export interface TailorAction {
  action_type: TailorActionType;
  skill_canonical: string;
  display_name: string;
  /** Deterministic, localized, carries REAL numbers (jd_count/cv_count/levels). */
  why: string;
  /** true → FE may offer "Viết lại với AI" (rewrite mode `tailor`). */
  rewrite_eligible: boolean;
  /** Where in the CV to act, from the evidence ledger (deepen_wording). */
  anchor: { kind: string; ref: string } | null;
  jd_importance: string | null;
  jd_count: number | null;
  cv_count: number | null;
  cv_level: number | null;
  required_level: number | null;
  /** A2: the joined gap_items[] severity (0-1) for this skill — additive, so FE can explain why
   *  this action ranks where it does. Absent when no severity map was supplied, or the skill's
   *  canonical has no matching gap item (should not happen; guarded defensively). */
  gap_severity?: number;
}

const MAX_MISSING = 3;
const MAX_ADD_EVIDENCE = 2;
const MAX_EMPHASIZE = 3;
const MAX_DEEPEN = 2;
// ponytail: 4 = every gradeable non-skill dimension (seniority/language/education/domain) — the
// pool is bounded by construction, so this "cap" only exists to keep bucketCap total.
const MAX_ADVICE = 4;
const MAX_TOTAL = 8;

type Lang = 'vi' | 'en';
const T = {
  vi: {
    missing: (s: string, jd: number | null) =>
      `JD yêu cầu ${s} (REQUIRED${jd ? `, nhấn ${jd} lần` : ''}) — CV chưa có. Nếu bạn thực sự có kinh nghiệm với ${s}, hãy thêm kèm bằng chứng thật; nếu chưa, ưu tiên học trước khi ứng tuyển.`,
    addEvidence: (s: string) =>
      `${s} khớp JD nhưng trong CV chỉ nằm ở mục Kỹ năng — thêm một bullet ở dự án/kinh nghiệm chứng minh bạn đã dùng ${s}.`,
    emphasize: (s: string, jd: number, cv: number) =>
      `JD nhấn ${s} ${jd} lần, CV chỉ nhắc ${cv} lần — đưa ${s} vào summary hoặc bullet nổi bật hơn.`,
    deepen: (s: string, cv: number, req: number) =>
      `CV có bằng chứng ${s} nhưng wording mới thể hiện mức ${cv}/5, JD cần ${req}/5 — viết lại bullet cho rõ độ sâu (không thổi phồng).`,
    // A2 advice — honest framing: inferred from what the CV shows/doesn't show, never "bạn thiếu".
    adviceSeniority: (cv: number | null, req: number | null) =>
      cv != null && req != null
        ? `JD yêu cầu cấp độ kinh nghiệm ${req}/5, CV đang thể hiện ${cv}/5 — khoảng trống này không sửa được bằng viết lại CV: tích lũy thêm kinh nghiệm thực tế, hoặc nêu rõ số năm và phạm vi trách nhiệm nếu CV chưa phản ánh đủ.`
        : `JD yêu cầu cấp độ kinh nghiệm cao hơn mức CV thể hiện — tích lũy thêm kinh nghiệm thực tế, hoặc nêu rõ số năm và phạm vi trách nhiệm nếu CV chưa phản ánh đủ.`,
    adviceLanguage: () =>
      `JD yêu cầu trình độ ngoại ngữ mà CV chưa thể hiện — bổ sung chứng chỉ/minh chứng thật nếu bạn có; nếu chưa, đây là khoảng trống cần đầu tư học, không sửa được bằng viết lại CV.`,
    adviceEducation: () =>
      `JD yêu cầu học vấn/bằng cấp mà CV chưa thể hiện — bổ sung thông tin học vấn hoặc chứng chỉ tương đương nếu có; viết lại CV không tạo ra bằng cấp.`,
    adviceDomain: () =>
      `CV đang thể hiện lĩnh vực khác với JD — nêu bật kinh nghiệm/dự án liên quan tới lĩnh vực của JD nếu có; nếu chưa, xác định đây là khoảng trống cần thời gian tích lũy.`,
  },
  en: {
    missing: (s: string, jd: number | null) =>
      `The JD requires ${s} (REQUIRED${jd ? `, mentioned ${jd}×` : ''}) — the CV doesn't show it. If you truly have ${s} experience, add it with real evidence; otherwise prioritize learning it first.`,
    addEvidence: (s: string) =>
      `${s} matches the JD but only sits in the Skills list — add one project/experience bullet proving you used ${s}.`,
    emphasize: (s: string, jd: number, cv: number) =>
      `The JD mentions ${s} ${jd}×, your CV only ${cv}× — surface ${s} in the summary or a prominent bullet.`,
    deepen: (s: string, cv: number, req: number) =>
      `The CV evidences ${s} but the wording reads level ${cv}/5 while the JD needs ${req}/5 — reword the bullet to show depth (without inflating).`,
    adviceSeniority: (cv: number | null, req: number | null) =>
      cv != null && req != null
        ? `The JD asks for experience level ${req}/5 while the CV reads ${cv}/5 — no rewrite closes this: gain more hands-on experience, or state your years and scope of responsibility clearly if the CV under-reports them.`
        : `The JD asks for a higher experience level than the CV shows — gain more hands-on experience, or state your years and scope of responsibility clearly if the CV under-reports them.`,
    adviceLanguage: () =>
      `The JD requires a language proficiency the CV doesn't show — add a real certificate/proof if you have one; otherwise this is a gap to invest in, not something a rewrite can fix.`,
    adviceEducation: () =>
      `The JD requires education/credentials the CV doesn't show — add your education details or an equivalent certificate if you have them; a rewrite cannot create a degree.`,
    adviceDomain: () =>
      `The CV reads as a different domain than the JD — highlight related experience/projects for the JD's domain if you have any; otherwise treat this as a gap that takes time to build.`,
  },
} as const;

/**
 * Deterministic Tailor-to-JD checklist. CODE decides every action from the persisted match
 * (diff + keyword_frequency) + the CV's evidence ledger. NO LLM. NEVER suggests fabricating:
 * missing skills get a conditional "if you truly have it" — the rewrite path (mode `tailor`)
 * is only offered where the skill is evidence-backed (`rewrite_eligible`).
 * Rules in order (one action per skill, total ≤ 8):
 *   1. missing_required — REQUIRED gaps the user must address honestly (no rewrite).
 *   2. add_evidence     — matched but listed-only → write a proving bullet (no rewrite).
 *   3. emphasize        — JD stresses it (jd_count ≥ 2), CV barely mentions it (cv_count ≤ 1).
 *   4. deepen_wording   — partial with demonstrated evidence → reword the anchored bullet.
 *   5. advice (A2)      — non-skill gaps (seniority/language/education/domain, from `nonSkillGaps`)
 *                         → a clear next step that is explicitly NOT a CV rewrite (never verified/
 *                         rewritten; the tailor verifier rejects it as ACTION_NOT_REWRITABLE).
 *
 * A2 (severity ranking) + ACTION' A1: the 4 buckets above decide which skills are CANDIDATES.
 * When `severityByCanonical` is supplied, the candidate pools are UNCAPPED — severity (desc) ranks
 * the full pool first, and only then do the per-bucket maxima apply as diversity constraints
 * (walking the ranked list, skipping a candidate whose bucket is full) followed by MAX_TOTAL. So
 * neither a per-bucket cap nor the top-8 cap can ever hide the highest-severity actionable gap —
 * action #1 always matches gap #1 (bug B3 / audit P0-5). Ties fall back to the bucket/weight order
 * above via a stable sort. Pass `severityByCanonical` from the SAME gap_items the caller already
 * built (gap-report.service); omit it to keep the old capped-slice bucket-order behavior
 * byte-identical (e.g. standalone/legacy callers).
 */
export function buildTailorChecklist(
  match: CvJdMatchParsedResponse,
  ledger: EvidenceLedger | null,
  lang: Lang,
  severityByCanonical?: Map<string, number> | null,
  nonSkillGaps?: NonSkillGap[] | null,
): TailorAction[] {
  const t = T[lang];
  const taken = new Set<string>();
  const out: TailorAction[] = [];
  const kfByCanonical = new Map((match.keyword_frequency ?? []).map((k) => [k.canonical_name, k]));
  const kfOf = (c: string) => kfByCanonical.get(c) ?? null;
  // A1: severity mode collects the FULL pool (caps move to the post-ranking walk); legacy slices here.
  const poolCap = (n: number) => (severityByCanonical ? Number.POSITIVE_INFINITY : n);

  // 1. missing_required
  const missingReq = match.missing_skills
    .filter((m) => m.importance === 'REQUIRED')
    .sort((a, b) => b.weight - a.weight || a.canonical_name.localeCompare(b.canonical_name));
  for (const m of missingReq.slice(0, poolCap(MAX_MISSING))) {
    taken.add(m.canonical_name);
    const k = kfOf(m.canonical_name);
    out.push({
      action_type: 'missing_required',
      skill_canonical: m.canonical_name,
      display_name: m.display_name,
      why: t.missing(m.display_name, k ? k.jd_count : null),
      rewrite_eligible: false,
      anchor: null,
      jd_importance: m.importance,
      jd_count: k ? k.jd_count : null,
      cv_count: k ? k.cv_count : null,
      cv_level: null,
      required_level: m.required_level,
    });
  }

  // 2. add_evidence — matched ∩ evidence_gap (listed_only)
  if (ledger && ledger.evidence_gap.length > 0) {
    const gapSet = new Set(ledger.evidence_gap);
    const candidates = match.matched_skills
      .filter((m) => gapSet.has(m.canonical_name) && !taken.has(m.canonical_name))
      .sort((a, b) => b.weight - a.weight || a.canonical_name.localeCompare(b.canonical_name));
    for (const m of candidates.slice(0, poolCap(MAX_ADD_EVIDENCE))) {
      taken.add(m.canonical_name);
      const k = kfOf(m.canonical_name);
      out.push({
        action_type: 'add_evidence',
        skill_canonical: m.canonical_name,
        display_name: m.display_name,
        why: t.addEvidence(m.display_name),
        rewrite_eligible: false,
        anchor: null,
        jd_importance: m.importance,
        jd_count: k ? k.jd_count : null,
        cv_count: k ? k.cv_count : null,
        cv_level: m.cv_level,
        required_level: m.required_level,
      });
    }
  }

  // 3. emphasize — evidence-backed (matched/partial) skills the JD stresses but the CV under-mentions
  const presentSkills: Array<MatchedSkill | PartialSkill> = [
    ...match.matched_skills,
    ...match.partial_skills,
  ];
  const emphasizeCandidates = presentSkills
    .map((s) => ({ s, k: kfOf(s.canonical_name) }))
    .filter(
      (x): x is { s: MatchedSkill | PartialSkill; k: NonNullable<ReturnType<typeof kfOf>> } =>
        x.k !== null && x.k.jd_count >= 2 && x.k.cv_count <= 1 && !taken.has(x.s.canonical_name),
    )
    .sort(
      (a, b) =>
        b.k.jd_count - a.k.jd_count ||
        b.s.weight - a.s.weight ||
        a.s.canonical_name.localeCompare(b.s.canonical_name),
    );
  for (const { s, k } of emphasizeCandidates.slice(0, poolCap(MAX_EMPHASIZE))) {
    taken.add(s.canonical_name);
    out.push({
      action_type: 'emphasize',
      skill_canonical: s.canonical_name,
      display_name: s.display_name,
      why: t.emphasize(s.display_name, k.jd_count, k.cv_count),
      rewrite_eligible: true,
      anchor: null,
      jd_importance: s.importance,
      jd_count: k.jd_count,
      cv_count: k.cv_count,
      cv_level: s.cv_level,
      required_level: s.required_level,
    });
  }

  // 4. deepen_wording — partial with demonstrated evidence, anchored to the proving source
  if (ledger) {
    const demonstratedBy = new Map(
      ledger.items.filter((i) => i.strength === 'demonstrated').map((i) => [i.skill_canonical, i]),
    );
    const deepenCandidates = match.partial_skills
      .filter((p) => demonstratedBy.has(p.canonical_name) && !taken.has(p.canonical_name))
      .sort((a, b) => b.gap_levels - a.gap_levels || b.weight - a.weight);
    for (const p of deepenCandidates.slice(0, poolCap(MAX_DEEPEN))) {
      taken.add(p.canonical_name);
      const src = demonstratedBy.get(p.canonical_name)!.sources[0] ?? null;
      const k = kfOf(p.canonical_name);
      out.push({
        action_type: 'deepen_wording',
        skill_canonical: p.canonical_name,
        display_name: p.display_name,
        why: t.deepen(p.display_name, p.cv_level, p.required_level),
        rewrite_eligible: true,
        anchor: src ? { kind: src.kind, ref: src.ref } : null,
        jd_importance: p.importance,
        jd_count: k ? k.jd_count : null,
        cv_count: k ? k.cv_count : null,
        cv_level: p.cv_level,
        required_level: p.required_level,
      });
    }
  }

  // 5. advice (A2) — non-skill gaps become an honest next step. No rewrite path, no anchor; the
  // grader already decided cv_status, so only real (non-matched) gradeable gaps qualify.
  if (nonSkillGaps?.length) {
    const adviceWhy = (g: NonSkillGap): string | null => {
      if (g.type === 'seniority') return t.adviceSeniority(g.cv_level, g.required_level);
      if (g.type === 'language') return t.adviceLanguage();
      if (g.type === 'education') return t.adviceEducation();
      if (g.type === 'domain') return t.adviceDomain();
      return null; // work_mode & anything else stays disclosure-only — never an action
    };
    for (const g of nonSkillGaps) {
      if (g.cv_status === 'matched' || taken.has(g.canonical_name)) continue;
      const why = adviceWhy(g);
      if (!why) continue;
      taken.add(g.canonical_name);
      out.push({
        action_type: 'advice',
        skill_canonical: g.canonical_name,
        display_name: g.display_name,
        why,
        rewrite_eligible: false,
        anchor: null,
        jd_importance: g.importance,
        jd_count: null,
        cv_count: null,
        cv_level: g.cv_level,
        required_level: g.required_level,
      });
    }
  }

  // Back-compat: no severity map → old bucket-ordered slice, byte-identical, untouched.
  if (!severityByCanonical) return out.slice(0, MAX_TOTAL);

  // A1: severity decides who makes the cut AND the final order. The pool above is UNCAPPED in this
  // mode, so ranking runs on every candidate; the per-bucket maxima then act as diversity
  // constraints on the ranked walk (a full bucket skips the candidate, never the whole walk), and
  // MAX_TOTAL bounds the result. Capping before ranking (the old bug) let a fixed per-bucket slice
  // silently exclude a later, more severe candidate — the top action could never be the top gap.
  // Stable sort (spec-guaranteed) keeps the bucket→weight order for ties. A canonical missing from
  // the map (shouldn't happen — guarded) sorts as severity 0, i.e. to the end, with NO gap_severity.
  const bucketCap: Record<TailorActionType, number> = {
    missing_required: MAX_MISSING,
    add_evidence: MAX_ADD_EVIDENCE,
    emphasize: MAX_EMPHASIZE,
    deepen_wording: MAX_DEEPEN,
    advice: MAX_ADVICE,
  };
  const used: Partial<Record<TailorActionType, number>> = {};
  const picked: TailorAction[] = [];
  const ranked = out
    .map((a) => ({ a, sev: severityByCanonical.get(a.skill_canonical) }))
    .sort((x, y) => (y.sev ?? 0) - (x.sev ?? 0));
  for (const { a, sev } of ranked) {
    if (picked.length >= MAX_TOTAL) break;
    if ((used[a.action_type] ?? 0) >= bucketCap[a.action_type]) continue;
    used[a.action_type] = (used[a.action_type] ?? 0) + 1;
    picked.push(sev === undefined ? a : { ...a, gap_severity: sev });
  }
  return picked;
}
