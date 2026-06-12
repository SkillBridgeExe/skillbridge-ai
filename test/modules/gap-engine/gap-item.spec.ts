import { buildGapItems } from '../../../src/modules/gap-engine/gap-item';
import { CvJdMatchParsedResponse } from '../../../src/modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { EvidenceLedger } from '../../../src/common/services/evidence-ledger';

/**
 * PR1 — pure GapItem builder. No DB, no LLM: feed a parsed match (+ optional ledger / market map)
 * and assert the deterministic unification rules.
 */
describe('buildGapItems', () => {
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
    source_of_requirements: 'role_rubric',
    target_role: 'backend_developer',
    ...over,
  });

  const missing = (over = {}) => ({
    skill_id: 'kubernetes',
    canonical_name: 'kubernetes',
    display_name: 'Kubernetes',
    required_level: 4,
    importance: 'REQUIRED' as const,
    weight: 0.2,
    skill_type: 'hard' as const,
    gap_levels: 4,
    ...over,
  });
  const partial = (over = {}) => ({
    skill_id: 'sql',
    canonical_name: 'sql',
    display_name: 'SQL',
    cv_level: 2,
    required_level: 3,
    importance: 'REQUIRED' as const,
    weight: 0.15,
    skill_type: 'hard' as const,
    gap_levels: 1,
    ...over,
  });
  const matched = (over = {}) => ({
    skill_id: 'react',
    canonical_name: 'react',
    display_name: 'React',
    cv_level: 4,
    required_level: 3,
    importance: 'REQUIRED' as const,
    weight: 0.15,
    skill_type: 'hard' as const,
    ...over,
  });

  it('maps a missing REQUIRED skill → missing / learn / gap_levels = required_level', () => {
    const [g] = buildGapItems({ match: emptyMatch({ missing_skills: [missing()] }) });
    expect(g.cv_status).toBe('missing');
    expect(g.fixability).toBe('learn');
    expect(g.gap_levels).toBe(4);
    expect(g.cv_level).toBeNull();
    expect(g.type).toBe('hard_skill');
    expect(g.severity).toBeCloseTo(1.0 * (4 / 5)); // REQUIRED multiplier 1.0
    expect(g.requirement_id).toBe('role_rubric:hard_skill:kubernetes');
    expect(g.recommended_next_action).not.toBe('');
  });

  it('partial WITH demonstrated evidence → rewrite; WITHOUT → learn', () => {
    const ledger: EvidenceLedger = {
      items: [
        {
          skill_canonical: 'sql',
          display_name: 'SQL',
          sources: [{ kind: 'experience', ref: 'FPT — BE', recency_year: 2024 }],
          strength: 'demonstrated',
          most_recent_year: 2024,
        },
      ],
      evidence_gap: [],
    };
    const withEv = buildGapItems({ match: emptyMatch({ partial_skills: [partial()] }), ledger })[0];
    expect(withEv.fixability).toBe('rewrite');
    expect(withEv.evidence_refs).toEqual(['FPT — BE']);

    const noEv = buildGapItems({ match: emptyMatch({ partial_skills: [partial()] }) })[0];
    expect(noEv.fixability).toBe('learn');
    expect(noEv.evidence_refs).toEqual([]);
  });

  it('matched skill listed-only (in evidence_gap) → unproven / add_evidence', () => {
    const ledger: EvidenceLedger = {
      items: [
        {
          skill_canonical: 'react',
          display_name: 'React',
          sources: [],
          strength: 'listed_only',
          most_recent_year: null,
        },
      ],
      evidence_gap: ['react'],
    };
    const [g] = buildGapItems({
      match: emptyMatch({ matched_skills: [matched({ cv_level: 3 })] }),
      ledger,
    });
    expect(g.cv_status).toBe('unproven');
    expect(g.evidence_risk).toBe('listed_only');
    expect(g.fixability).toBe('add_evidence');
    expect(g.gap_levels).toBe(0);
    expect(g.severity).toBeGreaterThan(0); // evidence gap still carries a baseline severity
  });

  it('matched at cv_level>=4 but only listed → overclaimed', () => {
    const ledger: EvidenceLedger = {
      items: [
        {
          skill_canonical: 'react',
          display_name: 'React',
          sources: [],
          strength: 'listed_only',
          most_recent_year: null,
        },
      ],
      evidence_gap: ['react'],
    };
    const [g] = buildGapItems({
      match: emptyMatch({ matched_skills: [matched({ cv_level: 5 })] }),
      ledger,
    });
    expect(g.cv_status).toBe('overclaimed');
    expect(g.evidence_risk).toBe('unproven');
  });

  it('cleanly matched + demonstrated → matched / not_fixable_now / severity 0', () => {
    const ledger: EvidenceLedger = {
      items: [
        {
          skill_canonical: 'react',
          display_name: 'React',
          sources: [{ kind: 'project', ref: 'Portfolio', recency_year: 2025 }],
          strength: 'demonstrated',
          most_recent_year: 2025,
        },
      ],
      evidence_gap: [],
    };
    const [g] = buildGapItems({ match: emptyMatch({ matched_skills: [matched()] }), ledger });
    expect(g.cv_status).toBe('matched');
    expect(g.fixability).toBe('not_fixable_now');
    expect(g.severity).toBe(0);
    expect(g.recommended_next_action).toBe('');
  });

  it('passes satisfied_by through + maps source jd_extraction → jd', () => {
    const [g] = buildGapItems({
      match: emptyMatch({
        source_of_requirements: 'jd_extraction',
        partial_skills: [partial({ satisfied_by: 'postgresql' })],
      }),
    });
    expect(g.source).toBe('jd');
    expect(g.satisfied_by).toBe('postgresql');
    expect(g.requirement_id).toBe('jd:hard_skill:sql');
  });

  it('attaches market_demand from the supplied map, null otherwise', () => {
    const md = new Map([['kubernetes', 62]]);
    const [g] = buildGapItems({
      match: emptyMatch({ missing_skills: [missing()] }),
      marketDemand: md,
    });
    expect(g.market_demand).toBe(62);
    const [g2] = buildGapItems({ match: emptyMatch({ missing_skills: [missing()] }) });
    expect(g2.market_demand).toBeNull();
  });

  it('sorts highest severity first (missing REQUIRED outranks a met match)', () => {
    const items = buildGapItems({
      match: emptyMatch({ missing_skills: [missing()], matched_skills: [matched()] }),
    });
    expect(items[0].cv_status).toBe('missing');
    expect(items[items.length - 1].cv_status).toBe('matched');
  });
});
