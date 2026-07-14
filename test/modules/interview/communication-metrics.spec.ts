import { analyzeAnswerSignals, Language } from '../../../src/modules/interview/answer-analyzer';
import {
  buildCommunicationSignals,
  CommunicationSignals,
} from '../../../src/modules/interview/communication-metrics';

/**
 * Wave I-VOICE TDD: CommunicationSignals is a thin, honest PROJECTION of the Layer-1
 * AnswerSignals (code-counted, no LLM) plus timing-derived speaking rate. It must never invent
 * emotion/psychology and must say when a metric is unavailable instead of faking it.
 */

function signalsFor(
  answer: string,
  over: { jd_terms?: string[]; language?: Language } = {},
): CommunicationSignals {
  const l1 = analyzeAnswerSignals({
    answer,
    jd_terms: over.jd_terms ?? [],
    language: over.language ?? 'en',
  });
  return buildCommunicationSignals(l1);
}

describe('buildCommunicationSignals — counts are the L1 counts', () => {
  it('projects word/sentence/filler counts from the analyzer (English fillers)', () => {
    const out = signalsFor(
      'Basically we used caching. You know, it was basically the main fix we shipped there.',
    );
    expect(out.word_count).toBe(15);
    expect(out.sentence_count).toBe(2);
    expect(out.filler_count).toBe(3);
    expect(out.filler_terms).toEqual(expect.arrayContaining(['basically', 'you know']));
  });

  it('counts Vietnamese fillers under the vi tables', () => {
    const out = signalsFor(
      'Kiểu như em làm phần giao diện, kiểu như nó cũng ổn, đại loại là em chưa chắc lắm.',
      { language: 'vi' },
    );
    expect(out.filler_count).toBe(3);
    expect(out.filler_terms).toEqual(expect.arrayContaining(['kiểu như', 'đại loại là']));
  });

  it('does NOT credit "Java" when the answer only says "JavaScript"', () => {
    const out = signalsFor('I write JavaScript every day for the web app.', {
      jd_terms: ['Java', 'JavaScript'],
    });
    expect(out.jd_term_hits).toEqual(['JavaScript']);
    expect(out.jd_term_misses).toEqual(['Java']);
  });

  it('reports repeated content terms (3+ occurrences)', () => {
    const out = signalsFor(
      'Caching is hard. Caching invalidation broke twice, and caching keys drifted over time.',
    );
    expect(out.repeated_terms).toContain('caching');
  });

  it('detects the STAR result component only when a result clue exists', () => {
    const withResult = signalsFor(
      'When the page broke, I had to fix it. I implemented a rollback and as a result errors stopped.',
    );
    expect(withResult.star.result).toBe(true);

    const noResult = signalsFor('When the page broke, I had to fix it. I implemented a rollback.');
    expect(noResult.star.result).toBe(false);
  });

  it('bands answer length: too_short / ideal / verbose', () => {
    expect(signalsFor('Just useState.').answer_length_band).toBe('too_short');
    expect(
      signalsFor(
        'We picked React Query for server state because it handles caching, retries, and background refetching without extra reducers or manual invalidation everywhere.',
      ).answer_length_band,
    ).toBe('ideal');
  });
});

describe('buildCommunicationSignals — timing metrics stay honest', () => {
  const l1 = analyzeAnswerSignals({
    answer: 'I implemented a Redis cache and as a result we reduced p99 latency by thirty percent.',
    jd_terms: [],
    language: 'en',
  });

  it('computes speaking rate only when a positive duration exists', () => {
    const out = buildCommunicationSignals(l1, { duration_seconds: 30 });
    expect(out.speaking_rate_wpm).toBe(Math.round((l1.word_count / 30) * 60));
    expect(out.unavailable_reason).toBeUndefined();
  });

  it('marks rate unavailable instead of faking it when timing is missing', () => {
    for (const timing of [undefined, {}, { duration_seconds: null }, { duration_seconds: 0 }]) {
      const out = buildCommunicationSignals(l1, timing);
      expect(out.speaking_rate_wpm).toBeUndefined();
      expect(out.unavailable_reason).toBe('no_timing_data');
    }
  });
});

describe('buildCommunicationSignals — no psychology, ever', () => {
  it('exposes zero emotion/personality fields', () => {
    const out = signalsFor('I think it went well.');
    const keys = Object.keys(out);
    for (const banned of ['confidence', 'confidence_tone', 'personality', 'emotion', 'mood']) {
      expect(keys).not.toContain(banned);
    }
  });
});
