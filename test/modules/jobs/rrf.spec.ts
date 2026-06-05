import { rrfFuse } from '../../../src/modules/jobs/reco/rrf';

describe('rrfFuse (Reciprocal Rank Fusion)', () => {
  it('an item ranked #1 in both lists beats items ranked #1 in only one', () => {
    const fused = rrfFuse([
      ['a', 'b', 'c'],
      ['a', 'c', 'b'],
    ]);
    const top = [...fused.entries()].sort((x, y) => y[1] - x[1])[0][0];
    expect(top).toBe('a');
  });

  it('agreement on rank-2 can beat a single rank-1 (rank-based consensus)', () => {
    // b is #2 in BOTH lists: 2/(60+2)=0.03226; a is #1 once: 1/61=0.01639, c likewise.
    const fused = rrfFuse([
      ['a', 'b'],
      ['c', 'b'],
    ]);
    expect(fused.get('b')!).toBeGreaterThan(fused.get('a')!);
    expect(fused.get('b')!).toBeGreaterThan(fused.get('c')!);
  });

  it('items missing from one list still score from the other (graceful degradation)', () => {
    const fused = rrfFuse([['a', 'b'], ['a']]);
    expect(fused.has('b')).toBe(true);
    expect(fused.get('a')!).toBeGreaterThan(fused.get('b')!);
  });

  it('single-list fusion preserves that list order', () => {
    const fused = rrfFuse([['x', 'y', 'z']]);
    const order = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(order).toEqual(['x', 'y', 'z']);
  });

  it('is deterministic — same input, same output', () => {
    const lists = [
      ['a', 'b', 'c'],
      ['c', 'a', 'b'],
    ];
    expect([...rrfFuse(lists).entries()]).toEqual([...rrfFuse(lists).entries()]);
  });
});
