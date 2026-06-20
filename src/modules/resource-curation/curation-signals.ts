import { ValidationStatus } from '../roadmap/learning-resource';
import { CuratedResource } from './curation-scoring';

/**
 * Deterministic signals the LLM cannot or should not own (provider authority, today's date, the
 * auto-publish risk gate). Deterministic-first: the LLM reads content; CODE owns the facts + the
 * safe-for-commerce decision. All pure (the live dead-link probe lives in the offline tool, not here).
 */

export type ProviderTier = 'T1' | 'T2' | 'T3';

/** quality_score at/above which a T1/T2 resource may auto-verify — STRICTER than the core verify
 * threshold (60) so a commercial catalog only auto-publishes high-confidence items. Architect-tunable. */
export const AUTO_VERIFY_BAND = 75;

// Provider authority allowlist (normalized substring match). Architect-tunable; unknown defaults to T3.
const TIER_1 = [
  'mdn',
  'mozilla',
  'freecodecamp',
  'coursera',
  'edx',
  'official',
  'w3c',
  'react.dev',
  'kubernetes.io',
  'docker docs',
  'university',
  'harvard',
  'mit ',
  'stanford',
  'google developers',
  'microsoft learn',
  'aws skill',
];
const TIER_2 = [
  'udemy',
  'pluralsight',
  'udacity',
  'linkedin learning',
  'codecademy',
  'youtube',
  'educative',
  'datacamp',
  'scrimba',
  'frontend masters',
];

const norm = (s: string): string => s.trim().toLowerCase();

/** Map a provider name → authority tier (T1 authoritative · T2 known commercial · T3 unknown). */
export function providerTier(provider: string): ProviderTier {
  const p = norm(provider);
  if (!p) return 'T3';
  if (TIER_1.some((t) => p.includes(t))) return 'T1';
  if (TIER_2.some((t) => p.includes(t))) return 'T2';
  return 'T3';
}

const DAY_MS = 86_400_000;

/** 0-100 freshness from age bands. Code owns this — the LLM doesn't know today's date. Invalid → neutral 50. */
export function freshnessScore(lastVerifiedAt: string | undefined, nowIso: string): number {
  if (!lastVerifiedAt) return 50;
  const then = Date.parse(lastVerifiedAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return 50;
  const days = (now - then) / DAY_MS;
  if (days <= 90) return 100;
  if (days <= 180) return 80;
  if (days <= 365) return 50;
  return 20;
}

/**
 * Confidence-band router — the safe-for-commerce auto-verify gate. The pure core's decideValidation is a
 * lenient ≥60→verified; this TIGHTENS it for an auto-published catalog: only the HIGH band
 * (≥AUTO_VERIFY_BAND) from a T1/T2 provider auto-verifies; anything else that merely passed the core stays
 * `pending` for a human spot-check. Terminal flagged / dead_link decisions are preserved.
 */
export function routeValidation(
  curated: CuratedResource,
  signals: { providerTier: ProviderTier },
): ValidationStatus {
  if (curated.validation_status === 'flagged' || curated.validation_status === 'dead_link') {
    return curated.validation_status;
  }
  const trustedTier = signals.providerTier === 'T1' || signals.providerTier === 'T2';
  if (curated.quality_score >= AUTO_VERIFY_BAND && trustedTier) return 'verified';
  return 'pending';
}
