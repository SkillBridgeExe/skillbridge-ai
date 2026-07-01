import { extractCerts } from './cert-extractor';
import { parseDateRange } from '../cv-intake/intake-dates';

describe('extractCerts', () => {
  it('matches AWS cert with a date and grounded issuer', () => {
    const certs = extractCerts('Mình có chứng chỉ AWS Certified Solutions Architect, cấp 03/2023.');
    expect(certs.length).toBe(1);
    expect(certs[0].issuer).toBe('Amazon Web Services');
    expect(certs[0].matched_pattern).toBe('aws');
    expect(certs[0].date).toBe('03/2023'); // from parseDateRange (MM/YYYY, not YYYY-MM)
    expect(certs[0].name.toLowerCase()).toContain('aws certified');
  });

  it('matches TOEIC (VN common) with the grounded ETS issuer', () => {
    const certs = extractCerts('Có chứng chỉ TOEIC 850 điểm năm 2022.');
    const toeic = certs.find((c) => c.matched_pattern === 'toeic');
    expect(toeic).toBeDefined();
    expect(toeic?.issuer).toBe('ETS');
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

  it("does not leak a later cert's date onto an earlier cert in the same clause", () => {
    // Learn the real year-only output shape from parseDateRange itself — don't guess it.
    const yearOnlyShape = parseDateRange('IELTS năm 2019').start;
    const certs = extractCerts(
      'Học IELTS năm 2019, thi AWS Certified Solutions Architect cấp 03/2023.',
    );
    const aws = certs.find((c) => c.matched_pattern === 'aws');
    const ielts = certs.find((c) => c.matched_pattern === 'ielts');
    expect(aws?.date).toBe('03/2023');
    expect(ielts?.date).not.toBe('03/2023');
    expect(ielts?.date).toBe(yearOnlyShape);
  });

  it('does not collapse two distinct certs from the same issuer family', () => {
    const certs = extractCerts(
      'Mình có AWS Certified Cloud Practitioner năm 2020. Sau đó học thêm AWS Certified Solutions Architect năm 2023.',
    );
    const awsCerts = certs.filter((c) => c.matched_pattern === 'aws');
    expect(awsCerts.length).toBe(2);
    expect(awsCerts[0].name).not.toBe(awsCerts[1].name);
  });

  it('bounds the captured name so unrelated trailing prose is not swallowed', () => {
    const certs = extractCerts(
      'Mình có chứng chỉ AWS Certified Solutions Architect Professional và cũng học thêm React Node Python tại công ty XYZ',
    );
    const aws = certs.find((c) => c.matched_pattern === 'aws');
    expect(aws).toBeDefined();
    expect(aws?.name).not.toContain('Python');
  });
});
