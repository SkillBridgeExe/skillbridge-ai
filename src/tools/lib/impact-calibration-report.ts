/**
 * MEASURE M3 — pure aggregation for the impact_calibrations reader.
 * Turns write-only ME2 rows (predicted impact vs what actually happened by the next scan)
 * into per-(action_type, skill) calibration stats so the impact simulator can be tuned
 * from real re-scan behavior.
 */

/** Raw row as returned by db.query over impact_calibrations (numerics arrive as strings). */
export interface ImpactCalibrationRow {
  canonical_name: string;
  action_type: string;
  predicted_score_min: string;
  predicted_score_max: string;
  actual_score_delta: string | null;
  status_transition: string;
  attempted: boolean;
}

export interface ImpactCalibrationGroup {
  action_type: string;
  canonical_name: string;
  /** All rows for the pair. */
  n: number;
  /** Rows where an actual delta was observed (user re-scanned). */
  measured: number;
  mean_predicted_mid: number | null;
  mean_actual_delta: number | null;
  /** Measured rows whose actual delta landed inside [predicted_min, predicted_max]. */
  within_range: number;
  /** mean_actual_delta minus the mean predicted mid of MEASURED rows only (not mean_predicted_mid,
   *  which spans all rows); positive = simulator under-promises. */
  bias: number | null;
}

export interface ImpactCalibrationAggregate {
  total: number;
  measured: number;
  groups: ImpactCalibrationGroup[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function aggregateImpactCalibrations(
  rows: ImpactCalibrationRow[],
): ImpactCalibrationAggregate {
  const byKey = new Map<string, ImpactCalibrationRow[]>();
  for (const r of rows) {
    const key = `${r.action_type}|${r.canonical_name}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }

  const groups: ImpactCalibrationGroup[] = [];
  let measuredTotal = 0;
  for (const bucket of byKey.values()) {
    const mid = (r: ImpactCalibrationRow): number =>
      (Number(r.predicted_score_min) + Number(r.predicted_score_max)) / 2;
    const mids = bucket.map(mid);
    const measuredRows = bucket.filter((r) => r.actual_score_delta !== null);
    // bias must compare like with like: predicted mids of the MEASURED rows only. Unmeasured rows
    // (the majority — users rarely re-scan) may carry different predicted ranges and would skew it.
    const measuredMids = measuredRows.map(mid);
    measuredTotal += measuredRows.length;
    const actuals = measuredRows.map((r) => Number(r.actual_score_delta));
    const withinRange = measuredRows.filter((r) => {
      const actual = Number(r.actual_score_delta);
      return actual >= Number(r.predicted_score_min) && actual <= Number(r.predicted_score_max);
    }).length;

    const meanMid = mids.length ? round2(mids.reduce((a, b) => a + b, 0) / mids.length) : null;
    const meanMeasuredMid = measuredMids.length
      ? round2(measuredMids.reduce((a, b) => a + b, 0) / measuredMids.length)
      : null;
    const meanActual = actuals.length
      ? round2(actuals.reduce((a, b) => a + b, 0) / actuals.length)
      : null;

    groups.push({
      action_type: bucket[0].action_type,
      canonical_name: bucket[0].canonical_name,
      n: bucket.length,
      measured: measuredRows.length,
      mean_predicted_mid: meanMid,
      mean_actual_delta: meanActual,
      within_range: withinRange,
      bias:
        meanMeasuredMid !== null && meanActual !== null
          ? round2(meanActual - meanMeasuredMid)
          : null,
    });
  }

  groups.sort((a, b) => b.n - a.n);
  return { total: rows.length, measured: measuredTotal, groups };
}

export function renderImpactCalibrationMarkdown(agg: ImpactCalibrationAggregate): string {
  const lines: string[] = ['# Impact Calibration Report', ''];
  lines.push(`Total rows: ${agg.total} · measured (re-scanned): ${agg.measured}`, '');
  if (agg.total === 0) {
    lines.push('No calibration rows yet — the reader has nothing to aggregate.', '');
    return lines.join('\n');
  }
  lines.push(
    '| action_type | skill | n | measured | mean predicted mid | mean actual Δ | within range | bias |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const g of agg.groups) {
    lines.push(
      `| ${g.action_type} | ${g.canonical_name} | ${g.n} | ${g.measured} | ${g.mean_predicted_mid ?? '—'} | ${g.mean_actual_delta ?? '—'} | ${g.within_range}/${g.measured} | ${g.bias ?? '—'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
