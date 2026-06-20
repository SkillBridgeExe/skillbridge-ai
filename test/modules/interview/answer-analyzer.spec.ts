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

  it('VI: counts ờ, kiểu như, đại loại là (multi-word disfluencies, no double-count)', () => {
    const out = analyzeAnswerSignals(vi('Ờ, tôi kiểu như làm cái này, đại loại là vậy.'));
    // ờ(1) + "kiểu như"(1) + "đại loại là"(1) = 3. The longer phrases claim their spans, so bare
    // "kiểu"/"đại loại" are NOT double-counted on top of them.
    expect(out.filler.count).toBe(3);
    expect(out.filler.terms).toEqual(expect.arrayContaining(['ờ', 'kiểu như', 'đại loại là']));
    // bare "kiểu" is no longer a filler entry at all
    expect(out.filler.terms).not.toContain('kiểu');
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

describe('analyzeAnswerSignals — has_concrete_example hardening (regression)', () => {
  // rule (a): a bare number out of context is NOT concrete
  it('age/tenure is NOT concrete ("25 years old")', () => {
    expect(analyzeAnswerSignals(en('I am 25 years old.')).has_concrete_example).toBe(false);
  });
  it('tenure is NOT concrete ("coding for 5 years")', () => {
    expect(analyzeAnswerSignals(en('I have been coding for 5 years.')).has_concrete_example).toBe(
      false,
    );
  });
  it('team size is NOT concrete ("team of 4 people")', () => {
    expect(analyzeAnswerSignals(en('We are a team of 4 people.')).has_concrete_example).toBe(false);
  });
  it('a bare year is NOT concrete ("in 2021")', () => {
    expect(analyzeAnswerSignals(en('I worked on this project in 2021.')).has_concrete_example).toBe(
      false,
    );
  });
  it('a self-rating is NOT concrete ("8 out of 10")', () => {
    expect(analyzeAnswerSignals(en('I rate myself 8 out of 10.')).has_concrete_example).toBe(false);
  });
  it('version numbers are NOT concrete ("Python 3 and Java 8")', () => {
    expect(analyzeAnswerSignals(en('I used Python 3 and Java 8.')).has_concrete_example).toBe(
      false,
    );
  });
  it('a phone number is NOT concrete', () => {
    expect(analyzeAnswerSignals(en('My phone is 0901234567.')).has_concrete_example).toBe(false);
  });

  // rule (a): a number IN context IS concrete
  it('a number with a metric unit is concrete ("by 200ms")', () => {
    expect(
      analyzeAnswerSignals(en('I built a Redis cache that cut p99 by 200ms.')).has_concrete_example,
    ).toBe(true);
  });
  it('a number adjacent to a metric noun is concrete ("10000 users")', () => {
    expect(analyzeAnswerSignals(en('We shipped to 10000 users.')).has_concrete_example).toBe(true);
  });

  // rule (b): a quantified-result cue is concrete WITHOUT a digit
  it('a spelled-out magnitude is concrete ("doubled the users")', () => {
    expect(
      analyzeAnswerSignals(en('We doubled the number of active users.')).has_concrete_example,
    ).toBe(true);
  });
  it('"reduced … by half" is concrete without a digit', () => {
    expect(analyzeAnswerSignals(en('I reduced our error rate by half.')).has_concrete_example).toBe(
      true,
    );
  });
  it('VI quantified cue without a digit is concrete ("giảm thời gian")', () => {
    expect(
      analyzeAnswerSignals(vi('Tôi tối ưu truy vấn và giảm thời gian phản hồi đáng kể.'))
        .has_concrete_example,
    ).toBe(true);
  });

  // rule (c): off-allowlist tech via action cue + proper-noun token
  it('action cue + off-allowlist proper-noun tech is concrete (Svelte)', () => {
    expect(
      analyzeAnswerSignals(en('I built a service with Svelte for the dashboard.'))
        .has_concrete_example,
    ).toBe(true);
  });
  it('action cue + off-allowlist proper-noun tech is concrete (Cassandra)', () => {
    expect(
      analyzeAnswerSignals(en('I designed the storage layer on Cassandra for scale.'))
        .has_concrete_example,
    ).toBe(true);
  });
  it('action cue + a jd_term hit is concrete even off the NAMED_TECH allowlist', () => {
    expect(
      analyzeAnswerSignals(
        en('I developed the realtime layer for the feed.', {
          jd_terms: ['realtime'],
        }),
      ).has_concrete_example,
    ).toBe(true);
  });
  it('a tech name ALONE (no action cue) is still NOT concrete', () => {
    expect(analyzeAnswerSignals(en('I really like Svelte and Elixir.')).has_concrete_example).toBe(
      false,
    );
  });
});

describe('analyzeAnswerSignals — jd_term_hits whole-word (regression)', () => {
  it('jd "Java" does NOT match inside "JavaScript"', () => {
    const out = analyzeAnswerSignals(
      en('I wrote everything in JavaScript for the frontend.', { jd_terms: ['Java'] }),
    );
    expect(out.jd_term_hits.hit).toEqual([]);
    expect(out.jd_term_hits.missed).toEqual(['Java']);
    expect(out.jd_term_hits.coverage).toBe(0);
  });
  it('jd "Java" DOES match when present as a whole word', () => {
    const out = analyzeAnswerSignals(
      en('I built backend services in Java and Spring.', { jd_terms: ['Java'] }),
    );
    expect(out.jd_term_hits.hit).toEqual(['Java']);
  });
  it('jd "Go" does NOT match inside "golang" but matches standalone Go', () => {
    const missed = analyzeAnswerSignals(en('We use golang internally.', { jd_terms: ['Go'] }));
    expect(missed.jd_term_hits.hit).toEqual([]);
    const hit = analyzeAnswerSignals(en('I rewrote the worker in Go.', { jd_terms: ['Go'] }));
    expect(hit.jd_term_hits.hit).toEqual(['Go']);
  });
  it('dotted jd term Node.js still matches as a whole word', () => {
    const out = analyzeAnswerSignals(
      en('I worked with React and Node.js to build the service.', { jd_terms: ['Node.js'] }),
    );
    expect(out.jd_term_hits.hit).toEqual(['Node.js']);
  });
});

describe('analyzeAnswerSignals — VI "kiểu" filler (regression)', () => {
  it('technical "kiểu dữ liệu" (data type) is NOT counted as filler', () => {
    const out = analyzeAnswerSignals(
      vi('Tôi định nghĩa một kiểu dữ liệu mới. Kiểu này gồm nhiều trường khác nhau.'),
    );
    expect(out.filler.count).toBe(0);
    expect(out.filler.terms).not.toContain('kiểu');
  });
  it('technical "kiểu kiến trúc" (architecture style) is NOT counted as filler', () => {
    const out = analyzeAnswerSignals(
      vi('Chúng tôi dùng một kiểu kiến trúc microservice. Kiểu thiết kế này khác kiểu monolith.'),
    );
    expect(out.filler.count).toBe(0);
  });
  it('one genuine "kiểu như" filler counts ONCE (no kiểu double-count)', () => {
    const out = analyzeAnswerSignals(vi('Nó hoạt động kiểu như là một hàng đợi vậy.'));
    expect(out.filler.count).toBe(1);
    expect(out.filler.terms).toEqual(['kiểu như']);
  });
  it('"à" does not false-match inside và/đã (boundary guard holds)', () => {
    const out = analyzeAnswerSignals(vi('Tôi xây dựng API và tối ưu database và cache.'));
    expect(out.filler.count).toBe(0);
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
