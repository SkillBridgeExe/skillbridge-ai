import { buildTailorChecklist, TailorAction } from '../../../src/modules/cv-jd-match/tailor-checklist';
import {
  MatchedSkill,
  MissingSkill,
  PartialSkill,
} from '../../../src/modules/cv-jd-match/skill-diff.service';
import {
  CvJdMatchParsedResponse,
  KeywordFrequency,
} from '../../../src/modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { EvidenceLedger } from '../../../src/common/services/evidence-ledger';

const matched = (c: string, w: number, cv = 4, req = 3): MatchedSkill => ({
  skill_id: c, canonical_name: c, display_name: c.toUpperCase(),
  cv_level: cv, required_level: req, importance: 'REQUIRED', weight: w, skill_type: 'hard',
});
const partial = (c: string, w: number, cv: number, req: number): PartialSkill => ({
  ...matched(c, w, cv, req), gap_levels: req - cv,
});
const missing = (c: string, w: number, imp: 'REQUIRED' | 'PREFERRED' = 'REQUIRED'): MissingSkill => ({
  skill_id: c, canonical_name: c, display_name: c.toUpperCase(),
  required_level: 3, importance: imp, weight: w, skill_type: 'hard', gap_levels: 3,
});
const kf = (c: string, cv_count: number, jd_count: number): KeywordFrequency => ({
  canonical_name: c, display_name: c.toUpperCase(), cv_count, jd_count,
});
const baseMatch = (over: Partial<CvJdMatchParsedResponse>): CvJdMatchParsedResponse =>
  ({
    overall_score: 50, match_ratio: 50, required_coverage: 0.5,
    matched_skills: [], partial_skills: [], missing_skills: [], bonus_skills: [],
    unnormalized_cv_skills: [], unnormalized_jd_requirements: [],
    scoring_breakdown: {
      total_requirements: 0, matched_count: 0, partial_count: 0, missing_count: 0,
      weight_sum: 0, achieved_weight: 0, required_total: 0, required_met: 0,
      raw_weighted_score: 0, cap_applied: false,
    },
    source_of_requirements: 'jd_extraction', target_role: null,
    ...over,
  }) as CvJdMatchParsedResponse;
const ledgerOf = (gap: string[], demonstrated: Array<[string, string]>): EvidenceLedger => ({
  evidence_gap: gap,
  items: [
    ...gap.map((c) => ({
      skill_canonical: c, display_name: c.toUpperCase(),
      sources: [{ kind: 'skills_list' as const, ref: 'Skills', recency_year: null }],
      strength: 'listed_only' as const, most_recent_year: null,
    })),
    ...demonstrated.map(([c, ref]) => ({
      skill_canonical: c, display_name: c.toUpperCase(),
      sources: [{ kind: 'project' as const, ref, recency_year: null }],
      strength: 'demonstrated' as const, most_recent_year: null,
    })),
  ],
});

describe('buildTailorChecklist (pure)', () => {
  it('missing_required: REQUIRED only, weight desc, max 3, honest why, not rewrite-eligible', () => {
    const m = baseMatch({
      missing_skills: [missing('a', 0.1), missing('b', 0.3), missing('c', 0.2), missing('d', 0.25), missing('e', 0.4, 'PREFERRED')],
    });
    const out = buildTailorChecklist(m, null, 'vi').filter((x) => x.action_type === 'missing_required');
    expect(out.map((x) => x.skill_canonical)).toEqual(['b', 'd', 'c']); // weight desc, max 3, no PREFERRED
    for (const x of out) {
      expect(x.rewrite_eligible).toBe(false);
      expect(x.why).toContain('thực sự có'); // never tells the user to fabricate
    }
  });

  it('add_evidence: matched ∩ evidence_gap only, not rewrite-eligible', () => {
    const m = baseMatch({ matched_skills: [matched('react', 0.2), matched('git', 0.1)] });
    const out = buildTailorChecklist(m, ledgerOf(['react'], []), 'vi');
    const add = out.filter((x) => x.action_type === 'add_evidence');
    expect(add.map((x) => x.skill_canonical)).toEqual(['react']);
    expect(add[0].rewrite_eligible).toBe(false);
  });

  it('emphasize: jd_count>=2 && cv_count<=1, jd_count desc, rewrite-eligible, real numbers in why', () => {
    const m = baseMatch({
      matched_skills: [matched('docker', 0.1), matched('sql', 0.1), matched('git', 0.1)],
      keyword_frequency: [kf('docker', 1, 3), kf('sql', 0, 2), kf('git', 5, 4)],
    });
    const out = buildTailorChecklist(m, null, 'vi').filter((x) => x.action_type === 'emphasize');
    expect(out.map((x) => x.skill_canonical)).toEqual(['docker', 'sql']); // git: cv_count 5 → not under-mentioned
    expect(out[0].rewrite_eligible).toBe(true);
    expect(out[0].why).toContain('3'); // jd_count surfaces in the copy
    expect(out[0].jd_count).toBe(3);
  });

  it('deepen_wording: partial ∩ demonstrated, anchored to the ledger source ref', () => {
    const m = baseMatch({ partial_skills: [partial('sql', 0.2, 2, 4), partial('css', 0.1, 2, 3)] });
    const out = buildTailorChecklist(m, ledgerOf([], [['sql', 'Dự án — Booking App']]), 'vi');
    const deep = out.filter((x) => x.action_type === 'deepen_wording');
    expect(deep.map((x) => x.skill_canonical)).toEqual(['sql']); // css not demonstrated
    expect(deep[0].anchor?.ref).toBe('Dự án — Booking App');
    expect(deep[0].rewrite_eligible).toBe(true);
    expect(deep[0].cv_level).toBe(2);
    expect(deep[0].required_level).toBe(4);
  });

  it('dedup: a skill qualifying for two rules appears once (earlier rule wins)', () => {
    const m = baseMatch({
      matched_skills: [matched('react', 0.2)],
      keyword_frequency: [kf('react', 0, 3)],
    });
    const out = buildTailorChecklist(m, ledgerOf(['react'], []), 'vi');
    expect(out.filter((x) => x.skill_canonical === 'react')).toHaveLength(1);
    expect(out.find((x) => x.skill_canonical === 'react')!.action_type).toBe('add_evidence');
  });

  it('degrades gracefully: no ledger → rules 2/4 skip; no keyword_frequency → rule 3 skips', () => {
    const m = baseMatch({
      matched_skills: [matched('react', 0.2)],
      partial_skills: [partial('sql', 0.2, 2, 4)],
      missing_skills: [missing('docker', 0.3)],
    });
    const out = buildTailorChecklist(m, null, 'vi');
    expect(out.map((x) => x.action_type)).toEqual(['missing_required']); // only rule 1 fires
  });

  it('caps the total at 8 and keeps rule order', () => {
    const m = baseMatch({
      missing_skills: Array.from({ length: 5 }, (_, i) => missing(`m${i}`, 0.1 + i / 100)),
      matched_skills: Array.from({ length: 6 }, (_, i) => matched(`k${i}`, 0.1)),
      keyword_frequency: Array.from({ length: 6 }, (_, i) => kf(`k${i}`, 0, 2 + i)),
    });
    const out = buildTailorChecklist(m, ledgerOf(['k0', 'k1', 'k2'], []), 'vi');
    expect(out.length).toBeLessThanOrEqual(8);
    const order = ['missing_required', 'add_evidence', 'emphasize', 'deepen_wording'];
    const seq = out.map((x) => order.indexOf(x.action_type));
    expect([...seq].sort((a, b) => a - b)).toEqual(seq); // grouped in rule order
  });

  it('en lang produces English why', () => {
    const m = baseMatch({ missing_skills: [missing('docker', 0.3)] });
    const out = buildTailorChecklist(m, null, 'en');
    expect(out[0].why).toMatch(/requires/i);
  });
});
