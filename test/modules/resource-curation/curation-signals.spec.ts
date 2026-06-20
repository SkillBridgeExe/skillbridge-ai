import {
  providerTier,
  freshnessScore,
  routeValidation,
  AUTO_VERIFY_BAND,
} from '../../../src/modules/resource-curation/curation-signals';
import { CuratedResource } from '../../../src/modules/resource-curation/curation-scoring';

const curated = (over: Partial<CuratedResource>): CuratedResource => ({
  quality_score: 80,
  validation_status: 'verified',
  description: 'd',
  flags: [],
  craap: { relevance: 0.8, authority: 0.8, currency: 0.8, accuracy: 0.8, purpose: 0.8 },
  ...over,
});

describe('providerTier', () => {
  it('classifies authoritative sources as T1 (official docs / MDN / freeCodeCamp / major MOOC)', () => {
    expect(providerTier('MDN Web Docs')).toBe('T1');
    expect(providerTier('freeCodeCamp')).toBe('T1');
    expect(providerTier('Coursera')).toBe('T1');
  });

  it('classifies known commercial platforms as T2', () => {
    expect(providerTier('Udemy')).toBe('T2');
    expect(providerTier('Pluralsight')).toBe('T2');
  });

  it('defaults unknown providers to T3', () => {
    expect(providerTier('Some Random Blog')).toBe('T3');
    expect(providerTier('')).toBe('T3');
  });

  it('is case/whitespace-insensitive', () => {
    expect(providerTier('  udemy  ')).toBe('T2');
  });
});

describe('freshnessScore (code owns the date — the LLM cannot)', () => {
  const now = '2026-06-20T00:00:00.000Z';
  it('full score for recent (≤90d), decaying by band', () => {
    expect(freshnessScore('2026-05-01T00:00:00.000Z', now)).toBe(100); // ~50d
    expect(freshnessScore('2026-01-15T00:00:00.000Z', now)).toBe(80); // ~5mo
    expect(freshnessScore('2025-09-01T00:00:00.000Z', now)).toBe(50); // ~9mo
    expect(freshnessScore('2023-01-01T00:00:00.000Z', now)).toBe(20); // >1y
  });

  it('invalid / missing date → neutral 50 (never throws)', () => {
    expect(freshnessScore(undefined, now)).toBe(50);
    expect(freshnessScore('not-a-date', now)).toBe(50);
  });
});

describe('routeValidation — safe-for-commerce auto-verify gate (tightens the core decision)', () => {
  it('auto-verifies only HIGH band (≥ AUTO_VERIFY_BAND) AND a T1/T2 provider', () => {
    expect(routeValidation(curated({ quality_score: 80 }), { providerTier: 'T1' })).toBe(
      'verified',
    );
    expect(routeValidation(curated({ quality_score: 80 }), { providerTier: 'T2' })).toBe(
      'verified',
    );
    expect(AUTO_VERIFY_BAND).toBeGreaterThan(60); // stricter than the core's verify threshold
  });

  it('an unknown (T3) provider NEVER auto-verifies on sighting → pending (human review)', () => {
    expect(routeValidation(curated({ quality_score: 95 }), { providerTier: 'T3' })).toBe('pending');
  });

  it('MID band (passed the core but below the auto-verify band) → pending even for T1', () => {
    expect(routeValidation(curated({ quality_score: 65 }), { providerTier: 'T1' })).toBe('pending');
  });

  it('preserves a flagged decision regardless of provider/score', () => {
    expect(
      routeValidation(curated({ validation_status: 'flagged', quality_score: 90 }), {
        providerTier: 'T1',
      }),
    ).toBe('flagged');
  });
});
