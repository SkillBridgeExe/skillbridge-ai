import { jdContentHash } from './jd-content-hash';

describe('jdContentHash', () => {
  it('is stable across whitespace and case differences (copy-paste variants)', () => {
    const a = jdContentHash('We need  React\n and TypeScript.');
    const b = jdContentHash('  we need react and typescript.  ');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different content', () => {
    expect(jdContentHash('React dev')).not.toBe(jdContentHash('Vue dev'));
  });
});
