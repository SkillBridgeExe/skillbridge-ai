import { computeMetrics } from '../../src/calibration/extractor-metrics';

const noSkills = () => [] as { canonical_name: string }[];

describe('computeMetrics', () => {
  it('counts mojibake (U+FFFD + mis-decoded UTF-8 sequences)', () => {
    const m = computeMetrics('Ho�ng â€“ Long', noSkills);
    expect(m.mojibakeCount).toBeGreaterThanOrEqual(2);
  });

  it('clean technical line → high ratios, no skills from a no-op scanner', () => {
    const m = computeMetrics('React Node.js TypeScript', noSkills);
    expect(m.skillsFound).toBe(0);
    expect(m.wordlikeRatio).toBe(1);
    expect(m.nonWsRatio).toBeGreaterThan(0.8);
    expect(m.lineCount).toBe(1);
  });

  it('skillsFound dedupes canonicals from the injected scanner, sorted', () => {
    const scan = () => [
      { canonical_name: 'react' },
      { canonical_name: 'react' },
      { canonical_name: 'node_js' },
    ];
    const m = computeMetrics('irrelevant', scan);
    expect(m.skillsFound).toBe(2);
    expect(m.skillCanonicals).toEqual(['node_js', 'react']);
  });

  it('empty text → zero ratios, no NaN', () => {
    const m = computeMetrics('', noSkills);
    expect(m.charCount).toBe(0);
    expect(m.nonWsRatio).toBe(0);
    expect(m.wordlikeRatio).toBe(0);
  });
});
