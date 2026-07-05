import { GapItem } from '../gap-engine/gap-item';
import { baselineReport, buildProgressReport } from './gap-progress';

function makeGapItem(overrides: Partial<GapItem> = {}): GapItem {
  return {
    requirement_id: 'jd:hard_skill:react',
    source: 'jd',
    type: 'hard_skill',
    canonical_name: 'react',
    display_name: 'React',
    importance: 'REQUIRED',
    cv_status: 'missing',
    cv_level: null,
    required_level: 4,
    gap_levels: 4,
    satisfied_by: null,
    evidence_refs: [],
    evidence_risk: 'none',
    fixability: 'learn',
    market_demand: 60,
    severity: 0.5,
    confidence: 1,
    recommended_next_action: 'Học & bổ sung kỹ năng này',
    ...overrides,
  };
}

const baseOpts = {
  prevScore: 50,
  currScore: 60,
  prevCoverage: null,
  currCoverage: null,
  templateChanged: false,
};

describe('buildProgressReport — learning_completed (V2, Wave VALUE_CHAIN)', () => {
  it('mastered ∩ OPEN gaps → learning_completed lists those canonicals (closed/matched and unlearned skills excluded)', () => {
    const prev = [
      makeGapItem(),
      makeGapItem({
        requirement_id: 'jd:hard_skill:sql',
        canonical_name: 'sql',
        display_name: 'SQL',
      }),
    ];
    const curr = [
      makeGapItem(), // react still missing (open) + mastered → pending verification
      makeGapItem({
        requirement_id: 'jd:hard_skill:sql',
        canonical_name: 'sql',
        display_name: 'SQL',
        cv_status: 'matched', // sql mastered but the gap is CLOSED → nothing pending
        severity: 0,
      }),
      makeGapItem({
        requirement_id: 'jd:hard_skill:docker',
        canonical_name: 'docker',
        display_name: 'Docker',
      }), // docker open but NOT mastered → excluded
    ];

    const report = buildProgressReport(prev, curr, {
      ...baseOpts,
      masteredCanonicals: new Set(['react', 'sql', 'kubernetes']),
    });

    expect(report.learning_completed).toEqual(['react']);
  });

  it('mastered but every matching gap closed → field absent entirely (never an empty array)', () => {
    const prev = [makeGapItem()];
    const curr = [makeGapItem({ cv_status: 'matched', severity: 0 })];

    const report = buildProgressReport(prev, curr, {
      ...baseOpts,
      masteredCanonicals: new Set(['react']),
    });

    expect(report).not.toHaveProperty('learning_completed');
  });

  it('duplicate canonicals across requirement types are listed once', () => {
    const curr = [
      makeGapItem(),
      makeGapItem({ requirement_id: 'jd:tool:react', type: 'tool' as GapItem['type'] }),
    ];

    const report = buildProgressReport([], curr, {
      ...baseOpts,
      masteredCanonicals: new Set(['react']),
    });

    expect(report.learning_completed).toEqual(['react']);
  });

  it('masteredCanonicals absent / null / empty → field absent + output byte-identical', () => {
    const prev = [makeGapItem()];
    const curr = [makeGapItem({ cv_status: 'partial' })];
    const base = buildProgressReport(prev, curr, baseOpts);

    expect(base).not.toHaveProperty('learning_completed');
    for (const masteredCanonicals of [undefined, null, new Set<string>()]) {
      const report = buildProgressReport(prev, curr, { ...baseOpts, masteredCanonicals });
      expect(JSON.stringify(report)).toBe(JSON.stringify(base));
    }
  });

  it('learning_completed never alters the rest of the report (presentation-only — severity/transitions/evidence untouched)', () => {
    const prev = [
      makeGapItem({ evidence_risk: 'listed_only', cv_status: 'unproven' }),
      makeGapItem({
        requirement_id: 'jd:hard_skill:sql',
        canonical_name: 'sql',
        display_name: 'SQL',
      }),
    ];
    const curr = [
      makeGapItem({ cv_status: 'partial' }),
      makeGapItem({
        requirement_id: 'jd:hard_skill:sql',
        canonical_name: 'sql',
        display_name: 'SQL',
      }),
    ];
    const base = buildProgressReport(prev, curr, baseOpts);
    const withMastered = buildProgressReport(prev, curr, {
      ...baseOpts,
      masteredCanonicals: new Set(['sql']),
    });

    const { learning_completed, ...rest } = withMastered;
    expect(learning_completed).toEqual(['sql']);
    expect(rest).toEqual(base);
  });
});

describe('baselineReport — learning_completed (V2, Wave VALUE_CHAIN)', () => {
  it('first scan with a mastered open gap → learning_completed present (the learn-then-rescan window)', () => {
    const curr = [makeGapItem()];
    const report = baselineReport(curr, 60, new Set(['react']));
    expect(report.baseline).toBe(true);
    expect(report.learning_completed).toEqual(['react']);
  });

  it('no mastered learning → byte-identical to the two-arg call', () => {
    const curr = [makeGapItem()];
    const base = baselineReport(curr, 60);
    expect(base).not.toHaveProperty('learning_completed');
    expect(JSON.stringify(baselineReport(curr, 60, undefined))).toBe(JSON.stringify(base));
    expect(JSON.stringify(baselineReport(curr, 60, new Set()))).toBe(JSON.stringify(base));
  });
});
