import { analyzeAnswerSignals } from '../../../src/modules/interview/answer-analyzer';

const sig = (
  answer: string,
  language: 'en' | 'vi' = 'en',
): ReturnType<typeof analyzeAnswerSignals> =>
  analyzeAnswerSignals({ answer, language, jd_terms: [] });

describe('analyzeAnswerSignals — is_quantified (split from has_concrete_example, 2026-06-21)', () => {
  it('true on a number in a meaningful context', () => {
    expect(sig('I reduced p99 latency by 30% for users.').is_quantified).toBe(true);
  });

  it('true on a quantified-result cue without a digit (vi)', () => {
    expect(sig('Em đã refactor và giảm thời gian build cho team.', 'vi').is_quantified).toBe(true);
  });

  it('KEY: tech-grounded action WITHOUT a number is concrete but NOT quantified', () => {
    const s = sig('I built the dashboard with React and Node for the team.');
    expect(s.has_concrete_example).toBe(true); // rule (c): action + named tech
    expect(s.is_quantified).toBe(false); // no number, no result cue
  });

  it('false on a generic answer with neither a number nor a result cue', () => {
    expect(
      sig('I am comfortable with React and have used it in some projects.').is_quantified,
    ).toBe(false);
  });
});
