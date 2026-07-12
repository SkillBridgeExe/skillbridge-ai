/**
 * Refuses to open the PRODUCTION database from a developer machine unless explicitly opted in.
 *
 * Why: on 2026-07-10 a locally-run BE (old branch, old taxonomy) pointed at the prod DATABASE_URL
 * and wrote cv_matches rows into prod — polluting metrics and risking real user data. The .env
 * files on dev machines carry the prod URL, so the guard has to live in code, not in discipline.
 *
 * Rules (first match wins):
 *  - no URL / URL without the prod marker  → allowed (local Postgres, dev DBs).
 *  - running on Cloud Run (K_SERVICE set by the platform, not settable in .env by accident) → allowed.
 *  - NODE_ENV=test → allowed (DB-less boots never eagerly connect; jest on dev machines must not die).
 *  - ALLOW_PROD_DB=1 → allowed, deliberately (DB ops like seed/backfill scripts) — caller logs a warning.
 *  - otherwise → throw, with instructions.
 */

/** Supabase project ref of the PRODUCTION database — appears in both the direct host
 *  (db.<ref>.supabase.co) and the pooler username (postgres.<ref>). */
const PROD_DB_MARKER = 'uvwbnezbgcyktkcmfztb';

/** true when the guard allowed a prod URL only because ALLOW_PROD_DB=1 — caller should warn loudly. */
export function isDeliberateProdOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_PROD_DB === '1';
}

export function assertNotAccidentalProdDb(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!url || !url.includes(PROD_DB_MARKER)) return;
  if (env.K_SERVICE) return; // Cloud Run
  if (env.NODE_ENV === 'test') return;
  if (isDeliberateProdOverride(env)) return;
  throw new Error(
    'DATABASE_URL points at the PRODUCTION database but this process is not running on Cloud Run. ' +
      'Refusing to start so a local run cannot silently write to prod. ' +
      'Point DATABASE_URL at a local/dev Postgres, or — for deliberate prod DB ops ' +
      '(seed/backfill) — set ALLOW_PROD_DB=1 for this one command.',
  );
}
