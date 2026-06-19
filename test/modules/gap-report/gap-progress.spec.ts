import { diffGapProgress, baselineProgress } from '../../../src/modules/gap-report/gap-progress';
import { GapItem } from '../../../src/modules/gap-engine/gap-item';

const g = (canonical: string, status: GapItem['cv_status'], severity: number): GapItem =>
  ({ canonical_name: canonical, cv_status: status, severity }) as GapItem;

describe('diffGapProgress', () => {
  it('reports closed gaps and newly worsened open gaps', () => {
    const prev = [g('react', 'missing', 0.8), g('sql', 'partial', 0.5)];
    const curr = [g('react', 'matched', 0), g('go', 'missing', 0.7)];

    const out = diffGapProgress(prev, curr);

    expect(out.baseline).toBe(false);
    expect(out.gaps_closed.sort()).toEqual(['react', 'sql']);
    expect(out.gaps_worsened).toEqual(['go']);
    expect(out.prev_count).toBe(2);
    expect(out.curr_count).toBe(1);
  });

  it('returns a negative average severity delta when open-gap severity improves', () => {
    const out = diffGapProgress([g('react', 'missing', 0.8)], [g('react', 'partial', 0.4)]);

    expect(out.avg_severity_delta).toBe(-0.4);
  });
});

describe('baselineProgress', () => {
  it('returns an honest first-measurement shape', () => {
    expect(baselineProgress(2)).toEqual({
      baseline: true,
      prev_count: 0,
      curr_count: 2,
      gaps_closed: [],
      gaps_worsened: [],
      avg_severity_delta: 0,
    });
  });
});
