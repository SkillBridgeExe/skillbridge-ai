import {
  BonusSkill,
  MatchedSkill,
  MissingSkill,
  PartialSkill,
} from '../cv-jd-match/skill-diff.service';
import { CvJdMatchParsedResponse } from '../cv-jd-match/dto/cv-jd-match-response.dto';
import { EvidenceLedger } from '../../common/services/evidence-ledger';
import { CvSeniority } from '../../common/services/seniority';

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
  /** HONEST v1: pasted JDs carry no extracted level yet — ALWAYS null until JD-intelligence (P1). */
  jd_level: null;
  verdict: 'unknown';
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
  language: 'vi' | 'en';
}

const SENIORITY_NOTE = {
  vi: 'Cấp độ JD chưa trích xuất được từ JD dán (sẽ bổ sung) — chỉ hiển thị ước lượng phía CV, không kết luận hợp/lệch.',
  en: 'The pasted JD carries no extracted level yet — only the CV-side estimate is shown; no fit verdict is made.',
} as const;

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
