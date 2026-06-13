import { maskPii, maskPiiDeep } from '../../src/common/services/pii-mask';

describe('pii-mask', () => {
  it('masks emails in a string', () => {
    expect(maskPii('Contact me at an.nguyen@gmail.com today')).toBe(
      'Contact me at [redacted-email] today',
    );
  });

  it('masks VN phone numbers in a string', () => {
    expect(maskPii('Gọi 0987 654 321 nhé')).toContain('[redacted-phone]');
    expect(maskPii('Gọi 0987 654 321 nhé')).not.toContain('0987');
  });

  it('leaves non-PII numbers (years, percents) untouched', () => {
    const text = 'Improved latency by 30% in 2024 across 3 teams';
    expect(maskPii(text)).toBe(text);
  });

  it('deep-masks every string in a nested object while keeping the shape', () => {
    const parsed = {
      matched_skills: [
        { canonical_name: 'react', evidence_text: 'Email an@x.dev led the React rewrite' },
      ],
      overall_score: 82,
      nested: { phone_line: 'Reach 0912345678 for refs' },
    };
    const masked = maskPiiDeep(parsed);
    expect(masked.overall_score).toBe(82); // numbers + structure preserved
    expect(masked.matched_skills[0].canonical_name).toBe('react');
    expect(masked.matched_skills[0].evidence_text).toContain('[redacted-email]');
    expect(masked.nested.phone_line).toContain('[redacted-phone]');
    // original is not mutated
    expect(parsed.matched_skills[0].evidence_text).toContain('an@x.dev');
  });

  it('handles null/undefined safely', () => {
    expect(maskPiiDeep(null)).toBeNull();
    expect(maskPiiDeep(undefined)).toBeUndefined();
  });
});
