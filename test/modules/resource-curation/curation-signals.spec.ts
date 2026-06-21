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
    expect(providerTier('typescriptlang.org')).toBe('T1');
    expect(providerTier('nodejs.org')).toBe('T1');
    expect(providerTier('spring.io')).toBe('T1');
    expect(providerTier('docs.python.org')).toBe('T1');
    expect(providerTier('git-scm.com')).toBe('T1');
    expect(providerTier('sqlbolt.com')).toBe('T1');
    expect(providerTier('github.com/donnemartin/system-design-primer')).toBe('T1');
    expect(providerTier('DeepLearning.AI')).toBe('T1');
    expect(providerTier('SkillBridge Internal')).toBe('T1');
  });

  it('classifies known commercial platforms as T2', () => {
    expect(providerTier('Udemy')).toBe('T2');
    expect(providerTier('Pluralsight')).toBe('T2');
  });

  it('defaults unknown providers to T3', () => {
    expect(providerTier('Some Random Blog')).toBe('T3');
    expect(providerTier('')).toBe('T3');
  });

  it('is NOT spoofable by generic/lookalike names (no bare "official"/"university"/"mit" tokens)', () => {
    expect(providerTier('Unofficial Docker Guide')).toBe('T3');
    expect(providerTier('Summit Academy')).toBe('T3'); // must not match a bare "mit"
    expect(providerTier('Harvard-lookalike Courses')).toBe('T3');
    expect(providerTier('My University Blog')).toBe('T3');
  });

  it('is case/whitespace-insensitive', () => {
    expect(providerTier('  udemy  ')).toBe('T2');
  });

  it('classifies trusted Vietnamese learning platforms as T2 (bilingual coverage)', () => {
    expect(providerTier('fullstack.edu.vn')).toBe('T2'); // F8
    expect(providerTier('CodeGym')).toBe('T2');
    expect(providerTier('TopCV')).toBe('T2');
    expect(providerTier('talkfirst')).toBe('T2');
  });

  it('keeps user-generated VN content (Viblo) at T3 — UGC must not auto-verify', () => {
    expect(providerTier('viblo.asia')).toBe('T3');
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

  it('future / negative-age date → 50 (invalid, not treated as freshest)', () => {
    expect(freshnessScore('2027-01-01T00:00:00.000Z', now)).toBe(50);
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

  it('NEVER upgrades a core pending (e.g. soft-flag-capped) to verified, even at high quality + T1', () => {
    expect(
      routeValidation(curated({ validation_status: 'pending', quality_score: 90 }), {
        providerTier: 'T1',
      }),
    ).toBe('pending');
  });

  it('a high-quality F8 (fullstack.edu.vn → T2) resource auto-verifies — VN bilingual path works end-to-end', () => {
    expect(
      routeValidation(curated({ quality_score: 90 }), {
        providerTier: providerTier('fullstack.edu.vn'),
      }),
    ).toBe('verified');
  });
});
