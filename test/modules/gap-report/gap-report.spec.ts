import {
  buildGapReportCore,
  toRoadmapSkillRequirements,
} from '../../../src/modules/gap-report/gap-report';
import {
  MatchedSkill,
  MissingSkill,
  PartialSkill,
  BonusSkill,
} from '../../../src/modules/cv-jd-match/skill-diff.service';
import {
  CvJdMatchParsedResponse,
  KeywordFrequency,
} from '../../../src/modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { EvidenceLedger } from '../../../src/common/services/evidence-ledger';
import { CvSeniority } from '../../../src/common/services/seniority';
import { CvProfileSignals } from '../../../src/common/services/cv-profile-signals';
import { buildGapItems } from '../../../src/modules/gap-engine/gap-item';

const matched = (c: string, w = 0.2, cv = 4, req = 3): MatchedSkill => ({
  skill_id: c,
  canonical_name: c,
  display_name: c.toUpperCase(),
  cv_level: cv,
  required_level: req,
  importance: 'REQUIRED',
  weight: w,
  skill_type: 'hard',
});
const partial = (c: string, cv: number, req: number): PartialSkill => ({
  ...matched(c, 0.2, cv, req),
  gap_levels: req - cv,
});
const missing = (c: string, imp: 'REQUIRED' | 'PREFERRED' = 'REQUIRED'): MissingSkill => ({
  skill_id: c,
  canonical_name: c,
  display_name: c.toUpperCase(),
  required_level: 3,
  importance: imp,
  weight: 0.2,
  skill_type: 'hard',
  gap_levels: 3,
});
const bonus = (c: string): BonusSkill =>
  ({ canonical_name: c, display_name: c.toUpperCase(), cv_level: 3 }) as BonusSkill;
const kf = (c: string, cvN: number, jdN: number): KeywordFrequency => ({
  canonical_name: c,
  display_name: c.toUpperCase(),
  cv_count: cvN,
  jd_count: jdN,
});
const baseMatch = (over: Partial<CvJdMatchParsedResponse>): CvJdMatchParsedResponse =>
  ({
    overall_score: 61,
    match_ratio: 50,
    required_coverage: 0.5,
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
    bonus_skills: [],
    unnormalized_cv_skills: [],
    unnormalized_jd_requirements: [],
    scoring_breakdown: {
      total_requirements: 0,
      matched_count: 0,
      partial_count: 0,
      missing_count: 0,
      weight_sum: 0,
      achieved_weight: 0,
      required_total: 0,
      required_met: 0,
      raw_weighted_score: 0,
      cap_applied: false,
    },
    source_of_requirements: 'jd_extraction',
    target_role: 'frontend_developer',
    ...over,
  }) as CvJdMatchParsedResponse;
const ledgerOf = (gap: string[], demonstrated: string[]): EvidenceLedger => ({
  evidence_gap: gap,
  items: [
    ...gap.map((c) => ({
      skill_canonical: c,
      display_name: c.toUpperCase(),
      sources: [{ kind: 'skills_list' as const, ref: 'Skills', recency_year: null }],
      strength: 'listed_only' as const,
      most_recent_year: null,
    })),
    ...demonstrated.map((c) => ({
      skill_canonical: c,
      display_name: c.toUpperCase(),
      sources: [{ kind: 'experience' as const, ref: 'Acme', recency_year: 2026 }],
      strength: 'demonstrated' as const,
      most_recent_year: 2026,
    })),
  ],
});
const seniority: CvSeniority = {
  bucket: 'fresher',
  est_years: null,
  confidence: 'high',
  signals: ['0 work entries', '1 project'],
};

describe('buildGapReportCore (pure)', () => {
  it('echoes explicit/proficiency gaps verbatim and never recomputes the score', () => {
    const m = baseMatch({
      missing_skills: [missing('html'), missing('graphql', 'PREFERRED')],
      partial_skills: [partial('react', 2, 4)],
    });
    const core = buildGapReportCore(m, null, null, null, 'vi');
    expect(core.explicit_gaps).toEqual(m.missing_skills); // verbatim echo, PREFERRED included
    expect(core.proficiency_gaps).toEqual(m.partial_skills);
    expect(core.overall_score).toBe(61);
    expect(core.target_role).toBe('frontend_developer');
  });

  it('evidence_gaps = (matched ∪ partial) ∩ ledger.evidence_gap — JD-relevant only', () => {
    const m = baseMatch({
      matched_skills: [matched('docker')],
      partial_skills: [partial('sql', 2, 4)],
      bonus_skills: [bonus('unity')],
    });
    const core = buildGapReportCore(m, ledgerOf(['docker', 'sql', 'unity'], []), null, null, 'vi');
    expect(core.evidence_gaps.map((e) => e.skill_canonical).sort()).toEqual(['docker', 'sql']);
    // unity is bonus (JD doesn't require) → NOT an evidence GAP for this JD
    const sqlItem = core.evidence_gaps.find((e) => e.skill_canonical === 'sql')!;
    expect(sqlItem.cv_level).toBe(2);
    expect(sqlItem.required_level).toBe(4);
  });

  it('jd_emphasis_gaps: jd_count>=2 && cv_count<=1 over matched∪partial, uncapped', () => {
    const m = baseMatch({
      matched_skills: [matched('a'), matched('b'), matched('c'), matched('d')],
      keyword_frequency: [kf('a', 0, 2), kf('b', 1, 3), kf('c', 2, 5), kf('d', 0, 1)],
    });
    const core = buildGapReportCore(m, null, null, null, 'vi');
    expect(core.jd_emphasis_gaps.map((e) => e.skill_canonical).sort()).toEqual(['a', 'b']);
    expect(core.jd_emphasis_gaps[0].jd_count).toBeGreaterThanOrEqual(2);
  });

  it('strengths: matched verbatim + demonstrated canonicals from ledger + bonus', () => {
    const m = baseMatch({ matched_skills: [matched('react')], bonus_skills: [bonus('unity')] });
    const core = buildGapReportCore(m, ledgerOf([], ['react']), null, null, 'vi');
    expect(core.strengths.matched).toEqual(m.matched_skills);
    expect(core.strengths.demonstrated).toEqual(['react']);
    expect(core.strengths.bonus).toEqual(m.bonus_skills);
  });

  it('seniority block is honest: cv side only, jd_level null, verdict unknown; null-safe', () => {
    const withCv = buildGapReportCore(baseMatch({}), null, seniority, null, 'vi');
    expect(withCv.seniority).toMatchObject({ cv: seniority, jd_level: null, verdict: 'unknown' });
    expect(withCv.seniority.note.length).toBeGreaterThan(0);
    const without = buildGapReportCore(baseMatch({}), null, null, null, 'en');
    expect(without.seniority.cv).toBeNull();
  });

  it('ledger null → evidence_gaps [] and demonstrated [] (generated_with_ledger handled by service)', () => {
    const core = buildGapReportCore(
      baseMatch({ matched_skills: [matched('x')] }),
      null,
      null,
      null,
      'vi',
    );
    expect(core.evidence_gaps).toEqual([]);
    expect(core.strengths.demonstrated).toEqual([]);
  });

  it('PR3c: grades language/domain (graded=true), keeps cv_signal, verdict stays seniority-only', () => {
    const m = baseMatch({
      jd_dimensions: [
        {
          dimension: 'language',
          value_text: 'English B2',
          level_hint: 'B2',
          min_years: null,
          importance: 'PREFERRED',
          deal_breaker: false,
          evidence_text: 'English B2 preferred',
        },
        {
          dimension: 'domain',
          value_text: 'E-commerce',
          level_hint: null,
          min_years: null,
          importance: 'PREFERRED',
          deal_breaker: false,
          evidence_text: 'e-commerce background a plus',
        },
      ],
    });
    const signals: CvProfileSignals = {
      english: {
        cefr: 'B2',
        source_kind: 'ielts',
        raw: 'English (IELTS 6.5)',
        confidence: 'high',
        signals: [],
      },
      education: null,
      domain: { domains: ['ecommerce'], confidence: 'low', signals: [] },
      work_mode: null,
    };
    const core = buildGapReportCore(m, null, null, signals, 'en');
    const byDim = Object.fromEntries(
      (core.jd_intelligence?.dimensions ?? []).map((d) => [d.dimension, d]),
    );
    // CV B2 == JD B2 → matched; CV ecommerce == JD ecommerce → matched. Both are graded now.
    expect(byDim.language.cv_signal).toBe('B2 (ielts) · high');
    expect(byDim.language.graded).toBe(true);
    expect(byDim.language.verdict).toBeNull(); // verdict is seniority-only (ExperienceVerdict)
    expect(byDim.domain.cv_signal).toBe('ecommerce · low');
    expect(byDim.domain.graded).toBe(true);
    expect(byDim.domain.verdict).toBeNull();
  });

  it('PR3c: work_mode is never graded; a CV-silent PREFERRED dim stays graded=false', () => {
    const m = baseMatch({
      jd_dimensions: [
        {
          dimension: 'work_mode',
          value_text: 'Onsite',
          level_hint: null,
          min_years: null,
          importance: 'REQUIRED',
          deal_breaker: true,
          evidence_text: 'Onsite only',
        },
        {
          dimension: 'language',
          value_text: 'English B2',
          level_hint: 'B2',
          min_years: null,
          importance: 'PREFERRED',
          deal_breaker: false,
          evidence_text: 'English B2 preferred',
        },
      ],
    });
    const signals: CvProfileSignals = {
      english: null, // CV silent + PREFERRED language → omitted (graded=false)
      education: null,
      domain: null,
      work_mode: { mode: 'remote', confidence: 'low', signals: [] },
    };
    const core = buildGapReportCore(m, null, null, signals, 'en');
    const byDim = Object.fromEntries(
      (core.jd_intelligence?.dimensions ?? []).map((d) => [d.dimension, d]),
    );
    expect(byDim.work_mode.graded).toBe(false); // disclosure-only, even as a deal-breaker
    expect(byDim.work_mode.cv_signal).toBe('remote · low');
    expect(byDim.language.graded).toBe(false); // CV silent + PREFERRED → omitted
  });

  it('PR3c: jd_intelligence.graded never contradicts gap_items (shared graders)', () => {
    const jd_dimensions = [
      {
        dimension: 'language' as const,
        value_text: 'English B2',
        level_hint: 'B2',
        min_years: null,
        importance: 'REQUIRED' as const,
        deal_breaker: false,
        evidence_text: 'English B2 required',
      },
      {
        dimension: 'work_mode' as const,
        value_text: 'Onsite',
        level_hint: null,
        min_years: null,
        importance: 'REQUIRED' as const,
        deal_breaker: true,
        evidence_text: 'Onsite only',
      },
    ];
    const m = baseMatch({ jd_dimensions });
    const signals: CvProfileSignals = {
      english: { cefr: 'A2', source_kind: 'cefr', raw: '', confidence: 'low', signals: [] },
      education: null,
      domain: null,
      work_mode: null,
    };
    const core = buildGapReportCore(m, null, null, signals, 'en');
    const gapItems = buildGapItems({ match: m, jdDimensions: jd_dimensions, cvProfileSignals: signals });
    const gradedDims = new Set(
      (core.jd_intelligence?.dimensions ?? []).filter((d) => d.graded).map((d) => d.dimension),
    );
    const gapTypes = new Set(gapItems.map((g) => g.type));
    // language A2 vs B2 REQUIRED → a missing language GapItem + graded language; work_mode neither.
    expect(gradedDims.has('language')).toBe(true);
    expect(gapTypes.has('language')).toBe(true);
    expect(gradedDims.has('work_mode')).toBe(false);
    expect(gapTypes.has('work_mode')).toBe(false);
  });

  it('PR3b: cv_signal stays null when the CV has no signal for that dimension (no fabrication)', () => {
    const m = baseMatch({
      jd_dimensions: [
        {
          dimension: 'work_mode',
          value_text: 'Onsite',
          level_hint: null,
          min_years: null,
          importance: 'PREFERRED',
          deal_breaker: false,
          evidence_text: 'onsite in HCMC',
        },
      ],
    });
    const core = buildGapReportCore(
      m,
      null,
      null,
      { english: null, education: null, domain: null, work_mode: null },
      'en',
    );
    expect(core.jd_intelligence?.dimensions[0].cv_signal).toBeNull();
  });
});

describe('toRoadmapSkillRequirements (the P0 roadmap-trust fix)', () => {
  it('maps explicit→missing (current_level 0) and proficiency→partial (current_level=cv_level) in the exact DTO shape', () => {
    const m = baseMatch({
      missing_skills: [missing('html')],
      partial_skills: [partial('react', 2, 4)],
    });
    const core = buildGapReportCore(m, null, null, null, 'vi');
    const out = toRoadmapSkillRequirements(core);
    expect(out.missing_skills).toEqual([
      {
        skill_canonical_name: 'html',
        display_name: 'HTML',
        required_level: 3,
        current_level: 0,
        importance: 'REQUIRED',
        weight: 0.2,
      },
    ]);
    expect(out.partial_skills).toEqual([
      {
        skill_canonical_name: 'react',
        display_name: 'REACT',
        required_level: 4,
        current_level: 2,
        importance: 'REQUIRED',
        weight: 0.2,
      },
    ]);
  });
});
