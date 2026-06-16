import { buildInterviewPlanFromGapItems } from '../../../src/modules/interview/interview-planner';
import { GapItem } from '../../../src/modules/gap-engine/gap-item';

const g = (over: Partial<GapItem>): GapItem =>
  ({
    requirement_id: 'x',
    source: 'jd',
    type: 'hard_skill',
    canonical_name: 'x',
    display_name: 'X',
    importance: 'REQUIRED',
    cv_status: 'missing',
    cv_level: null,
    required_level: 3,
    gap_levels: 3,
    satisfied_by: null,
    evidence_refs: [],
    evidence_risk: 'none',
    fixability: 'learn',
    market_demand: null,
    severity: 0.5,
    confidence: 1,
    recommended_next_action: '',
    ...over,
  }) as GapItem;

describe('buildInterviewPlanFromGapItems', () => {
  it('missing+REQUIRED → gap_probe (cap 2, foundation)', () => {
    const out = buildInterviewPlanFromGapItems(
      [
        g({ canonical_name: 'react', cv_status: 'missing', importance: 'REQUIRED' }),
        g({ canonical_name: 'sql', cv_status: 'missing', importance: 'REQUIRED' }),
        g({ canonical_name: 'go', cv_status: 'missing', importance: 'REQUIRED' }),
      ],
      'vi',
    );
    expect(out.map((a) => a.focus_type)).toEqual(['gap_probe', 'gap_probe']);
    expect(out.map((a) => a.skill_canonical)).toEqual(['react', 'sql']);
    expect(out[0].difficulty).toBe('foundation');
  });

  it('partial (evidence none) → depth_probe; difficulty by gap_levels', () => {
    const out = buildInterviewPlanFromGapItems(
      [
        g({
          canonical_name: 'docker',
          cv_status: 'partial',
          cv_level: 2,
          required_level: 4,
          gap_levels: 2,
          evidence_risk: 'none',
        }),
      ],
      'vi',
    );
    expect(out[0].focus_type).toBe('depth_probe');
    expect(out[0].difficulty).toBe('foundation'); // gap_levels >= 2
  });

  it('unproven / overclaimed → evidence_probe', () => {
    const out = buildInterviewPlanFromGapItems(
      [g({ canonical_name: 'aws', cv_status: 'unproven' }), g({ canonical_name: 'k8s', cv_status: 'overclaimed' })],
      'vi',
    );
    expect(out.map((a) => a.focus_type)).toEqual(['evidence_probe', 'evidence_probe']);
  });

  it('partial + weak evidence_risk → evidence_probe (priority over depth)', () => {
    const out = buildInterviewPlanFromGapItems(
      [
        g({
          canonical_name: 'redis',
          cv_status: 'partial',
          cv_level: 2,
          required_level: 3,
          evidence_risk: 'listed_only',
        }),
      ],
      'vi',
    );
    expect(out[0].focus_type).toBe('evidence_probe');
  });

  it('matched + evidence none → strength_showcase (max 1, last)', () => {
    const out = buildInterviewPlanFromGapItems(
      [
        g({ canonical_name: 'react', cv_status: 'missing', importance: 'REQUIRED' }),
        g({ canonical_name: 'ts', cv_status: 'matched', evidence_risk: 'none' }),
        g({ canonical_name: 'js', cv_status: 'matched', evidence_risk: 'none' }),
      ],
      'vi',
    );
    const showcases = out.filter((a) => a.focus_type === 'strength_showcase');
    expect(showcases).toHaveLength(1);
    expect(out[out.length - 1].focus_type).toBe('strength_showcase');
  });

  it('non-skill types excluded (seniority/language/education/domain/work_mode)', () => {
    const out = buildInterviewPlanFromGapItems(
      [
        g({ type: 'seniority', canonical_name: 'seniority', cv_status: 'missing' }),
        g({ type: 'language', canonical_name: 'language', cv_status: 'partial' }),
        g({ type: 'education', canonical_name: 'education', cv_status: 'missing' }),
        g({ type: 'domain', canonical_name: 'fintech', cv_status: 'partial' }),
        g({ type: 'work_mode', canonical_name: 'onsite', cv_status: 'missing' }),
      ],
      'vi',
    );
    expect(out).toEqual([]);
  });

  it('dedupe by canonical — same skill in two items appears once', () => {
    const out = buildInterviewPlanFromGapItems(
      [
        g({ source: 'jd', canonical_name: 'react', cv_status: 'missing', importance: 'REQUIRED' }),
        g({ source: 'role_rubric', canonical_name: 'react', cv_status: 'missing', importance: 'REQUIRED' }),
      ],
      'vi',
    );
    expect(out.map((a) => a.skill_canonical)).toEqual(['react']);
  });

  it('missing & NOT REQUIRED → skipped (parity)', () => {
    const out = buildInterviewPlanFromGapItems(
      [g({ canonical_name: 'graphql', cv_status: 'missing', importance: 'PREFERRED' })],
      'vi',
    );
    expect(out).toEqual([]);
  });

  it('zero skill items → []', () => {
    expect(buildInterviewPlanFromGapItems([], 'vi')).toEqual([]);
  });
});
