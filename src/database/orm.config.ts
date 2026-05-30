import { DataSourceOptions } from 'typeorm';

/**
 * Single source of TypeORM connection options, shared by:
 *   - the CLI DataSource (`data-source.ts`) for migration generate/run
 *   - the app runtime (`TypeOrmModule.forRootAsync`, wired once a DB is available)
 *
 * `synchronize` is FORCED false — migrations are the source of truth (like EF
 * Migrations). Never auto-sync a shared/prod schema.
 */
export function buildDataSourceOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
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
