import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreAnswerSignalCase,
  AnswerSignalCase,
} from '../../../src/modules/interview/answer-signals-eval';

describe('scoreAnswerSignalCase', () => {
  it('passes when the expected subset matches the analyzer output', () => {
    const c: AnswerSignalCase = {
      id: 'short-dodge',
      input: { answer: 'I am not sure.', language: 'en' },
      expect: {
        conciseness: 'too_short',
        flags: { is_too_short: true, no_concrete_example: true, rambling_risk: false },
      },
    };
    const out = scoreAnswerSignalCase(c);
    expect(out.pass).toBe(true);
    expect(out.mismatches).toEqual([]);
  });

  it('fails and names the mismatching key', () => {
    const c: AnswerSignalCase = {
      id: 'wrong-conciseness',
      input: { answer: 'I am not sure.', language: 'en' },
      expect: { conciseness: 'verbose' },
    };
    const out = scoreAnswerSignalCase(c);
    expect(out.pass).toBe(false);
    expect(out.mismatches).toContain('conciseness');
  });

  it('deep-compares nested expected objects', () => {
    const c: AnswerSignalCase = {
      id: 'nested-miss',
      input: { answer: 'I used Docker for deployment.', language: 'en' },
      expect: { has_concrete_example: true }, // analyzer returns false → mismatch
    };
    const out = scoreAnswerSignalCase(c);
    expect(out.pass).toBe(false);
    expect(out.mismatches).toContain('has_concrete_example');
  });
});

describe('answer-signals golden set', () => {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'answer-signals-golden.json'), 'utf8'),
  ) as { cases: AnswerSignalCase[] };

  it('has >=10 well-formed cases', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of golden.cases) {
      expect(c.id).toBeTruthy();
      expect(c.input).toBeTruthy();
      expect(c.input.language === 'vi' || c.input.language === 'en').toBe(true);
      expect(c.expect).toBeTruthy();
    }
  });

  it('covers the review-mandated cases (VI, named-tech-only, alias, focused-repeat, strong-STAR, rambling, too-short)', () => {
    const langs = new Set(golden.cases.map((c) => c.input.language));
    expect(langs.has('vi')).toBe(true);
    expect(langs.has('en')).toBe(true);

    // named-tech-only must assert has_concrete_example=false
    const namedTechOnly = golden.cases.find(
      (c) => c.expect.has_concrete_example === false && /react|docker|node/i.test(c.input.answer),
    );
    expect(namedTechOnly).toBeDefined();

    // alias case: a jd_term with an aliases map that resolves to a hit
    const aliasCase = golden.cases.find(
      (c) => c.input.aliases && Object.keys(c.input.aliases).length > 0,
    );
    expect(aliasCase).toBeDefined();

    // focused-repeat: expects repeated_terms present AND rambling_risk false
    const focusedRepeat = golden.cases.find(
      (c) => c.expect.flags?.rambling_risk === false && /repeat|focus/i.test(c.id),
    );
    expect(focusedRepeat).toBeDefined();

    // a too_short dodge
    expect(golden.cases.some((c) => c.expect.conciseness === 'too_short')).toBe(true);
    // a rambling case
    expect(golden.cases.some((c) => c.expect.flags?.rambling_risk === true)).toBe(true);
    // a strong STAR-with-metrics
    expect(golden.cases.some((c) => c.expect.star?.complete === true)).toBe(true);
  });

  it('every golden case PASSES its own expectation (self-consistent)', () => {
    for (const c of golden.cases) {
      const out = scoreAnswerSignalCase(c);
      if (!out.pass) {
        throw new Error(`golden case ${c.id} failed: ${out.mismatches.join(', ')}`);
      }
      expect(out.pass).toBe(true);
    }
  });
});
