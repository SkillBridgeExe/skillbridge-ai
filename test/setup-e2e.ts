/**
 * Runs before every e2e test file via jest-e2e.json `setupFiles`.
 * Sets the minimum env required by ConfigModule.forRoot() Joi validation,
 * so importing AppModule does not throw at module-decorator evaluation.
 *
 * DATABASE_URL points at a fake host because the e2e suite never actually
 * connects to Postgres — pg.Pool is lazy and only opens a connection on
 * first query. Tests that DO query the DB must mock DatabaseService.
 */

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.INTERNAL_AUTH_SECRET =
  process.env.INTERNAL_AUTH_SECRET ?? 'test-secret-at-least-16-chars';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test';
process.env.PORT = process.env.PORT ?? '3099';
