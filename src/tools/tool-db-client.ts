import { Client } from 'pg';
import { assertNotAccidentalProdDb } from '../database/prod-db-guard';

/**
 * Creates a standard database Client for CLI tools using the production conventions:
 * 1. Fails fast if DATABASE_URL is missing.
 * 2. Guards against accidental production writes unless ALLOW_PROD_DB=1.
 * 3. Configures SSL if DB_SSL=true.
 */
export function createToolDbClient(): Client {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Tools must run against a specific DB url.');
  }

  assertNotAccidentalProdDb(databaseUrl);

  return new Client({
    connectionString: databaseUrl,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
}
