import { GapItem } from '../../../src/modules/gap-engine/gap-item';
import { UnifiedDevelopmentPlanItem } from '../../../src/modules/gap-report/unified-plan';
import { toFeasibilityInputs } from '../../../src/modules/roadmap/roadmap-composer';

const learn = (over: Partial<UnifiedDevelopmentPlanItem>): UnifiedDevelopmentPlanItem => ({
  source: 'gap',
  track: 'learn',
  skill_canonical: 'react',
  display_name: 'React',
  priority: 0.8,
  severity: 0.8,
  rationale: '',
  requirement_id: 'jd:hard_skill:react',
  ...over,
});

const gap = (canonical: string, over: Partial<GapItem>): GapItem =>
  ({
    requirement_id: `jd:hard_skill:${canonical}`,
    source: 'jd',
    type: 'hard_skill',
    canonical_name: canonical,
    display_name: canonical,
    importance: 'REQUIRED',
    cv_status: 'partial',
    cv_level: 1,
    required_level: 4,
    gap_levels: 3,
    satisfied_by: null,
    evidence_refs: [],
    evidence_risk: 'none',
    fixability: 'learn',
    market_demand: 50,
    severity: 0.8,
    confidence: 1,
    recommended_next_action: '',
    ...over,
  }) as GapItem;

describe('toFeasibilityInputs', () => {
  it('enriches a learn item with required_level/cv_level/market_demand from the matching gap', () => {
    const out = toFeasibilityInputs([learn({ skill_canonical: 'react' })], [gap('react', {})]);

    expect(out[0]).toMatchObject({
      skill_canonical: 'react',
      required_level: 4,
      cv_level: 1,
      market_demand: 50,
    });
  });

  it('uses documented defaults for an interview-only learn item with no matching gap', () => {
    const out = toFeasibilityInputs(
      [
        learn({
          skill_canonical: 'go',
          display_name: 'Go',
          source: 'interview',
          requirement_id: undefined,
        }),
      ],
      [],
    );

    expect(out[0]).toMatchObject({
      required_level: 3,
      cv_level: 0,
      needs_evidence: false,
      market_demand: null,
    });
  });

  it('carries interview_confirmed = true when the item source is both', () => {
    const out = toFeasibilityInputs([learn({ source: 'both' })], [gap('react', {})]);

    expect(out[0].interview_confirmed).toBe(true);
  });

  it('derives needs_evidence from the gap evidence_risk', () => {
    const out = toFeasibilityInputs(
      [learn({ skill_canonical: 'react' })],
      [gap('react', { evidence_risk: 'listed_only', fixability: 'learn' })],
    );

    expect(out[0].needs_evidence).toBe(true);
  });
});
