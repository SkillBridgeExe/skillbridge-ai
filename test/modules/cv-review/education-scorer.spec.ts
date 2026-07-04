import { scoreEducation } from '../../../src/modules/cv-review/education-scorer';
import { CanonicalCvDocument, emptyCanonicalCv } from '../../../src/common/types/canonical-cv';

function doc(partial: Partial<CanonicalCvDocument>): CanonicalCvDocument {
  return { ...emptyCanonicalCv('en'), ...partial };
}

function edu(
  overrides: Partial<CanonicalCvDocument['education'][number]> = {},
): CanonicalCvDocument['education'][number] {
  return {
    school: 'Some University',
    degree: null,
    field: null,
    start: null,
    end: null,
    gpa: null,
    highlights: [],
    ...overrides,
  };
}

describe('scoreEducation (Dim-4 deterministic scorer)', () => {
  it('bachelor + IT field + GPA 3.4/4.0 above threshold → 20 (8 + 6 + 4 + 2, capped)', () => {
    const document = doc({
      education: [
        edu({
          school: 'ABC University',
          degree: 'Bachelor of Science',
          field: 'CS',
          gpa: '3.4/4.0',
        }),
      ],
    });
    const result = scoreEducation(document, 'irrelevant raw text');
    expect(result).not.toBeNull();
    expect(result!.score20).toBe(20);
    expect(result!.confidence).toBe('high');
  });

  it('studying (no degree yet, school+field present) + IT field → 16 (8 + 4 studying + 4 field)', () => {
    const document = doc({
      education: [edu({ school: 'Đại học Bách Khoa', degree: null, field: 'CNTT' })],
    });
    const result = scoreEducation(document, 'irrelevant raw text');
    expect(result!.score20).toBe(16);
  });

  it('education empty + rawText has no education token → 4, deterministic, confidence high', () => {
    const document = doc({ education: [] });
    const result = scoreEducation(document, 'Frontend developer, 2 years experience with React.');
    expect(result).not.toBeNull();
    expect(result!.score20).toBe(4);
    expect(result!.confidence).toBe('high');
    expect(result!.evidence).toContain('0 education entries');
  });

  it('education empty + rawText mentions "Đại học Bách Khoa" → null (parser likely missed it)', () => {
    const document = doc({ education: [] });
    const result = scoreEducation(
      document,
      'Tốt nghiệp Đại học Bách Khoa Hà Nội, chuyên ngành CNTT.',
    );
    expect(result).toBeNull();
  });

  it('bachelor economics (non-IT field, no GPA) → 14 (8 + 6, no field/GPA bonus)', () => {
    const document = doc({
      education: [edu({ school: 'Đại học Kinh tế', degree: 'Cử nhân', field: 'Kinh tế' })],
    });
    const result = scoreEducation(document, 'irrelevant raw text');
    expect(result!.score20).toBe(14);
  });

  it('associate/college degree, non-IT field, no GPA → 12 (8 + 4 associate)', () => {
    const document = doc({
      education: [edu({ school: 'Cao đẳng FPT', degree: 'Cao đẳng', field: 'Kế toán' })],
    });
    const result = scoreEducation(document, 'irrelevant raw text');
    expect(result!.score20).toBe(12);
  });

  it('GPA below threshold on /4 scale → no bonus (18 = 8 + 6 + 4, GPA 2.5/4.0 excluded)', () => {
    const document = doc({
      education: [edu({ school: 'X University', degree: 'Bachelor', field: 'SE', gpa: '2.5/4.0' })],
    });
    const result = scoreEducation(document, 'irrelevant raw text');
    expect(result!.score20).toBe(18);
  });

  it('GPA 8.2/10 above the /10 threshold → bonus applied (16 = 8 + 6 + 0 + 2)', () => {
    const document = doc({
      education: [
        edu({ school: 'Y University', degree: 'Bachelor', field: 'Business', gpa: '8.2/10' }),
      ],
    });
    const result = scoreEducation(document, 'irrelevant raw text');
    expect(result!.score20).toBe(16);
  });

  it('unparseable GPA string never crashes and grants no bonus', () => {
    const document = doc({
      education: [
        edu({ school: 'Z University', degree: 'Bachelor', field: 'Business', gpa: 'Very good' }),
      ],
    });
    expect(() => scoreEducation(document, '')).not.toThrow();
    const result = scoreEducation(document, '');
    expect(result!.score20).toBe(14); // 8 + 6, no field/gpa bonus
  });

  it('multiple entries: scores the BEST entry, evidence mentions the entry count', () => {
    const document = doc({
      education: [
        edu({ school: 'High School A', degree: null, field: null }), // school-only → 8
        edu({ school: 'Best University', degree: 'Bachelor', field: 'CS', gpa: '3.8/4.0' }), // → 20
      ],
    });
    const result = scoreEducation(document, 'irrelevant raw text');
    expect(result!.score20).toBe(20);
    expect(result!.evidence).toContain('2 education entries');
  });
});
