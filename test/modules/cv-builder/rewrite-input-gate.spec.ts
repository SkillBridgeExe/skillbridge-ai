import { assessRewriteInput } from '../../../src/modules/cv-builder/rewrite-input-gate';

/**
 * Unit tests for the deterministic input-quality gate.
 * No LLM, no network — pure function.
 */
describe('assessRewriteInput', () => {
  // -------------------------------------------------------------------------
  // FAIL cases — garbage / insufficient content
  // -------------------------------------------------------------------------
  describe('FAIL cases', () => {
    it('"aa" → INSUFFICIENT_CONTEXT (single repeated char, 1 token)', () => {
      const r = assessRewriteInput('aa');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('INSUFFICIENT_CONTEXT');
    });

    it('"AAA" → INSUFFICIENT_CONTEXT (single repeated char, 1 token)', () => {
      const r = assessRewriteInput('AAA');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('INSUFFICIENT_CONTEXT');
    });

    it('"aaaa aaaa" → INSUFFICIENT_CONTEXT (both tokens are single-char repeated)', () => {
      const r = assessRewriteInput('aaaa aaaa');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('INSUFFICIENT_CONTEXT');
    });

    it('"test test test" → INSUFFICIENT_CONTEXT (low unique-ratio + blocklist)', () => {
      const r = assessRewriteInput('test test test');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('INSUFFICIENT_CONTEXT');
    });

    it('"asdf asdf" → INSUFFICIENT_CONTEXT (blocklist token, low ratio)', () => {
      const r = assessRewriteInput('asdf asdf');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('INSUFFICIENT_CONTEXT');
    });

    it('"lorem ipsum" → INSUFFICIENT_CONTEXT (blocklist tokens, < 4 meaningful, < 25 chars)', () => {
      const r = assessRewriteInput('lorem ipsum');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('INSUFFICIENT_CONTEXT');
    });

    it('"12 34 56" → INSUFFICIENT_CONTEXT (no letters in any token)', () => {
      const r = assessRewriteInput('12 34 56');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('INSUFFICIENT_CONTEXT');
    });

    it('"react react react react" → INSUFFICIENT_CONTEXT (unique-ratio ≤ 0.34)', () => {
      const r = assessRewriteInput('react react react react');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('INSUFFICIENT_CONTEXT');
    });
  });

  // -------------------------------------------------------------------------
  // PASS cases — real content
  // -------------------------------------------------------------------------
  describe('PASS cases', () => {
    it('"Built admin dashboard with React" → ok', () => {
      const r = assessRewriteInput('Built admin dashboard with React');
      expect(r.ok).toBe(true);
      expect(r.reason).toBeUndefined();
    });

    it('Vietnamese sentence with percentage → ok', () => {
      const r = assessRewriteInput('Xây dựng giỏ hàng với ReactJS, tăng chuyển đổi 12%');
      expect(r.ok).toBe(true);
    });

    it('"Tối ưu SQL queries" (4 meaningful tokens) → ok', () => {
      // "Tối" (3), "ưu" (len 2, has letter, not blocklist), "SQL" (3), "queries" (7) — 4 meaningful
      const r = assessRewriteInput('Tối ưu SQL queries');
      expect(r.ok).toBe(true);
    });

    it('"Optimized PostgreSQL queries" (3 tokens, 26 letter-chars) → ok (long chars override token count)', () => {
      // 3 meaningful tokens, but meaningfulChars >= 25 → combined FAIL condition is false → PASS
      const r = assessRewriteInput('Optimized PostgreSQL queries');
      expect(r.ok).toBe(true);
    });
  });
});
