import { CvReviewParser } from '../../../src/modules/cv-review/cv-review.parser';

/**
 * Golden unit tests for the LLM-output validator: it must clamp/round scores, compute its own
 * total, tolerate severity casing, and FAIL LOUDLY on a malformed shape (so a bad model response
 * can never become a plausible-but-wrong SUCCESS). No LLM, no quota.
 */
function validRaw() {
  return {
    scores: { action_verbs: 15, skills_relevance: 12, experience: 10, education: 8 },
    llm_total: 45,
    rationale: { action_verbs: 'a', skills_relevance: 'b', experience: 'c', education: 'd' },
    sections: [
      { name: 'Skills', score: 80, issues: [{ severity: 'warning', text: 'x', hint: 'y' }] },
    ],
    ats_extracted: {
      name: 'A',
      email: 'a@b.com',
      phone: '0900000000',
      skills_raw: ['React', 'Node'],
    },
  };
}

describe('CvReviewParser', () => {
  const p = new CvReviewParser();

  it('parses a valid rubric and computes llm_total from the per-dimension scores', () => {
    const out = p.parse(validRaw());
    expect(out.scores).toEqual({
      action_verbs: 15,
      skills_relevance: 12,
      experience: 10,
      education: 8,
    });
    expect(out.llm_total).toBe(45);
    expect(out.sections[0].score).toBe(80);
    expect(out.ats_extracted.skills_raw).toEqual(['React', 'Node']);
  });

  it('uses the COMPUTED total, ignoring a wrong model-reported llm_total', () => {
    const raw = { ...validRaw(), llm_total: 999 };
    expect(p.parse(raw).llm_total).toBe(45); // 15+12+10+8, not 999
  });

  it('clamps + rounds per-dimension scores into 0-20', () => {
    const raw = validRaw();
    raw.scores = {
      action_verbs: 25,
      skills_relevance: -3,
      experience: 18.6,
      education: 0,
    } as never;
    const out = p.parse(raw);
    expect(out.scores.action_verbs).toBe(20); // clamped from 25
    expect(out.scores.skills_relevance).toBe(0); // clamped from -3
    expect(out.scores.experience).toBe(19); // rounded from 18.6
  });

  it('clamps section.score into 0-100', () => {
    const raw = validRaw();
    raw.sections = [
      { name: 'A', score: 150, issues: [] },
      { name: 'B', score: -10, issues: [] },
    ] as never;
    const out = p.parse(raw);
    expect(out.sections[0].score).toBe(100);
    expect(out.sections[1].score).toBe(0);
  });

  it('tolerates severity casing/shorthand (WARN→warning, ERROR→error) and throws on garbage', () => {
    const ok = validRaw();
    ok.sections = [
      { name: 'A', score: 50, issues: [{ severity: 'WARN', text: 't' }] },
      { name: 'B', score: 50, issues: [{ severity: 'ERROR', text: 't' }] },
    ] as never;
    const out = p.parse(ok);
    expect(out.sections[0].issues[0].severity).toBe('warning');
    expect(out.sections[1].issues[0].severity).toBe('error');

    const bad = validRaw();
    bad.sections = [{ name: 'A', score: 50, issues: [{ severity: 'meh', text: 't' }] }] as never;
    expect(() => p.parse(bad)).toThrow();
  });

  it('defaults issues to [] when not an array, and rationale fields to "" when missing', () => {
    const raw = validRaw();
    raw.sections = [{ name: 'A', score: 50, issues: 'nope' }] as never;
    delete (raw.rationale as Record<string, unknown>).experience;
    const out = p.parse(raw);
    expect(out.sections[0].issues).toEqual([]);
    expect(out.rationale.experience).toBe('');
  });

  it('defaults ats_extracted to nulls/[] when fields are missing or wrong-typed', () => {
    const raw = validRaw();
    raw.ats_extracted = { name: 123, email: null, skills_raw: 'nope' } as never;
    const out = p.parse(raw);
    expect(out.ats_extracted.name).toBeNull();
    expect(out.ats_extracted.email).toBeNull();
    expect(out.ats_extracted.skills_raw).toEqual([]);
  });

  it('FAILS LOUDLY on a malformed shape (missing scores, non-number score, non-object input)', () => {
    expect(() => p.parse(null)).toThrow();
    expect(() => p.parse('a string')).toThrow();
    expect(() => p.parse([])).toThrow();
    expect(() => p.parse({ ...validRaw(), scores: undefined })).toThrow();
    const nonNumber = validRaw();
    nonNumber.scores = {
      action_verbs: 'high',
      skills_relevance: 12,
      experience: 10,
      education: 8,
    } as never;
    expect(() => p.parse(nonNumber)).toThrow();
  });

  it('parses N8 skills_extracted (proficiency + evidence), drops blanks, normalizes bad proficiency', () => {
    const raw = validRaw();
    (raw.ats_extracted as Record<string, unknown>).skills_extracted = [
      { name: 'React', proficiency_hint: 'ADVANCED', evidence_text: 'Built a component library' },
      { name: 'Node', proficiency_hint: 'wizard', evidence_text: '' },
      { name: '', proficiency_hint: 'advanced' },
    ];
    const out = p.parse(raw);
    expect(out.ats_extracted.skills_extracted).toEqual([
      { name: 'React', proficiency_hint: 'advanced', evidence_text: 'Built a component library' },
      { name: 'Node', proficiency_hint: 'unknown', evidence_text: null },
    ]);
  });

  it('falls back skills_extracted to skills_raw names when the LLM omits it', () => {
    const out = p.parse(validRaw()); // skills_raw ['React','Node'], no skills_extracted
    expect(out.ats_extracted.skills_extracted).toEqual([
      { name: 'React', proficiency_hint: 'unknown', evidence_text: null },
      { name: 'Node', proficiency_hint: 'unknown', evidence_text: null },
    ]);
  });
});
