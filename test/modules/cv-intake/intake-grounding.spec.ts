// test/modules/cv-intake/intake-grounding.spec.ts
import { isGrounded } from '../../../src/modules/cv-intake/intake-grounding';
const N =
  'Tôi làm ở SmartAI Solutions vị trí AI Engineer, xây chatbot bằng GPT-4o, giảm 40% thời gian.';
describe('isGrounded', () => {
  it('accepts a value present in the narrative', () => {
    expect(isGrounded('SmartAI Solutions', N)).toBe(true);
    expect(isGrounded('GPT-4o', N)).toBe(true);
    expect(isGrounded('giảm 40% thời gian', N)).toBe(true);
  });
  it('rejects a fabricated entity not in the narrative', () => {
    expect(isGrounded('Google', N)).toBe(false);
  });
  it('rejects a fabricated number', () => {
    expect(isGrounded('giảm 80% thời gian', N)).toBe(false); // 80% not stated (40% is)
  });
  it('rejects a fabricated named-tech (Kafka)', () => {
    expect(isGrounded('xây bằng Kafka', N)).toBe(false);
  });

  // Issue #1: company/position are single atoms — recombined/substring words must NOT pass `atom` mode.
  describe('atom mode (company/position) rejects recombination + substring', () => {
    it('rejects a company recombined from scattered words', () => {
      const n = 'Tôi làm ở Smart Data, đội Cloud Solutions, vị trí AI Engineer.';
      expect(isGrounded('Smart Solutions', n, 'atom')).toBe(false);
    });
    it('rejects a position recombined from scattered words', () => {
      const n = 'I was a frontend lead and also did backend dev work.';
      expect(isGrounded('Backend Lead', n, 'atom')).toBe(false);
    });
    it('rejects a substring false-positive company', () => {
      const n = 'I interned at Apple and used the network.';
      expect(isGrounded('App Net', n, 'atom')).toBe(false);
    });
    it('accepts a contiguous company/position', () => {
      expect(isGrounded('SmartAI Solutions', N, 'atom')).toBe(true);
      expect(isGrounded('AI Engineer', N, 'atom')).toBe(true);
    });
  });
});
