/**
 * Pins CURRENT behavior of rrfFuse (see test/modules/jobs/rrf.spec.ts for the
 * consensus/degradation properties — this file pins the exact math and edges).
 * fused(d) = Σ_lists 1 / (k + rank_d), rank 1-based, default k = RRF_K = 60.
 */
import { RRF_K, rrfFuse } from './rrf';

describe('rrfFuse — exact fusion math (k = 60 default)', () => {
  it('exports the literature-default k constant of 60', () => {
    expect(RRF_K).toBe(60);
  });

  it('computes 1/(k + rank) per list and sums across lists (hand-computed fixture)', () => {
    // lists: ['a','b','c'] and ['b','a','c']
    //   a: 1/61 + 1/62 = 0.0325224748810153358
    //   b: 1/62 + 1/61 = same sum
    //   c: 1/63 + 1/63 = 0.0317460317460317460
    const fused = rrfFuse([
      ['a', 'b', 'c'],
      ['b', 'a', 'c'],
    ]);
    expect(fused.get('a')).toBeCloseTo(0.032522474881015336, 15);
    expect(fused.get('c')).toBeCloseTo(0.031746031746031744, 15);
  });

  it('single-list scores are exactly 1/61, 1/62, 1/63... in descending order', () => {
    const fused = rrfFuse([['x', 'y', 'z']]);
    expect(fused.get('x')).toBe(1 / 61);
    expect(fused.get('y')).toBe(1 / 62);
    expect(fused.get('z')).toBe(1 / 63);
    const scores = [...fused.values()];
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe('rrfFuse — ties and ordering', () => {
  it('mirrored ranks across two lists produce EXACTLY equal scores (tie is not broken here)', () => {
    // a is #1/#2, b is #2/#1 — commutative sum, bit-identical. Tie-breaking is the
    // caller's job (job-recommendation.service sorts candidates by id before ranking).
    const fused = rrfFuse([
      ['a', 'b', 'c'],
      ['b', 'a', 'c'],
    ]);
    expect(fused.get('a')).toBe(fused.get('b'));
  });

  it('Map iteration order is first-appearance order across lists, NOT score order', () => {
    const fused = rrfFuse([
      ['a', 'b'],
      ['c', 'a'],
    ]);
    expect([...fused.keys()]).toEqual(['a', 'b', 'c']);
  });
});

describe('rrfFuse — degenerate inputs', () => {
  it('no lists → empty map', () => {
    expect(rrfFuse([]).size).toBe(0);
  });

  it('only empty lists → empty map', () => {
    expect(rrfFuse([[], []]).size).toBe(0);
  });

  it('a duplicate id within ONE list accumulates both ranks (current behavior — callers pass deduped lists)', () => {
    const fused = rrfFuse([['a', 'a']]);
    expect(fused.size).toBe(1);
    expect(fused.get('a')).toBe(1 / 61 + 1 / 62);
  });
});

describe('rrfFuse — k constant effect', () => {
  it('small k rewards a single top rank; large k rewards cross-list consensus (order flips)', () => {
    // x is #1 in one list only; y is #3 in BOTH lists.
    //   k=0:  x = 1/1 = 1        > y = 1/3 + 1/3 = 0.667
    //   k=60: x = 1/61 ≈ 0.0164  < y = 2/63 ≈ 0.0317
    const lists = [
      ['x', 'a', 'y'],
      ['b', 'c', 'y'],
    ];
    const sharp = rrfFuse(lists, 0);
    expect(sharp.get('x')!).toBeGreaterThan(sharp.get('y')!);
    const smooth = rrfFuse(lists);
    expect(smooth.get('y')!).toBeGreaterThan(smooth.get('x')!);
  });
});
