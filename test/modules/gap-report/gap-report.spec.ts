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
      sources: [{ kind: 'skills_list' as const, ref: 'Skills', recency_year: null, quote: null }],
      strength: 'listed_only' as const,
      most_recent_year: null,
    })),
    ...demonstrated.map((c) => ({
      skill_canonical: c,
      display_name: c.toUpperCase(),
      sources: [{ kind: 'experience' as const, ref: 'Acme', recency_year: 2026, quote: null }],
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

  // E5: v2-flip — when the match carries an extracted+gradeable seniority jd_dimension, the block
  // must show the REAL verdict (same one gradeSeniority feeds into jd_intelligence — never contradict).
  it('E5: seniority block shows the real jd_level + verdict when jd_dimensions grades a seniority gap', () => {
    const jd_dimensions = [
      {
        dimension: 'seniority' as const,
        value_text: 'Senior level',
        level_hint: 'SENIOR',
        min_years: 5,
        importance: 'REQUIRED' as const,
        deal_breaker: false,
        evidence_text: '5+ years senior experience required',
      },
    ];
    const m = baseMatch({ jd_dimensions });
    const core = buildGapReportCore(m, null, seniority, null, 'en'); // seniority = fresher, high confidence
    expect(core.seniority.jd_level).toBe('SENIOR');
    expect(core.seniority.verdict).toBe('stretch'); // fresher vs SENIOR ⇒ same verdict as jd_intelligence
    expect(core.jd_intelligence?.dimensions[0].verdict).toBe(core.seniority.verdict); // never contradict
    expect(core.seniority.cv).toEqual(seniority);
    expect(core.seniority.note).not.toMatch(/no fit verdict|không kết luận/i);
  });

  it('E5: seniority block keeps byte-identical {null, unknown} fallback when the dim cannot be graded', () => {
    // Low-confidence CV signal ⇒ gradeSeniority returns null even though a seniority dim is present.
    const jd_dimensions = [
      {
        dimension: 'seniority' as const,
        value_text: 'Senior level',
        level_hint: 'SENIOR',
        min_years: 5,
        importance: 'REQUIRED' as const,
        deal_breaker: false,
        evidence_text: '5+ years senior experience required',
      },
    ];
    const lowConfSeniority: CvSeniority = { ...seniority, confidence: 'low' };
    const m = baseMatch({ jd_dimensions });
    const core = buildGapReportCore(m, null, lowConfSeniority, null, 'en');
    expect(core.seniority.jd_level).toBeNull();
    expect(core.seniority.verdict).toBe('unknown');
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
    const gapItems = buildGapItems({
      match: m,
      jdDimensions: jd_dimensions,
      cvProfileSignals: signals,
    });
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

describe("TRUST' T4: jd_intelligence 4-state status (empty dims are never ambiguous)", () => {
  it('v1 path (attempted falsy) → block OMITTED (byte-identical legacy)', () => {
    const m = baseMatch({ jd_dimensions: [] }); // attempted undefined
    const core = buildGapReportCore(m, null, null, null, 'vi');
    expect(core.jd_intelligence).toBeUndefined();
  });

  it("attempted + empty + JD parsed for skills (jd_extraction) → 'no_eligible_dimension_found'", () => {
    const m = baseMatch({
      jd_dimensions: [],
      jd_dimensions_attempted: true,
      source_of_requirements: 'jd_extraction',
    });
    const core = buildGapReportCore(m, null, null, null, 'vi');
    expect(core.jd_intelligence?.status).toBe('no_eligible_dimension_found');
    expect(core.jd_intelligence?.dimensions).toEqual([]);
  });

  it("attempted + empty + JD pasted but unreadable (fell_back_to_rubric) → 'not_extracted'", () => {
    const m = baseMatch({
      jd_dimensions: [],
      jd_dimensions_attempted: true,
      source_of_requirements: 'role_rubric',
      fell_back_to_rubric: true,
    });
    const core = buildGapReportCore(m, null, null, null, 'en');
    expect(core.jd_intelligence?.status).toBe('not_extracted');
  });

  it("attempted + empty + no JD pasted (role rubric, no fallback) → 'not_requested'", () => {
    const m = baseMatch({
      jd_dimensions: [],
      jd_dimensions_attempted: true,
      source_of_requirements: 'role_rubric',
      fell_back_to_rubric: false,
    });
    const core = buildGapReportCore(m, null, null, null, 'en');
    expect(core.jd_intelligence?.status).toBe('not_requested');
  });

  it("dims present → status 'available'", () => {
    const m = baseMatch({
      jd_dimensions_attempted: true,
      jd_dimensions: [
        {
          dimension: 'seniority',
          value_text: 'Senior',
          level_hint: 'SENIOR',
          min_years: 5,
          importance: 'REQUIRED',
          deal_breaker: false,
          evidence_text: '5+ years senior engineer',
        },
      ],
    });
    const core = buildGapReportCore(m, null, null, null, 'en');
    expect(core.jd_intelligence?.status).toBe('available');
    expect(core.jd_intelligence?.dimensions.length).toBe(1);
  });
});

describe('A1 (Wave ACTION): fit — score=overall_score, deal_breakers from jd_intelligence', () => {
  it('v1 path (no jd_dimensions): fit is present with unmet_deal_breakers=[]', () => {
    const m = baseMatch({ overall_score: 61, required_coverage: 0.5 });
    const core = buildGapReportCore(m, null, null, null, 'vi');
    expect(core.fit).toBeDefined();
    expect(core.fit!.reasons).not.toContain('DEAL_BREAKER_UNMET');
    // score 61 < 65 and coverage 0.5 < 0.7 → not safe_apply.
    expect(core.fit!.verdict).toBe('stretch');
  });

  it('a REQUIRED+deal_breaker seniority dim graded "stretch" → unmet deal breaker → not_recommended', () => {
    const jd_dimensions = [
      {
        dimension: 'seniority' as const,
        value_text: 'Senior level',
        level_hint: 'SENIOR',
        min_years: 5,
        importance: 'REQUIRED' as const,
        deal_breaker: true,
        evidence_text: '5+ years senior experience required, non-negotiable',
      },
    ];
    const m = baseMatch({ jd_dimensions, overall_score: 95, required_coverage: 1 });
    const core = buildGapReportCore(m, null, seniority, null, 'en'); // seniority = fresher ⇒ stretch vs SENIOR
    expect(core.seniority.verdict).toBe('stretch');
    expect(core.fit!.verdict).toBe('not_recommended');
    expect(core.fit!.reasons).toContain('DEAL_BREAKER_UNMET');
    // a REAL graded-unmet verdict ('stretch', non-null) is NOT the same bucket as an ungraded/null one.
    expect(core.fit!.reasons).not.toContain('DEAL_BREAKER_UNVERIFIED');
  });

  it('a deal_breaker dim with a graded "over_qualified" seniority verdict counts as MET (not unmet)', () => {
    const jd_dimensions = [
      {
        dimension: 'seniority' as const,
        value_text: 'Fresher level',
        level_hint: 'FRESHER',
        min_years: 0,
        importance: 'REQUIRED' as const,
        deal_breaker: true,
        evidence_text: 'Fresher role, must be entry-level',
      },
    ];
    const seniorCv: CvSeniority = { ...seniority, bucket: 'senior' };
    const m = baseMatch({ jd_dimensions, overall_score: 90, required_coverage: 1 });
    const core = buildGapReportCore(m, null, seniorCv, null, 'en'); // senior CV vs FRESHER ⇒ over_qualified
    expect(core.seniority.verdict).toBe('over_qualified');
    expect(core.fit!.reasons).not.toContain('DEAL_BREAKER_UNMET');
  });

  it('a deal_breaker dim on an ungraded dimension (language) is UNVERIFIED (not fabricated unmet) — capped at stretch, never safe_apply', () => {
    const jd_dimensions = [
      {
        dimension: 'language' as const,
        value_text: 'English C1',
        level_hint: 'C1',
        min_years: null,
        importance: 'REQUIRED' as const,
        deal_breaker: true,
        evidence_text: 'English C1 mandatory, non-negotiable',
      },
    ];
    const m = baseMatch({ jd_dimensions, overall_score: 90, required_coverage: 1 });
    // Even with a CV signal that plainly meets C1, the dim's `verdict` field stays null (only
    // seniority carries an ExperienceVerdict today) — "cannot verify" must not read as "unmet":
    // it is capped at stretch, never fabricated into not_recommended, and never lets a perfect
    // score/coverage combo slip through to safe_apply either.
    const signals: CvProfileSignals = {
      english: { cefr: 'C1', source_kind: 'ielts', raw: '', confidence: 'high', signals: [] },
      education: null,
      domain: null,
      work_mode: null,
    };
    const core = buildGapReportCore(m, null, null, signals, 'en');
    expect(core.jd_intelligence?.dimensions[0].verdict).toBeNull();
    expect(core.fit!.verdict).toBe('stretch');
    expect(core.fit!.verdict).not.toBe('safe_apply');
    expect(core.fit!.reasons).toContain('DEAL_BREAKER_UNVERIFIED');
    expect(core.fit!.reasons).not.toContain('DEAL_BREAKER_UNMET');
  });

  it('required_coverage flows through verbatim (no re-scoring) — low coverage blocks safe_apply', () => {
    const m = baseMatch({ overall_score: 80, required_coverage: 0.4 });
    const core = buildGapReportCore(m, null, null, null, 'en');
    expect(core.fit!.reasons).toContain('LOW_COVERAGE');
    expect(core.fit!.verdict).not.toBe('safe_apply');
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
