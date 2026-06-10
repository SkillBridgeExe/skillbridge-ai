import { CvJdMatchParsedResponse } from '../../cv-jd-match/dto/cv-jd-match-response.dto';
import { SkillTrendsResponse } from './skill-demand.service';

export type MarketPosition = 'niche' | 'common' | 'standard';

export const NICHE_LT = 10;
export const STANDARD_GTE = 40;
export const IMPLIED_GTE = 40;
export const IMPLIED_CAP = 5;
export const TRENDS_LIMIT = 200;

export interface JdMarketSkill {
  skill_canonical: string;
  display_name: string;
  jd_importance: string;
  pct_of_postings: number;
  posting_count: number;
  trend_delta: number | null;
  position: MarketPosition;
  /** Localized, grounded in OUR pool ("tin hệ thống theo dõi") — never an absolute claim. */
  why: string;
}
export interface ImpliedSkill {
  skill_canonical: string;
  display_name: string;
  pct_of_postings: number;
  posting_count: number;
  trend_delta: number | null;
  /** true = the CV already has it (matched ∪ partial ∪ bonus). */
  covered: boolean;
  why: string;
}

type Lang = 'vi' | 'en';
const T = {
  vi: {
    nicheKnown: (s: string, pct: number) =>
      `Chỉ ${pct}% tin role này trong pool yêu cầu ${s} — yêu cầu khá đặc thù của công ty; đáng tìm hiểu kỹ sản phẩm/stack của họ trước khi phỏng vấn.`,
    nicheAbsent: (s: string) =>
      `${s} hiếm thấy trong tin tuyển dụng role này mà hệ thống theo dõi (pool) — yêu cầu rất đặc thù; đáng hỏi kỹ khi phỏng vấn.`,
    standard: (s: string, pct: number) => `${pct}% tin role này yêu cầu ${s} — chuẩn mặt bằng thị trường.`,
    common: (s: string, pct: number) => `${s} xuất hiện trong ${pct}% tin role này — mức phổ biến trung bình.`,
    impliedCovered: (s: string, pct: number) =>
      `JD không nhắc ${s} nhưng ${pct}% tin role này cần — CV bạn đã có, cứ tự tin thể hiện.`,
    impliedMissing: (s: string, pct: number) =>
      `JD không nhắc ${s} nhưng ${pct}% tin role này cần — ngầm định thị trường, nên chuẩn bị.`,
  },
  en: {
    nicheKnown: (s: string, pct: number) =>
      `Only ${pct}% of tracked postings for this role require ${s} — a company-specific ask; research their product/stack before the interview.`,
    nicheAbsent: (s: string) =>
      `${s} barely appears in the postings we track for this role — a very company-specific ask; probe it in the interview.`,
    standard: (s: string, pct: number) => `${pct}% of postings for this role require ${s} — the market standard.`,
    common: (s: string, pct: number) => `${s} appears in ${pct}% of postings for this role — moderately common.`,
    impliedCovered: (s: string, pct: number) =>
      `The JD never names ${s}, but ${pct}% of postings for this role want it — your CV already has it; show it confidently.`,
    impliedMissing: (s: string, pct: number) =>
      `The JD never names ${s}, but ${pct}% of postings for this role want it — an implied market expectation; be prepared.`,
  },
} as const;

const POSITION_RANK: Record<MarketPosition, number> = { niche: 0, standard: 1, common: 2 };

/**
 * Deterministic JD-vs-market positioning. ALL numbers come from the real skill-demand
 * snapshot (SQL over the jobs pool); thresholds are tunable constants; NO LLM. Display-only:
 * NEVER feeds any score and NEVER turns a market trend into a JD requirement.
 */
export function buildJdMarketPosition(
  match: CvJdMatchParsedResponse,
  trends: SkillTrendsResponse,
  lang: Lang,
): { jd_skills: JdMarketSkill[]; implied: ImpliedSkill[] } {
  const t = T[lang];
  const rowBy = new Map(trends.skills.map((r) => [r.canonical_name, r]));
  const jdReqs = [...match.matched_skills, ...match.partial_skills, ...match.missing_skills];
  const jdSet = new Set(jdReqs.map((r) => r.canonical_name));
  const covered = new Set([
    ...match.matched_skills.map((s) => s.canonical_name),
    ...match.partial_skills.map((s) => s.canonical_name),
    ...match.bonus_skills.map((s) => s.canonical_name),
  ]);

  const seen = new Set<string>();
  const jd_skills: JdMarketSkill[] = [];
  for (const r of jdReqs) {
    if (seen.has(r.canonical_name)) continue;
    seen.add(r.canonical_name);
    const row = rowBy.get(r.canonical_name);
    const pct = row?.pct_of_postings ?? 0;
    const position: MarketPosition =
      pct < NICHE_LT ? 'niche' : pct >= STANDARD_GTE ? 'standard' : 'common';
    const why =
      position === 'niche'
        ? row
          ? t.nicheKnown(r.display_name, pct)
          : t.nicheAbsent(r.display_name)
        : position === 'standard'
          ? t.standard(r.display_name, pct)
          : t.common(r.display_name, pct);
    jd_skills.push({
      skill_canonical: r.canonical_name,
      display_name: r.display_name,
      jd_importance: r.importance,
      pct_of_postings: pct,
      posting_count: row?.posting_count ?? 0,
      trend_delta: row?.trend_delta ?? null,
      position,
      why,
    });
  }
  jd_skills.sort(
    (a, b) =>
      POSITION_RANK[a.position] - POSITION_RANK[b.position] ||
      (a.position === 'niche' ? a.pct_of_postings - b.pct_of_postings : b.pct_of_postings - a.pct_of_postings) ||
      a.skill_canonical.localeCompare(b.skill_canonical),
  );

  const implied: ImpliedSkill[] = trends.skills
    .filter((r) => r.pct_of_postings >= IMPLIED_GTE && !jdSet.has(r.canonical_name))
    .sort(
      (a, b) =>
        b.pct_of_postings - a.pct_of_postings || a.canonical_name.localeCompare(b.canonical_name),
    )
    .slice(0, IMPLIED_CAP)
    .map((r) => {
      const has = covered.has(r.canonical_name);
      return {
        skill_canonical: r.canonical_name,
        display_name: r.display_name,
        pct_of_postings: r.pct_of_postings,
        posting_count: r.posting_count,
        trend_delta: r.trend_delta,
        covered: has,
        why: has
          ? t.impliedCovered(r.display_name, r.pct_of_postings)
          : t.impliedMissing(r.display_name, r.pct_of_postings),
      };
    });

  return { jd_skills, implied };
}
