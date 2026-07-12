import { DataSourceOptions } from 'typeorm';
import { assertNotAccidentalProdDb } from './prod-db-guard';

/**
 * Single source of TypeORM connection options, shared by:
 *   - the CLI DataSource (`data-source.ts`) for migration generate/run
 *   - the app runtime (`TypeOrmModule.forRootAsync`, wired once a DB is available)
 *
 * `synchronize` is FORCED false — migrations are the source of truth (like EF
 * Migrations). Never auto-sync a shared/prod schema.
 */
export function buildDataSourceOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  // Covers the app runtime AND the migration CLI: a dev machine cannot open (or migrate) the
  // production database by accident — see prod-db-guard.ts.
  assertNotAccidentalProdDb(env.DATABASE_URL, env);
  return {
    type: 'postgres',
    url: env.DATABASE_URL,
    entities: [__dirname + '/entities/*.entity.{ts,js}'],
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    synchronize: false,
    logging: env.TYPEORM_LOGGING === 'true',
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
}
