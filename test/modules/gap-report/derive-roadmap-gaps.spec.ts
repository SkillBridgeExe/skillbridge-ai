import { deriveRoadmapGapsFromReport } from '../../../src/modules/gap-report/gap-report';
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

describe('deriveRoadmapGapsFromReport — only fixability=learn, severity order preserved', () => {
  it('keeps learn (missing→missing_skills, partial→partial_skills); drops rewrite/add_evidence/not_fixable_now', () => {
    const items: GapItem[] = [
      g({ canonical_name: 'react', cv_status: 'missing', fixability: 'learn', required_level: 4 }),
      g({
        canonical_name: 'sql',
        cv_status: 'partial',
        cv_level: 2,
        fixability: 'learn',
        required_level: 3,
      }),
      g({ canonical_name: 'docker', fixability: 'rewrite' }),
      g({ canonical_name: 'git', fixability: 'add_evidence' }),
      g({ canonical_name: 'comm', fixability: 'not_fixable_now' }),
    ];
    const out = deriveRoadmapGapsFromReport(items);
    expect(out.missing_skills.map((s) => s.skill_canonical_name)).toEqual(['react']);
    expect(out.partial_skills.map((s) => s.skill_canonical_name)).toEqual(['sql']);
    expect(out.partial_skills[0].current_level).toBe(2);
    expect(out.missing_skills[0].current_level).toBe(0);
  });

  it('preserves the incoming (severity) order among learn gaps', () => {
    const items: GapItem[] = [
      g({ canonical_name: 'b', fixability: 'learn' }),
      g({ canonical_name: 'a', fixability: 'learn' }),
    ];
    expect(
      deriveRoadmapGapsFromReport(items).missing_skills.map((s) => s.skill_canonical_name),
    ).toEqual(['b', 'a']);
  });

  it('all non-learn → empty', () => {
    const out = deriveRoadmapGapsFromReport([
      g({ fixability: 'rewrite' }),
      g({ fixability: 'add_evidence' }),
    ]);
    expect(out).toEqual({ missing_skills: [], partial_skills: [] });
  });

  it('skips a learn gap with null required_level (a learning step needs a target level)', () => {
    const out = deriveRoadmapGapsFromReport([g({ fixability: 'learn', required_level: null })]);
    expect(out).toEqual({ missing_skills: [], partial_skills: [] });
  });
});
