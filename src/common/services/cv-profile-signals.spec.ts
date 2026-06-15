import { CanonicalCvDocument, emptyCanonicalCv } from '../types/canonical-cv';
import {
  deriveCvEnglishLevel,
  deriveCvEducation,
  deriveCvDomain,
  deriveCvWorkMode,
  deriveCvProfileSignals,
  parseEnglishRequirement,
  classifyDomains,
  classifyDegree,
  CEFR_RANK,
  DEGREE_RANK,
} from './cv-profile-signals';

const doc = (over: Partial<CanonicalCvDocument> = {}): CanonicalCvDocument => ({
  ...emptyCanonicalCv(),
  ...over,
});
const langs = (...l: string[]): CanonicalCvDocument =>
  doc({ skills: { technical: [], soft: [], languages: l, tools: [] } });
const edu = (e: Partial<CanonicalCvDocument['education'][number]>): CanonicalCvDocument =>
  doc({
    education: [
      {
        school: '',
        degree: null,
        field: null,
        start: null,
        end: null,
        gpa: null,
        highlights: [],
        ...e,
      },
    ],
  });
const exp = (e: Partial<CanonicalCvDocument['experience'][number]>): CanonicalCvDocument =>
  doc({
    experience: [
      { org: '', role: null, start: null, end: null, location: null, bullets: [], ...e },
    ],
  });
const proj = (p: Partial<CanonicalCvDocument['projects'][number]>): CanonicalCvDocument =>
  doc({ projects: [{ name: '', role: null, tech: [], bullets: [], link: null, ...p }] });

describe('deriveCvEnglishLevel (IELTS/TOEIC/CEFR/textual → CEFR, null when no signal)', () => {
  it('IELTS 6.5 → B2 high (ielts)', () => {
    expect(deriveCvEnglishLevel(langs('English (IELTS 6.5)'))).toMatchObject({
      cefr: 'B2',
      source_kind: 'ielts',
      confidence: 'high',
    });
  });
  it('TOEIC 750 → B1 high (toeic)', () => {
    expect(deriveCvEnglishLevel(langs('TOEIC 750'))).toMatchObject({
      cefr: 'B1',
      source_kind: 'toeic',
      confidence: 'high',
    });
  });
  it('explicit "English B2" → B2 high (cefr)', () => {
    expect(deriveCvEnglishLevel(langs('English B2'))).toMatchObject({
      cefr: 'B2',
      source_kind: 'cefr',
      confidence: 'high',
    });
  });
  it('reads certifications[].name too (IELTS 7.0 → C1)', () => {
    expect(
      deriveCvEnglishLevel(
        doc({ certifications: [{ name: 'IELTS 7.0', issuer: 'BC', date: null }] }),
      ),
    ).toMatchObject({ cefr: 'C1', source_kind: 'ielts' });
  });
  it('textual "Tiếng Anh giao tiếp" → B1 low (textual)', () => {
    expect(deriveCvEnglishLevel(langs('Tiếng Anh giao tiếp'))).toMatchObject({
      cefr: 'B1',
      source_kind: 'textual',
      confidence: 'low',
    });
  });
  it('test score beats textual when both present', () => {
    expect(deriveCvEnglishLevel(langs('English - fluent', 'English (IELTS 6.5)'))).toMatchObject({
      source_kind: 'ielts',
      cefr: 'B2',
    });
  });
  it('bare "English" / Japanese / no english → null (no fabrication)', () => {
    expect(deriveCvEnglishLevel(langs('English'))).toBeNull();
    expect(deriveCvEnglishLevel(langs('Tiếng Nhật N3'))).toBeNull();
    expect(deriveCvEnglishLevel(doc())).toBeNull();
  });
  it('driving licence "Bằng lái xe B2" → null (no english cue, no fabrication)', () => {
    expect(deriveCvEnglishLevel(langs('Bằng lái xe B2'))).toBeNull();
  });
  it('out-of-range IELTS 12 → null', () => {
    expect(deriveCvEnglishLevel(langs('IELTS 12'))).toBeNull();
  });
});

describe('deriveCvEducation (degree level + major, null when no entry)', () => {
  it('explicit degree → bachelor high + field', () => {
    expect(
      deriveCvEducation(edu({ school: 'X', degree: 'Cử nhân', field: 'Kỹ thuật phần mềm' })),
    ).toMatchObject({ level: 'bachelor', field: 'Kỹ thuật phần mềm', confidence: 'high' });
  });
  it('FPT University + Software Engineering, no degree → bachelor medium (inferred from school)', () => {
    expect(
      deriveCvEducation(
        edu({ school: 'FPT University', degree: null, field: 'Software Engineering' }),
      ),
    ).toMatchObject({ level: 'bachelor', field: 'Software Engineering', confidence: 'medium' });
  });
  it('master beats bachelor (highest across entries)', () => {
    expect(
      deriveCvEducation(
        doc({
          education: [
            {
              school: 'A',
              degree: 'Bachelor',
              field: 'CS',
              start: null,
              end: null,
              gpa: null,
              highlights: [],
            },
            {
              school: 'B',
              degree: 'Master of Science',
              field: 'AI',
              start: null,
              end: null,
              gpa: null,
              highlights: [],
            },
          ],
        }),
      ),
    ).toMatchObject({ level: 'master' });
  });
  it('no education → null', () => {
    expect(deriveCvEducation(doc())).toBeNull();
  });
});

describe('deriveCvDomain (industry from experience/projects, null when no keyword)', () => {
  it('ecommerce project → ecommerce', () => {
    expect(
      deriveCvDomain(
        proj({ name: 'E-commerce shopping cart', bullets: ['checkout + marketplace'] }),
      )?.domains,
    ).toContain('ecommerce');
  });
  it('explicit fintech anchor (e-wallet / payment gateway) → fintech', () => {
    expect(
      deriveCvDomain(
        exp({ org: 'PayCo', bullets: ['built a payment gateway for a ví điện tử (e-wallet)'] }),
      )?.domains,
    ).toContain('fintech');
  });
  it('no domain keyword → null', () => {
    expect(deriveCvDomain(exp({ org: 'X', bullets: ['internal tooling'] }))).toBeNull();
  });
});

describe('deriveCvWorkMode (remote/hybrid/onsite, null when not stated)', () => {
  it('explicit Remote location → remote low', () => {
    expect(deriveCvWorkMode(exp({ org: 'X', location: 'Remote' }))).toMatchObject({
      mode: 'remote',
      confidence: 'low',
    });
  });
  it('no work_mode mention → null', () => {
    expect(deriveCvWorkMode(doc())).toBeNull();
  });
});

describe('deriveCvProfileSignals (aggregator)', () => {
  it('empty doc → all four null', () => {
    expect(deriveCvProfileSignals(doc())).toEqual({
      english: null,
      education: null,
      domain: null,
      work_mode: null,
    });
  });
  it('combines all four when present', () => {
    const d = doc({
      skills: { technical: [], soft: [], languages: ['English (IELTS 6.5)'], tools: [] },
      education: [
        {
          school: 'FPT University',
          degree: 'Bachelor',
          field: 'Software Engineering',
          start: null,
          end: null,
          gpa: null,
          highlights: [],
        },
      ],
      projects: [
        {
          name: 'E-commerce platform',
          role: null,
          tech: [],
          bullets: ['payment checkout'],
          link: null,
        },
      ],
      experience: [
        { org: 'X', role: null, start: null, end: null, location: 'Remote', bullets: [] },
      ],
    });
    const out = deriveCvProfileSignals(d);
    expect(out.english).toMatchObject({ cefr: 'B2' });
    expect(out.education).toMatchObject({ level: 'bachelor', field: 'Software Engineering' });
    expect(out.domain?.domains).toContain('ecommerce');
    expect(out.work_mode).toMatchObject({ mode: 'remote' });
  });
});

describe('anti-fabrication regression (adversarial review w77s4r9nb)', () => {
  it('english: aspiration/duration/sub-test/stray-year do NOT fabricate', () => {
    expect(deriveCvEnglishLevel(langs('IELTS preparation, 2 years'))).toBeNull(); // duration + prep
    expect(deriveCvEnglishLevel(langs('TOEIC target 990 by 2025'))).toBeNull(); // aspiration
    expect(deriveCvEnglishLevel(langs('TOEIC Speaking 180'))).toBeNull(); // wrong scale gated
    expect(deriveCvEnglishLevel(langs('IELTS 3'))).toBeNull(); // below B1 floor
  });
  it('english: picks the highest valid band in a window (sub-scores / leading year)', () => {
    expect(deriveCvEnglishLevel(langs('TOEIC Listening 495, Reading 480 = 975'))).toMatchObject({
      cefr: 'C1',
    });
    expect(deriveCvEnglishLevel(langs('IELTS 2023 score 7.0'))).toMatchObject({ cefr: 'C1' });
  });
  it('english: textual must be ADJACENT to the english cue (no cross-language / negation / unrelated adj)', () => {
    expect(deriveCvEnglishLevel(langs('French - fluent, English - basic'))).toMatchObject({
      cefr: 'A2',
    }); // not C1
    expect(deriveCvEnglishLevel(langs('English - not very good'))).toBeNull(); // negation breaks adjacency
    expect(deriveCvEnglishLevel(langs('English Java advanced developer'))).toBeNull(); // 'advanced' not the english level
    expect(deriveCvEnglishLevel(langs('English: khác với người bản xứ'))).toBeNull(); // 'khá' must not match inside 'khác'
  });
  it('domain: generic engineering vocabulary does NOT fabricate an industry', () => {
    expect(deriveCvDomain(exp({ bullets: ['Continuous delivery pipeline (CI/CD)'] }))).toBeNull();
    expect(deriveCvDomain(exp({ bullets: ['Shipping the MVP to production'] }))).toBeNull();
    expect(
      deriveCvDomain(proj({ name: 'Game theory research', bullets: ['optimize bidding'] })),
    ).toBeNull();
    expect(deriveCvDomain(exp({ bullets: ['Education: BSc Computer Science'] }))).toBeNull();
  });
  it('work_mode: technical "remote"/"hybrid" in bullets does NOT fabricate (location-only)', () => {
    expect(
      deriveCvWorkMode(
        exp({
          location: null,
          bullets: ['Built a remote procedure call (RPC) service', 'hybrid cloud architecture'],
        }),
      ),
    ).toBeNull();
  });
  it('education: High School Diploma → high_school (not associate); bootcamp Diploma → field-only', () => {
    expect(deriveCvEducation(edu({ school: 'X', degree: 'High School Diploma' }))).toMatchObject({
      level: 'high_school',
    });
    expect(
      deriveCvEducation(
        edu({ school: 'X', degree: 'Diploma in Web Development', field: 'Web Development' }),
      ),
    ).toMatchObject({ level: null, field: 'Web Development' });
    expect(
      deriveCvEducation(edu({ school: 'Greenfield University High School', degree: null })),
    ).toMatchObject({ level: 'high_school' }); // not bachelor
    expect(deriveCvEducation(edu({ school: 'X', degree: 'Mastering React course' }))).toBeNull(); // not master, no field → no signal
  });
});

describe('review round 2 regression (MUST 1–4)', () => {
  // MUST 1 — score/max notation: take the SCORE, never the max
  it('IELTS 6.5/9.0 → B2 (not C2); TOEIC 750/990 → B1 (not C1)', () => {
    expect(deriveCvEnglishLevel(langs('English IELTS 6.5/9.0'))).toMatchObject({ cefr: 'B2' });
    expect(deriveCvEnglishLevel(langs('TOEIC 750/990'))).toMatchObject({ cefr: 'B1' });
  });
  it('unclear score/max → null (do not pick max)', () => {
    expect(deriveCvEnglishLevel(langs('IELTS 7/10'))).toBeNull();
  });

  // MUST 2 — TOEIC L/R sub-scores
  it('TOEIC L 495 R 480 = 975 → C1 (total); no total → intentional sum 975 → C1', () => {
    expect(deriveCvEnglishLevel(langs('TOEIC Listening 495, Reading 480 = 975'))).toMatchObject({
      cefr: 'C1',
    });
    expect(deriveCvEnglishLevel(langs('TOEIC Listening 495, Reading 480'))).toMatchObject({
      cefr: 'C1',
    });
  });
  it('a single TOEIC section score is NOT mapped (→ null); Speaking still rejected', () => {
    expect(deriveCvEnglishLevel(langs('TOEIC Listening 495'))).toBeNull();
    expect(deriveCvEnglishLevel(langs('TOEIC Speaking 180'))).toBeNull();
  });
  it('TOEIC L/R sections must each be 5..495 — out-of-range → null (no fake total)', () => {
    expect(deriveCvEnglishLevel(langs('TOEIC Listening 500, Reading 480'))).toBeNull(); // L > 495
    expect(deriveCvEnglishLevel(langs('TOEIC Listening 600, Reading 390'))).toBeNull(); // L > 495
    expect(deriveCvEnglishLevel(langs('TOEIC Listening 495, Reading 480'))).toMatchObject({
      cefr: 'C1',
    }); // valid
    expect(deriveCvEnglishLevel(langs('TOEIC Listening 5, Reading 5'))).toMatchObject({
      cefr: 'A1',
    }); // low boundary, total 10
  });

  // MUST 3 — domain overmatch
  it('ecommerce checkout + thanh toán đơn hàng → ecommerce only, NO fintech', () => {
    const d = deriveCvDomain(
      proj({ name: 'Ecommerce store', bullets: ['checkout + thanh toán đơn hàng'] }),
    );
    expect(d?.domains).toContain('ecommerce');
    expect(d?.domains).not.toContain('fintech');
  });
  it('Unity AR / training simulator → NO gaming', () => {
    expect(
      deriveCvDomain(
        proj({ name: 'Unity AR training simulator', tech: ['Unity'], bullets: ['VR sim'] }),
      ),
    ).toBeNull();
  });

  // MUST 4 — work_mode conflict
  it('conflicting locations (Remote + On-site) → null; consistent → mode', () => {
    expect(
      deriveCvWorkMode(
        doc({
          experience: [
            { org: 'A', role: null, start: null, end: null, location: 'Remote', bullets: [] },
            {
              org: 'B',
              role: null,
              start: null,
              end: null,
              location: 'On-site, HCMC',
              bullets: [],
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      deriveCvWorkMode(
        doc({
          experience: [
            { org: 'A', role: null, start: null, end: null, location: 'Remote', bullets: [] },
            {
              org: 'B',
              role: null,
              start: null,
              end: null,
              location: 'Work from home',
              bullets: [],
            },
          ],
        }),
      ),
    ).toMatchObject({ mode: 'remote' });
  });
});

// ── PR3c — JD-side shared primitives ────────────────────────────────────────────
describe('parseEnglishRequirement (PR3c, JD-side, English-only)', () => {
  it('English + CEFR token → CEFR', () => {
    expect(parseEnglishRequirement('English B2 required')).toBe('B2');
    expect(parseEnglishRequirement('Tiếng Anh C1')).toBe('C1');
  });
  it('IELTS / TOEIC scores → CEFR (inherently English)', () => {
    expect(parseEnglishRequirement('IELTS 6.5+')).toBe('B2');
    expect(parseEnglishRequirement('TOEIC 800')).toBe('B2');
  });
  it('bare CEFR with NO english cue → null (no fabrication)', () => {
    expect(parseEnglishRequirement('B2 level')).toBeNull();
  });
  it('a non-English language requirement → null (English-only by design)', () => {
    expect(parseEnglishRequirement('Japanese N2')).toBeNull();
    expect(parseEnglishRequirement('Tiếng Nhật N2')).toBeNull();
  });
  it('English but no parseable level → null (honest omission upstream)', () => {
    expect(parseEnglishRequirement('Good English communication')).toBeNull();
  });
  it('empty/whitespace → null', () => {
    expect(parseEnglishRequirement('')).toBeNull();
    expect(parseEnglishRequirement('   ')).toBeNull();
  });
});

describe('classifyDomains (PR3c, shared)', () => {
  it('canonicalises a JD industry phrase', () => {
    expect(classifyDomains('experience in fintech / payment gateway')).toContain('fintech');
    expect(classifyDomains('e-commerce marketplace')).toContain('ecommerce');
  });
  it('generic prose → [] (no fabrication)', () => {
    expect(classifyDomains('built scalable backend services')).toEqual([]);
  });
  it('deriveCvDomain still works after refactor (byte-identical behaviour)', () => {
    expect(
      deriveCvDomain(proj({ name: 'Ecommerce store', bullets: ['checkout cart'] }))?.domains,
    ).toContain('ecommerce');
  });
});

describe('exported rank maps + classifyDegree (PR3c)', () => {
  it('ranks are ordered', () => {
    expect(CEFR_RANK.C2).toBeGreaterThan(CEFR_RANK.B2);
    expect(CEFR_RANK.B2).toBeGreaterThan(CEFR_RANK.B1);
    expect(DEGREE_RANK.phd).toBeGreaterThan(DEGREE_RANK.bachelor);
    expect(DEGREE_RANK.bachelor).toBeGreaterThan(DEGREE_RANK.associate);
  });
  it('classifyDegree maps JD degree text', () => {
    expect(classifyDegree("Bachelor's degree in Computer Science")).toBe('bachelor');
    expect(classifyDegree('Thạc sĩ CNTT')).toBe('master');
    expect(classifyDegree('No degree text here')).toBeNull();
  });
});
