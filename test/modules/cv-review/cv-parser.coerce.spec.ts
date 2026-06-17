import { CvParserService } from '../../../src/modules/cv-review/cv-parser.service';

/**
 * Deterministic CI gate for the cv_parse coercion layer. coerce() turns arbitrary LLM JSON into a
 * guaranteed-valid CanonicalCvDocument — this is the safety net that stops a malformed model
 * response from scoring a real CV as blank. 0 LLM, 0 DB: the service is built with null deps because
 * coerce() never touches them. (The LLM extraction QUALITY itself is measured separately, opt-in, by
 * eval:cv-parse.)
 */
describe('CvParserService.coerce', () => {
  // coerce() does not use llm/prompts — safe to construct with nulls for a pure unit test.
  const svc = new CvParserService(null as never, null as never);

  it('non-object input (null / array / string) → empty document, language "en"', () => {
    for (const bad of [null, undefined, [], 'a string', 42]) {
      const doc = svc.coerce(bad);
      expect(doc.language).toBe('en');
      expect(doc.summary).toBe('');
      expect(doc.education).toEqual([]);
      expect(doc.experience).toEqual([]);
      expect(doc.projects).toEqual([]);
      expect(doc.skills).toEqual({ technical: [], soft: [], languages: [], tools: [] });
    }
  });

  it('normalizes Vietnamese language variants → "vi"', () => {
    for (const v of ['vi', 'vn', 'vie', 'Vietnamese', 'tiếng Việt', 'vie-VN', 'VIE']) {
      expect(svc.coerce({ language: v }).language).toBe('vi');
    }
  });

  it('normalizes English variants → "en"; unknown language → 2-letter prefix', () => {
    expect(svc.coerce({ language: 'English' }).language).toBe('en');
    expect(svc.coerce({ language: 'eng' }).language).toBe('en');
    expect(svc.coerce({ language: 'japanese' }).language).toBe('ja');
    expect(svc.coerce({ language: '' }).language).toBe('en'); // empty → default
  });

  it('wrong-typed sections coerce to safe empties (never throw)', () => {
    const doc = svc.coerce({
      education: 'not-an-array',
      experience: 42,
      projects: null,
      skills: 'nope',
      certifications: {},
      activities: false,
    });
    expect(doc.education).toEqual([]);
    expect(doc.experience).toEqual([]);
    expect(doc.projects).toEqual([]);
    expect(doc.skills).toEqual({ technical: [], soft: [], languages: [], tools: [] });
    expect(doc.certifications).toEqual([]);
    expect(doc.activities).toEqual([]);
  });

  it('skills arrays drop blanks and non-strings', () => {
    const doc = svc.coerce({
      skills: {
        technical: ['React', '', '   ', 42, null, 'Node.js'],
        soft: 'x',
        tools: ['Docker'],
      },
    });
    expect(doc.skills.technical).toEqual(['React', 'Node.js']);
    expect(doc.skills.soft).toEqual([]); // non-array → []
    expect(doc.skills.tools).toEqual(['Docker']);
  });

  it('education: non-string gpa → null; dates preserved verbatim (no ISO normalization)', () => {
    const doc = svc.coerce({
      education: [
        { school: 'HUST', gpa: 123, start: '09/2020', end: 'Hiện tại', degree: 'Cử nhân' },
      ],
    });
    expect(doc.education[0].gpa).toBeNull(); // number is not a string → null
    expect(doc.education[0].start).toBe('09/2020');
    expect(doc.education[0].end).toBe('Hiện tại');
    expect(doc.education[0].degree).toBe('Cử nhân');
  });

  it('experience bullets filter to non-blank strings', () => {
    const doc = svc.coerce({
      experience: [{ org: 'FPT', role: 'BE', bullets: ['Built API', '', 7, 'Tuned SQL'] }],
    });
    expect(doc.experience[0].bullets).toEqual(['Built API', 'Tuned SQL']);
  });

  it('contact links drop entries without a url; label defaults to "Link"', () => {
    const doc = svc.coerce({
      contact: {
        name: 'An',
        links: [{ label: 'GitHub', url: 'gh.com/a' }, { label: 'NoUrl' }, { url: 'x.com' }],
      },
    });
    expect(doc.contact.name).toBe('An');
    expect(doc.contact.links).toEqual([
      { label: 'GitHub', url: 'gh.com/a' },
      { label: 'Link', url: 'x.com' },
    ]);
  });

  it('summary: null / number → empty string', () => {
    expect(svc.coerce({ summary: null }).summary).toBe('');
    expect(svc.coerce({ summary: 42 }).summary).toBe('');
    expect(svc.coerce({ summary: 'Backend dev' }).summary).toBe('Backend dev');
  });

  it('certification: null issuer/date preserved as null, name coerced', () => {
    const doc = svc.coerce({ certifications: [{ name: 'AWS SAA', issuer: null, date: null }] });
    expect(doc.certifications[0]).toEqual({ name: 'AWS SAA', issuer: null, date: null });
  });

  it('fills missing contact fields from extracted CV text without overwriting model data', () => {
    const text = [
      'ANONYMIZED CANDIDATE',
      '0912.345.678 | candidate@example.com | LinkedIn | GitHub | Thu Duc, Ho Chi Minh City',
      'Summary',
      'Backend developer focused on ASP.NET Core.',
    ].join('\n');

    const coerce = svc.coerce as (
      raw: unknown,
      extractedText?: string,
    ) => ReturnType<typeof svc.coerce>;
    const doc = coerce.call(
      svc,
      {
        contact: {
          name: 'Model Name',
          email: null,
          phone: null,
          location: null,
          links: [],
        },
      },
      text,
    );

    expect(doc.contact.name).toBe('Model Name');
    expect(doc.contact.email).toBe('candidate@example.com');
    expect(doc.contact.phone).toBe('0912.345.678');
    expect(doc.contact.location).toBe('Thu Duc, Ho Chi Minh City');
  });

  it('fills a missing contact name from the first resume-like line', () => {
    const coerce = svc.coerce as (
      raw: unknown,
      extractedText?: string,
    ) => ReturnType<typeof svc.coerce>;
    const doc = coerce.call(
      svc,
      { contact: { name: null, email: null, phone: null, location: null, links: [] } },
      'ANONYMIZED CANDIDATE\ncandidate@example.com',
    );

    expect(doc.contact.name).toBe('ANONYMIZED CANDIDATE');
  });
});
