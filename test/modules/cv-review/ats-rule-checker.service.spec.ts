import {
  AtsRuleCheckerService,
  AtsCheckResult,
} from '../../../src/modules/cv-review/ats-rule-checker.service';
import { CanonicalCvDocument, emptyCanonicalCv } from '../../../src/common/types/canonical-cv';

/**
 * Deterministic ATS rule checker — golden unit tests (no LLM, no quota).
 * Locks each of the 10 rules + the 0-100 composite math, since this service is 40% of every
 * CV score and was previously untested.
 */
const LONG_TEXT = 'Experienced backend developer building scalable services. '.repeat(60); // ~360 words

function byId(res: AtsCheckResult, id: string) {
  const r = res.rules.find((x) => x.rule_id === id);
  if (!r) throw new Error(`rule ${id} missing`);
  return r;
}

function strongDoc(): CanonicalCvDocument {
  return {
    ...emptyCanonicalCv('en'),
    contact: {
      name: 'Nguyen Van A',
      email: 'a.nguyen@gmail.com',
      phone: '+84 912 345 678',
      location: 'HCM',
      links: [],
    },
    summary: 'Backend developer focused on Node.js and Postgres.',
    education: [
      {
        school: 'FPT',
        degree: 'BSc',
        field: 'CS',
        start: '2021',
        end: '2025',
        gpa: '3.5/4',
        highlights: [],
      },
    ],
    experience: [
      {
        org: 'FPT Software',
        role: 'Intern',
        start: '01/2024',
        end: '06/2024',
        location: 'HCM',
        bullets: ['Built REST APIs with Node.js, cutting latency 40%'],
      },
    ],
    skills: {
      technical: ['Node.js', 'PostgreSQL', 'React'],
      soft: [],
      languages: [],
      tools: ['Docker'],
    },
  };
}

describe('AtsRuleCheckerService', () => {
  const svc = new AtsRuleCheckerService();

  it('a complete, well-formed CV passes the core rules and scores high', () => {
    const res = svc.check({ document: strongDoc(), parsed_text: LONG_TEXT });
    expect(res.summary.total).toBe(10);
    expect(byId(res, 'has_section_contact').status).toBe('pass');
    expect(byId(res, 'has_section_education').status).toBe('pass');
    expect(byId(res, 'has_section_experience').status).toBe('pass');
    expect(byId(res, 'has_section_skills').status).toBe('pass');
    expect(byId(res, 'email_present').status).toBe('pass');
    expect(byId(res, 'phone_present').status).toBe('pass');
    expect(res.ats_rule_score).toBeGreaterThanOrEqual(90);
  });

  it('ats_rule_score = round((passed + warned*0.5) / total * 100) — pure + reproducible', () => {
    const res = svc.check({ document: strongDoc(), parsed_text: LONG_TEXT });
    const expected = Math.round(
      ((res.summary.passed + res.summary.warned * 0.5) / res.summary.total) * 100,
    );
    expect(res.ats_rule_score).toBe(expected);
    // Deterministic: same input → identical result.
    expect(svc.check({ document: strongDoc(), parsed_text: LONG_TEXT })).toEqual(res);
  });

  it('is_ocr_only fails the file-format rule (ATS cannot read an image-only CV)', () => {
    const res = svc.check({ document: strongDoc(), parsed_text: LONG_TEXT, is_ocr_only: true });
    expect(byId(res, 'file_format_acceptable').status).toBe('fail');
  });

  it('missing contact + no email/phone → contact/email/phone rules fail', () => {
    const res = svc.check({
      document: emptyCanonicalCv('en'),
      parsed_text: 'Just some prose with no contact details.',
    });
    expect(byId(res, 'has_section_contact').status).toBe('fail');
    expect(byId(res, 'email_present').status).toBe('fail');
    expect(byId(res, 'phone_present').status).toBe('fail');
  });

  it('skills rule: ≥3 pass, 1-2 warn, 0 fail', () => {
    const three = {
      ...strongDoc(),
      skills: { technical: ['A', 'B', 'C'], soft: [], languages: [], tools: [] },
    };
    const two = {
      ...strongDoc(),
      skills: { technical: ['A'], soft: ['B'], languages: [], tools: [] },
    };
    const none = { ...strongDoc(), skills: { technical: [], soft: [], languages: [], tools: [] } };
    expect(
      byId(svc.check({ document: three, parsed_text: LONG_TEXT }), 'has_section_skills').status,
    ).toBe('pass');
    expect(
      byId(svc.check({ document: two, parsed_text: LONG_TEXT }), 'has_section_skills').status,
    ).toBe('warn');
    expect(
      byId(svc.check({ document: none, parsed_text: LONG_TEXT }), 'has_section_skills').status,
    ).toBe('fail');
  });

  it('reasonable_length: <100 fail, <250 warn, in-range pass, >1500 warn', () => {
    const lenStatus = (words: number) =>
      byId(
        svc.check({ document: strongDoc(), parsed_text: 'w '.repeat(words) }),
        'reasonable_length',
      ).status;
    expect(lenStatus(80)).toBe('fail');
    expect(lenStatus(200)).toBe('warn');
    expect(lenStatus(500)).toBe('pass');
    expect(lenStatus(1600)).toBe('warn');
  });

  it('experience-or-projects rule is student-lenient: projects substitute for experience (warn, not fail)', () => {
    const projectsOnly: CanonicalCvDocument = {
      ...emptyCanonicalCv('en'),
      projects: [
        {
          name: 'P',
          role: null,
          tech: [],
          bullets: ['Built a CLI cutting build time 30%'],
          link: null,
        },
      ],
    };
    expect(
      byId(svc.check({ document: projectsOnly, parsed_text: LONG_TEXT }), 'has_section_experience')
        .status,
    ).toBe('warn');
  });

  it('dates rule (review fix): 1 dated education + projects → PASS, not warn', () => {
    const studentWithProjects: CanonicalCvDocument = {
      ...emptyCanonicalCv('en'),
      education: [
        {
          school: 'X',
          degree: null,
          field: null,
          start: '2021',
          end: '2025',
          gpa: null,
          highlights: [],
        },
      ],
      projects: [
        { name: 'P1', role: null, tech: [], bullets: ['Built X'], link: null },
        { name: 'P2', role: null, tech: [], bullets: ['Shipped Y'], link: null },
      ],
    };
    expect(
      byId(svc.check({ document: studentWithProjects, parsed_text: LONG_TEXT }), 'dates_present')
        .status,
    ).toBe('pass');

    // No dates anywhere AND no projects → still fail.
    const noTimeline: CanonicalCvDocument = {
      ...emptyCanonicalCv('en'),
      education: [
        {
          school: 'X',
          degree: null,
          field: null,
          start: null,
          end: null,
          gpa: null,
          highlights: [],
        },
      ],
    };
    expect(
      byId(svc.check({ document: noTimeline, parsed_text: LONG_TEXT }), 'dates_present').status,
    ).toBe('fail');
  });

  it('filler-verb rule warns/fails when bullets are duty-phrased', () => {
    const fillerDoc: CanonicalCvDocument = {
      ...emptyCanonicalCv('en'),
      experience: [
        {
          org: 'X',
          role: 'Y',
          start: '2024',
          end: null,
          location: null,
          bullets: [
            'Responsible for the website',
            'Worked on some tasks',
            'Helped with the project',
            'In charge of testing',
          ],
        },
      ],
    };
    expect(
      byId(svc.check({ document: fillerDoc, parsed_text: LONG_TEXT }), 'no_excessive_repetition')
        .status,
    ).not.toBe('pass');
  });
});
