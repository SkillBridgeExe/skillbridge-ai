import { levelsToCraap } from '../../../src/modules/resource-curation/curation-levels';

describe('levelsToCraap — anchored 0-3 levels → 0-1 CRAAP floats (calibration adapter)', () => {
  it('maps level 3 → 1.0 and level 0 → 0 for every dimension', () => {
    const c = levelsToCraap({
      relevance: { rationale: 'x', level: 3 },
      authority: { rationale: 'x', level: 0 },
      currency: { rationale: 'x', level: 3 },
      accuracy: { rationale: 'x', level: 0 },
      purpose: { rationale: 'x', level: 3 },
    });
    expect(c).toEqual({ relevance: 1, authority: 0, currency: 1, accuracy: 0, purpose: 1 });
  });

  it('maps level 2 → 2/3 (discrete anchor, not a free float)', () => {
    expect(levelsToCraap({ relevance: { level: 2 } }).relevance).toBeCloseTo(2 / 3, 5);
  });

  it('accepts a bare numeric level too (lenient parsing)', () => {
    expect(levelsToCraap({ relevance: 2 }).relevance).toBeCloseTo(2 / 3, 5);
  });

  it('clamps out-of-range levels into [0,1]', () => {
    const c = levelsToCraap({ relevance: { level: 9 }, authority: { level: -4 } });
    expect(c.relevance).toBe(1);
    expect(c.authority).toBe(0);
  });

  it('missing dimension / non-object input → 0 (never throws, never invents)', () => {
    expect(levelsToCraap({ relevance: { level: 3 } }).accuracy).toBe(0);
    expect(levelsToCraap('garbage')).toEqual({
      relevance: 0,
      authority: 0,
      currency: 0,
      accuracy: 0,
      purpose: 0,
    });
  });
});
