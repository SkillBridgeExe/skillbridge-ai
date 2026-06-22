import { buildNextSteps } from '../../../src/modules/gap-advisor/gap-advisor';
import { GapItem } from '../../../src/modules/gap-engine/gap-item';

/** minimal valid GapItem for advisor tests (severityRaw reads importance/gap_levels/evidence_risk/status/market). */
function gap(over: Partial<GapItem>): GapItem {
  return {
    requirement_id: 'jd:hard_skill:x',
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
    evidence_risk: 'unproven',
    fixability: 'learn',
    market_demand: 50,
    severity: 0.5,
    confidence: 1,
    recommended_next_action: 'do',
    ...over,
  };
}

describe('buildNextSteps — prioritized, grounded next steps', () => {
  it('excludes matched gaps and ranks by severity (most severe first)', () => {
    const steps = buildNextSteps(
      [
        gap({ canonical_name: 'react', display_name: 'React', cv_status: 'matched' }),
        gap({
          canonical_name: 'aws',
          display_name: 'AWS',
          cv_status: 'missing',
          importance: 'REQUIRED',
          market_demand: 90,
          gap_levels: 4,
        }),
        gap({
          canonical_name: 'docker',
          display_name: 'Docker',
          cv_status: 'partial',
          importance: 'PREFERRED',
          market_demand: 30,
          gap_levels: 1,
        }),
      ],
      'en',
    );
    expect(steps.map((s) => s.skill)).toEqual(['AWS', 'Docker']);
    expect(steps[0].rank).toBe(1);
    expect(steps[0].action).toMatch(/Learn this skill/);
  });

  it('respects the limit', () => {
    const gaps = Array.from({ length: 8 }, (_, i) =>
      gap({ canonical_name: `s${i}`, display_name: `S${i}`, market_demand: 100 - i }),
    );
    expect(buildNextSteps(gaps, 'en', { limit: 3 })).toHaveLength(3);
  });

  it('is bilingual (Vietnamese action templates)', () => {
    const steps = buildNextSteps([gap({ cv_status: 'unproven' })], 'vi');
    expect(steps[0].action).toMatch(/bullet chứng minh/);
  });

  it('a fully matched report → no next steps', () => {
    expect(
      buildNextSteps([gap({ cv_status: 'matched' }), gap({ cv_status: 'matched' })], 'en'),
    ).toEqual([]);
  });
});
