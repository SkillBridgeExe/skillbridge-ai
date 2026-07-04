import { CvJdMatchParsedResponse } from './dto/cv-jd-match-response.dto';
import { MatchedSkill, PartialSkill } from './skill-diff.service';
import { EvidenceLedger } from '../../common/services/evidence-ledger';

export type TailorActionType = 'missing_required' | 'add_evidence' | 'emphasize' | 'deepen_wording';

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
 *
 * A2 (severity ranking): the 4 buckets above decide WHICH skills make the list (unchanged). The
 * FINAL order is then re-ranked by the joined gap_items severity (desc) so action #1 never
 * contradicts gap #1 (bug B3) — ties fall back to the bucket/weight order above via a stable sort.
 * Pass `severityByCanonical` from the SAME gap_items the caller already built (gap-report.service);
 * omit it to keep the old bucket-order behavior (e.g. standalone/legacy callers).
 */
export function buildTailorChecklist(
  match: CvJdMatchParsedResponse,
  ledger: EvidenceLedger | null,
  lang: Lang,
  severityByCanonical?: Map<string, number> | null,
): TailorAction[] {
  const t = T[lang];
  const taken = new Set<string>();
  const out: TailorAction[] = [];
  const kfByCanonical = new Map((match.keyword_frequency ?? []).map((k) => [k.canonical_name, k]));
  const kfOf = (c: string) => kfByCanonical.get(c) ?? null;

  // 1. missing_required
  const missingReq = match.missing_skills
    .filter((m) => m.importance === 'REQUIRED')
    .sort((a, b) => b.weight - a.weight || a.canonical_name.localeCompare(b.canonical_name));
  for (const m of missingReq.slice(0, MAX_MISSING)) {
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
    for (const m of candidates.slice(0, MAX_ADD_EVIDENCE)) {
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
  for (const { s, k } of emphasizeCandidates.slice(0, MAX_EMPHASIZE)) {
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
    for (const p of deepenCandidates.slice(0, MAX_DEEPEN)) {
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

  const capped = out.slice(0, MAX_TOTAL);
  if (!severityByCanonical) return capped;

  // Final ordering: severity desc, stable (Array.sort is spec-guaranteed stable) so ties keep the
  // bucket→weight order already baked into `capped`. A canonical missing from the map (shouldn't
  // happen — guarded) sorts as severity 0, i.e. to the end, and gets NO gap_severity field.
  return capped
    .map((a) => ({ a, sev: severityByCanonical.get(a.skill_canonical) }))
    .sort((x, y) => (y.sev ?? 0) - (x.sev ?? 0))
    .map(({ a, sev }) => (sev === undefined ? a : { ...a, gap_severity: sev }));
}
