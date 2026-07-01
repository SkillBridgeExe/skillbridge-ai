import { extractCerts } from './cert-extractor';

describe('extractCerts', () => {
  it('matches AWS cert with a date and grounded issuer', () => {
    const certs = extractCerts('Mình có chứng chỉ AWS Certified Solutions Architect, cấp 03/2023.');
    expect(certs.length).toBe(1);
    expect(certs[0].issuer).toBe('Amazon Web Services');
    expect(certs[0].matched_pattern).toBe('aws');
    expect(certs[0].date).toBe('03/2023'); // from parseDateRange (MM/YYYY, not YYYY-MM)
    expect(certs[0].name.toLowerCase()).toContain('aws certified');
  });

  it('matches TOEIC (VN common)', () => {
    const certs = extractCerts('Có chứng chỉ TOEIC 850 điểm năm 2022.');
    expect(certs.some((c) => c.matched_pattern === 'toeic')).toBe(true);
  });

  it('returns [] when no known cert pattern appears (no fabrication)', () => {
    const certs = extractCerts('Mình làm web với React và Node.');
    expect(certs).toEqual([]);
  });

  it('does not invent a date when none is present', () => {
    const certs = extractCerts('Có chứng chỉ IELTS.');
    expect(certs[0].matched_pattern).toBe('ielts');
    expect(certs[0].date).toBeNull();
  });
});
