import {
  BonusSkill,
  MatchedSkill,
  MissingSkill,
  PartialSkill,
} from '../cv-jd-match/skill-diff.service';
import { CvJdMatchParsedResponse } from '../cv-jd-match/dto/cv-jd-match-response.dto';
import { EvidenceLedger } from '../../common/services/evidence-ledger';
import { CvSeniority, ExperienceVerdict } from '../../common/services/seniority';
import {
  JdDimension,
  JdDimensionType,
  gradeSeniority,
  gradeNonSkillDimensions,
} from '../gap-engine/jd-dimensions';
import { CvProfileSignals } from '../../common/services/cv-profile-signals';

export interface EvidenceGapItem {
  skill_canonical: string;
  display_name: string;
  importance: string;
  cv_level: number | null;
  required_level: number | null;
}
export interface EmphasisGapItem {
  skill_canonical: string;
  display_name: string;
  jd_count: number;
  cv_count: number;
  importance: string;
}
export interface SeniorityBlock {
  /** Evidence-based CV seniority (#34). null when the review/document is unavailable. */
  cv: CvSeniority | null;
  /** HONEST v1: pasted JDs carry no extracted level yet — ALWAYS null until JD-intelligence (P1).
   *  PR3 keeps this null (the extracted JD level lives in jd_intelligence, not here) so the FE
   *  contract (shared/api.ts GapSeniorityBlock.jd_level: null) is unchanged until the v2-flip PR. */
  jd_level: null;
  verdict: 'unknown';
  note: string;
}

/** One extracted non-skill JD requirement, surfaced for honest disclosure (PR3, JD-Intelligence v2). */
export interface JdIntelligenceItem {
  dimension: JdDimensionType;
  value_text: string;
  level_hint: string | null;
  min_years: number | null;
  importance: string;
  deal_breaker: boolean;
  /** Exact JD quote backing this requirement (never fabricated — un-quoted dims are dropped upstream). */
  evidence_text: string;
  /** true only when a gap_item was actually emitted for it — seniority + (PR3c) language/education/
   *  domain with a usable CV signal. work_mode is disclosure-only ⇒ always false. */
  graded: boolean;
  /** Human-readable CV-side signal for the dimension (PR3b); null when the CV gives no signal. */
  cv_signal: string | null;
  /** Seniority fit verdict (ExperienceVerdict); null for language/education/domain/work_mode. */
  verdict: ExperienceVerdict | null;
}
/** JD-Intelligence disclosure block: what the JD requires beyond skills. Only seniority is graded into
 *  gap_items today; the rest are read from the JD and shown here until a CV-side parser lands (PR3b). */
export interface JdIntelligenceBlock {
  dimensions: JdIntelligenceItem[];
  note: string;
}

export interface GapReportCore {
  target_role: string | null;
  overall_score: number;
  source_of_requirements: CvJdMatchParsedResponse['source_of_requirements'];
  explicit_gaps: MissingSkill[];
  proficiency_gaps: PartialSkill[];
  evidence_gaps: EvidenceGapItem[];
  seniority: SeniorityBlock;
  jd_emphasis_gaps: EmphasisGapItem[];
  strengths: { matched: MatchedSkill[]; demonstrated: string[]; bonus: BonusSkill[] };
  /** PR3: non-skill JD requirements (seniority/language/education/domain/work_mode). Optional +
   *  additive — OMITTED entirely when the match carries no jd_dimensions (v1 path), so legacy output
   *  is byte-identical. Present only when cv_jd_match_v2 extracted dimensions. */
  jd_intelligence?: JdIntelligenceBlock;
  language: 'vi' | 'en';
}

const SENIORITY_NOTE = {
  vi: 'Cấp độ JD chưa trích xuất được từ JD dán (sẽ bổ sung) — chỉ hiển thị ước lượng phía CV, không kết luận hợp/lệch.',
  en: 'The pasted JD carries no extracted level yet — only the CV-side estimate is shown; no fit verdict is made.',
} as const;

const JD_INTEL_NOTE = {
  vi: 'Đã chấm gap cho cấp độ/kinh nghiệm, ngôn ngữ, học vấn và lĩnh vực khi CV có tín hiệu tương ứng. Hình thức làm việc chỉ hiển thị (không chấm gap). Các mục không đủ tín hiệu phía CV được bỏ qua một cách trung thực.',
  en: 'Seniority, language, education and domain are graded when the CV carries a matching signal. Work mode is disclosure-only (not graded). Dimensions without enough CV-side signal are honestly omitted.',
} as const;

/** Human-readable CV-side signal per dimension (enums/derived values only — never raw CV text).
 *  The seniority format is UNCHANGED (byte-identical); PR3b fills language/education/domain/work_mode
 *  from the CV profile signals. Returns null when the CV gives no signal for that dimension. */
function cvSignalFor(
  dimension: JdDimensionType,
  cvSeniority: CvSeniority | null,
  signals: CvProfileSignals | null,
): string | null {
  switch (dimension) {
    case 'seniority':
      return cvSeniority
        ? `${cvSeniority.bucket}${cvSeniority.est_years != null ? ` (~${cvSeniority.est_years}y)` : ''} · ${cvSeniority.confidence}`
        : null;
    case 'language': {
      const e = signals?.english;
      return e ? `${e.cefr} (${e.source_kind}) · ${e.confidence}` : null;
    }
    case 'education': {
      const ed = signals?.education;
      return ed
        ? `${ed.level ?? 'field-only'}${ed.field ? ` · ${ed.field}` : ''} · ${ed.confidence}`
        : null;
    }
    case 'domain': {
      const dm = signals?.domain;
      return dm ? `${dm.domains.join(', ')} · ${dm.confidence}` : null;
    }
    case 'work_mode': {
      const w = signals?.work_mode;
      return w ? `${w.mode} · ${w.confidence}` : null;
    }
    default:
      return null;
  }
}

/** Pure: turn the extracted JD dimensions into the disclosure block. Seniority gets a fit verdict +
 *  graded=true when a gap_item was emitted; PR3b fills cv_signal for the other four from the CV
 *  profile signals (still graded=false / verdict=null — grading those is a later PR). */
function buildJdIntelligence(
  dims: JdDimension[],
  cvSeniority: CvSeniority | null,
  cvSignals: CvProfileSignals | null,
  lang: 'vi' | 'en',
): JdIntelligenceBlock {
  // The graded dims come from the SHARED graders (gradeSeniority + gradeNonSkillDimensions), so
  // `graded`/`verdict` here can NEVER contradict gap_items. seniority → ExperienceVerdict; the
  // PR3c dims (language/education/domain) are graded but carry no ExperienceVerdict (verdict stays
  // null — honest). work_mode is never graded (disclosure-only).
  const grade = gradeSeniority(dims, cvSeniority);
  const nonSkillGraded = new Set<JdDimension>(
    gradeNonSkillDimensions(dims, cvSignals).flatMap((g) => g.dims),
  );
  const dimensions: JdIntelligenceItem[] = dims.map((d) => {
    const isSeniorityGraded = !!grade && d === grade.dim;
    const isGraded = isSeniorityGraded || nonSkillGraded.has(d);
    return {
      dimension: d.dimension,
      value_text: d.value_text,
      level_hint: d.level_hint,
      min_years: d.min_years,
      importance: d.importance,
      deal_breaker: d.deal_breaker,
      evidence_text: d.evidence_text,
      graded: isGraded,
      cv_signal: cvSignalFor(d.dimension, cvSeniority, cvSignals),
      // Assert a verdict ONLY for the seniority dim we graded (ExperienceVerdict); the PR3c dims have
      // no such verdict and a weak/omitted signal stays null so the disclosure never overclaims.
      verdict: isSeniorityGraded ? grade.verdict : null,
    };
  });
  return { dimensions, note: JD_INTEL_NOTE[lang] };
}

const EMPHASIS_JD_MIN = 2;
const EMPHASIS_CV_MAX = 1;

/**
 * Gap Engine v1 — the deterministic core of SkillBridgeGapReport. Pure composition over data
 * the eval-gated stack already computed: NOTHING here is rescored, reweighted, or invented.
 * The service layer adds the two collaborator blocks (recommended_actions, market_trend_gaps).
 */
export function buildGapReportCore(
  match: CvJdMatchParsedResponse,
  ledger: EvidenceLedger | null,
  cvSeniority: CvSeniority | null,
  cvSignals: CvProfileSignals | null,
  lang: 'vi' | 'en',
): GapReportCore {
  const present: Array<MatchedSkill | PartialSkill> = [
    ...match.matched_skills,
    ...match.partial_skills,
  ];

  const gapSet = new Set(ledger?.evidence_gap ?? []);
  const evidence_gaps: EvidenceGapItem[] = present
    .filter((s) => gapSet.has(s.canonical_name))
    .map((s) => ({
      skill_canonical: s.canonical_name,
      display_name: s.display_name,
      importance: s.importance,
      cv_level: s.cv_level ?? null,
      required_level: s.required_level ?? null,
    }));

  const kfBy = new Map((match.keyword_frequency ?? []).map((k) => [k.canonical_name, k]));
  const jd_emphasis_gaps: EmphasisGapItem[] = present
    .map((s) => ({ s, k: kfBy.get(s.canonical_name) }))
    .filter(
      (x): x is { s: MatchedSkill | PartialSkill; k: NonNullable<typeof x.k> } =>
        !!x.k && x.k.jd_count >= EMPHASIS_JD_MIN && x.k.cv_count <= EMPHASIS_CV_MAX,
    )
    .map(({ s, k }) => ({
      skill_canonical: s.canonical_name,
      display_name: s.display_name,
      jd_count: k.jd_count,
      cv_count: k.cv_count,
      importance: s.importance,
    }));

  const demonstrated = ledger
    ? ledger.items.filter((i) => i.strength === 'demonstrated').map((i) => i.skill_canonical)
    : [];

  // PR3: build the JD-Intelligence disclosure block only when v2 extracted dimensions — OMITTED on
  // the v1 path so legacy output is byte-identical (additive, cross-lane-safe).
  const jdDims = match.jd_dimensions ?? [];
  const jd_intelligence = jdDims.length
    ? buildJdIntelligence(jdDims, cvSeniority, cvSignals, lang)
    : undefined;

  return {
    target_role: match.target_role,
    overall_score: match.overall_score,
    source_of_requirements: match.source_of_requirements,
    explicit_gaps: match.missing_skills,
    proficiency_gaps: match.partial_skills,
    evidence_gaps,
    seniority: { cv: cvSeniority, jd_level: null, verdict: 'unknown', note: SENIORITY_NOTE[lang] },
    jd_emphasis_gaps,
    strengths: { matched: match.matched_skills, demonstrated, bonus: match.bonus_skills },
    ...(jd_intelligence ? { jd_intelligence } : {}),
    language: lang,
  };
}

/** Roadmap input shape (mirrors RoadmapSkillRequirementDto — kept structural to avoid importing a class DTO). */
export interface RoadmapSkillRequirementInput {
  skill_canonical_name: string;
  display_name: string;
  required_level: number;
  current_level: number;
  importance: string;
  weight?: number;
}

/**
 * Codex P0 #4 fix: derive the roadmap's gap input from the unified report instead of trusting
 * caller-supplied skill strings. The future platform roadmap route does:
 *   match → buildGapReport → toRoadmapSkillRequirements → roadmap.generate(...)
 */
export function toRoadmapSkillRequirements(core: GapReportCore): {
  missing_skills: RoadmapSkillRequirementInput[];
  partial_skills: RoadmapSkillRequirementInput[];
} {
  return {
    missing_skills: core.explicit_gaps.map((m) => ({
      skill_canonical_name: m.canonical_name,
      display_name: m.display_name,
      required_level: m.required_level,
      current_level: 0,
      importance: m.importance,
      weight: m.weight,
    })),
    partial_skills: core.proficiency_gaps.map((p) => ({
      skill_canonical_name: p.canonical_name,
      display_name: p.display_name,
      required_level: p.required_level,
      current_level: p.cv_level,
      importance: p.importance,
      weight: p.weight,
    })),
  };
}
