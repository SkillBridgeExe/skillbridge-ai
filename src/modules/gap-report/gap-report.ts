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
import { GapItem } from '../gap-engine/gap-item';
import { classifyFit, FitVerdict } from '../gap-engine/fit-strategy';

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
  /** E5 (v2-flip): the JD level_hint of the graded seniority dimension (SAME gradeSeniority() decision
   *  jd_intelligence uses — never contradicts). null on the v1 path / when ungradeable, byte-identical
   *  to the old always-null contract. */
  jd_level: string | null;
  /** E5: the real ExperienceVerdict when gradeSeniority() could grade the dim; 'unknown' otherwise
   *  (byte-identical fallback — no dims, no/low-confidence CV seniority, no valid level_hint). */
  verdict: ExperienceVerdict | 'unknown';
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
  /** TRUST' T4: makes an empty dimensions[] unambiguous. The v1 path omits the block entirely.
   *  - available: ≥1 non-skill dimension was extracted.
   *  - no_eligible_dimension_found: JD parsed fine for skills but stated no seniority/language/
   *    education/domain requirement (honest "none in this JD", not "no gap").
   *  - not_extracted: a JD was pasted but couldn't be read (it also failed to yield skills).
   *  - not_requested: no JD was pasted (role-rubric / no-basis match) — nothing to extract from. */
  status?: 'available' | 'no_eligible_dimension_found' | 'not_extracted' | 'not_requested';
}

export interface GapReportCore {
  target_role: string | null;
  /** null when the match had no requirement basis (source none) — TRUST' honest-zero passthrough. */
  overall_score: number | null;
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
  /** Wave ACTION (A1/A2): deterministic safe_apply/stretch/not_recommended verdict, input score =
   *  overall_score (the match score, not re-scored). unmet_deal_breakers (confirmed) and
   *  unverified_deal_breakers (cannot-grade) are both derived from jd_intelligence dims (see
   *  buildGapReportCore) — always [] on the v1 path (no jd_intelligence). */
  fit?: FitVerdict;
}

const SENIORITY_NOTE = {
  vi: 'Cấp độ JD chưa trích xuất được từ JD dán (sẽ bổ sung) — chỉ hiển thị ước lượng phía CV, không kết luận hợp/lệch.',
  en: 'The pasted JD carries no extracted level yet — only the CV-side estimate is shown; no fit verdict is made.',
} as const;
const SENIORITY_GRADED_NOTE = {
  vi: 'Đã trích xuất cấp độ JD và so sánh với ước lượng kinh nghiệm phía CV.',
  en: 'The JD level was extracted and compared with the CV-side experience estimate.',
} as const;

const JD_INTEL_NOTE = {
  vi: 'Đã chấm gap cho cấp độ/kinh nghiệm, ngôn ngữ, học vấn và lĩnh vực khi CV có tín hiệu tương ứng. Hình thức làm việc chỉ hiển thị (không chấm gap). Các mục không đủ tín hiệu phía CV được bỏ qua một cách trung thực.',
  en: 'Seniority, language, education and domain are graded when the CV carries a matching signal. Work mode is disclosure-only (not graded). Dimensions without enough CV-side signal are honestly omitted.',
} as const;

/** TRUST' T4 copy per empty-dimension status. Each is honest about WHY there are no dimensions —
 *  never a claim that "there is no seniority/language gap". */
const JD_INTEL_EMPTY_NOTE: Record<
  'no_eligible_dimension_found' | 'not_extracted' | 'not_requested',
  { vi: string; en: string }
> = {
  no_eligible_dimension_found: {
    vi: 'JD đã được đọc nhưng không nêu yêu cầu phi kỹ năng nào (cấp độ, ngôn ngữ, học vấn, lĩnh vực) — không phải kết luận "không có gap".',
    en: 'The JD was read but states no non-skill requirement (seniority, language, education, domain) — this is not a conclusion that "there is no gap".',
  },
  not_extracted: {
    vi: 'Không đọc được yêu cầu phi kỹ năng từ JD này (JD có thể ở định dạng khó đọc). Chưa thể kết luận có hay không yêu cầu về cấp độ/ngôn ngữ/học vấn/lĩnh vực.',
    en: 'Non-skill requirements could not be read from this JD (it may be in a hard-to-parse format). Whether it requires a seniority/language/education/domain level is undetermined.',
  },
  not_requested: {
    vi: 'Chưa dán JD nên không có yêu cầu phi kỹ năng để đối chiếu.',
    en: 'No JD was provided, so there are no non-skill requirements to compare against.',
  },
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
  return { dimensions, note: JD_INTEL_NOTE[lang], status: 'available' };
}

const EMPHASIS_JD_MIN = 2;
const EMPHASIS_CV_MAX = 1;

/** A JD-Intelligence dim's requirement counts as MET when the graded seniority verdict says the CV
 *  fits or exceeds it (`fits`/`over_qualified`). `stretch` and `unknown` are graded-but-not-met.
 *  `verdict === null` is a SEPARATE bucket handled by the caller (buildGapReportCore) — it means the
 *  dim was never gradeable at all (language/education/domain/work_mode carry no ExperienceVerdict
 *  today), i.e. "cannot verify", which is NOT the same claim as "confirmed unmet". */
function isDimVerdictMet(verdict: ExperienceVerdict | null): boolean {
  return verdict === 'fits' || verdict === 'over_qualified';
}

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

  // PR3 + TRUST' T4: build the JD-Intelligence disclosure. When v2 extracted dimensions → 'available'.
  // When v2 RAN but dims are empty, disambiguate WHY instead of silently omitting (a missed non-skill
  // requirement must not read as "no such gap"): JD parsed for skills but stated none →
  // no_eligible_dimension_found; JD pasted but unreadable (also failed to yield skills) → not_extracted;
  // no JD pasted at all → not_requested. The v1 path (attempted falsy) still omits (byte-identical).
  const jdDims = match.jd_dimensions ?? [];
  const emptyStatus: 'no_eligible_dimension_found' | 'not_extracted' | 'not_requested' =
    match.source_of_requirements === 'jd_extraction'
      ? 'no_eligible_dimension_found'
      : match.fell_back_to_rubric
        ? 'not_extracted'
        : 'not_requested';
  const jd_intelligence: JdIntelligenceBlock | undefined = jdDims.length
    ? buildJdIntelligence(jdDims, cvSeniority, cvSignals, lang)
    : match.jd_dimensions_attempted
      ? { dimensions: [], note: JD_INTEL_EMPTY_NOTE[emptyStatus][lang], status: emptyStatus }
      : undefined;

  // E5 (v2-flip): reuse the SAME gradeSeniority() decision jd_intelligence.dimensions[].verdict
  // already carries, so the two blocks can never disagree. null/'unknown' when ungradeable —
  // byte-identical to the pre-E5 hardcoded fallback.
  const seniorityGrade = gradeSeniority(jdDims, cvSeniority);
  const seniorityVerdict = seniorityGrade?.verdict ?? 'unknown';

  // A1/A2 (Wave ACTION): split deal-breaker dims into two honest buckets — see isDimVerdictMet above.
  // Both are [] on the v1 path (no jd_intelligence extracted at all, byte-identical fallback).
  //  - unmetDealBreakers: CONFIRMED unmet — graded (verdict !== null) and not fits/over_qualified.
  //    Only seniority is gradeable today, so only a graded seniority deal-breaker can land here.
  //  - unverifiedDealBreakers: verdict === null — never gradeable at all (language/education/domain/
  //    work_mode). "Cannot verify" is not "unmet"; classifyFit caps these at stretch instead of
  //    fabricating a not_recommended.
  const dealBreakerDims = (jd_intelligence?.dimensions ?? []).filter((d) => d.deal_breaker);
  const unmetDealBreakers = dealBreakerDims
    .filter((d) => d.verdict !== null && !isDimVerdictMet(d.verdict))
    .map((d) => d.value_text);
  const unverifiedDealBreakers = dealBreakerDims
    .filter((d) => d.verdict === null)
    .map((d) => d.value_text);

  // No score basis → no fit verdict; fabricating one from a null score would be the exact
  // dishonesty TRUST' removes (fit stays optional on GapReportCore).
  const fit =
    match.overall_score === null
      ? undefined
      : classifyFit({
          score: match.overall_score,
          required_coverage: match.required_coverage,
          seniority_verdict: seniorityVerdict,
          unmet_deal_breakers: unmetDealBreakers,
          unverified_deal_breakers: unverifiedDealBreakers,
        });

  return {
    target_role: match.target_role,
    overall_score: match.overall_score,
    source_of_requirements: match.source_of_requirements,
    explicit_gaps: match.missing_skills,
    proficiency_gaps: match.partial_skills,
    evidence_gaps,
    seniority: {
      cv: cvSeniority,
      jd_level: seniorityGrade?.dim.level_hint ?? null,
      verdict: seniorityVerdict,
      note: seniorityGrade ? SENIORITY_GRADED_NOTE[lang] : SENIORITY_NOTE[lang],
    },
    jd_emphasis_gaps,
    strengths: { matched: match.matched_skills, demonstrated, bonus: match.bonus_skills },
    ...(jd_intelligence ? { jd_intelligence } : {}),
    language: lang,
    fit,
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

/**
 * GapItem types that map to a learnable skill the course catalog can address. hard_skill / soft_skill
 * carry a real taxonomy canonical; language maps to a single English-proficiency canonical (below).
 * seniority / education / domain / work_mode are advisory / experience / credential / preference gaps
 * with no course skill in the current catalog — they are NOT promoted to roadmap learning skills (v1).
 */
const COURSE_ADDRESSABLE_TYPES: ReadonlySet<GapItem['type']> = new Set([
  'hard_skill',
  'soft_skill',
  'language',
]);

/**
 * Derive the LEARNING roadmap input from canonical GapItems. A gap becomes a learning skill ONLY when
 * it is both (1) `fixability === 'learn'` — `rewrite` / `add_evidence` / `not_fixable_now` are
 * CV-tailoring / evidence / unfixable, not learning needs — and (2) a course-addressable `type`
 * (see COURSE_ADDRESSABLE_TYPES). `language` gaps map to the `english_proficiency` canonical so the
 * CourseMatcher can find English courses (IT/VN context → the JD language requirement is English).
 * Preserves the incoming order (gap_items are already severity-ranked by buildGapItems). Used by the
 * platform from-match roadmap route (gaps derived server-side, never trusting client-supplied skills).
 */
export function deriveRoadmapGapsFromReport(gapItems: GapItem[]): {
  missing_skills: RoadmapSkillRequirementInput[];
  partial_skills: RoadmapSkillRequirementInput[];
} {
  const missing_skills: RoadmapSkillRequirementInput[] = [];
  const partial_skills: RoadmapSkillRequirementInput[] = [];
  for (const g of gapItems) {
    if (g.fixability !== 'learn' || g.required_level == null) continue;
    if (!COURSE_ADDRESSABLE_TYPES.has(g.type)) continue;
    const req: RoadmapSkillRequirementInput = {
      skill_canonical_name: g.type === 'language' ? 'english_proficiency' : g.canonical_name,
      display_name: g.display_name,
      required_level: g.required_level,
      current_level: g.cv_level ?? 0,
      importance: g.importance,
    };
    if (g.cv_status === 'partial') partial_skills.push(req);
    else missing_skills.push(req);
  }
  return { missing_skills, partial_skills };
}
