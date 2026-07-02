import {
  diffGapProgress,
  baselineProgress,
  buildProgressReport,
  baselineReport,
} from '../../../src/modules/gap-report/gap-progress';
import { GapItem } from '../../../src/modules/gap-engine/gap-item';
import { JdIntelligenceItem } from '../../../src/modules/gap-report/gap-report';

const g = (
  canonical: string,
  status: GapItem['cv_status'],
  severity = 0.5,
  evidence: GapItem['evidence_risk'] = 'none',
): GapItem =>
  ({
    canonical_name: canonical,
    display_name: canonical.toUpperCase(),
    cv_status: status,
    severity,
    evidence_risk: evidence,
  }) as GapItem;

const d = (dimension: string, verdict: string | null, graded = true): JdIntelligenceItem =>
  ({ dimension, graded, verdict }) as JdIntelligenceItem;

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

  it('carries the before/after match score when provided, else null', () => {
    const withScores = diffGapProgress([g('react', 'missing', 0.8)], [], 72, 80);
    expect(withScores.prev_score).toBe(72);
    expect(withScores.curr_score).toBe(80);

    const withoutScores = diffGapProgress([], []);
    expect(withoutScores.prev_score).toBeNull();
    expect(withoutScores.curr_score).toBeNull();
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
      prev_score: null,
      curr_score: null,
    });
  });

  it('carries the current score with no previous score at baseline', () => {
    const out = baselineProgress(1, 65);
    expect(out.prev_score).toBeNull();
    expect(out.curr_score).toBe(65);
  });
});

describe('buildProgressReport', () => {
  const BASE_OPTS = {
    prevScore: 50,
    currScore: 60,
    prevCoverage: 0.5,
    currCoverage: 0.6,
    templateChanged: false,
  };

  it('1. missing -> partial is an improved transition', () => {
    const out = buildProgressReport(
      [g('react', 'missing', 0.8)],
      [g('react', 'partial', 0.5)],
      BASE_OPTS,
    );
    expect(out.transitions).toEqual([
      expect.objectContaining({
        canonical_name: 'react',
        prev_status: 'missing',
        curr_status: 'partial',
        kind: 'improved',
      }),
    ]);
  });

  it('2. partial -> matched is a closed transition', () => {
    const out = buildProgressReport(
      [g('sql', 'partial', 0.5)],
      [g('sql', 'matched', 0)],
      BASE_OPTS,
    );
    expect(out.transitions).toEqual([
      expect.objectContaining({ canonical_name: 'sql', kind: 'closed' }),
    ]);
  });

  it('3. matched -> matched is a kept strength, not a transition', () => {
    const out = buildProgressReport([g('git', 'matched', 0)], [g('git', 'matched', 0)], BASE_OPTS);
    expect(out.transitions).toEqual([]);
    expect(out.strengths_kept).toEqual(['GIT']);
  });

  it('4. absent from prev, missing in curr is a new transition', () => {
    const out = buildProgressReport([], [g('docker', 'missing', 0.6)], BASE_OPTS);
    expect(out.transitions).toEqual([
      expect.objectContaining({
        canonical_name: 'docker',
        prev_status: null,
        curr_status: 'missing',
        kind: 'new',
      }),
    ]);
  });

  it('5. partial -> missing is a worsened transition', () => {
    const out = buildProgressReport(
      [g('aws', 'partial', 0.4)],
      [g('aws', 'missing', 0.8)],
      BASE_OPTS,
    );
    expect(out.transitions).toEqual([
      expect.objectContaining({ canonical_name: 'aws', kind: 'worsened' }),
    ]);
  });

  it('6. a skill vanished from curr entirely is excluded from transitions (extraction noise, not a fix)', () => {
    const out = buildProgressReport([g('vue', 'partial', 0.5)], [], BASE_OPTS);
    expect(out.transitions).toEqual([]);
  });

  it('7. unproven+listed_only -> partial+none is evidence_recognized and improved', () => {
    const out = buildProgressReport(
      [g('node', 'unproven', 0.6, 'listed_only')],
      [g('node', 'partial', 0.4, 'none')],
      BASE_OPTS,
    );
    expect(out.evidence_recognized).toEqual(['NODE']);
    expect(out.transitions).toEqual([
      expect.objectContaining({ canonical_name: 'node', kind: 'improved' }),
    ]);
  });

  it('8. templateChanged makes prev_score and coverage_delta honestly null but still computes transitions', () => {
    const out = buildProgressReport([g('react', 'missing', 0.8)], [g('react', 'matched', 0)], {
      prevScore: 50,
      currScore: 90,
      prevCoverage: 0.4,
      currCoverage: 0.9,
      templateChanged: true,
    });
    expect(out.prev_score).toBeNull();
    expect(out.curr_score).toBe(90);
    expect(out.required_coverage_delta).toBeNull();
    expect(out.template_changed).toBe(true);
    expect(out.transitions).toEqual([
      expect.objectContaining({ canonical_name: 'react', kind: 'closed' }),
    ]);
  });

  it('9. a JD dimension verdict changing from stretch to fits is a changed dimension', () => {
    const out = buildProgressReport([], [], {
      ...BASE_OPTS,
      prevJdIntel: [d('seniority', 'stretch')],
      currJdIntel: [d('seniority', 'fits')],
    });
    expect(out.dimension_changes).toEqual([
      { dimension: 'seniority', prev_verdict: 'stretch', curr_verdict: 'fits', changed: true },
    ]);
  });

  it('10. baselineReport returns the baseline shape with empty arrays and a null coverage delta', () => {
    const curr = [g('react', 'missing', 0.8)];
    const out = baselineReport(curr, 65);
    expect(out).toEqual({
      ...baselineProgress(curr, 65),
      transitions: [],
      dimension_changes: [],
      evidence_recognized: [],
      strengths_kept: [],
      required_coverage_delta: null,
      template_changed: false,
    });
  });
});
