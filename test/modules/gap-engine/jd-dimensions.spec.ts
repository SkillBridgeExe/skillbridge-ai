import { buildGapItems, gradeJdDimensions } from '../../../src/modules/gap-engine/gap-item';
import { normalizeJdDimensions, JdDimension } from '../../../src/modules/gap-engine/jd-dimensions';
import { CvJdMatchParsedResponse } from '../../../src/modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { CvSeniority } from '../../../src/common/services/seniority';

/**
 * PR3 — JD-Intelligence v2. The non-skill dimension extraction (normalizeJdDimensions, pure) +
 * the seniority-only grader (gradeJdDimensions, pure) + its additive integration into buildGapItems.
 * Deterministic; reuses computeSeverity UNCHANGED (PR2 golden severities must not move).
 */
const sen = (over: Partial<CvSeniority> = {}): CvSeniority => ({
  bucket: 'fresher',
  est_years: null,
  confidence: 'high',
  signals: [],
  ...over,
});

const dim = (over: Partial<JdDimension> = {}): JdDimension => ({
  dimension: 'seniority',
  value_text: 'Senior',
  level_hint: 'SENIOR',
  min_years: 5,
  importance: 'REQUIRED',
  deal_breaker: true,
  evidence_text: 'Requires a Senior engineer with 5+ years',
  ...over,
});

const emptyMatch = (over: Partial<CvJdMatchParsedResponse> = {}): CvJdMatchParsedResponse => ({
  overall_score: 0,
  match_ratio: 0,
  matched_skills: [],
  partial_skills: [],
  missing_skills: [],
  bonus_skills: [],
  required_coverage: 0,
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
  target_role: 'backend_developer',
  ...over,
});

describe('normalizeJdDimensions (PR3, pure)', () => {
  it('hardens raw LLM output: keeps valid, coerces enums/level, defaults importance', () => {
    const [g] = normalizeJdDimensions([
      {
        dimension: 'seniority',
        value_text: 'Senior',
        level_hint: 'senior',
        min_years: 5,
        importance_hint: 'required',
        deal_breaker: false,
        evidence_text: 'Senior backend engineer',
      },
    ]);
    expect(g.dimension).toBe('seniority');
    expect(g.level_hint).toBe('SENIOR'); // uppercased to a JOB_LEVEL_RANK key
    expect(g.importance).toBe('REQUIRED');
    expect(g.min_years).toBe(5);
  });

  it('DROPS an entry with no evidence_text (anti-fabrication)', () => {
    expect(normalizeJdDimensions([{ dimension: 'seniority', level_hint: 'SENIOR' }])).toEqual([]);
  });

  it('DROPS an unknown dimension type', () => {
    expect(
      normalizeJdDimensions([{ dimension: 'salary', value_text: '$x', evidence_text: 'pays $x' }]),
    ).toEqual([]);
  });

  it('seniority level_hint that is not a known rank → null (cannot be graded)', () => {
    const [g] = normalizeJdDimensions([
      { dimension: 'seniority', level_hint: 'staff', evidence_text: 'Staff engineer' },
    ]);
    expect(g.level_hint).toBeNull();
  });

  it('deal_breaker forces importance REQUIRED even without a hint', () => {
    const [g] = normalizeJdDimensions([
      {
        dimension: 'seniority',
        level_hint: 'SENIOR',
        deal_breaker: true,
        evidence_text: 'must be senior',
      },
    ]);
    expect(g.importance).toBe('REQUIRED');
  });

  it('non-seniority dim keeps its raw level qualifier (no rank coercion)', () => {
    const [g] = normalizeJdDimensions([
      {
        dimension: 'language',
        value_text: 'English B2',
        level_hint: 'B2',
        evidence_text: 'English B2 required',
      },
    ]);
    expect(g.dimension).toBe('language');
    expect(g.level_hint).toBe('B2');
    expect(g.importance).toBe('PREFERRED'); // default when no hint / not a deal-breaker
  });

  it('ignores non-array input', () => {
    expect(normalizeJdDimensions(null)).toEqual([]);
    expect(normalizeJdDimensions({})).toEqual([]);
  });
});

describe('gradeJdDimensions (PR3, seniority-only, pure)', () => {
  it('senior-required (deal-breaker) vs fresher → missing, gap 3, severity 0.408', () => {
    const [g] = gradeJdDimensions({
      jdDimensions: [dim()],
      cvSeniority: sen({ bucket: 'fresher' }),
      source: 'jd',
    });
    expect(g.type).toBe('seniority');
    expect(g.canonical_name).toBe('seniority');
    expect(g.cv_status).toBe('missing');
    expect(g.gap_levels).toBe(3);
    expect(g.importance).toBe('REQUIRED');
    expect(g.cv_level).toBe(2); // fresher rank 1 + 1
    expect(g.required_level).toBe(5); // SENIOR rank 4 + 1
    expect(g.fixability).toBe('learn');
    expect(g.severity).toBe(0.408); // NEW golden — REQ missing gap3, no market
    expect(g.requirement_id).toBe('jd:seniority:seniority');
    expect(g.confidence).toBe(0.8); // high-confidence CV signal
    expect(g.recommended_next_action).not.toBe('');
  });

  it('within ±1 of the JD level → matched, no penalty (consistent with computeExperienceFit)', () => {
    // CV junior (rank 2) vs JD MIDDLE (rank 3): one level below → 'fits' tolerance → matched, severity 0.
    // This is the regression guard for the must-fix: gap_items must NOT report a penalty where
    // jd_intelligence (computeExperienceFit) reports 'fits'.
    const [g] = gradeJdDimensions({
      jdDimensions: [dim({ level_hint: 'MIDDLE', importance: 'REQUIRED', deal_breaker: false })],
      cvSeniority: sen({ bucket: 'junior', confidence: 'high' }),
      source: 'jd',
    });
    expect(g.cv_status).toBe('matched');
    expect(g.gap_levels).toBe(0);
    expect(g.severity).toBe(0);
  });

  it('≥2 levels below the JD → missing (stretch), gap 2, severity 0.278', () => {
    // CV fresher (rank 1) vs JD MIDDLE (rank 3): two below → 'stretch' → a real gap.
    const [g] = gradeJdDimensions({
      jdDimensions: [dim({ level_hint: 'MIDDLE', importance: 'REQUIRED', deal_breaker: false })],
      cvSeniority: sen({ bucket: 'fresher', confidence: 'high' }),
      source: 'jd',
    });
    expect(g.cv_status).toBe('missing');
    expect(g.gap_levels).toBe(2);
    expect(g.severity).toBe(0.278);
  });

  it('collapses duplicate seniority dims to ONE GapItem (strictest level)', () => {
    const items = gradeJdDimensions({
      jdDimensions: [
        dim({ level_hint: 'MIDDLE', deal_breaker: false }),
        dim({ level_hint: 'SENIOR', deal_breaker: true }),
      ],
      cvSeniority: sen({ bucket: 'fresher', confidence: 'high' }),
      source: 'jd',
    });
    expect(items).toHaveLength(1);
    expect(items[0].required_level).toBe(5); // strictest = SENIOR (rank 4 + 1)
    expect(items[0].cv_status).toBe('missing');
  });

  it('senior-required vs senior CV → matched, severity 0', () => {
    const [g] = gradeJdDimensions({
      jdDimensions: [dim()],
      cvSeniority: sen({ bucket: 'senior', confidence: 'high' }),
      source: 'jd',
    });
    expect(g.cv_status).toBe('matched');
    expect(g.gap_levels).toBe(0);
    expect(g.severity).toBe(0);
    expect(g.fixability).toBe('not_fixable_now');
    expect(g.recommended_next_action).toBe('');
  });

  it('over-qualified (senior CV, junior JD) → matched, no penalty', () => {
    const [g] = gradeJdDimensions({
      jdDimensions: [dim({ level_hint: 'JUNIOR' })],
      cvSeniority: sen({ bucket: 'senior', confidence: 'high' }),
      source: 'jd',
    });
    expect(g.cv_status).toBe('matched');
    expect(g.severity).toBe(0);
  });

  it('medium-confidence CV → confidence 0.6', () => {
    const [g] = gradeJdDimensions({
      jdDimensions: [dim()],
      cvSeniority: sen({ bucket: 'fresher', confidence: 'medium' }),
      source: 'jd',
    });
    expect(g.confidence).toBe(0.6);
  });

  describe('honest omission — emit NOTHING (no fabrication)', () => {
    it('no CV seniority signal', () => {
      expect(gradeJdDimensions({ jdDimensions: [dim()], cvSeniority: null, source: 'jd' })).toEqual(
        [],
      );
    });
    it('low-confidence CV signal', () => {
      expect(
        gradeJdDimensions({
          jdDimensions: [dim()],
          cvSeniority: sen({ confidence: 'low' }),
          source: 'jd',
        }),
      ).toEqual([]);
    });
    it('JD states no parseable level', () => {
      expect(
        gradeJdDimensions({
          jdDimensions: [dim({ level_hint: null })],
          cvSeniority: sen(),
          source: 'jd',
        }),
      ).toEqual([]);
    });
    it('non-seniority dimensions are NOT graded in PR3', () => {
      expect(
        gradeJdDimensions({
          jdDimensions: [
            {
              dimension: 'language',
              value_text: 'English B2',
              level_hint: 'B2',
              min_years: null,
              importance: 'REQUIRED',
              deal_breaker: false,
              evidence_text: 'English B2',
            },
            {
              dimension: 'work_mode',
              value_text: 'Onsite',
              level_hint: null,
              min_years: null,
              importance: 'REQUIRED',
              deal_breaker: true,
              evidence_text: 'Onsite only',
            },
          ],
          cvSeniority: sen(),
          source: 'jd',
        }),
      ).toEqual([]);
    });
  });
});

describe('buildGapItems — non-skill integration (PR3, additive)', () => {
  const missing = (over = {}) => ({
    skill_id: 'kubernetes',
    canonical_name: 'kubernetes',
    display_name: 'Kubernetes',
    required_level: 4,
    importance: 'NICE_TO_HAVE' as const,
    weight: 0.2,
    skill_type: 'hard' as const,
    gap_levels: 4,
    ...over,
  });

  it('a REQUIRED seniority gap interleaves and can outrank a NICE missing skill', () => {
    const items = buildGapItems({
      match: emptyMatch({ missing_skills: [missing()] }),
      jdDimensions: [dim()], // REQUIRED senior, deal-breaker
      cvSeniority: sen({ bucket: 'fresher', confidence: 'high' }),
    });
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe('seniority'); // REQUIRED seniority (0.408) outranks NICE skill
    expect(items[0].canonical_name).toBe('seniority');
    expect(items[1].canonical_name).toBe('kubernetes');
  });

  it('ADDITIVE: with jdDimensions absent, output is byte-identical to the baseline', () => {
    const base = buildGapItems({ match: emptyMatch({ missing_skills: [missing()] }) });
    const withEmpty = buildGapItems({
      match: emptyMatch({ missing_skills: [missing()] }),
      jdDimensions: [],
      cvSeniority: sen(),
    });
    expect(withEmpty).toEqual(base);
    expect(base.every((g) => g.type === 'hard_skill' || g.type === 'soft_skill')).toBe(true);
  });

  it('no seniority emitted when CV signal absent, even if JD dimension present', () => {
    const items = buildGapItems({
      match: emptyMatch({ missing_skills: [missing()] }),
      jdDimensions: [dim()],
      cvSeniority: null,
    });
    expect(items.every((g) => g.type !== 'seniority')).toBe(true);
    expect(items).toHaveLength(1);
  });
});
