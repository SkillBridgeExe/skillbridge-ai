import { detectProficiencyInflation, summarizeInflation } from './proficiency-crosscheck';

describe('detectProficiencyInflation (telemetry — no score effect, enum-only)', () => {
  it('flags when the LLM hint EXCEEDS the qualifier — returns ENUM PAIR ONLY (no name)', () => {
    const out = detectProficiencyInflation([
      {
        name: 'react',
        proficiency_hint: 'EXPERT',
        evidence_text: 'basic React on a class project',
      },
    ]);
    expect(out).toEqual([{ llm_hint: 'EXPERT', qualifier_proficiency: 'BEGINNER' }]);
  });

  it('no-ops when no qualifier word is present in evidence', () => {
    expect(
      detectProficiencyInflation([
        { name: 'react', proficiency_hint: 'EXPERT', evidence_text: 'Built the checkout flow' },
      ]),
    ).toEqual([]);
  });

  it('no-ops when evidence_text is absent', () => {
    expect(detectProficiencyInflation([{ name: 'react', proficiency_hint: 'EXPERT' }])).toEqual([]);
  });

  it('no-ops when the LLM hint is missing or invalid', () => {
    expect(detectProficiencyInflation([{ name: 'react', evidence_text: 'basic React' }])).toEqual(
      [],
    );
    expect(
      detectProficiencyInflation([
        { name: 'react', proficiency_hint: 'GARBLED', evidence_text: 'basic React' },
      ]),
    ).toEqual([]);
  });

  it('does NOT flag when the hint is at or below the qualifier', () => {
    expect(
      detectProficiencyInflation([
        { name: 'react', proficiency_hint: 'INTERMEDIATE', evidence_text: 'thành thạo React' }, // qual=ADVANCED
      ]),
    ).toEqual([]);
  });

  it('REGRESSION: never leaks the raw skill name (PII) — name with email/url/person', () => {
    const out = detectProficiencyInflation([
      {
        name: 'React — contact Nguyễn Văn A john@evil.com https://evil.example/cv',
        proficiency_hint: 'EXPERT',
        evidence_text: 'basic React, email me at john@evil.com',
      },
    ]);
    expect(out).toEqual([{ llm_hint: 'EXPERT', qualifier_proficiency: 'BEGINNER' }]);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('john@evil.com');
    expect(serialized).not.toContain('Nguyễn Văn A');
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('basic React'); // evidence text never carried either
  });
});

describe('summarizeInflation (log-safe enum-pair counts only)', () => {
  it('aggregates findings into "ENUM>ENUM=count", sorted by count then key', () => {
    const summary = summarizeInflation([
      { llm_hint: 'ADVANCED', qualifier_proficiency: 'NOVICE' },
      { llm_hint: 'EXPERT', qualifier_proficiency: 'BEGINNER' },
      { llm_hint: 'ADVANCED', qualifier_proficiency: 'NOVICE' },
    ]);
    expect(summary).toBe('ADVANCED>NOVICE=2, EXPERT>BEGINNER=1');
  });

  it('is empty for no findings, and contains ONLY enums/counts (no raw text)', () => {
    expect(summarizeInflation([])).toBe('');
    const summary = summarizeInflation([{ llm_hint: 'EXPERT', qualifier_proficiency: 'BEGINNER' }]);
    expect(summary).toBe('EXPERT>BEGINNER=1');
    expect(/^[A-Z>=,\s0-9]+$/.test(summary)).toBe(true); // enums + counts + separators only
  });
});
