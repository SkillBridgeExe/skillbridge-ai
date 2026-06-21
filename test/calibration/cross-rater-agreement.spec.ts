import {
  crossRaterAgreement,
  crossRaterAgreementOrdinal,
  formatCrossRater,
} from '../../src/calibration/cross-rater-agreement';

const BANDS = ['poor', 'borderline', 'solid', 'outstanding'];

describe('crossRaterAgreement', () => {
  it('computes the inter-rater ceiling and flags a heuristic that does NOT reach it', () => {
    // gold == rater2 (perfect, ceiling 1.0); heuristic agrees 0.5 with each.
    const r = crossRaterAgreement([
      { rater: 'heuristic', labels: ['y', 'y', 'n', 'n'] },
      { rater: 'gold', labels: ['y', 'n', 'n', 'n'] },
      { rater: 'rater2', labels: ['y', 'n', 'n', 'n'] },
    ]);
    expect(r.pairwise).toHaveLength(3);
    expect(r.interRaterCeiling).toBeCloseTo(1, 6);
    expect(r.heuristicVsRaters[0].kappa).toBeCloseTo(0.5, 6);
    expect(r.reachesCeiling).toBe(false);
  });

  it('flags a heuristic that REACHES the ceiling (as good as the raters agree with each other)', () => {
    // gold and rater2 only agree 0.5 with each other; heuristic matches gold perfectly.
    const r = crossRaterAgreement([
      { rater: 'heuristic', labels: ['y', 'n', 'n', 'n'] },
      { rater: 'gold', labels: ['y', 'n', 'n', 'n'] },
      { rater: 'rater2', labels: ['y', 'y', 'n', 'n'] },
    ]);
    expect(r.interRaterCeiling).toBeCloseTo(0.5, 6);
    expect(r.heuristicVsRaters[0].kappa).toBeCloseTo(1, 6);
    expect(r.reachesCeiling).toBe(true);
  });

  it('returns null ceiling/verdict with only the heuristic + one rater (no human-human pair)', () => {
    const r = crossRaterAgreement([
      { rater: 'heuristic', labels: ['y', 'n', 'y'] },
      { rater: 'gold', labels: ['y', 'n', 'y'] },
    ]);
    expect(r.pairwise).toHaveLength(1);
    expect(r.interRaterCeiling).toBeNull();
    expect(r.reachesCeiling).toBeNull();
  });

  it('formats a readable report', () => {
    const r = crossRaterAgreement([
      { rater: 'heuristic', labels: ['y', 'n'] },
      { rater: 'gold', labels: ['y', 'n'] },
      { rater: 'rater2', labels: ['y', 'y'] },
    ]);
    const text = formatCrossRater(r);
    expect(text).toContain('CROSS-RATER AGREEMENT');
    expect(text).toContain('inter-rater ceiling');
  });
});

describe('crossRaterAgreementOrdinal (QWK on ordered bands)', () => {
  it('identical raters → QWK 1 across the board', () => {
    const seq = ['poor', 'solid', 'outstanding', 'borderline', 'solid', 'poor'];
    const r = crossRaterAgreementOrdinal(
      [
        { rater: 'heuristic', labels: seq },
        { rater: 'gold', labels: seq },
        { rater: 'rater2', labels: seq },
      ],
      BANDS,
    );
    expect(r.interRaterCeiling).toBeCloseTo(1, 6);
    expect(r.reachesCeiling).toBe(true);
    expect(r.pairwise.every((p) => Math.abs(p.kappa - 1) < 1e-9)).toBe(true);
  });

  it('an adjacent band disagreement keeps QWK in (0,1) — penalised but not catastrophic', () => {
    const gold = [
      'poor',
      'borderline',
      'solid',
      'outstanding',
      'poor',
      'solid',
      'outstanding',
      'borderline',
    ];
    const heuristic = [
      'borderline', // off by ONE band vs gold (poor→borderline)
      'borderline',
      'solid',
      'outstanding',
      'poor',
      'solid',
      'outstanding',
      'borderline',
    ];
    const r = crossRaterAgreementOrdinal(
      [
        { rater: 'heuristic', labels: heuristic },
        { rater: 'gold', labels: gold },
        { rater: 'rater2', labels: gold },
      ],
      BANDS,
    );
    expect(r.interRaterCeiling).toBeCloseTo(1, 6); // gold == rater2
    expect(r.heuristicVsRaters[0].kappa).toBeLessThan(1);
    expect(r.heuristicVsRaters[0].kappa).toBeGreaterThan(0);
  });
});
