import {
  aggregateImpactCalibrations,
  renderImpactCalibrationMarkdown,
  ImpactCalibrationRow,
} from './impact-calibration-report';

function row(overrides: Partial<ImpactCalibrationRow> = {}): ImpactCalibrationRow {
  return {
    canonical_name: 'docker',
    action_type: 'add_skill_evidence',
    predicted_score_min: '2.00',
    predicted_score_max: '6.00',
    actual_score_delta: '4.00',
    status_transition: 'improved',
    attempted: true,
    ...overrides,
  };
}

describe('aggregateImpactCalibrations', () => {
  it('groups by action_type + canonical_name with per-group counts and means', () => {
    const rows = [
      row(),
      row({ actual_score_delta: '2.00' }),
      row({ canonical_name: 'kubernetes', actual_score_delta: '1.00' }),
    ];
    const agg = aggregateImpactCalibrations(rows);

    expect(agg.total).toBe(3);
    const docker = agg.groups.find(
      (g) => g.canonical_name === 'docker' && g.action_type === 'add_skill_evidence',
    );
    expect(docker).toBeDefined();
    expect(docker!.n).toBe(2);
    expect(docker!.measured).toBe(2);
    expect(docker!.mean_predicted_mid).toBe(4); // (2+6)/2 both rows
    expect(docker!.mean_actual_delta).toBe(3); // (4+2)/2
    expect(docker!.bias).toBe(-1); // actual - predicted mid
  });

  it('counts a row as within-range when actual falls inside [predicted_min, predicted_max]', () => {
    const rows = [
      row({ actual_score_delta: '4.00' }), // inside [2,6]
      row({ actual_score_delta: '9.00' }), // outside
    ];
    const agg = aggregateImpactCalibrations(rows);
    const docker = agg.groups[0];
    expect(docker.within_range).toBe(1);
  });

  it('keeps unmeasured rows (actual null) in n but out of means and within-range', () => {
    const rows = [row(), row({ actual_score_delta: null })];
    const agg = aggregateImpactCalibrations(rows);
    const docker = agg.groups[0];
    expect(docker.n).toBe(2);
    expect(docker.measured).toBe(1);
    expect(docker.mean_actual_delta).toBe(4);
    expect(docker.within_range).toBe(1);
  });

  it('computes bias from MEASURED rows only — unmeasured predicted ranges must not skew it', () => {
    // Post-merge review finding: 9 unmeasured rows (mid 5) + 1 perfectly-calibrated measured row
    // (mid 1, actual 1). Bias must be 0, not (1 - 4.6) = -3.6.
    const rows = [
      ...Array.from({ length: 9 }, () =>
        row({
          predicted_score_min: '4.00',
          predicted_score_max: '6.00',
          actual_score_delta: null,
        }),
      ),
      row({ predicted_score_min: '1.00', predicted_score_max: '1.00', actual_score_delta: '1.00' }),
    ];
    const agg = aggregateImpactCalibrations(rows);
    const g = agg.groups[0];
    expect(g.mean_actual_delta).toBe(1);
    expect(g.bias).toBe(0);
  });

  it('handles zero rows without dividing by zero', () => {
    const agg = aggregateImpactCalibrations([]);
    expect(agg.total).toBe(0);
    expect(agg.groups).toEqual([]);
  });

  it('sorts groups by n desc so the most-calibrated pairs lead the report', () => {
    const rows = [row({ canonical_name: 'kubernetes' }), row(), row()];
    const agg = aggregateImpactCalibrations(rows);
    expect(agg.groups[0].canonical_name).toBe('docker');
  });
});

describe('renderImpactCalibrationMarkdown', () => {
  it('renders a table with group rows and an overall summary line', () => {
    const md = renderImpactCalibrationMarkdown(aggregateImpactCalibrations([row()]));
    expect(md).toContain('| add_skill_evidence | docker |');
    expect(md).toContain('Total rows: 1');
  });

  it('says so explicitly when there is no calibration data yet', () => {
    const md = renderImpactCalibrationMarkdown(aggregateImpactCalibrations([]));
    expect(md).toContain('No calibration rows');
  });
});
