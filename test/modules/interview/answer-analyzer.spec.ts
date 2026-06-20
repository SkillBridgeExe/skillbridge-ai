import {
  analyzeAnswerSignals,
  AnswerSignalInput,
} from '../../../src/modules/interview/answer-analyzer';

const en = (answer: string, over: Partial<AnswerSignalInput> = {}): AnswerSignalInput => ({
  answer,
  language: 'en',
  ...over,
});
const vi = (answer: string, over: Partial<AnswerSignalInput> = {}): AnswerSignalInput => ({
  answer,
  language: 'vi',
  ...over,
});

describe('analyzeAnswerSignals — counts', () => {
  it('counts whitespace-delimited words and sentence terminators', () => {
    const out = analyzeAnswerSignals(en('I built it. Then I shipped it! Did it work?'));
    expect(out.word_count).toBe(10);
    expect(out.sentence_count).toBe(3);
  });

  it('treats newlines as sentence boundaries', () => {
    const out = analyzeAnswerSignals(en('first line\nsecond line'));
    expect(out.sentence_count).toBe(2);
  });
});

describe('analyzeAnswerSignals — conciseness bands', () => {
  it('too_short below 20 words', () => {
    expect(analyzeAnswerSignals(en('I used React and shipped a feature quickly')).conciseness).toBe(
      'too_short',
    );
  });

  it('ideal between 20 and 150 words', () => {
    const ans = Array.from({ length: 40 }, () => 'word').join(' ');
    expect(analyzeAnswerSignals(en(ans)).conciseness).toBe('ideal');
  });

  it('verbose above 150 words', () => {
    const ans = Array.from({ length: 200 }, () => 'word').join(' ');
    expect(analyzeAnswerSignals(en(ans)).conciseness).toBe('verbose');
  });
});

describe('analyzeAnswerSignals — filler (language-aware)', () => {
  it('EN: counts um, like, you know with matched terms', () => {
    const out = analyzeAnswerSignals(
      en('Um, I like coding and, you know, it works. I like React.'),
    );
    // "like" appears twice, "um" once, "you know" once -> count 4
    expect(out.filler.count).toBe(4);
    expect(out.filler.terms).toEqual(expect.arrayContaining(['um', 'like', 'you know']));
  });

  it('VI: counts ờ, kiểu, đại loại', () => {
    const out = analyzeAnswerSignals(vi('Ờ, tôi kiểu như làm cái này, đại loại là vậy.'));
    expect(out.filler.count).toBeGreaterThanOrEqual(3);
    expect(out.filler.terms).toEqual(expect.arrayContaining(['ờ', 'đại loại']));
  });

  it('is case-insensitive and word-boundary aware (no substring false hit)', () => {
    // "umbrella" must NOT match filler "um"
    const out = analyzeAnswerSignals(en('I carried an umbrella to the office today.'));
    expect(out.filler.count).toBe(0);
  });
});

describe('analyzeAnswerSignals — hedging (language-aware)', () => {
  it('EN: counts i think, maybe, probably', () => {
    const out = analyzeAnswerSignals(en('I think maybe it was probably caused by a race.'));
    expect(out.hedging.count).toBe(3);
    expect(out.hedging.terms).toEqual(expect.arrayContaining(['i think', 'maybe', 'probably']));
  });

  it('VI: counts chắc là, hình như', () => {
    const out = analyzeAnswerSignals(vi('Chắc là do cache, hình như vậy.'));
    expect(out.hedging.terms).toEqual(expect.arrayContaining(['chắc là', 'hình như']));
  });
});

describe('analyzeAnswerSignals — repeated_terms (DESCRIPTIVE, never penalized)', () => {
  it('returns content terms with count >= 3, sorted desc; drops stopwords', () => {
    const out = analyzeAnswerSignals(
      en('React is great. I used React for the UI. React made it fast. React again.'),
    );
    const react = out.repeated_terms.find((t) => t.term === 'react');
    expect(react).toBeDefined();
    expect(react?.count).toBe(4);
    // stopwords like "the"/"i"/"it" never appear
    expect(out.repeated_terms.some((t) => ['the', 'i', 'it', 'is'].includes(t.term))).toBe(false);
  });

  it('a focused repeat does NOT raise any negative flag', () => {
    const out = analyzeAnswerSignals(
      en(
        'I reduced API latency by 40% using React Query caching. React Query dedupes requests. ' +
          'React Query also retries. React Query was the key win here for the whole team overall.',
      ),
    );
    expect(out.repeated_terms.length).toBeGreaterThan(0);
    expect(out.flags.rambling_risk).toBe(false);
  });
});

describe('analyzeAnswerSignals — jd_term_hits', () => {
  it('matches normalized exact phrase / substring; computes coverage', () => {
    const out = analyzeAnswerSignals(
      en('I worked with React and Node.js to build the service.', {
        jd_terms: ['React', 'Kubernetes', 'Node.js'],
      }),
    );
    expect(out.jd_term_hits.hit).toEqual(expect.arrayContaining(['React', 'Node.js']));
    expect(out.jd_term_hits.missed).toEqual(['Kubernetes']);
    expect(out.jd_term_hits.coverage).toBeCloseTo(2 / 3, 5);
  });

  it('coverage is 1 when no jd_terms supplied', () => {
    expect(analyzeAnswerSignals(en('anything goes here')).jd_term_hits.coverage).toBe(1);
  });

  it('without an alias, TS does NOT match TypeScript (documented limitation)', () => {
    const out = analyzeAnswerSignals(
      en('I wrote everything in TS for type safety.', {
        jd_terms: ['TypeScript'],
      }),
    );
    expect(out.jd_term_hits.missed).toEqual(['TypeScript']);
  });

  it('alias map lets TS satisfy TypeScript', () => {
    const out = analyzeAnswerSignals(
      en('I wrote everything in TS for type safety.', {
        jd_terms: ['TypeScript'],
        aliases: { TypeScript: ['TS', 'ts'] },
      }),
    );
    expect(out.jd_term_hits.hit).toEqual(['TypeScript']);
    expect(out.jd_term_hits.coverage).toBe(1);
  });
});

describe('analyzeAnswerSignals — STAR (DESCRIPTIVE)', () => {
  it('detects all four sections on a full STAR answer; complete=true', () => {
    const out = analyzeAnswerSignals(
      en(
        'When our checkout page was slow, I was responsible for fixing it. ' +
          'I implemented a caching layer with Redis. As a result we reduced load time by 2 seconds.',
      ),
    );
    expect(out.star.situation).toBe(true);
    expect(out.star.task).toBe(true);
    expect(out.star.action).toBe(true);
    expect(out.star.result).toBe(true);
    expect(out.star.complete).toBe(true);
  });

  it('a short technical answer is incomplete but raises NO penalty flag from STAR', () => {
    const out = analyzeAnswerSignals(
      en('I reduced p99 latency by 30% by adding an index on the orders table.'),
    );
    expect(out.star.complete).toBe(false);
    // no flag is derived from incomplete STAR
    expect(out.flags.rambling_risk).toBe(false);
  });

  it('VI STAR cues are detected', () => {
    const out = analyzeAnswerSignals(
      vi(
        'Lúc đó hệ thống bị chậm. Nhiệm vụ của tôi là tối ưu. ' +
          'Tôi đã thêm cache Redis. Kết quả là giảm 30% thời gian tải.',
      ),
    );
    expect(out.star.situation).toBe(true);
    expect(out.star.task).toBe(true);
    expect(out.star.action).toBe(true);
    expect(out.star.result).toBe(true);
  });
});

describe('analyzeAnswerSignals — has_concrete_example (review-locked)', () => {
  it('digits make it concrete', () => {
    expect(analyzeAnswerSignals(en('I shipped 3 features last sprint.')).has_concrete_example).toBe(
      true,
    );
  });

  it('a percent makes it concrete', () => {
    expect(
      analyzeAnswerSignals(en('I improved coverage by quite a bit, 12% overall.'))
        .has_concrete_example,
    ).toBe(true);
  });

  it('a quantified-result cue with a number makes it concrete', () => {
    expect(
      analyzeAnswerSignals(en('I reduced p99 latency by 30% on the orders endpoint.'))
        .has_concrete_example,
    ).toBe(true);
  });

  it('a named tech ALONE is NOT concrete (EN)', () => {
    expect(analyzeAnswerSignals(en('I used Docker for deployment.')).has_concrete_example).toBe(
      false,
    );
  });

  it('a named tech ALONE is NOT concrete (VI)', () => {
    expect(analyzeAnswerSignals(vi('Tôi dùng React.')).has_concrete_example).toBe(false);
  });

  it('action/project cue + named tech + a metric is concrete', () => {
    expect(
      analyzeAnswerSignals(en('I built a React dashboard that cut load time by 2 seconds.'))
        .has_concrete_example,
    ).toBe(true);
  });
});

describe('analyzeAnswerSignals — flags', () => {
  it('is_too_short on a short dodge', () => {
    const out = analyzeAnswerSignals(en('I am not sure.'));
    expect(out.flags.is_too_short).toBe(true);
    expect(out.flags.no_concrete_example).toBe(true);
  });

  it('rambling_risk on verbose + no-concrete + low coverage', () => {
    const padded = Array.from({ length: 200 }, () => 'stuff').join(' ');
    const out = analyzeAnswerSignals(
      en(`Um, you know, I kind of just rambled about ${padded}.`, {
        jd_terms: ['React', 'Kubernetes'],
      }),
    );
    expect(out.conciseness).toBe('verbose');
    expect(out.has_concrete_example).toBe(false);
    expect(out.jd_term_hits.coverage).toBeLessThan(0.5);
    expect(out.flags.rambling_risk).toBe(true);
  });

  it('NO rambling_risk when verbose but concrete (focused long answer)', () => {
    const padded = Array.from({ length: 200 }, () => 'detail').join(' ');
    const out = analyzeAnswerSignals(
      en(`I reduced latency by 30% after profiling. ${padded}`, { jd_terms: ['React'] }),
    );
    expect(out.conciseness).toBe('verbose');
    expect(out.has_concrete_example).toBe(true);
    expect(out.flags.rambling_risk).toBe(false);
  });
});
