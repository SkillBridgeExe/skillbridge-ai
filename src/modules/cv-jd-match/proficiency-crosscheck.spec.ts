import { detectProficiencyInflation } from './proficiency-crosscheck';

describe('detectProficiencyInflation (telemetry — no score effect)', () => {
  it('flags when the LLM hint EXCEEDS the qualifier found in evidence', () => {
    const out = detectProficiencyInflation([
      {
        name: 'react',
        proficiency_hint: 'EXPERT',
        evidence_text: 'basic React on a class project',
      },
    ]);
    expect(out).toEqual([
      { canonical_or_raw: 'react', llm_hint: 'EXPERT', qualifier_proficiency: 'BEGINNER' },
    ]);
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

  it('payload carries enum/canonical ONLY — never raw evidence text (PII guard)', () => {
    const out = detectProficiencyInflation([
      {
        name: 'react',
        proficiency_hint: 'EXPERT',
        evidence_text: 'basic React, email me at a@b.com',
      },
    ]);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('a@b.com');
    expect(serialized).not.toContain('basic React');
  });
});
