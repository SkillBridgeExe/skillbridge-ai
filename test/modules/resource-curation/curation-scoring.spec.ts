import {
  aggregateQuality,
  decideValidation,
  groundCuration,
  CurationInput,
} from '../../../src/modules/resource-curation/curation-scoring';

const input: CurationInput = {
  title: 'Docker for Developers',
  provider: 'Udemy',
  description: 'Learn Docker from scratch',
  skills: ['docker'],
  url: 'https://example.com/x',
};

describe('aggregateQuality (CRAAP → 0-100, deterministic)', () => {
  it('maps all-1 → 100 and all-0 → 0', () => {
    expect(
      aggregateQuality({ relevance: 1, authority: 1, currency: 1, accuracy: 1, purpose: 1 }),
    ).toBe(100);
    expect(
      aggregateQuality({ relevance: 0, authority: 0, currency: 0, accuracy: 0, purpose: 0 }),
    ).toBe(0);
  });

  it('weights relevance as the heaviest dimension', () => {
    const onlyRel = aggregateQuality({
      relevance: 1,
      authority: 0,
      currency: 0,
      accuracy: 0,
      purpose: 0,
    });
    const onlyAuth = aggregateQuality({
      relevance: 0,
      authority: 1,
      currency: 0,
      accuracy: 0,
      purpose: 0,
    });
    expect(onlyRel).toBeGreaterThan(onlyAuth);
  });

  it('clamps out-of-range dimensions into [0,100]', () => {
    const q = aggregateQuality({
      relevance: 9,
      authority: -3,
      currency: 0,
      accuracy: 0,
      purpose: 0,
    });
    expect(q).toBeGreaterThanOrEqual(0);
    expect(q).toBeLessThanOrEqual(100);
  });
});

describe('decideValidation', () => {
  it('verified when quality ≥ threshold + has skills + no hard flag', () => {
    expect(decideValidation(80, [], true)).toBe('verified');
  });

  it('flagged when NO skills detected (useless for matching) even with high quality', () => {
    expect(decideValidation(95, [], false)).toBe('flagged');
  });

  it('flagged on a promotional flag regardless of score', () => {
    expect(decideValidation(95, ['promotional'], true)).toBe('flagged');
  });

  it('pending (human review) when quality below the verify threshold', () => {
    expect(decideValidation(40, [], true)).toBe('pending');
  });
});

describe('groundCuration (anti-fabrication + aggregation)', () => {
  it('aggregates CRAAP, decides verified, and strips a raw url from the description', () => {
    const out = groundCuration(
      {
        craap: { relevance: 0.9, authority: 0.8, currency: 0.8, accuracy: 0.7, purpose: 0.8 },
        description: 'Solid hands-on intro — buy at https://promo.example now',
        flags: [],
      },
      input,
    );
    expect(out.quality_score).toBeGreaterThan(60);
    expect(out.validation_status).toBe('verified');
    expect(out.description).not.toMatch(/https?:\/\//i);
    expect(out.description.length).toBeGreaterThan(0);
  });

  it('bad/garbage parse → pending (NEVER auto-verifies), neutral description from the title', () => {
    const out = groundCuration('garbage', input);
    expect(out.validation_status).toBe('pending');
    expect(out.description).toContain('Docker for Developers');
    expect(out.quality_score).toBeLessThanOrEqual(50);
  });

  it('drops unknown flags, keeps valid ones, and a promotional flag forces flagged', () => {
    const out = groundCuration(
      {
        craap: { relevance: 0.2, authority: 0.2, currency: 0.2, accuracy: 0.2, purpose: 0.2 },
        description: 'x',
        flags: ['promotional', 'TOTALLY_BOGUS'],
      },
      input,
    );
    expect(out.flags).toContain('promotional');
    expect(out.flags).not.toContain('TOTALLY_BOGUS');
    expect(out.validation_status).toBe('flagged');
  });

  it('no declared skills → flagged even with excellent CRAAP', () => {
    const out = groundCuration(
      {
        craap: { relevance: 0.95, authority: 0.95, currency: 0.95, accuracy: 0.95, purpose: 0.95 },
        description: 'great',
        flags: [],
      },
      { ...input, skills: [] },
    );
    expect(out.validation_status).toBe('flagged');
  });

  it('soft flags (outdated/paywalled/low_quality) cap a would-be-verified result at pending', () => {
    const out = groundCuration(
      {
        craap: { relevance: 0.9, authority: 0.9, currency: 0.9, accuracy: 0.9, purpose: 0.9 },
        description: 'good',
        flags: ['outdated'],
      },
      input,
    );
    expect(out.quality_score).toBeGreaterThan(60);
    expect(out.validation_status).toBe('pending');
  });

  it('purpose floor: pure-marketing purpose (level 0) → flagged despite high other dimensions', () => {
    const out = groundCuration(
      {
        craap: { relevance: 0.9, authority: 0.9, currency: 0.9, accuracy: 0.9, purpose: 0 },
        description: 'buy now',
        flags: [],
      },
      input,
    );
    expect(out.validation_status).toBe('flagged');
  });

  it('strips a scheme-less promo host + shortener from the description (not just http://)', () => {
    const out = groundCuration(
      {
        craap: { relevance: 0.9, authority: 0.9, currency: 0.9, accuracy: 0.9, purpose: 0.9 },
        description: 'Khoá hay, mua tại promo.example/buy và bit.ly/xyz',
        flags: [],
      },
      input,
    );
    expect(out.description).not.toMatch(/promo\.example|bit\.ly/i);
    expect(out.description).toContain('[link]');
  });
});
