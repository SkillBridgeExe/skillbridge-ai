import { dataConfidence } from '../../../src/modules/jobs/trends/data-confidence';

describe('dataConfidence (>=50 high / 20-49 medium / <20 low)', () => {
  it.each([
    [1000, 'high'],
    [50, 'high'],
    [49, 'medium'],
    [20, 'medium'],
    [19, 'low'],
    [0, 'low'],
  ] as const)('sampleSize %i → %s', (n, expected) => {
    expect(dataConfidence(n)).toBe(expected);
  });
});
