import { buildGapItems, gradeJdDimensions } from '../../../src/modules/gap-engine/gap-item';
import {
  normalizeJdDimensions,
  gradeNonSkillDimensions,
  JdDimension,
} from '../../../src/modules/gap-engine/jd-dimensions';
import { CvJdMatchParsedResponse } from '../../../src/modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { CvSeniority } from '../../../src/common/services/seniority';
import { CvProfileSignals } from '../../../src/common/services/cv-profile-signals';

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

  it('same-rank duplicate → keeps the MORE SEVERE (deal-breaker / importance), order-independent (P2)', () => {
    // Both SENIOR, but a PREFERRED non-deal-breaker is listed BEFORE a REQUIRED deal-breaker. The
    // tie-break must keep the REQUIRED one so severity reflects the real requirement (0.408, not 0.245).
    const items = gradeJdDimensions({
      jdDimensions: [
        dim({ level_hint: 'SENIOR', importance: 'PREFERRED', deal_breaker: false }),
        dim({ level_hint: 'SENIOR', importance: 'REQUIRED', deal_breaker: true }),
      ],
      cvSeniority: sen({ bucket: 'fresher', confidence: 'high' }),
      source: 'jd',
    });
    expect(items).toHaveLength(1);
    expect(items[0].importance).toBe('REQUIRED');
    expect(items[0].severity).toBe(0.408);
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
    it('PR3c: work_mode never grades; a soft-requirement language dim with no CV signal omits', () => {
      // No cvProfileSignals supplied (CV silent). A PREFERRED language dim → omit; work_mode → never.
      expect(
        gradeJdDimensions({
          jdDimensions: [
            {
              dimension: 'language',
              value_text: 'English B2',
              level_hint: 'B2',
              min_years: null,
              importance: 'PREFERRED',
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

// ── PR3c — non-skill graders (language/education/domain; work_mode disclosure-only) ──────────
const langDim = (over: Partial<JdDimension> = {}): JdDimension => ({
  dimension: 'language',
  value_text: 'English B2',
  level_hint: 'B2',
  min_years: null,
  importance: 'REQUIRED',
  deal_breaker: false,
  evidence_text: 'English B2 required',
  ...over,
});
const eduDim = (over: Partial<JdDimension> = {}): JdDimension => ({
  dimension: 'education',
  value_text: "Bachelor's degree",
  level_hint: null,
  min_years: null,
  importance: 'REQUIRED',
  deal_breaker: false,
  evidence_text: "Bachelor's degree in Computer Science",
  ...over,
});
const domDim = (over: Partial<JdDimension> = {}): JdDimension => ({
  dimension: 'domain',
  value_text: 'fintech',
  level_hint: null,
  min_years: null,
  importance: 'PREFERRED',
  deal_breaker: false,
  evidence_text: 'fintech / payment gateway experience',
  ...over,
});
const wmDim = (over: Partial<JdDimension> = {}): JdDimension => ({
  dimension: 'work_mode',
  value_text: 'Onsite',
  level_hint: null,
  min_years: null,
  importance: 'REQUIRED',
  deal_breaker: true,
  evidence_text: 'Onsite only',
  ...over,
});
const sig = (over: Partial<CvProfileSignals> = {}): CvProfileSignals => ({
  english: null,
  education: null,
  domain: null,
  work_mode: null,
  ...over,
});
const eng = (cefr: string, confidence = 'high') =>
  ({ cefr, source_kind: 'cefr', raw: '', confidence, signals: [] }) as CvProfileSignals['english'];
const eduSig = (level: string | null, confidence = 'high') =>
  ({ level, field: null, confidence, signals: [] }) as CvProfileSignals['education'];
const domSig = (domains: string[], confidence = 'low') =>
  ({ domains, confidence, signals: [] }) as CvProfileSignals['domain'];

describe('gradeNonSkillDimensions (PR3c, pure)', () => {
  describe('language (CEFR ordered scale)', () => {
    it('CV ≥ JD → matched, gap 0', () => {
      const [g] = gradeNonSkillDimensions([langDim()], sig({ english: eng('C1') }));
      expect(g.type).toBe('language');
      expect(g.cv_status).toBe('matched');
      expect(g.gap_levels).toBe(0);
    });
    it('CV one below → partial, gap 1', () => {
      const [g] = gradeNonSkillDimensions([langDim()], sig({ english: eng('B1') }));
      expect(g.cv_status).toBe('partial');
      expect(g.gap_levels).toBe(1);
      expect(g.from_silence).toBe(false);
    });
    it('CV ≥2 below → missing (evidenced), gap 2', () => {
      const [g] = gradeNonSkillDimensions([langDim()], sig({ english: eng('A2') }));
      expect(g.cv_status).toBe('missing');
      expect(g.gap_levels).toBe(2);
      expect(g.from_silence).toBe(false);
    });
    it('CV silent + REQUIRED → missing (from silence), confidence 0.5, cv_level null', () => {
      const [g] = gradeNonSkillDimensions([langDim({ importance: 'REQUIRED' })], sig());
      expect(g.cv_status).toBe('missing');
      expect(g.from_silence).toBe(true);
      expect(g.confidence).toBe(0.5);
      expect(g.cv_level).toBeNull();
    });
    it('CV silent + deal_breaker → missing', () => {
      const [g] = gradeNonSkillDimensions(
        [langDim({ importance: 'PREFERRED', deal_breaker: true })],
        sig(),
      );
      expect(g.cv_status).toBe('missing');
      expect(g.from_silence).toBe(true);
    });
    it('CV silent + PREFERRED (not deal_breaker) → omitted', () => {
      expect(gradeNonSkillDimensions([langDim({ importance: 'PREFERRED' })], sig())).toEqual([]);
    });
    it('CV signal present always grades, even at PREFERRED', () => {
      const [g] = gradeNonSkillDimensions(
        [langDim({ importance: 'PREFERRED' })],
        sig({ english: eng('A2') }),
      );
      expect(g.cv_status).toBe('missing');
    });
    it('unparseable / non-English JD → omitted', () => {
      expect(
        gradeNonSkillDimensions(
          [langDim({ value_text: 'Japanese N2', level_hint: 'N2', evidence_text: 'Japanese N2' })],
          sig({ english: eng('C1') }),
        ),
      ).toEqual([]);
    });
    it('collapses duplicate language dims to the STRICTEST required level', () => {
      const [g] = gradeNonSkillDimensions(
        [
          langDim({ value_text: 'English B1', level_hint: 'B1', evidence_text: 'English B1' }),
          langDim({ value_text: 'English C1', level_hint: 'C1', evidence_text: 'English C1' }),
        ],
        sig({ english: eng('B2') }),
      );
      expect(g.required_level).toBe(5); // C1 rank (strictest)
      expect(g.cv_status).toBe('partial'); // CV B2(4) is one below C1(5) → partial
      expect(g.gap_levels).toBe(1);
    });
  });

  describe('education (degree ordered scale, no partial)', () => {
    it('CV ≥ JD → matched', () => {
      const [g] = gradeNonSkillDimensions([eduDim()], sig({ education: eduSig('master') }));
      expect(g.type).toBe('education');
      expect(g.cv_status).toBe('matched');
    });
    it('CV below → missing (no partial tolerance)', () => {
      const [g] = gradeNonSkillDimensions([eduDim()], sig({ education: eduSig('associate') }));
      expect(g.cv_status).toBe('missing');
      expect(g.from_silence).toBe(false);
    });
    it('CV silent + REQUIRED → missing (from silence)', () => {
      const [g] = gradeNonSkillDimensions([eduDim({ importance: 'REQUIRED' })], sig());
      expect(g.cv_status).toBe('missing');
      expect(g.from_silence).toBe(true);
    });
    it('field-only (level null) + REQUIRED → missing (treated as silent)', () => {
      const [g] = gradeNonSkillDimensions([eduDim()], sig({ education: eduSig(null) }));
      expect(g.cv_status).toBe('missing');
      expect(g.from_silence).toBe(true);
    });
    it('CV silent + PREFERRED → omitted', () => {
      expect(gradeNonSkillDimensions([eduDim({ importance: 'PREFERRED' })], sig())).toEqual([]);
    });
    it('unparseable JD degree → omitted', () => {
      expect(
        gradeNonSkillDimensions(
          [eduDim({ value_text: 'a degree', level_hint: null, evidence_text: 'some degree' })],
          sig({ education: eduSig('bachelor') }),
        ),
      ).toEqual([]);
    });
  });

  describe('domain (exact overlap only)', () => {
    it('JD domain ∈ CV domains → matched', () => {
      const [g] = gradeNonSkillDimensions([domDim()], sig({ domain: domSig(['fintech']) }));
      expect(g.type).toBe('domain');
      expect(g.cv_status).toBe('matched');
      expect(g.gap_levels).toBe(0);
    });
    it('JD domain ∉ CV domains → missing (mismatch), gap 1', () => {
      const [g] = gradeNonSkillDimensions([domDim()], sig({ domain: domSig(['ecommerce']) }));
      expect(g.cv_status).toBe('missing');
      expect(g.gap_levels).toBe(1);
    });
    it('CV silent (no domain signal) → ALWAYS omitted', () => {
      expect(gradeNonSkillDimensions([domDim({ importance: 'REQUIRED' })], sig())).toEqual([]);
    });
    it('unparseable JD domain → omitted', () => {
      expect(
        gradeNonSkillDimensions(
          [domDim({ value_text: 'cool product', evidence_text: 'build cool products' })],
          sig({ domain: domSig(['ecommerce']) }),
        ),
      ).toEqual([]);
    });
  });

  describe('work_mode is disclosure-only — NEVER graded', () => {
    it('any work_mode dim + any signal → []', () => {
      expect(
        gradeNonSkillDimensions(
          [wmDim()],
          sig({ work_mode: { mode: 'remote', confidence: 'low', signals: [] } }),
        ),
      ).toEqual([]);
      expect(gradeNonSkillDimensions([wmDim()], sig())).toEqual([]);
    });
  });

  it('null/empty inputs → []', () => {
    expect(gradeNonSkillDimensions(null, null)).toEqual([]);
    expect(gradeNonSkillDimensions([], sig())).toEqual([]);
    // null signals = CV silent: a PREFERRED dim omits; a REQUIRED dim would be a silent-missing (covered above).
    expect(gradeNonSkillDimensions([langDim({ importance: 'PREFERRED' })], null)).toEqual([]);
  });
});

describe('gradeJdDimensions — non-skill GapItem mapping (PR3c)', () => {
  it('language missing → correct GapItem fields (reuses computeSeverity, evidence_risk none)', () => {
    const items = gradeJdDimensions({
      jdDimensions: [langDim()],
      cvProfileSignals: sig({ english: eng('A2') }),
      source: 'jd',
    });
    const g = items.find((i) => i.type === 'language');
    expect(g).toBeDefined();
    expect(g!.requirement_id).toBe('jd:language:language');
    expect(g!.canonical_name).toBe('language');
    expect(g!.display_name).toBe('Tiếng Anh');
    expect(g!.cv_status).toBe('missing');
    expect(g!.evidence_risk).toBe('none');
    expect(g!.fixability).toBe('learn');
    expect(g!.severity).toBeGreaterThan(0);
    expect(g!.recommended_next_action).not.toBe('');
    expect(g!.confidence).toBeLessThan(1);
  });
  it('language matched → severity 0, no action, not_fixable_now', () => {
    const [g] = gradeJdDimensions({
      jdDimensions: [langDim()],
      cvProfileSignals: sig({ english: eng('C1') }),
      source: 'jd',
    });
    expect(g.cv_status).toBe('matched');
    expect(g.severity).toBe(0);
    expect(g.recommended_next_action).toBe('');
    expect(g.fixability).toBe('not_fixable_now');
  });
  it('CV-silent missing uses honest wording (not an accusation)', () => {
    const [g] = gradeJdDimensions({
      jdDimensions: [langDim({ importance: 'REQUIRED' })],
      cvProfileSignals: sig(),
      source: 'jd',
    });
    expect(g.cv_status).toBe('missing');
    expect(g.recommended_next_action).toMatch(/chưa thể hiện/i);
  });
  it('education + domain map too; work_mode never produces a GapItem', () => {
    const items = gradeJdDimensions({
      jdDimensions: [eduDim(), domDim(), wmDim()],
      cvProfileSignals: sig({ education: eduSig('associate'), domain: domSig(['ecommerce']) }),
      source: 'jd',
    });
    expect(items.map((i) => i.type).sort()).toEqual(['domain', 'education']);
    expect(items.find((i) => i.type === 'domain')!.requirement_id).toBe('jd:domain:domain');
  });
  it('seniority + non-skill grade together off one call', () => {
    const items = gradeJdDimensions({
      jdDimensions: [dim(), langDim()],
      cvSeniority: sen({ bucket: 'fresher', confidence: 'high' }),
      cvProfileSignals: sig({ english: eng('A2') }),
      source: 'jd',
    });
    expect(items.map((i) => i.type).sort()).toEqual(['language', 'seniority']);
  });
});

describe('buildGapItems — non-skill grading integration (PR3c)', () => {
  it('emits a language gap that interleaves with skills by severity', () => {
    const items = buildGapItems({
      match: emptyMatch(),
      jdDimensions: [langDim()],
      cvProfileSignals: sig({ english: eng('A2') }),
    });
    const lang = items.find((g) => g.type === 'language');
    expect(lang).toBeDefined();
    expect(lang!.cv_status).toBe('missing');
    expect(lang!.severity).toBeGreaterThan(0);
  });
  it('ADDITIVE: no jdDimensions ⇒ byte-identical (cvProfileSignals ignored without dims)', () => {
    const base = buildGapItems({ match: emptyMatch() });
    const withSignals = buildGapItems({
      match: emptyMatch(),
      cvProfileSignals: sig({ english: eng('A2'), education: eduSig('associate') }),
    });
    expect(withSignals).toEqual(base);
  });
  it('matched language is a strength (severity 0), still emitted', () => {
    const items = buildGapItems({
      match: emptyMatch(),
      jdDimensions: [langDim()],
      cvProfileSignals: sig({ english: eng('C2') }),
    });
    const lang = items.find((g) => g.type === 'language');
    expect(lang!.cv_status).toBe('matched');
    expect(lang!.severity).toBe(0);
  });
});
