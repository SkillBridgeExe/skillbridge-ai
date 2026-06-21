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
// SPOOF-HARDENED: only specific, hard-to-fake brand/domain tokens — NO generic words like 'official' /
// 'university' / 'mit' (which match "Unofficial...", "Summit Academy", etc. and inflate the auto-verify gate).
const TIER_1 = [
  'mdn',
  'mozilla',
  'freecodecamp',
  'coursera',
  'edx',
  'w3c',
  'w3schools',
  'react.dev',
  'kubernetes.io',
  'docker docs',
  'docs.docker',
  'google developers',
  'developers.google',
  'microsoft learn',
  'learn.microsoft',
  'developer.android',
  'developer.apple',
  'postgresql.org',
  'python.org',
  'typescriptlang.org',
  'nodejs.org',
  'spring.io',
  'docs.python.org',
  'git-scm.com',
  'sqlbolt.com',
  'github.com/donnemartin/system-design-primer',
  'deeplearning.ai',
  'skillbridge internal',
  'aws skill builder',
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
  // Trusted Vietnamese learning platforms — editorially-curated courses (NOT user-generated). Lets the
  // bilingual VN lane auto-verify; without this, F8/CodeGym/etc. stay T3 → pending → never embed. Viblo is
  // deliberately NOT here (user-generated articles must stay T3 / human-reviewed). Domain-form tokens are
  // spoof-hard. See specs/2026-06-20-learning-datasource-and-bilingual-design.md §4.2.
  'fullstack.edu.vn', // F8
  'codegym',
  'topcv',
  'talkfirst',
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
  if (then > now) return 50; // future / negative-age date is invalid, not "freshest"
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
  // The gate only TIGHTENS a core 'verified' → it NEVER upgrades a 'pending'/'flagged'/'dead_link' the core
  // (or a content-safety downgrade like a soft flag / purpose floor) set on purpose.
  if (curated.validation_status !== 'verified') return curated.validation_status;
  const trustedTier = signals.providerTier === 'T1' || signals.providerTier === 'T2';
  return curated.quality_score >= AUTO_VERIFY_BAND && trustedTier ? 'verified' : 'pending';
}
